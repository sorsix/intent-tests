// `upload "<file>" to <target>` in a real browser with the stub decider: the snapshot offers file inputs and the
// labels that open hidden ones as `file` elements (only to upload steps, so `click` sees the page as before), and the
// runner chooses the file in the picker the target opens, or fails when none opens.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page, type TestInfo } from '@playwright/test';

const app = fileURLToPath(new URL('./fixture/', import.meta.url));
process.env.AT_APP_DIR = app;
Object.assign(process.env, { AT_DECIDER: 'stub', AT_MIN_LOOKS: '1', AT_SETTLE_MS: '0' });
const { snapshot, describe } = await import('../src/snapshot.ts');
const { StepRunner } = await import('../src/steps.ts');

let browser: Browser;
let page: Page;
before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
});
after(async () => {
  await browser?.close();
});

const info = {
  title: 'upload',
  testId: 'upload',
  retry: 0,
  annotations: [],
  project: { name: 'parallel' },
  attach: async () => undefined,
} as unknown as TestInfo;

const page$ = `
  <label class="card" for="kh" tabindex="0"><div aria-hidden="true">+</div><small>Upload Files</small></label>
  <input id="kh" type="file" hidden>
  <label for="plain">Scan of consent</label><input id="plain" type="file" style="display:none">
  <label for="referral">Referral letter</label><input id="referral" type="file">
  <button type="button" id="attach">Attach photo</button><input id="photo" type="file" style="display:none">
  <button type="button">Clear</button>
  <p id="got"></p>
  <script>
    for (const input of document.querySelectorAll('input[type=file]'))
      input.addEventListener('change', () => {
        document.getElementById('got').textContent = input.id + ': ' + input.files[0].name + ' ' + input.files[0].size;
      });
    document.getElementById('attach').addEventListener('click', () => document.getElementById('photo').click());
  </script>`;

test('file inputs and the labels that open hidden ones are file elements; a focusable label stays a button', async () => {
  await page.setContent(page$);
  const { elements } = await snapshot(page);
  const offered = elements.map((e) => describe(e)).filter((d) => !d.startsWith('textbox'));
  assert.deepEqual(offered, [
    'button "+ Upload Files"',
    'file upload "Scan of consent"',
    'file upload "Referral letter"',
    'button "Attach photo"',
    'button "Clear"',
  ]);
});

async function upload(target: string, attachment = 'files/referral.pdf') {
  const runner = new StepRunner(page, info);
  await runner.run({
    kind: 'upload',
    attachment,
    target,
    number: 1,
    label: '1',
    file: 'x.md',
    line: 1,
    text: `upload "${attachment}" to ${target}`,
  });
  return (runner as unknown as { records: { outcome?: string }[] }).records.at(-1)!;
}

const size = readFileSync(new URL('./fixture/files/referral.pdf', import.meta.url)).length;

for (const [target, input] of [
  ['the "Upload Files" button', 'kh'],
  ['the "Scan of consent" file upload', 'plain'],
  ['the "Referral letter" file upload', 'referral'],
  ['the "Attach photo" button', 'photo'],
] as const)
  test(`upload to ${target} chooses the file in the picker it opens`, async () => {
    await page.setContent(page$);
    const record = await upload(target);
    assert.equal(await page.textContent('#got'), `${input}: referral.pdf ${size}`);
    assert.equal(record.outcome, `uploaded "files/referral.pdf" (${size} bytes)`);
  });

test('a target that opens no file picker fails the step', async () => {
  await page.setContent(page$);
  await assert.rejects(
    upload('the "Clear" button'),
    /Clicking button "Clear" did not open a file picker within 5 s/,
  );
  assert.equal(await page.textContent('#got'), '');
});

test('a click step is never offered a file element', async () => {
  await page.setContent(page$);
  const runner = new StepRunner(page, info);
  await runner
    .run({
      kind: 'click',
      target: 'the "Scan of consent" file upload',
      number: 1,
      label: '1',
      file: 'x.md',
      line: 1,
      text: 'click the "Scan of consent" file upload',
    })
    .catch(() => undefined);
  const record = (
    runner as unknown as { records: { top?: { description: string }[] }[] }
  ).records.at(-1)!;
  const offered = record.top!.map((t) => t.description);
  assert.ok(offered.length > 0);
  assert.ok(!offered.some((d) => d.startsWith('file upload')), offered.join('; '));
});
