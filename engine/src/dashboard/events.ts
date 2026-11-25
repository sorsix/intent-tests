// The reporting protocol between the engine and the dashboard: the envelope of `POST /api/ingest/events` and every
// event type the engine sends. This file is the contract. `dashboard/docs/contract/ingest-events.schema.json` is
// generated from it (`npm run contract:ingest`), and the backend validates its own accepted payloads against that
// schema (`IngestContractTest`). The rules follow what the dashboard enforces in
// `dashboard/backend/.../reporting/Ingest*.kt`; where the server is stricter than the engine's output, the server wins.
//
// Keep this file free of imports (the schema generator reads it on its own) and change it only together with both
// sides; see dashboard/docs/REPORTING-PROTOCOL.md. The schema allows additional properties, because the server stores
// what it does not interpret. Rules that need several fields at once (done <= total, a step needs its test,
// template with parameters) stay server-only and are noted where they apply.

/** A non-blank string of at most 1024 characters, the server's `required` rule for identities and names. @pattern \S @minLength 1 @maxLength 1024 */
export type RequiredString = string;
/** An integer, zero or more. @asType integer @minimum 0 */
export type Count = number;
/** A number, zero or more. @minimum 0 */
export type Amount = number;
/** A probability between 0 and 1. @minimum 0 @maximum 1 */
export type Probability = number;
/** ISO-8601 instant with a time zone; the server clock is used when it is missing. @format date-time */
export type Timestamp = string;

export type FailureKind =
  | 'setup'
  | 'seed'
  | 'model-transport'
  | 'target-not-found'
  | 'low-confidence'
  | 'assertion'
  | 'browser'
  | 'unknown';
/** Why a test or step failed, as diagnosed by the runner. */
export type IngestFailure = {
  kind: FailureKind;
  summary: RequiredString;
  origin: 'runner' | 'inferred';
  detail?: string | null;
};

export type TestOutcome =
  'passed' | 'failed' | 'expected-fail' | 'unexpected-pass' | 'skipped' | 'flaky' | 'cancelled';
/** `running` while a step executes, `between-steps` while none does. */
export type CurrentStepState = 'running' | 'between-steps';

/** Model usage and timing totals. A null total is accepted and means unknown. */
export type RunStats = {
  durationMs?: Amount | null;
  modelMs?: Amount | null;
  latencyMs?: Amount | null;
  inputTokens?: Count | null;
  modelCalls?: Count | null;
  avgLatencyMs?: Amount | null;
  costUsd?: Amount | null;
  avgConfidence?: Probability | null;
  [key: string]: unknown;
};

/** The release of the reporting engine, recorded once at registration. */
export type EngineReport = {
  /** A release version such as 0.18.0. @pattern ^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$ */
  version: string;
  allowOutdated?: boolean;
};
export type DeciderSettings = {
  name?: string;
  model?: string;
  host?: string;
  [key: string]: unknown;
};
export type Thresholds = { choice?: number; yesNo?: number; [key: string]: unknown };
export type RunSettingsMap = {
  /** Model price; the rate is zero or more and an explicit zero means a free model. */
  pricing?: { usdPerMInput?: Amount | null; [key: string]: unknown } | null;
  [key: string]: unknown;
};

/** One planned step of a test; the server only requires an object. */
export type PlannedStep = {
  number?: number | string;
  label?: string;
  text?: string;
  kind?: string;
  file?: string;
  line?: number;
  [key: string]: unknown;
};
/** The template a parameterized case was expanded from; always sent together with `parameters`. */
export type TestTemplate = { clientTestId: RequiredString; name: RequiredString };
/** The row of a parameter set; the case identity is `<template identity>[<key>]`. */
export type TestParameters = {
  set: RequiredString;
  /** At most 120 characters, without `]`. @pattern ^[^\]]{1,120}$ */
  key: string;
  /** At most 100 values. */
  values: Record<string, string>;
};
/** A test running now, as listed in `run.progress`. */
export type RunningTest = {
  clientTestId?: string;
  attempt?: number;
  title?: string;
  phase?: string;
  workerIndex?: Count;
  stepsDone?: Count;
  stepsTotal?: Count;
  currentStep?: string | null;
  currentStepState?: CurrentStepState | null;
  [key: string]: unknown;
};
/** An option offered to the model for a step, with its probability. */
export type RankedOption = {
  id?: string;
  p?: number;
  description?: string;
  [key: string]: unknown;
};
/** The element a step acted on. */
export type ChosenElement = {
  id?: string;
  description?: string;
  /** A number; older reporters sent text, which the server keeps and ignores. */
  confidence?: unknown;
  [key: string]: unknown;
};
/** A failure message: text, or an object with the original `message` and `stack` (the server keeps either). */
export type ErrorValue = string | { message?: string; stack?: string; [key: string]: unknown };
/** A model call of a step, normalized (the original request is in `decision.recorded`). */
export type ModelCall = {
  /** The model that answered; the server also accepts an empty or null model. */
  model?: string | null;
  [key: string]: unknown;
};
/** The original answer of a model call. */
export type DecisionAnswer = {
  type?: 'choice' | 'yesno';
  model?: string;
  latencyMs?: Amount | null;
  inputTokens?: Count | null;
  costUsd?: Amount | null;
  choice?: string;
  confidence?: Probability | null;
  reportedConfidence?: number;
  probabilities?: Record<string, number>;
  yes?: Probability | null;
  [key: string]: unknown;
};
/** Where a model call was made. */
export type DecisionContext = {
  test?: string;
  file?: string;
  line?: number;
  step?: number;
  stepText?: string;
  /** Which look at the page of the step this was. */
  look?: Count;
  clientTestId?: string;
  attempt?: number;
  clientStepId?: string;
  pass?: string;
  [key: string]: unknown;
};
/** One original JSONL row of the decision log. The server keeps unknown fields and never rewrites the row. */
export type DecisionRecord = {
  clientDecisionId?: string;
  ts?: Timestamp;
  ctx?: DecisionContext | null;
  decider?: string;
  model?: string;
  /** Also taken from `answer.type` when missing. */
  type?: 'choice' | 'yesno';
  request?: Record<string, unknown> | null;
  /** Absent for a failed transport call, which carries `error` instead. */
  answer?: DecisionAnswer | null;
  failure?: IngestFailure;
  error?: unknown;
  [key: string]: unknown;
};

/** Fields every event carries. `id` is stable: a resend of the same event has the same id and the same JSON. */
export type EventBase = {
  id: RequiredString;
  ts?: Timestamp;
};

/** Registers the run; the first batch of a run must contain it. A repeated start does not reset state. */
export type RunStartedEvent = EventBase & {
  type: 'run.started';
  displayName?: string;
  branch?: string;
  commitSha?: string;
  environment?: string;
  triggeredBy?: string;
  ciJobUrl?: string | null;
  /**
   * What the run is for. When absent the server decides: a run by an automation token verifies, every other
   * reporter authors. A declared purpose overrides that.
   */
  purpose?: 'verification' | 'authoring';
  /** The Launcher installation the run was started from; stored only for Launcher desktop sessions. @format uuid */
  launcherInstallationId?: string;
  /** The Intent Launcher environment version under test (a UUID); the server captures its description itself. */
  environmentBuildId?: string | null;
  engine?: EngineReport;
  decider?: DeciderSettings | null;
  thresholds?: Thresholds | null;
  settings?: RunSettingsMap | null;
  stats?: RunStats | null;
};

/** Shallow-merges objects into the run; never include credentials. */
export type RunSettingsEvent = EventBase & {
  type: 'run.settings';
  decider?: DeciderSettings;
  thresholds?: Thresholds;
  settings?: RunSettingsMap;
};

/** Identity of a test attempt, shared by every event that belongs to one. */
export type AttemptReference = {
  clientTestId: RequiredString;
  /** Starts at 1 and counts Playwright retries. @asType integer @minimum 1 */
  attempt?: number;
};

type TestPlanFields = {
  explicitId?: string;
  title: RequiredString;
  file: RequiredString;
  line?: number;
  kind?: 'test' | 'session';
  session?: string;
  tags?: string[] | null;
  seed?: string;
  template?: TestTemplate;
  parameters?: TestParameters;
  ord?: Count;
  stepsTotal?: Count;
  plan?: PlannedStep[] | null;
  phase?: string;
  workerIndex?: Count;
};

/** Reserves a pending attempt before any worker starts; always attempt 1. */
export type TestRegisteredEvent = EventBase &
  Omit<AttemptReference, 'attempt'> &
  TestPlanFields & {
    type: 'test.registered';
    attempt?: 1;
  };

/** Starts a registered attempt or creates it. A finished attempt never restarts. */
export type TestStartedEvent = EventBase &
  AttemptReference &
  TestPlanFields & { type: 'test.started' };

/** A complete progress snapshot; only a `seq` greater than the stored one is applied. */
export type TestProgressEvent = EventBase &
  AttemptReference & {
    type: 'test.progress';
    seq: Count;
    /** Zero or more, and not above `stepsTotal`. */
    stepsDone: Count;
    stepsTotal: Count;
    title?: string;
    currentStep?: string | null;
    currentStepState?: CurrentStepState | null;
    phase?: string;
    workerIndex?: Count;
  };

/** One executed step, recorded once under its stable `clientStepId`. */
export type StepRecordedEvent = EventBase &
  AttemptReference & {
    type: 'step.recorded';
    clientStepId: RequiredString;
    /** The step label as text, such as "3" or "3.2". */
    number?: string;
    label?: string;
    ord?: Count;
    text: RequiredString;
    kind: RequiredString;
    status: 'passed' | 'failed' | 'skipped';
    durationMs?: Amount;
    modelMs?: Amount;
    inputTokens?: Count;
    chosen?: ChosenElement | null;
    top?: RankedOption[] | null;
    narrowed?: string;
    screenshotFallback?: boolean;
    outcome?: string;
    condition?: string;
    error?: ErrorValue | null;
    failure?: IngestFailure | null;
    calls?: ModelCall[] | null;
    sourceFile?: string;
    sourceLine?: Count;
  };

/** An original model call, linked to its test and step. A step reference needs a test reference (server rule). */
export type DecisionRecordedEvent = EventBase & {
  type: 'decision.recorded';
  clientDecisionId: RequiredString;
  clientTestId?: string;
  attempt?: number;
  clientStepId?: string;
  record: DecisionRecord;
};

/** The terminal outcome of an attempt; a retry is a new attempt. */
export type TestFinishedEvent = EventBase &
  AttemptReference & {
    type: 'test.finished';
    status: TestOutcome;
    durationMs?: Amount;
    error?: ErrorValue | null;
    failure?: IngestFailure | null;
  };

/** The run's progress across phases; only a `seq` greater than the stored one is applied. */
export type RunProgressEvent = EventBase & {
  type: 'run.progress';
  seq: Count;
  /** Zero or more, and not above `stepsTotal`. */
  stepsDone: Count;
  stepsTotal: Count;
  etaSec?: Amount | null;
  running?: RunningTest[] | null;
  currentStep?: string | null;
  currentStepState?: CurrentStepState | null;
};

/** Keeps a run alive: runs without a heartbeat for five minutes are cancelled. */
export type RunHeartbeatEvent = EventBase & {
  type: 'run.heartbeat';
  workerId?: string;
};

/** A line of the run log. It is also accepted after the run finished. */
export type RunLogEvent = EventBase & {
  type: 'run.log';
  /** The server records `info` when it is missing. */
  level?: 'info' | 'warn' | 'error';
  message: RequiredString;
};

/** The execution outcome. The server derives the status when it is missing and rejects one that contradicts the tests. */
export type RunFinishedEvent = EventBase & {
  type: 'run.finished';
  status?: 'passed' | 'failed' | 'cancelled';
  durationMs?: Amount | null;
  stats?: RunStats | null;
};

/** The evidence receipt, separate from the execution outcome. Completion needs declared expectations. */
export type RunReportingEvent = EventBase & {
  type: 'run.reporting';
  seq: Count;
  status: 'uploading' | 'partial' | 'complete';
  expectedArtifacts?: Count;
  expectedDecisions?: Count;
  reason?: string | null;
};

/** Every event type of the protocol, told apart by `type`. */
export type IngestEvent =
  | RunStartedEvent
  | RunSettingsEvent
  | TestRegisteredEvent
  | TestStartedEvent
  | TestProgressEvent
  | StepRecordedEvent
  | DecisionRecordedEvent
  | TestFinishedEvent
  | RunProgressEvent
  | RunHeartbeatEvent
  | RunLogEvent
  | RunFinishedEvent
  | RunReportingEvent;

/** The reported product and application, registered on first use (an unknown product is rejected). */
export type IngestIdentity = {
  project: { key: RequiredString; name?: string };
  app: { key: RequiredString; name: RequiredString };
  /** Stable for one invocation and kept through retries. */
  clientRunId: RequiredString;
};

/** The body of `POST /api/ingest/events`: one to 500 events, at most 8 MiB. */
export type IngestEnvelope = IngestIdentity & {
  /** @minItems 1 @maxItems 500 */
  events: IngestEvent[];
};
