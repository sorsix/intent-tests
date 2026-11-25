// AT_DECIDER_IMAGES=fallback in a real browser: an unsure text-only element choice is asked again with a screenshot,
// taken after scrolling to the element the model leaned to; `expect` stays text-only. The model is a local server.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page, type TestInfo } from '@playwright/test';

type Request = {
  images?: string[];
  state: { notes?: string[]; elements?: { id: string; description: string }[] };
  questions: Record<string, { criteria?: Record<string, string> }>;
};
const requests: Request[] = [];
const server: Server = createServer((req, res) => {
  let text = '';
  req.on('data', (c) => (text += c));
  req.on('end', () => {
    const body: Request = JSON.parse(text);
    requests.push(body);
    // Unsure without a screenshot, sure with one: the button the step names is the one called "Request assistance".
    // Any other step ("Missing") is a confident "none".
    const target = body.questions.target;
    const instructions = JSON.stringify(body);
    const id = target
      ? Object.entries(target.criteria ?? {}).find(([, d]) => d.includes('Request assistance'))?.[0]
      : undefined;
    const answers = !target
      ? { claim: { noul: 0.97 } }
      : instructions.includes('Missing')
        ? { target: { choice: 'none', probabilities: { [id!]: 0.03, none: 0.97 } } }
        : {
            target: body.images
              ? { choice: id, probabilities: { [id!]: 0.96, none: 0.04 } }
              : { choice: 'none', probabilities: { [id!]: 0.4, none: 0.6 } },
          };
    res
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ model: 'vllm-sr/d3-ultra', answers, usage: { input_tokens: 1 } }));
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));

process.env.AT_APP_DIR = fileURLToPath(new URL('./fixture/', import.meta.url));
Object.assign(process.env, {
  AT_DECIDER: 'd3-ultra',
  VLLM_SR_API_KEY: 'test-key',
  AT_DECIDER_IMAGES: 'fallback',
  AT_DECIDER_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/systemone`,
  AT_MIN_LOOKS: '1',
  AT_SETTLE_MS: '0',
});
const { StepRunner } = await import('../src/steps.ts');

let browser: Browser;
let page: Page;
before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  // The "?" button sits below the fold: named only by aria-label, showing just an icon ligature.
  await page.setContent(`<h1>Booked</h1><div style="height:2000px"></div>
    <button aria-label="Request assistance" onclick="document.title='clicked'"><span class="material-icons" aria-hidden="true">help_outline</span></button>`);
});
after(async () => {
  await browser?.close();
  server.close();
});

const info = {
  title: 'fallback',
  testId: 'fallback',
  retry: 0,
  annotations: [],
  project: { name: 'parallel' },
  attach: async () => undefined,
} as unknown as TestInfo;

test('an unsure text-only choice is re-asked with a screenshot of the scrolled-to element, which decides', async () => {
  requests.length = 0;
  const runner = new StepRunner(page, info);
  await runner.run({
    kind: 'click',
    target: '"Request assistance" button',
    number: 1,
    label: '1',
    file: 'x.md',
    line: 1,
    text: 'click the "Request assistance" button',
  });

  assert.equal(await page.title(), 'clicked');
  assert.equal(requests.length, 2);
  const [text, shot] = requests;
  assert.equal(text.images, undefined);
  assert.ok(!text.state.notes!.some((n) => n.includes('screenshot')));
  assert.equal(shot.images?.length, 1);
  assert.match(shot.images![0], /^data:image\/jpeg;base64,/);
  assert.ok(
    shot.state.notes!.some((n) => n.includes('only the part of the page currently in view')),
  );
  // Described as the icon a user sees, and scrolled into view before the screenshot.
  assert.ok(
    shot.state.elements!.some(
      (e) => e.description === 'button "Request assistance" (icon only), icon "help outline"',
    ),
  );
  assert.ok(await page.evaluate(() => window.scrollY > 1000));
  const record = (
    runner as unknown as { records: { screenshotFallback?: boolean; calls: unknown[] }[] }
  ).records.at(-1)!;
  assert.equal(record.screenshotFallback, true);
  assert.equal(record.calls.length, 2);
});

test('expect stays text-only in fallback mode', async () => {
  requests.length = 0;
  const runner = new StepRunner(page, info);
  await runner.run({
    kind: 'expect',
    assertion: 'the page says Booked',
    number: 2,
    label: '2',
    file: 'x.md',
    line: 2,
    text: 'expect the page says Booked',
  } as never);
  assert.ok(requests.length >= 1);
  assert.ok(requests.every((r) => r.images === undefined));
});

test('a confident text-only "none" is not re-asked with a screenshot', async () => {
  requests.length = 0;
  const runner = new StepRunner(page, info);
  await runner.run({
    kind: 'click',
    target: '"Missing" button',
    number: 3,
    label: '3',
    file: 'x.md',
    line: 3,
    text: 'optionally click the "Missing" button',
    optional: true,
  } as never);
  assert.ok(requests.length >= 1);
  assert.ok(requests.every((r) => r.images === undefined));
});
