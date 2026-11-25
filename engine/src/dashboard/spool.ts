import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { captureRecord, sanitize } from './sanitize.ts';
import type { IngestEnvelope } from './events.ts';

// The spool stores events generically; the protocol's typed events are in events.ts.
export type Event = Record<string, unknown> & { id: string; type: string; ts?: string };
export type Envelope = Omit<IngestEnvelope, 'events'>;
export type Manifest = {
  version: 1;
  url: string;
  envelope: Envelope;
  createdAt: string;
  reports: Record<string, string>;
  planned: Record<string, number>;
  decisionOffsets?: Record<string, number>;
  finished?: boolean;
  reportingProtocol?: 1;
};
export type ArtifactJob = {
  clientArtifactId: string;
  clientTestId?: string;
  attempt?: number;
  clientStepId?: string;
  kind: string;
  filename: string;
  contentType: string;
  path: string;
};
export const digest = (text: string) => createHash('sha256').update(text).digest('hex');

/** The dashboard rejects event ids and `run.log` messages longer than this many characters. */
export const MAX_EVENT_TEXT = 1024;
/**
 * An id within the server's limit. Short ids pass unchanged; a longer one keeps its readable prefix and ends with the
 * SHA-256 of the whole id, so it stays unique and is the same every time the same event is written.
 */
export function boundedEventId(id: string): string {
  if (id.length <= MAX_EVENT_TEXT) return id;
  const suffix = `~${digest(id)}`;
  let prefix = id.slice(0, MAX_EVENT_TEXT - suffix.length);
  // Never end on half of a surrogate pair.
  if (/[\ud800-\udbff]$/.test(prefix)) prefix = prefix.slice(0, -1);
  return prefix + suffix;
}
/** A message within the server's limit; the closing marker counts what was cut. */
export function boundedLogMessage(message: string): string {
  if (message.length <= MAX_EVENT_TEXT) return message;
  // Room for the marker with any realistic count ("… [truncated 1234567890 characters]" is 36 characters).
  let head = message.slice(0, MAX_EVENT_TEXT - 40);
  // Never end on half of a surrogate pair.
  if (/[\ud800-\udbff]$/.test(head)) head = head.slice(0, -1);
  return `${head}… [truncated ${message.length - head.length} characters]`;
}

const priority: Record<string, number> = {
  'run.started': 0,
  'run.settings': 1,
  'test.registered': 1.5,
  'test.started': 2,
  'step.recorded': 3,
  'decision.recorded': 4,
  'test.progress': 5,
  'test.finished': 6,
  'run.progress': 7,
  'run.heartbeat': 8,
  'run.log': 8,
  'run.finished': 10,
  'run.reporting': 11,
};

// Progress events are complete snapshots and the dashboard keeps only one whose seq is greater than the stored one, so
// among pending events only the highest seq per test attempt (test.progress) and for the run (run.progress) matters.
export function supersededProgress(events: Event[]): Event[] {
  const latest = new Map<string, Event>();
  const superseded: Event[] = [];
  for (const event of events) {
    if (event.type !== 'test.progress' && event.type !== 'run.progress') continue;
    const key =
      event.type === 'run.progress'
        ? 'run'
        : `test:${JSON.stringify([event.clientTestId, event.attempt ?? 1])}`;
    const kept = latest.get(key);
    if (!kept) latest.set(key, event);
    else if (Number(event.seq) > Number(kept.seq)) {
      superseded.push(kept);
      latest.set(key, event);
    } else superseded.push(event);
  }
  return superseded;
}

export function atomicJson(path: string, value: unknown): void {
  atomicText(path, JSON.stringify(value));
}
function atomicText(path: string, text: string): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, path);
}
const byUploadOrder = (a: Event, b: Event) =>
  (priority[a.type] ?? 9) - (priority[b.type] ?? 9) ||
  String(a.ts).localeCompare(String(b.ts)) ||
  a.id.localeCompare(b.id);

const SLIM_FIELDS = [
  'id',
  'type',
  'ts',
  'seq',
  'clientTestId',
  'attempt',
  'clientStepId',
  'clientDecisionId',
  'level',
  'status',
] as const;
/**
 * What the parent still reads from an acknowledged event, so a long run does not keep every uploaded payload (decision
 * records carry whole page texts) in memory. Readers of `events(true)`: session.ts collectRaw (test/step ownership),
 * the prior run.reporting receipts (their receipt fields), finish() (decision errors and input tokens, step call
 * counts, run.log levels) and the quarantine count (ids); replay's banner (run.started displayName).
 */
export function slimEvent(event: Event): Event {
  const slim: Record<string, unknown> = {};
  for (const key of SLIM_FIELDS) if (Object.hasOwn(event, key)) slim[key] = event[key];
  const keep = (...keys: string[]) => {
    for (const key of keys) if (Object.hasOwn(event, key)) slim[key] = event[key];
  };
  if (event.type === 'run.started') keep('displayName');
  if (event.type === 'run.reporting') keep('expectedArtifacts', 'expectedDecisions', 'reason');
  // finish() counts a step's model calls; their content is not needed.
  if (event.type === 'step.recorded' && Array.isArray(event.calls))
    slim.calls = event.calls.map(() => null);
  if (event.type === 'decision.recorded' && event.record && typeof event.record === 'object') {
    const record = event.record as Record<string, unknown>;
    const answer = record.answer as Record<string, unknown> | undefined;
    slim.record = {
      ...(record.error
        ? {
            error:
              typeof record.error === 'string'
                ? record.error
                : typeof (record.error as { message?: unknown }).message === 'string'
                  ? (record.error as { message: string }).message
                  : true,
          }
        : {}),
      ...(typeof answer?.inputTokens === 'number'
        ? { answer: { inputTokens: answer.inputTokens } }
        : {}),
    };
  }
  return slim as Event;
}

// Event and artifact files are immutable once renamed into place, and only this process acknowledges them while it
// runs. The spool therefore keeps an in-memory index: every file is read and parsed at most once per process (the
// parent pumps every second for the whole run), the acknowledged set is loaded from disk once and then maintained
// here, and only the directory listings are repeated to find files the reporter processes added. Full events are
// kept only while pending; an acknowledged one is reduced to slimEvent, and staged artifact metadata is dropped once
// uploaded (artifact bytes and raw decision files are never cached). A new Spool on the same directory (replay) starts
// cold from disk.
export class Spool {
  dir: string;
  private parsedEvents = new Map<string, Event>();
  private parsedArtifacts = new Map<string, ArtifactJob>();
  private acknowledged: Set<string> | null = null;
  constructor(dir: string) {
    this.dir = dir;
    for (const sub of ['events', 'artifacts', 'bytes', 'ack', 'phases', 'raw'])
      mkdirSync(join(dir, sub), { recursive: true, mode: 0o700 });
  }
  /** Reads one spool file; the only file read of the index (a seam for tests). */
  protected read(path: string): string {
    return readFileSync(path, 'utf8');
  }
  private acks(): Set<string> {
    this.acknowledged ??= new Set(readdirSync(join(this.dir, 'ack')));
    return this.acknowledged;
  }
  event(input: Event): void {
    const event: Event = { ...input, id: boundedEventId(input.id) };
    const name = `${digest(event.id)}.json`,
      path = join(this.dir, 'events', name);
    if (!this.parsedEvents.has(name) && !existsSync(path)) {
      const original: Event = { ...event, ts: event.ts ?? new Date().toISOString() };
      const captured = sanitize(original);
      if (original.type === 'run.log' && typeof captured.message === 'string')
        captured.message = boundedLogMessage(captured.message);
      for (const key of [
        'id',
        'type',
        'ts',
        'clientTestId',
        'explicitId',
        'phase',
        'workerIndex',
        'currentStepState',
        'file',
        'line',
        'sourceFile',
        'sourceLine',
        'clientStepId',
        'clientDecisionId',
        'attempt',
        'seq',
        'status',
        'kind',
        'level',
        'number',
        'label',
      ]) {
        if (Object.hasOwn(original, key)) captured[key] = original[key];
      }
      if (Array.isArray(original.running) && Array.isArray(captured.running)) {
        original.running.forEach((item, index) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) return;
          const source = item as Record<string, unknown>,
            target = (captured.running as Record<string, unknown>[])[index];
          for (const key of ['clientTestId', 'attempt', 'phase', 'workerIndex', 'currentStepState'])
            if (Object.hasOwn(source, key)) target[key] = source[key];
        });
      }
      if (
        original.template &&
        typeof original.template === 'object' &&
        !Array.isArray(original.template) &&
        captured.template &&
        typeof captured.template === 'object'
      ) {
        (captured.template as Record<string, unknown>).clientTestId = (
          original.template as Record<string, unknown>
        ).clientTestId;
      }
      if (
        original.failure &&
        typeof original.failure === 'object' &&
        !Array.isArray(original.failure)
      ) {
        const failure = original.failure as Record<string, unknown>;
        const diagnosed = captured.failure as Record<string, unknown>;
        for (const key of ['kind', 'origin'])
          if (Object.hasOwn(failure, key)) diagnosed[key] = failure[key];
      }
      if (
        original.settings &&
        typeof original.settings === 'object' &&
        !Array.isArray(original.settings)
      ) {
        const settings = original.settings as Record<string, unknown>;
        const target = captured.settings as Record<string, unknown>;
        for (const key of ['suiteHash', 'suiteRevision', 'activePhase'])
          if (Object.hasOwn(settings, key)) target[key] = settings[key];
      }
      if (event.record && typeof event.record === 'object' && !Array.isArray(event.record))
        captured.record = captureRecord(event.record as Record<string, unknown>);
      const text = JSON.stringify(captured);
      atomicText(path, text);
      this.parsedEvents.set(name, JSON.parse(text) as Event);
    }
  }
  artifact(job: Omit<ArtifactJob, 'path'>, source: string | Buffer): void {
    const key = digest(job.clientArtifactId),
      path = join(this.dir, 'artifacts', `${key}.json`);
    if (existsSync(path)) return;
    const bytesPath = join(this.dir, 'bytes', key);
    if (typeof source === 'string') {
      if (statSync(source).size > 100 * 1024 * 1024) throw new Error('Artifact exceeds 100 MiB');
      copyFileSync(source, bytesPath);
    } else {
      if (source.length > 100 * 1024 * 1024) throw new Error('Artifact exceeds 100 MiB');
      writeFileSync(bytesPath, source, { mode: 0o600 });
    }
    // Only display metadata is redacted: ids, MIME, ownership and generated byte paths are transport data.
    atomicJson(path, { ...job, filename: sanitize(basename(job.filename)), path: `bytes/${key}` });
  }
  names(): string[] {
    return readdirSync(join(this.dir, 'events'));
  }
  private indexed(names: string[], includeAcknowledged: boolean): [string, Event][] {
    const acks = this.acks(),
      out: [string, Event][] = [];
    for (const name of names) {
      if (!name.endsWith('.json') || (!includeAcknowledged && acks.has(name))) continue;
      let event = this.parsedEvents.get(name);
      if (!event) {
        event = JSON.parse(this.read(join(this.dir, 'events', name))) as Event;
        if (acks.has(name)) event = slimEvent(event);
        this.parsedEvents.set(name, event);
      }
      out.push([name, event]);
    }
    return out.sort((a, b) => byUploadOrder(a[1], b[1]));
  }
  events(includeAcknowledged = false): Event[] {
    return this.indexed(this.names(), includeAcknowledged).map(([, event]) => event);
  }
  // The pending events that are safe to upload while the reporter is still writing. A directory read is not a snapshot:
  // it can miss a file added while it runs yet return one added just after. The reporter writes a test's last steps and
  // progress just before its finish, so one read could see the finish without them; the dashboard then rejects them as
  // changes to a finished test (409) and the upload stalls on them (seen in a real run). A finish is therefore uploaded only
  // once an earlier read has seen it: everything written before it already existed when the later read started.
  uploadable(): Event[] {
    const earlier = new Set(this.names());
    return this.indexed(this.names(), false)
      .filter(([name, event]) => event.type !== 'test.finished' || earlier.has(name))
      .map(([, event]) => event);
  }
  artifacts(): ArtifactJob[] {
    const acks = this.acks(),
      out: ArtifactJob[] = [];
    for (const name of readdirSync(join(this.dir, 'artifacts'))) {
      if (!name.endsWith('.json') || acks.has(`artifact-${name}`)) continue;
      let job = this.parsedArtifacts.get(name);
      if (!job) {
        job = JSON.parse(this.read(join(this.dir, 'artifacts', name))) as ArtifactJob;
        this.parsedArtifacts.set(name, job);
      }
      out.push(job);
    }
    return out;
  }
  /** Marks an event as done; `details` records why when it was not accepted by the dashboard. */
  acknowledge(event: Event, details: Record<string, unknown> = {}) {
    const name = `${digest(event.id)}.json`;
    atomicJson(join(this.dir, 'ack', name), {
      acknowledgedAt: new Date().toISOString(),
      ...details,
    });
    this.acks().add(name);
    const cached = this.parsedEvents.get(name);
    if (cached) this.parsedEvents.set(name, slimEvent(cached));
  }
  acknowledgeArtifact(job: ArtifactJob) {
    const key = `${digest(job.clientArtifactId)}.json`;
    atomicJson(join(this.dir, 'ack', `artifact-${key}`), {
      acknowledgedAt: new Date().toISOString(),
    });
    this.acks().add(`artifact-${key}`);
    this.parsedArtifacts.delete(key);
  }
}
