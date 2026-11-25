import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
  TestStep,
} from '@playwright/test/reporter';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { appDir } from '../app.ts';
import { config } from '../config.ts';
import { authHook } from '../app-config.ts';
import { credentialsOf } from '../login.ts';
import { deciderSettings } from '../decider/index.ts';
import { annotatedCase, parseAll } from '../parse.ts';
import type { ParameterBinding } from '../parse.ts';
import { atomicJson, Spool } from './spool.ts';
import { sanitize } from './sanitize.ts';
import type {
  CurrentStepState,
  IngestFailure,
  RunLogEvent,
  RunSettingsEvent,
  RunningTest,
  StepRecordedEvent,
  TestFinishedEvent,
  TestOutcome,
  TestProgressEvent,
  TestStartedEvent,
} from './events.ts';

type Plan = {
  number: number;
  label?: string;
  text: string;
  kind: string;
  file?: string;
  line?: number;
};
type Entry = {
  clientTestId: string;
  attempt: number;
  title: string;
  file: string;
  line?: number;
  kind: 'test' | 'session';
  phase: string;
  workerIndex?: number;
  explicitId?: string;
  plan: Plan[];
  session?: string;
  tags: string[];
  seed?: string;
  template?: { clientTestId: string; name: string };
  parameters?: ParameterBinding;
  ord: number;
};
const note = (test: TestCase, name: string) =>
  test.annotations.find((annotation) => annotation.type === name)?.description;
const attachment = <T = Record<string, unknown>>(result: TestResult, name: string): T | null => {
  const found = result.attachments.find((item) => item.name === name);
  if (!found) return null;
  return JSON.parse(found.body?.toString('utf8') ?? readFileSync(found.path!, 'utf8')) as T;
};
/** The step record the runner attaches (StepRecord in steps.ts) as the reporter receives it. */
type StepAttachment = Pick<StepRecordedEvent, 'text' | 'kind' | 'status'> &
  Partial<StepRecordedEvent> & {
    number: number;
    screenshot?: string;
    file?: string;
    line?: number;
  };
export function outcome(
  test: Pick<TestCase, 'expectedStatus' | 'outcome'>,
  result: Pick<TestResult, 'status'>,
): TestOutcome {
  if (result.status === 'skipped') return 'skipped';
  if (test.outcome() === 'flaky') return 'flaky';
  if (result.status === 'passed')
    return test.expectedStatus === 'failed'
      ? 'unexpected-pass'
      : test.outcome() === 'flaky'
        ? 'flaky'
        : 'passed';
  return result.status === 'failed' && test.expectedStatus === 'failed'
    ? 'expected-fail'
    : 'failed';
}
export default class DashboardReporter implements Reporter {
  private spool: Spool | null = null;
  private phase = process.env.AT_DASHBOARD_PHASE || 'direct';
  private outputDir: string;
  private entries = new Map<string, Entry>();
  private started = new Set<string>();
  private steps = new Set<string>();
  private finished = new Set<string>();
  private running = new Map<string, RunningTest>();
  private progressSequence = 0;
  private attemptSequences = new Map<string, number>();
  private activeSteps = new Map<string, TestStep[]>();
  private warned = false;
  private startedAt = new Date();
  constructor(options: { outputDir?: string } = {}) {
    this.outputDir = options.outputDir || '.';
    this.safe(() => {
      if (process.env.AT_DASHBOARD_SPOOL_DIR)
        this.spool = new Spool(process.env.AT_DASHBOARD_SPOOL_DIR);
    });
  }
  private safe(work: () => void) {
    try {
      work();
    } catch (error) {
      if (!this.warned) {
        this.warned = true;
        console.warn(
          `Dashboard capture pending: ${sanitize(error instanceof Error ? error.message : String(error))}`,
        );
      }
    }
  }
  private identity(
    test: TestCase,
    result: Pick<TestResult, 'retry'> & Partial<Pick<TestResult, 'workerIndex'>>,
  ): Entry {
    const known = this.entries.get(test.id);
    const kind = test.parent.project()?.name === 'sessions' ? 'session' : 'test';
    return {
      clientTestId: note(test, 'at-client-test-id') || `${this.phase}:${test.id}`,
      attempt: result.retry + 1,
      title: test.title,
      file: note(test, 'at-file') || (kind === 'session' ? 'Sessions' : 'unknown'),
      line: Number(note(test, 'at-line')) || known?.line,
      kind,
      phase: this.phase,
      ...(typeof result.workerIndex === 'number' && result.workerIndex >= 0
        ? { workerIndex: result.workerIndex }
        : {}),
      explicitId: note(test, 'at-explicit-id'),
      plan: known?.plan || [],
      session: note(test, 'at-session'),
      tags: test.tags,
      seed: known?.seed,
      ...(known?.template ? { template: known.template, parameters: known.parameters } : {}),
      ord: known?.ord || 0,
    };
  }
  onBegin(fullConfig: FullConfig, suite: Suite) {
    this.safe(() => {
      this.startedAt = new Date();
      // Playwright already listed the selected cases; parameter sets are not loaded here (onBegin is synchronous).
      const parsedSuite = parseAll(appDir());
      for (const [ord, test] of suite.allTests().entries()) {
        const parsed = annotatedCase(
          parsedSuite,
          note(test, 'at-client-test-id'),
          note(test, 'at-template-client-test-id'),
          note(test, 'at-parameters'),
        );
        const entry = this.identity(test, { retry: 0 });
        const block =
          entry.kind === 'session'
            ? parsedSuite.blocks.get(
                note(test, 'at-session') || test.title.replace(/^Session: /, ''),
              )
            : undefined;
        const plan = block
          ? authHook() && credentialsOf(block.steps)
            ? []
            : block.steps
          : parsed?.test.steps || [];
        entry.ord = ord;
        entry.plan = plan.map(({ number, label, text, kind, file, line }) => ({
          number,
          label,
          text,
          kind,
          file,
          line,
        }));
        entry.seed = parsed?.test.seed;
        if (parsed?.test.template) {
          entry.template = parsed.test.template;
          entry.parameters = parsed.test.parameters;
        }
        this.entries.set(test.id, entry);
      }
      const total = [...this.entries.values()].reduce((sum, entry) => sum + entry.plan.length, 0);
      const discovery = process.env.AT_DASHBOARD_DISCOVERY_DIR;
      if (discovery) {
        writeFileSync(
          join(discovery, `${this.phase}.json`),
          JSON.stringify({
            stepsTotal: total,
            tests: suite.allTests().filter((test) => test.parent.project()?.name !== 'sessions')
              .length,
            entries: [...this.entries.values()],
          }),
        );
        return;
      }
      if (!this.spool) return;
      const decider = deciderSettings();
      this.spool.event({
        id: `${this.phase}:settings`,
        type: 'run.settings',
        decider: { name: decider.name, model: decider.model, host: new URL(decider.url).host },
        thresholds: { choice: config.choiceThreshold, yesNo: config.yesNoThreshold },
        settings: {
          pricing: { usdPerMInput: decider.usdPerMInput },
          sendImages: config.sendImages,
          imageMode: config.imageMode,
          viewport: fullConfig.projects.find((project) => project.name !== 'sessions')?.use
            .viewport,
          timezone: fullConfig.projects.find((project) => project.name !== 'sessions')?.use
            .timezoneId,
          [`phase_${this.phase}`]: {
            workers: fullConfig.workers,
            testTimeoutMs: config.testTimeoutMs,
          },
          resolveTimeoutMs: config.resolveTimeoutMs,
          requiredResolveTimeoutMs: config.requiredResolveTimeoutMs,
          minLooks: config.minLooks,
          settleMs: config.settleMs,
        },
      } satisfies RunSettingsEvent);
      this.progress();
    });
  }
  private ensureStarted(test: TestCase, result: TestResult): Entry {
    const entry = this.identity(test, result),
      key = `${entry.clientTestId}:${entry.attempt}`;
    const plan = attachment(result, 'at-plan');
    if (plan && Array.isArray(plan.steps)) {
      entry.plan = plan.steps as Plan[];
      entry.line = Number(plan.line) || entry.line;
      entry.seed = typeof plan.seed === 'string' ? plan.seed : entry.seed;
      this.entries.set(test.id, entry);
    }
    if (!this.started.has(key)) {
      this.spool?.event({
        id: `${this.phase}:${key}:start`,
        type: 'test.started',
        ...entry,
        stepsTotal: entry.plan.length,
      } satisfies TestStartedEvent);
      this.started.add(key);
      this.running.set(key, {
        clientTestId: entry.clientTestId,
        attempt: entry.attempt,
        title: entry.title,
        phase: entry.phase,
        ...(entry.workerIndex !== undefined ? { workerIndex: entry.workerIndex } : {}),
        stepsDone: 0,
        stepsTotal: entry.plan.length,
        currentStep: null,
        currentStepState: 'between-steps',
      });
    }
    return entry;
  }
  private liveProgress(test: TestCase, result: TestResult) {
    const entry = this.ensureStarted(test, result),
      key = `${entry.clientTestId}:${entry.attempt}`;
    const done = [...this.steps].filter((step) => step.startsWith(`${key}:`)).length;
    const currentStep = this.activeSteps.get(key)?.at(-1)?.title ?? null;
    const currentStepState: CurrentStepState = currentStep === null ? 'between-steps' : 'running';
    const snapshot = {
      clientTestId: entry.clientTestId,
      attempt: entry.attempt,
      title: entry.title,
      phase: entry.phase,
      ...(entry.workerIndex !== undefined ? { workerIndex: entry.workerIndex } : {}),
      stepsDone: done,
      stepsTotal: Math.max(entry.plan.length, done),
      currentStep,
      currentStepState,
    };
    this.running.set(key, snapshot);
    const seq = (this.attemptSequences.get(key) ?? 0) + 1;
    this.attemptSequences.set(key, seq);
    this.spool?.event({
      id: `${this.phase}:${key}:progress:${String(seq).padStart(12, '0')}`,
      type: 'test.progress',
      seq,
      ...snapshot,
    } satisfies TestProgressEvent);
  }
  onTestBegin(test: TestCase, result: TestResult) {
    this.safe(() => {
      if (this.spool) {
        this.liveProgress(test, result);
        this.progress();
      }
    });
  }
  onStepBegin(test: TestCase, result: TestResult, step: TestStep) {
    this.safe(() => {
      if (!this.spool || step.category !== 'test.step') return;
      const entry = this.ensureStarted(test, result),
        key = `${entry.clientTestId}:${entry.attempt}`;
      const active = this.activeSteps.get(key) ?? [];
      active.push(step);
      this.activeSteps.set(key, active);
      this.liveProgress(test, result);
      this.progress();
    });
  }
  private recordSteps(test: TestCase, result: TestResult) {
    const entry = this.ensureStarted(test, result),
      key = `${entry.clientTestId}:${entry.attempt}`;
    for (const item of result.attachments.filter((item) => item.name.startsWith('at-step-'))) {
      const record = JSON.parse(
        item.body?.toString('utf8') ?? readFileSync(item.path!, 'utf8'),
      ) as StepAttachment;
      const clientStepId = String(record.number),
        stepKey = `${key}:${clientStepId}`;
      if (this.steps.has(stepKey)) continue;
      const { screenshot, file, line, ...fields } = record;
      this.spool?.event({
        ...fields,
        id: `${this.phase}:${stepKey}:step`,
        type: 'step.recorded',
        clientTestId: entry.clientTestId,
        attempt: entry.attempt,
        clientStepId,
        number: clientStepId,
        label: String(record.label ?? clientStepId),
        ord: Number(record.number) - 1,
        ...(file ? { sourceFile: file } : {}),
        ...(line ? { sourceLine: line } : {}),
      } satisfies StepRecordedEvent);
      if (typeof screenshot === 'string') {
        try {
          this.spool?.artifact(
            {
              clientArtifactId: `${this.phase}:${stepKey}:screenshot`,
              clientTestId: entry.clientTestId,
              attempt: entry.attempt,
              clientStepId,
              kind: 'screenshot',
              filename: `step-${clientStepId}.jpg`,
              contentType: 'image/jpeg',
            },
            Buffer.from(screenshot, 'base64'),
          );
        } catch (error) {
          this.spool?.event({
            id: `${this.phase}:${stepKey}:screenshot-warning`,
            type: 'run.log',
            level: 'warn',
            message: `Screenshot staging failed: ${String(error)}`,
          } satisfies RunLogEvent);
        }
      }
      this.steps.add(stepKey);
    }
  }
  onStepEnd(test: TestCase, result: TestResult, step: TestStep) {
    this.safe(() => {
      if (!this.spool || step.category !== 'test.step') return;
      const entry = this.ensureStarted(test, result),
        key = `${entry.clientTestId}:${entry.attempt}`;
      const active = this.activeSteps.get(key) ?? [],
        index = active.indexOf(step);
      if (index >= 0) active.splice(index, 1);
      this.activeSteps.set(key, active);
      this.recordSteps(test, result);
      this.liveProgress(test, result);
      this.progress();
    });
  }
  onTestEnd(test: TestCase, result: TestResult) {
    this.safe(() => {
      if (!this.spool) return;
      this.safe(() => this.recordSteps(test, result));
      const entry = this.identity(test, result),
        key = `${entry.clientTestId}:${entry.attempt}`;
      this.activeSteps.delete(key);
      this.liveProgress(test, result);
      if (result.status === 'interrupted')
        this.spool.event({
          id: `${this.phase}:${key}:interrupted`,
          type: 'run.log',
          level: 'warn',
          message: `${entry.title}: execution interrupted; attempt remains incomplete.`,
        } satisfies RunLogEvent);
      else
        this.spool.event({
          id: `${this.phase}:${key}:finish`,
          type: 'test.finished',
          clientTestId: entry.clientTestId,
          attempt: entry.attempt,
          status: outcome(test, result),
          durationMs: result.duration,
          failure: attachment<IngestFailure>(result, 'at-failure') || undefined,
          error:
            result.errors
              .map((error) => error.message || error.value || '')
              .filter(Boolean)
              .join('\n\n') || null,
        } satisfies TestFinishedEvent);
      if (result.attachments.some((item) => item.name === 'at-capture-warning'))
        this.spool.event({
          id: `${this.phase}:${key}:raw-warning`,
          type: 'run.log',
          level: 'warn',
          message: 'Some original decision records could not be captured.',
        } satisfies RunLogEvent);
      for (const [index, item] of result.attachments.entries()) {
        if (!item.path || !existsSync(item.path) || item.name.startsWith('at-')) continue;
        const kind = item.name.includes('trace')
          ? 'trace'
          : item.contentType.startsWith('video/')
            ? 'video'
            : item.contentType.startsWith('image/')
              ? 'screenshot'
              : 'other';
        try {
          this.spool.artifact(
            {
              clientArtifactId: `${this.phase}:${key}:attachment:${index}`,
              clientTestId: entry.clientTestId,
              attempt: entry.attempt,
              kind,
              filename: basename(item.path),
              contentType: item.contentType,
            },
            item.path,
          );
        } catch (error) {
          this.spool.event({
            id: `${this.phase}:${key}:attachment:${index}:warning`,
            type: 'run.log',
            level: 'warn',
            message: `Could not stage ${item.name}: ${String(error)}`,
          } satisfies RunLogEvent);
        }
      }
      this.finished.add(key);
      this.running.delete(key);
      this.progress();
    });
  }
  private progress() {
    if (!this.spool) return;
    const stepsTotal = Math.max(
      this.steps.size,
      [...this.entries.values()].reduce((sum, entry) => sum + entry.plan.length, 0),
    );
    atomicJson(join(this.spool.dir, 'phases', `${this.phase}.progress.json`), {
      stepsDone: this.steps.size,
      stepsTotal,
      running: [...this.running.values()],
      seq: ++this.progressSequence,
    });
  }
  onEnd(result: FullResult) {
    this.safe(() => {
      if (!this.spool) return;
      if (result.status !== 'interrupted')
        for (const entry of this.entries.values()) {
          const key = `${entry.clientTestId}:1`;
          if (this.started.has(key)) continue;
          this.spool.event({
            id: `${this.phase}:${key}:start`,
            type: 'test.started',
            ...entry,
            attempt: 1,
            stepsTotal: entry.plan.length,
          } satisfies TestStartedEvent);
          this.spool.event({
            id: `${this.phase}:${key}:finish`,
            type: 'test.finished',
            clientTestId: entry.clientTestId,
            attempt: 1,
            status: 'skipped',
            durationMs: 0,
            failure: entry.session
              ? {
                  kind: 'setup',
                  summary: 'The dependent session could not be set up',
                  origin: 'runner',
                }
              : undefined,
            error: `Not run: ${entry.session ? `session "${entry.session}" could not be set up` : 'execution could not reach this test'}.`,
          } satisfies TestFinishedEvent);
          this.started.add(key);
          this.finished.add(key);
        }
      this.progress();
      const source = join(this.outputDir, 'results.json');
      let stats: unknown;
      if (existsSync(source) && statSync(source).mtimeMs >= this.startedAt.getTime()) {
        const report = sanitize(
          JSON.parse(readFileSync(source, 'utf8')) as Record<string, unknown>,
        );
        stats = report.summary as Record<string, unknown> | undefined;
        try {
          this.spool.artifact(
            {
              clientArtifactId: `${this.phase}:results`,
              kind: 'report',
              filename: `${this.phase}-results.json`,
              contentType: 'application/json',
            },
            Buffer.from(JSON.stringify(report, null, 2)),
          );
        } catch (error) {
          this.spool.event({
            id: `${this.phase}:results-warning`,
            type: 'run.log',
            level: 'warn',
            message: `Results artifact staging failed: ${String(error)}`,
          } satisfies RunLogEvent);
        }
      }
      atomicJson(join(this.spool.dir, 'phases', `${this.phase}.finished.json`), {
        status: result.status,
        tests: this.finished.size,
        stats,
        captureIncomplete: this.warned,
      });
    });
  }
}
