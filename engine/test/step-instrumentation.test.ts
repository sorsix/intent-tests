import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Page, TestInfo } from '@playwright/test';
import type { ParsedStep } from '../src/parse.ts';
import type { StepRecord } from '../src/steps.ts';
import type { SnapElement } from '../src/snapshot.ts';
import { withLogging } from '../src/decider/log.ts';
import type { Decider, DecisionCall } from '../src/decider/types.ts';

// The imported runner configuration needs a selected app; this fixture uses only the offline decider.
process.env.AT_APP_DIR = fileURLToPath(new URL('./fixture/', import.meta.url));
process.env.AT_DECIDER = 'stub';
const { StepRunner } = await import('../src/steps.ts');

function info(attachments: { name: string; body: string }[]): TestInfo {
  return {
    title: 'Same title',
    testId: 'playwright-fallback',
    retry: 1,
    annotations: [{ type: 'at-client-test-id', description: 'source:booking.md:15' }],
    project: { name: 'parallel' },
    attach: async (name: string, attachment: { body: string }) => {
      attachments.push({ name, body: attachment.body });
    },
  } as unknown as TestInfo;
}
const call: DecisionCall = {
  type: 'choice',
  instructions: 'q',
  model: 'fixture',
  latencyMs: 12,
  inputTokens: 23,
  choice: 'e1',
  confidence: 1,
  probabilities: { e1: 1 },
};
const inner: Decider = {
  name: 'fixture',
  model: 'fixture',
  host: 'fixture.invalid',
  limits: { maxOptions: 10 },
  pricing: { usdPerMInput: 0 },
  choose: async () => call,
  yesNo: async () => ({ ...call, type: 'yesno', yes: 1 }),
};

test('a reused-block step records source identity, retry, display label and unchanged screenshot bytes', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'intent-step-linkage-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const attachments: { name: string; body: string }[] = [];
  const runner = new StepRunner(
    {
      on() {
        return undefined;
      },
    } as unknown as Page,
    info(attachments),
  );
  const screenshot = Buffer.from('pre-action fixture bytes').toString('base64');
  const logged = withLogging(inner, { directory: dir });
  Object.assign(runner, {
    execute: async (_step: ParsedStep, record: StepRecord) => {
      record.calls.push(await logged.choose({ page: 'fixture' }, 'q', { e1: 'Book' }));
      record.screenshot = screenshot;
    },
  });
  const step: ParsedStep = {
    kind: 'fill',
    target: 'password field',
    value: 'synthetic-test-secret',
    number: 5,
    label: '3.2',
    file: 'shared/login.md',
    line: 10,
    text: 'fill password with "{{SYNTHETIC_PASSWORD}}"',
  };
  await runner.run(step);
  const row = JSON.parse(readFileSync(join(dir, `${process.pid}.jsonl`), 'utf8').trim());
  assert.deepEqual(row.ctx, {
    test: 'Same title',
    file: 'shared/login.md',
    line: 10,
    step: 5,
    stepText: step.text,
    clientTestId: 'source:booking.md:15',
    attempt: 2,
    clientStepId: '5',
    pass: process.env.AT_DASHBOARD_PHASE || 'parallel',
    look: 1,
  });
  assert.equal(attachments[0].name, 'at-step-5');
  const recorded = JSON.parse(attachments[0].body);
  assert.equal(recorded.screenshot, screenshot);
  assert.equal(recorded.label, '3.2');
  assert.equal(recorded.file, 'shared/login.md');
  assert.equal(recorded.line, 10);
  assert.equal(recorded.inputTokens, 23);
  assert.equal(recorded.modelMs, 12);
  assert.equal(recorded.status, 'passed');
  assert.ok(!JSON.stringify(row).includes(step.value));
});

test('action evidence is captured with the target outlined before the action changes the page', async () => {
  const attachments: { name: string; body: string }[] = [];
  const order: string[] = [];
  const node = { style: { outline: 'old', outlineOffset: '' }, dataset: {} };
  let acted = false;
  const locator = { evaluate: async (fn: (target: typeof node) => unknown) => fn(node) };
  const page = {
    on() {
      return undefined;
    },
    locator: () => locator,
    screenshot: async () => {
      assert.equal(acted, false);
      assert.equal(node.style.outline, '3px solid #e11d48');
      order.push('screenshot');
      return Buffer.from('outlined-before-action');
    },
  } as unknown as Page;
  const runner = new StepRunner(page, info(attachments));
  Object.assign(runner, {
    dismissCoveringToasts: async () => undefined,
    waitForTableToSettle: async () => undefined,
    settle: async () => undefined,
  });
  const record: StepRecord = {
    number: 1,
    label: '1',
    file: 'case.md',
    line: 4,
    text: 'click "Book"',
    kind: 'click',
    status: 'passed',
    durationMs: 0,
    modelMs: 0,
    inputTokens: 0,
    calls: [],
  };
  const act = Reflect.get(runner, 'act') as (
    element: SnapElement,
    recorded: StepRecord,
    action: () => Promise<void>,
  ) => Promise<void>;
  await act.call(
    runner,
    { id: 'e1', kind: 'button', name: 'Book' } as SnapElement,
    record,
    async () => {
      assert.equal(node.style.outline, 'old');
      acted = true;
      order.push('action');
    },
  );
  assert.deepEqual(order, ['screenshot', 'action']);
  assert.equal(Buffer.from(record.screenshot!, 'base64').toString(), 'outlined-before-action');
});
