// `expect X is not shown` in a real browser against a local model server: it asks the positive statement and passes
// only on confident "no" answers on minLooks looks in a row; any other expect is asked as written, as before.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page, type TestInfo } from '@playwright/test';

/** The `yes` probability of each next yes/no answer; the last one repeats. */
let answers: number[] = [];
const asked: string[] = [];
const server: Server = createServer((req, res) => {
  let text = '';
  req.on('data', (c) => (text += c));
  req.on('end', () => {
    const body = JSON.parse(text) as { state: { assertion: string } };
    asked.push(body.state.assertion);
    const yes = answers.length > 1 ? answers.shift()! : answers[0];
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(
      JSON.stringify({
        model: 'vllm-sr/d3-ultra',
        answers: { claim: { noul: yes } },
        usage: { input_tokens: 1 },
      }),
    );
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));

process.env.AT_APP_DIR = fileURLToPath(new URL('./fixture/', import.meta.url));
Object.assign(process.env, {
  AT_DECIDER: 'd3-ultra', // yes/no threshold 0.8: "not shown" needs yes ≤ 0.2
  VLLM_SR_API_KEY: 'test-key',
  AT_DECIDER_IMAGES: 'false',
  AT_DECIDER_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/systemone`,
  AT_MIN_LOOKS: '3',
  AT_SETTLE_MS: '0',
  AT_POLL_INTERVAL_MS: '10',
  AT_RESOLVE_TIMEOUT_MS: '50',
});
const { StepRunner } = await import('../src/steps.ts');

let browser: Browser;
let page: Page;
before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.setContent('<nav><a href="#">Patients</a></nav><h1>Home</h1>');
});
after(async () => {
  await browser?.close();
  server.close();
});
beforeEach(() => {
  asked.length = 0;
});

const info = {
  title: 'not shown',
  testId: 'not-shown',
  retry: 0,
  annotations: [],
  project: { name: 'parallel' },
  attach: async () => undefined,
} as unknown as TestInfo;

function expectStep(assertion: string) {
  const runner = new StepRunner(page, info);
  const run = runner.run({
    kind: 'expect',
    assertion,
    number: 1,
    label: '1',
    file: 'x.md',
    line: 1,
    text: `expect ${assertion}`,
  } as never);
  const record = () => (runner as unknown as { records: { outcome?: string }[] }).records.at(-1)!;
  return { run, record };
}

test('asks whether it is shown and passes on confident "no" answers on three looks in a row', async () => {
  answers = [0.05];
  const { run, record } = expectStep('the "Debtors" menu item is not shown');
  await run;
  assert.deepEqual(asked, Array(3).fill('the "Debtors" menu item is shown'));
  assert.match(record().outcome!, /yes 0\.05 ≤ 0\.2, so it is not shown \(3\/3 looks\)/);
});

test('a "shown" answer restarts the streak', async () => {
  answers = [0.05, 0.95, 0.05];
  const { run } = expectStep('the "Debtors" menu item is not shown');
  await run;
  assert.equal(asked.length, 5);
});

test('an unsure answer never counts as not shown: the step fails', async () => {
  answers = [0.5];
  const { run } = expectStep('the "Debtors" menu item is not shown');
  await assert.rejects(
    run,
    /Expectation not met: the "Debtors" menu item is not shown \(asked "the "Debtors" menu item is shown": probability 0\.50/,
  );
  assert.equal(asked.length, 3);
});

test('something that is shown fails', async () => {
  answers = [0.97];
  const { run } = expectStep('"Patients" is not visible');
  await assert.rejects(run, /Expectation not met/);
  assert.ok(asked.every((a) => a === '"Patients" is visible'));
});

test('a streak under way at the deadline is finished', async () => {
  answers = [0.95, 0.1, 0.1, 0.1];
  const { run } = expectStep('the "Debtors" menu item is not shown');
  // The 50 ms deadline passes during the streak that starts on the second look; it still completes on the fourth.
  await run;
  assert.equal(asked.length, 4);
});

test('past the deadline with no streak under way, it fails at once', async () => {
  answers = [0.95, 0.95, 0.95, 0.1];
  const { run } = expectStep('the "Debtors" menu item is not shown');
  await assert.rejects(run, /probability 0\.95 that it is shown/);
  assert.equal(asked.length, 3);
});

test('any other expect is asked as written, once when it holds', async () => {
  answers = [0.95];
  const { run } = expectStep('no dialog is open and no error message is shown');
  await run;
  assert.deepEqual(asked, ['no dialog is open and no error message is shown']);
});
