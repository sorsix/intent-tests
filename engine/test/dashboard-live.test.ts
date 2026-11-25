import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { FullConfig, Suite, TestCase, TestResult, TestStep } from '@playwright/test/reporter';
import { Spool } from '../src/dashboard/spool.ts';

process.env.AT_APP_DIR = fileURLToPath(new URL('./fixture/', import.meta.url));
process.env.AT_DECIDER = 'stub';
process.loadEnvFile(join(process.env.AT_APP_DIR, '.env.dev'));
const { default: DashboardReporter } = await import('../src/dashboard/reporter.ts');

function directory(t: TestContext) {
  const path = mkdtempSync(join(tmpdir(), 'intent-live-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
function env(t: TestContext, values: Record<string, string | undefined>) {
  const original = { ...process.env };
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
  });
}
const configuration = {
  workers: 4,
  projects: [
    { name: 'parallel', use: { viewport: { width: 1280, height: 720 }, timezoneId: 'UTC' } },
  ],
} as unknown as FullConfig;
function session(phase: string): TestCase {
  return {
    id: `pw-${phase}`,
    title: 'Session: log in as reception',
    tags: ['@session'],
    expectedStatus: 'passed',
    outcome: () => 'expected',
    parent: { project: () => ({ name: 'sessions' }) },
    annotations: [
      { type: 'at-client-test-id', description: `session:${phase}:log in as reception` },
      { type: 'at-session', description: 'log in as reception' },
      { type: 'at-file', description: 'self-test/engine.md' },
    ],
  } as unknown as TestCase;
}
function suite(tests: TestCase[]): Suite {
  return { allTests: () => tests } as Suite;
}
function result(workerIndex = 3, retry = 0): TestResult {
  return {
    workerIndex,
    retry,
    attachments: [],
    status: 'passed',
    errors: [],
    duration: 10,
  } as unknown as TestResult;
}
function step(title: string, parent?: TestStep): TestStep {
  return { title, category: 'test.step', parent } as TestStep;
}

test('discovery preserves genuine sessions in both phases without inventing a worker assignment', (t) => {
  const dir = directory(t);
  mkdirSync(join(dir, 'discovery'));
  env(t, {
    AT_DASHBOARD_DISCOVERY_DIR: join(dir, 'discovery'),
    AT_DASHBOARD_SPOOL_DIR: undefined,
    AT_TESTS: 'self-test',
    AT_CASE_IDS: undefined,
  });
  const snapshots: {
    entries: { clientTestId: string; phase: string; workerIndex?: number; plan: unknown[] }[];
  }[] = [];
  for (const phase of ['parallel', 'exclusive']) {
    process.env.AT_DASHBOARD_PHASE = phase;
    new DashboardReporter().onBegin(configuration, suite([session(phase)]));
    snapshots.push(JSON.parse(readFileSync(join(dir, 'discovery', `${phase}.json`), 'utf8')));
  }
  assert.equal(snapshots[0].entries[0].clientTestId, 'session:parallel:log in as reception');
  assert.equal(snapshots[1].entries[0].clientTestId, 'session:exclusive:log in as reception');
  assert.deepEqual(
    snapshots.map((snapshot) => snapshot.entries[0].phase),
    ['parallel', 'exclusive'],
  );
  assert.ok(snapshots.every((snapshot) => snapshot.entries[0].workerIndex === undefined));
  assert.ok(snapshots.every((snapshot) => snapshot.entries[0].plan.length > 0));
});

test('true current steps, worker metadata and begin/end sequence stay monotonic, including nested steps and retries', (t) => {
  const dir = directory(t);
  env(t, {
    AT_DASHBOARD_SPOOL_DIR: dir,
    AT_DASHBOARD_DISCOVERY_DIR: undefined,
    AT_DASHBOARD_PHASE: 'parallel',
    AT_TESTS: 'self-test',
    AT_CASE_IDS: undefined,
  });
  const reporter = new DashboardReporter(),
    testcase = session('parallel'),
    attempt = result(3);
  reporter.onBegin(configuration, suite([testcase]));
  reporter.onTestBegin(testcase, attempt);
  const outer = step('1. click "Log in"'),
    inner = step('seed nested operation', outer);
  reporter.onStepBegin(testcase, attempt, outer);
  let snapshot = JSON.parse(readFileSync(join(dir, 'phases', 'parallel.progress.json'), 'utf8'));
  assert.equal(snapshot.running[0].currentStep, outer.title);
  assert.equal(snapshot.running[0].currentStepState, 'running');
  assert.equal(snapshot.running[0].stepsDone, 0);
  assert.equal(snapshot.running[0].phase, 'parallel');
  assert.equal(snapshot.running[0].workerIndex, 3);
  reporter.onStepBegin(testcase, attempt, inner);
  reporter.onStepEnd(testcase, attempt, inner);
  snapshot = JSON.parse(readFileSync(join(dir, 'phases', 'parallel.progress.json'), 'utf8'));
  assert.equal(
    snapshot.running[0].currentStep,
    outer.title,
    'Ending a nested operation resumes its actual parent',
  );
  attempt.attachments.push({
    name: 'at-step-1',
    contentType: 'application/json',
    body: Buffer.from(
      JSON.stringify({
        number: 1,
        label: '1',
        text: 'click "Log in"',
        kind: 'click',
        status: 'passed',
        calls: [],
        durationMs: 1,
      }),
    ),
  });
  reporter.onStepEnd(testcase, attempt, outer);
  snapshot = JSON.parse(readFileSync(join(dir, 'phases', 'parallel.progress.json'), 'utf8'));
  assert.equal(snapshot.running[0].currentStepState, 'between-steps');
  assert.equal(
    snapshot.running[0].currentStep,
    null,
    'A completed step is never presented as active',
  );
  assert.equal(snapshot.running[0].stepsDone, 1);
  const second = step('2. expect "Home"');
  reporter.onStepBegin(testcase, attempt, second);
  snapshot = JSON.parse(readFileSync(join(dir, 'phases', 'parallel.progress.json'), 'utf8'));
  assert.equal(snapshot.running[0].currentStep, second.title);
  assert.equal(snapshot.running[0].stepsDone, 1);
  reporter.onStepEnd(testcase, attempt, second);
  reporter.onTestEnd(testcase, attempt);
  const retry = result(7, 1);
  reporter.onTestBegin(testcase, retry);
  reporter.onStepBegin(testcase, retry, step('1. retry login'));
  const events = new Spool(dir).events(true),
    progress = events.filter((event) => event.type === 'test.progress' && event.attempt === 1);
  assert.deepEqual(
    progress.map((event) => event.seq),
    progress.map((_, index) => index + 1),
  );
  assert.ok(progress.every((event) => event.workerIndex === 3 && event.phase === 'parallel'));
  assert.equal(
    events.find((event) => event.type === 'test.started' && event.attempt === 1)?.workerIndex,
    3,
  );
  assert.equal(
    events.find((event) => event.type === 'test.started' && event.attempt === 2)?.workerIndex,
    7,
  );
  assert.equal(
    events.find((event) => event.type === 'test.progress' && event.attempt === 2)?.seq,
    1,
  );
  const settings = events.find((event) => event.type === 'run.settings')?.settings as Record<
    string,
    unknown
  >;
  assert.deepEqual(
    settings.pricing,
    { usdPerMInput: 0 },
    'Free model price is known zero, not missing',
  );
  assert.equal(events.find((event) => event.type === 'test.finished')?.status, 'passed');
});

test('non-test-step browser callbacks do not invent a current intent step', (t) => {
  const dir = directory(t);
  env(t, {
    AT_DASHBOARD_SPOOL_DIR: dir,
    AT_DASHBOARD_DISCOVERY_DIR: undefined,
    AT_DASHBOARD_PHASE: 'exclusive',
    AT_TESTS: 'self-test',
    AT_CASE_IDS: undefined,
  });
  const reporter = new DashboardReporter(),
    testcase = session('exclusive'),
    attempt = result(0);
  reporter.onBegin(configuration, suite([testcase]));
  reporter.onTestBegin(testcase, attempt);
  reporter.onStepBegin(testcase, attempt, {
    title: 'locator.click',
    category: 'pw:api',
  } as TestStep);
  const progress = new Spool(dir).events().filter((event) => event.type === 'test.progress');
  assert.equal(progress.length, 1);
  assert.equal(progress[0].currentStep, null);
  assert.equal(progress[0].currentStepState, 'between-steps');
  assert.equal(progress[0].workerIndex, 0);
});

test('explicit positive model pricing remains available for live cost without dropping free zero pricing', (t) => {
  const dir = directory(t);
  env(t, {
    AT_DASHBOARD_SPOOL_DIR: dir,
    AT_DASHBOARD_DISCOVERY_DIR: undefined,
    AT_DASHBOARD_PHASE: 'parallel',
    AT_TESTS: 'self-test',
    AT_CASE_IDS: undefined,
    AT_DECIDER_USD_PER_M_INPUT: '1.25',
  });
  new DashboardReporter().onBegin(configuration, suite([session('parallel')]));
  const settings = new Spool(dir).events().find((event) => event.type === 'run.settings')
    ?.settings as Record<string, unknown>;
  assert.deepEqual(settings.pricing, { usdPerMInput: 1.25 });
});

test('a parameterized case is discovered with its row, template and bound plan', (t) => {
  const dir = directory(t);
  mkdirSync(join(dir, 'discovery'));
  env(t, {
    AT_DASHBOARD_DISCOVERY_DIR: join(dir, 'discovery'),
    AT_DASHBOARD_SPOOL_DIR: undefined,
    AT_TESTS: 'self-test',
    AT_CASE_IDS: undefined,
    AT_DASHBOARD_PHASE: 'parallel',
  });
  const parameters = {
    set: 'worklist search',
    key: 'Petrova',
    values: { search: 'Petrova', patient: 'Ana Petrova' },
  };
  const variant = {
    id: 'pw-variant',
    title: 'Search the worklist for "Petrova"',
    tags: [],
    expectedStatus: 'passed',
    outcome: () => 'expected',
    parent: { project: () => ({ name: 'parallel' }) },
    annotations: [
      { type: 'at-client-test-id', description: 'case:self.worklist-search[Petrova]' },
      { type: 'at-file', description: 'self-test/engine.md' },
      { type: 'at-template-client-test-id', description: 'case:self.worklist-search' },
      { type: 'at-parameters', description: JSON.stringify(parameters) },
    ],
  } as unknown as TestCase;
  new DashboardReporter().onBegin(configuration, suite([variant]));
  const [entry] = JSON.parse(readFileSync(join(dir, 'discovery', 'parallel.json'), 'utf8')).entries;
  assert.equal(entry.clientTestId, 'case:self.worklist-search[Petrova]');
  assert.deepEqual(entry.template, {
    clientTestId: 'case:self.worklist-search',
    name: 'Search the worklist for "{{param.search}}"',
  });
  assert.deepEqual(entry.parameters, parameters);
  assert.equal(entry.plan.at(-1).text, 'expect the worklist shows "Ana Petrova"');
});
