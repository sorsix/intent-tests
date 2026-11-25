import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { DashboardClient, DashboardHttpError, batches } from './client.ts';
import { canonicalJson } from './catalog.ts';
import type { SuitePayload } from './catalog.ts';
import { atomicJson, digest, Spool, supersededProgress } from './spool.ts';
import type { Event, Manifest } from './spool.ts';
import { captureRecord, sanitize } from './sanitize.ts';
import type {
  DecisionRecord,
  DecisionRecordedEvent,
  RunFinishedEvent,
  RunHeartbeatEvent,
  RunLogEvent,
  RunProgressEvent,
  RunReportingEvent,
  RunStats,
  RunningTest,
} from './events.ts';

/** What the parent decides about the evidence receipt before it becomes a `run.reporting` event. */
type ReportingReceipt = Pick<
  RunReportingEvent,
  'status' | 'expectedArtifacts' | 'expectedDecisions' | 'reason'
>;

export function initialDecisionOffsets(reports: Record<string, string>): Record<string, number> {
  const offsets: Record<string, number> = {};
  for (const dir of Object.values(reports)) {
    const decisions = join(dir, 'decisions');
    if (!existsSync(decisions)) continue;
    for (const file of readdirSync(decisions).filter((file) => file.endsWith('.jsonl')))
      offsets[join(decisions, file)] = statSync(join(decisions, file)).size;
  }
  return offsets;
}
const QUARANTINE_LOG = 'parent:quarantine:';
/** Thrown inside a pump after an event was quarantined: the next pump continues with the rest. */
class EventQuarantined extends Error {}

export class DashboardSession {
  dir: string;
  manifest: Manifest;
  spool: Spool;
  client: DashboardClient;
  runId: string | null = null;
  runNumber: number | null = null;
  private busy = false;
  private lastHeartbeat = 0;
  private progressSequence = 0;
  private lastProgress = '';
  private warned = false;
  private tails = new Map<string, { offset: number; partial: string; decoder: StringDecoder }>();
  private captured = new Set<string>();
  // Ownership of raw decisions still waiting for their test or step to be spooled. Only these few fields are kept: the
  // record itself (a whole model request) is read again when it can be spooled.
  private waitingRaw = new Map<
    string,
    { clientTestId?: string; attempt: number; clientStepId?: string }
  >();
  constructor(
    dir: string,
    manifest: Manifest,
    options: { client?: DashboardClient; timeoutMs?: number } = {},
  ) {
    this.dir = dir;
    this.manifest = manifest;
    this.spool = new Spool(dir);
    this.client = options.client ?? new DashboardClient(manifest.url, options.timeoutMs);
    atomicJson(join(dir, 'manifest.json'), manifest);
    const state = join(dir, 'transport.json');
    if (existsSync(state)) {
      const saved = JSON.parse(readFileSync(state, 'utf8')) as {
        runId?: string;
        runNumber?: number;
        progressSequence?: number;
      };
      this.runId = saved.runId ?? null;
      this.runNumber =
        Number.isSafeInteger(saved.runNumber) && Number(saved.runNumber) > 0
          ? saved.runNumber!
          : null;
      this.progressSequence = saved.progressSequence ?? 0;
    }
  }
  private state() {
    atomicJson(join(this.dir, 'transport.json'), {
      runId: this.runId,
      runNumber: this.runNumber,
      progressSequence: this.progressSequence,
    });
  }
  private acknowledgeRun(result: Record<string, unknown>) {
    this.runId = String(result.runId);
    if (
      typeof result.runNumber === 'number' &&
      Number.isSafeInteger(result.runNumber) &&
      result.runNumber > 0
    ) {
      if (this.runNumber !== null && this.runNumber !== result.runNumber)
        throw new Error('Dashboard run number changed for the saved run');
      this.runNumber = result.runNumber;
    }
    this.state();
  }
  private collectRaw(final: boolean) {
    for (const [phase, report] of Object.entries(this.manifest.reports)) {
      const directory = join(report, 'decisions');
      if (!existsSync(directory)) continue;
      for (const filename of readdirSync(directory).filter((name) => name.endsWith('.jsonl'))) {
        const path = join(directory, filename),
          tail = this.tails.get(path) ?? {
            offset: this.manifest.decisionOffsets?.[path] ?? 0,
            partial: '',
            decoder: new StringDecoder('utf8'),
          };
        const size = statSync(path).size;
        if (size < tail.offset)
          throw new Error('Decision log was truncated during dashboard capture');
        const descriptor = openSync(path, 'r');
        try {
          const bytes = Buffer.alloc(64 * 1024);
          let budget = final ? Number.POSITIVE_INFINITY : 6 * 1024 * 1024;
          while (tail.offset < size && budget > 0) {
            const count = readSync(
              descriptor,
              bytes,
              0,
              Math.min(bytes.length, size - tail.offset, budget),
              tail.offset,
            );
            if (!count) break;
            tail.offset += count;
            budget -= count;
            tail.partial += tail.decoder.write(bytes.subarray(0, count));
            let end: number;
            while ((end = tail.partial.indexOf('\n')) >= 0) {
              const line = tail.partial.slice(0, end);
              tail.partial = tail.partial.slice(end + 1);
              if (!line.trim()) continue;
              const original = JSON.parse(line) as DecisionRecord;
              const record = captureRecord(original);
              const id =
                typeof original.clientDecisionId === 'string'
                  ? original.clientDecisionId
                  : digest(`${phase}:${filename}:${line}`);
              const output = join(this.dir, 'raw', `${digest(id)}.json`);
              if (!existsSync(output)) atomicJson(output, { id, phase, record });
            }
            if (tail.partial.length > 6 * 1024 * 1024)
              throw new Error('A decision log row exceeds 6 MiB');
          }
        } finally {
          closeSync(descriptor);
        }
        this.tails.set(path, tail);
      }
    }
    const events = this.spool.events(true),
      tests = new Set<string>(),
      steps = new Set<string>();
    for (const event of events) {
      const key = `${String(event.clientTestId)}:${String(event.attempt ?? 1)}`;
      if (event.type === 'test.started') tests.add(key);
      if (event.type === 'step.recorded') steps.add(`${key}:${String(event.clientStepId)}`);
    }
    for (const file of readdirSync(join(this.dir, 'raw')).filter((file) =>
      file.endsWith('.json'),
    )) {
      if (this.captured.has(file)) continue;
      const read = () =>
        JSON.parse(readFileSync(join(this.dir, 'raw', file), 'utf8')) as {
          id: string;
          record: DecisionRecord;
        };
      let loaded: ReturnType<typeof read> | undefined;
      let owner = this.waitingRaw.get(file);
      if (!owner) {
        loaded = read();
        const ctx = loaded.record.ctx;
        owner = {
          clientTestId: typeof ctx?.clientTestId === 'string' ? ctx.clientTestId : undefined,
          attempt: typeof ctx?.attempt === 'number' ? ctx.attempt : 1,
          clientStepId: typeof ctx?.clientStepId === 'string' ? ctx.clientStepId : undefined,
        };
      }
      const { clientTestId, attempt, clientStepId } = owner;
      const key = `${clientTestId}:${attempt}`;
      const linkedTest = !!clientTestId && tests.has(key),
        linkedStep = linkedTest && !!clientStepId && steps.has(`${key}:${clientStepId}`);
      if (!final && (!linkedTest || (clientStepId && !linkedStep))) {
        this.waitingRaw.set(file, owner);
        continue;
      }
      const raw = loaded ?? read();
      this.spool.event({
        id: `decision:${raw.id}`,
        type: 'decision.recorded',
        clientDecisionId: raw.id,
        record: raw.record,
        ...(linkedTest ? { clientTestId, attempt } : {}),
        ...(linkedStep ? { clientStepId } : {}),
      } satisfies DecisionRecordedEvent);
      if (!linkedTest || (clientStepId && !linkedStep))
        this.spool.event({
          id: `decision:${raw.id}:link-warning`,
          type: 'run.log',
          level: 'warn',
          message:
            'A raw decision was retained without missing test/step ownership after execution ended.',
        } satisfies RunLogEvent);
      this.captured.add(file);
      this.waitingRaw.delete(file);
    }
  }
  private async send(events: Event[]) {
    for (const batch of batches(this.manifest.envelope, events)) {
      let result: Record<string, unknown>;
      try {
        result = await this.client.ingest(this.manifest.envelope, batch);
      } catch (error) {
        if (this.quarantine(batch, error)) throw new EventQuarantined();
        throw error;
      }
      this.acknowledgeRun(result);
      for (const event of batch) this.spool.acknowledge(event);
    }
  }
  // A dashboard that names the one event it permanently rejects (400/409 with eventId) would otherwise block the whole
  // spool behind it forever. That event is set aside locally with the reason, a warning goes into the run logs and the
  // receipt becomes partial. run.started is never set aside: nothing else can be stored without it.
  private quarantine(batch: Event[], error: unknown): boolean {
    if (!(error instanceof DashboardHttpError) || !error.permanent) return false;
    const eventId = error.body?.eventId;
    const event = typeof eventId === 'string' && batch.find((item) => item.id === eventId);
    if (!event || event.type === 'run.started') return false;
    const message = sanitize(
      typeof error.body?.error === 'string' ? error.body.error : error.message,
    );
    // The warning is spooled before the acknowledgement, so a quarantined event always has one (the receipt counts them).
    if (!event.id.startsWith(QUARANTINE_LOG)) {
      const warning = `Dashboard rejected event ${event.id} (${error.status}): ${message}`;
      this.spool.event({
        id: `${QUARANTINE_LOG}${digest(event.id)}`,
        type: 'run.log',
        level: 'warn',
        message: warning,
      } satisfies RunLogEvent);
      console.warn(sanitize(warning));
    }
    this.spool.acknowledge(event, { quarantined: true, status: error.status, message });
    return true;
  }
  // Pending events to send now. Superseded progress snapshots are acknowledged locally and never uploaded.
  private uploadable() {
    const pending = this.spool.uploadable();
    const superseded = new Set(supersededProgress(pending));
    for (const event of superseded) this.spool.acknowledge(event, { superseded: true });
    return superseded.size ? pending.filter((event) => !superseded.has(event)) : pending;
  }
  private progress() {
    const snapshots: RunningTest[] = [];
    let done = 0,
      total = 0;
    for (const [phase, planned] of Object.entries(this.manifest.planned)) {
      const path = join(this.dir, 'phases', `${phase}.progress.json`);
      const snapshot = existsSync(path)
        ? (JSON.parse(readFileSync(path, 'utf8')) as {
            stepsDone: number;
            stepsTotal: number;
            running: RunningTest[];
          })
        : null;
      done += snapshot?.stepsDone ?? 0;
      total += Math.max(planned, snapshot?.stepsTotal ?? 0);
      snapshots.push(...(snapshot?.running ?? []));
    }
    const value = JSON.stringify({
      stepsDone: done,
      stepsTotal: Math.max(done, total),
      running: snapshots,
    });
    if (value !== this.lastProgress) {
      this.lastProgress = value;
      this.spool.event({
        id: `parent:progress:${++this.progressSequence}`,
        type: 'run.progress',
        seq: this.progressSequence,
        ...(JSON.parse(value) as Pick<RunProgressEvent, 'stepsDone' | 'stepsTotal' | 'running'>),
      } satisfies RunProgressEvent);
      this.state();
    }
  }
  async pump(): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      this.collectRaw(this.manifest.finished === true);
      if (!this.manifest.finished) {
        this.progress();
        if (Date.now() - this.lastHeartbeat > 15_000) {
          this.lastHeartbeat = Date.now();
          this.spool.event({
            id: `parent:heartbeat:${++this.progressSequence}`,
            type: 'run.heartbeat',
          } satisfies RunHeartbeatEvent);
          this.state();
        }
      }
      // Snapshot artifacts first: their dependency events were written before their staged descriptors.
      // New evidence arriving during awaited HTTP calls belongs to the next pump.
      const artifactJobs = this.spool.artifacts();
      const suitePath = join(this.dir, 'suite.json');
      let suitePending = existsSync(suitePath) && !existsSync(join(this.dir, 'ack', 'suite.json'));
      let permanentSuiteError = false;
      if (suitePending) {
        try {
          await this.client.publishSuite(
            JSON.parse(readFileSync(suitePath, 'utf8')) as SuitePayload,
          );
          atomicJson(join(this.dir, 'ack', 'suite.json'), {
            acknowledgedAt: new Date().toISOString(),
          });
          suitePending = false;
        } catch (error) {
          const message = sanitize(error instanceof Error ? error.message : String(error));
          permanentSuiteError =
            /Dashboard HTTP 4\d\d:/.test(message) && !/Dashboard HTTP (408|429):/.test(message);
          atomicJson(join(this.dir, 'suite-error.json'), {
            permanent: permanentSuiteError,
            message,
          });
          this.spool.event({
            id: `parent:suite-publish-warning:${digest(`${permanentSuiteError}:${message}`)}`,
            type: 'run.log',
            level: permanentSuiteError ? 'warn' : 'info',
            message: `Suite publication remains pending: ${message}`,
          } satisfies RunLogEvent);
        }
      }
      // Heartbeats of a registered run go in their own request, so an event the dashboard keeps rejecting cannot also hold
      // them back and get a live run cancelled as abandoned.
      const pending = this.uploadable();
      const heartbeats = this.runId
        ? pending.filter((event) => event.type === 'run.heartbeat')
        : [];
      await this.send(heartbeats);
      await this.send(pending.filter((event) => !heartbeats.includes(event)));
      if (this.runId)
        for (const job of artifactJobs) {
          await this.client.upload(this.dir, this.runId, job);
          this.spool.acknowledgeArtifact(job);
        }
      if (
        this.manifest.reportingProtocol &&
        this.manifest.finished &&
        !this.spool.events().length &&
        !this.spool.artifacts().length
      ) {
        if (suitePending && !permanentSuiteError) return false;
        const receiptPath = join(this.dir, 'reporting.json');
        if (!existsSync(receiptPath))
          throw new Error('Evidence completion receipt is missing; spool retained.');
        const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as ReportingReceipt;
        const all = this.spool.events(true);
        const rejected = all.filter((event) => event.id.startsWith(QUARANTINE_LOG)).length;
        const reasons = [
          ...(suitePending
            ? [
                'Suite publication was rejected; immutable suite capture is retained for replay. Inspect the run logs.',
              ]
            : []),
          ...(rejected
            ? [
                `The dashboard rejected ${rejected} event${rejected === 1 ? '' : 's'}; ${rejected === 1 ? 'it is' : 'they are'} quarantined in the spool. Inspect the run logs.`,
              ]
            : []),
        ];
        const desired = sanitize({
          ...receipt,
          ...(reasons.length ? { status: 'partial' as const, reason: reasons.join(' ') } : {}),
        });
        const priorReceipts = all
          .filter((event) => event.type === 'run.reporting')
          .sort((a, b) => Number(b.seq) - Number(a.seq));
        const previous = priorReceipts[0];
        const fields = (value: Record<string, unknown>) =>
          Object.fromEntries(
            ['status', 'expectedArtifacts', 'expectedDecisions', 'reason']
              .filter((key) => Object.hasOwn(value, key))
              .map((key) => [key, value[key]]),
          );
        // Each receipt is immutable. A repaired catalog advances its sequence rather than changing a staged event.
        if (!previous || canonicalJson(fields(previous)) !== canonicalJson(fields(desired))) {
          const seq = Math.max(1, Number(previous?.seq ?? 0)) + 1;
          this.spool.event({
            id: `parent:reporting:${seq}`,
            type: 'run.reporting',
            seq,
            ...desired,
          } satisfies RunReportingEvent);
        }
        await this.send(this.uploadable());
      }
      return !suitePending;
    } catch (error) {
      if (error instanceof EventQuarantined) return false;
      if (!this.warned) {
        this.warned = true;
        console.warn(
          `Dashboard upload pending; replay the saved spool. ${sanitize(error instanceof Error ? error.message : String(error))}`,
        );
      }
      return false;
    } finally {
      this.busy = false;
    }
  }
  async finish(status: 'failed' | 'cancelled' | undefined, durationMs: number): Promise<boolean> {
    while (this.busy) await new Promise((resolve) => setTimeout(resolve, 25));
    this.collectRaw(true);
    this.progress();
    const phaseFiles = Object.keys(this.manifest.planned).map((phase) =>
      join(this.dir, 'phases', `${phase}.finished.json`),
    );
    if (
      !status &&
      phaseFiles.some(
        (path) =>
          !existsSync(path) ||
          (JSON.parse(readFileSync(path, 'utf8')) as { captureIncomplete?: boolean })
            .captureIncomplete,
      )
    ) {
      this.spool.event({
        id: 'parent:capture-incomplete',
        type: 'run.log',
        level: 'error',
        message:
          'Reporting capture is incomplete; the test process outcome is unchanged and the dashboard run is not finalized as passed.',
      } satisfies RunLogEvent);
      await this.pump();
      return false;
    }
    this.manifest.finished = true;
    atomicJson(join(this.dir, 'manifest.json'), this.manifest);
    const summaries = phaseFiles
      .filter(existsSync)
      .map((path) => JSON.parse(readFileSync(path, 'utf8')) as { stats?: RunStats });
    const all = summaries
      .map((summary) => summary.stats)
      .filter((stats): stats is RunStats => !!stats);
    const stats: RunStats = {};
    if (all.length && all.length === phaseFiles.length) {
      for (const field of ['modelCalls', 'inputTokens'])
        if (all.every((summary) => typeof summary[field] === 'number'))
          stats[field] = all.reduce((sum, summary) => sum + Number(summary[field]), 0);
      if (all.every((summary) => typeof summary.costUsd === 'number'))
        stats.costUsd = all.reduce((sum, summary) => sum + Number(summary.costUsd), 0);
      if (
        all.every(
          (summary) =>
            typeof summary.modelCalls === 'number' &&
            (summary.modelCalls === 0 || typeof summary.avgLatencyMs === 'number'),
        )
      ) {
        const calls = all.reduce((sum, summary) => sum + Number(summary.modelCalls), 0);
        if (calls)
          stats.avgLatencyMs =
            all.reduce(
              (sum, summary) =>
                sum + Number(summary.modelCalls) * Number(summary.avgLatencyMs ?? 0),
              0,
            ) / calls;
      }
    }
    const raw = this.spool.events(true).filter((event) => event.type === 'decision.recorded');
    if (raw.some((event) => (event.record as Record<string, unknown>).error)) {
      stats.modelCalls = raw.length;
      stats.inputTokens = raw.reduce((sum, event) => {
        const answer = (event.record as Record<string, unknown>).answer as
          Record<string, unknown> | undefined;
        return sum + (typeof answer?.inputTokens === 'number' ? answer.inputTokens : 0);
      }, 0);
      stats.costUsd = null;
    }
    if (this.manifest.reportingProtocol) {
      const events = this.spool.events(true);
      const stepCalls = events
        .filter((event) => event.type === 'step.recorded')
        .reduce((sum, event) => sum + (Array.isArray(event.calls) ? event.calls.length : 0), 0);
      const normalizedCalls = Math.max(
        stepCalls,
        all.reduce(
          (sum, summary) => sum + (typeof summary.modelCalls === 'number' ? summary.modelCalls : 0),
          0,
        ),
      );
      const captureWarnings = events.some(
        (event) =>
          event.type === 'run.log' &&
          !event.id.startsWith('parent:suite-publish-warning') &&
          (event.level === 'warn' || event.level === 'error'),
      );
      const truncatedRaw = [...this.tails.values()].some((tail) => tail.partial.trim().length > 0);
      const incomplete =
        captureWarnings ||
        truncatedRaw ||
        raw.length < normalizedCalls ||
        phaseFiles.some((path) => !existsSync(path));
      const receipt: ReportingReceipt = {
        status: incomplete ? 'partial' : 'complete',
        expectedArtifacts: readdirSync(join(this.dir, 'artifacts')).filter((name) =>
          name.endsWith('.json'),
        ).length,
        expectedDecisions: Math.max(raw.length, normalizedCalls),
        ...(incomplete
          ? {
              reason: truncatedRaw
                ? 'An incomplete decision-log row remains at end of execution.'
                : raw.length < normalizedCalls
                  ? 'Some normalized model calls have no captured original request/response.'
                  : 'Capture warnings or an incomplete producer phase were recorded; inspect the run logs.',
            }
          : {}),
      };
      atomicJson(join(this.dir, 'reporting.json'), receipt);
    }
    this.spool.event({
      id: 'parent:finished',
      type: 'run.finished',
      ...(status ? { status } : {}),
      durationMs,
      ...(Object.keys(stats).length ? { stats } : {}),
    } satisfies RunFinishedEvent);
    return this.pump();
  }
}
export function loadSession(dir: string, url?: string): DashboardSession {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
  if (manifest.version !== 1) throw new Error('Unsupported dashboard spool version');
  if (url) manifest.url = url;
  return new DashboardSession(dir, manifest);
}
