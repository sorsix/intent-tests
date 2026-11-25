// The coloured areas an `expect` step about colours reads (pageColours in src/snapshot.ts), in a real browser, on the
// fixture's session page: colours from inline styles, stylesheet classes and CSS variables, faded tiles keeping their
// colour, a colour on a wrapper reported with the text inside it, semi-transparent tints blended, hidden tiles left out.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from '@playwright/test';

process.env.AT_APP_DIR = fileURLToPath(new URL('./fixture/', import.meta.url));
process.env.AT_DECIDER = 'stub';
const { pageColours } = await import('../src/snapshot.ts');
const { yesNoState } = await import('../src/steps.ts');

let browser: Browser;
let page: Page;
before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
});
after(async () => {
  await browser?.close();
});

test('session tiles are reported with their status colour, however it is set', async () => {
  await page.setContent(
    readFileSync(new URL('./fixture/site/sessions.html', import.meta.url), 'utf8'),
  );
  assert.deepEqual(await pageColours(page), [
    '"Friday, 6 November 2026 · Test Clinic B · 07:30 - 12:00": background green #228B22',
    '"Monday, 9 November 2026 · Test Clinic B · 07:30 - 12:00": background green #358856',
    '"Tuesday, 10 November 2026 · Test Clinic B · 07:30 - 12:00": background orange #FE994A',
    '"Wednesday, 11 November 2026 · Test Clinic B · 07:30 - 12:00": background grey #C7C7C7',
    '"Room 4 double booked": background light red #F3DBDB',
    '"Save": background blue #2967BC',
  ]);
});

test('areas without text, form fields, containers and colours like their background are not listed', async () => {
  await page.setContent(`<body style="background:#1c2430;color:#fff">
    <div style="background:#2967bc;width:20px;height:20px"></div>
    <input value="Typed" style="background:#ffeb3b">
    <div style="background:#1e2632">Almost the page colour</div>
    <div style="background:#358856">${'Long text in a coloured panel. '.repeat(10)}</div>
    <span title="Conflict" style="display:inline-block;background:#ea4335;width:12px;height:12px"></span>
  </body>`);
  assert.deepEqual(await pageColours(page), ['"Conflict": background red #EA4335']);
});

test('only a question about colours carries the colour list and its note', () => {
  const text = {
    url: '',
    title: '',
    dialog: null,
    tables: [],
    fields: [],
    actions: { rows: [], other: [] },
    visibleText: 'Future Events',
  };
  const plain = yesNoState('Check', 'the page shows "Future Events"', text);
  assert.equal('colours' in plain.page, false);
  assert.equal(plain.notes.length, 1);
  const coloured = yesNoState('Check', 'the Friday tile is green', text, false, [
    '"Friday": background green #228B22',
  ]);
  assert.deepEqual((coloured.page as { colours?: string[] }).colours, [
    '"Friday": background green #228B22',
  ]);
  assert.match(coloured.notes.join(' '), /"colours" list/);
});
