// Text that web components render in open shadow roots is part of what `expect` steps read, in a real browser:
// in the page text and in table cells, without repeating slotted content, and not when the component is hidden.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from '@playwright/test';

process.env.AT_APP_DIR = fileURLToPath(new URL('./fixture/', import.meta.url));
process.env.AT_DECIDER = 'stub';
const { pageText, snapshot, describe } = await import('../src/snapshot.ts');

let browser: Browser;
let page: Page;
before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
});
after(async () => {
  await browser?.close();
});

const component = (tag: string, html: string) =>
  `customElements.define('${tag}', class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '${html}'; } });`;

test('shadow-root text is read once, in cells too, and not from a transparent component', async () => {
  await page.setContent(`<main><h1>Triage</h1><x-card><span>Slotted note</span></x-card>
    <table><thead><tr><th>Name</th><th>Status</th></tr></thead><tbody><tr><td>Ann</td><td><x-chip></x-chip></td></tr></tbody></table>
    <x-faded style="opacity: 0"></x-faded></main>
    <script>${component('x-card', '<div><b>Card title</b><slot></slot></div>')}${component('x-chip', '<span>Triaged</span>')}${component('x-faded', '<span>Faded away</span>')}</script>`);
  const text = await pageText(page, 5000);
  assert.match(text.visibleText, /Card title/);
  assert.equal(text.visibleText.split('Slotted note').length, 2);
  assert.doesNotMatch(text.visibleText, /Faded away/);
  assert.deepEqual(text.tables[0].rows, [{ Name: 'Ann', Status: 'Triaged' }]);
});

test('buttons in a cell rendered in a shadow root belong to their row and column; icon-only cells are named', async () => {
  // Some grids render each cell's HTML template in its own shadow root: <td><shadow-template>#shadow-root…</td>.
  const cell = (html: string) => `<td><shadow-cell data-html='${html}'></shadow-cell></td>`;
  const row = (status: string, sent: string) =>
    `<tr>${cell(`<span>${status}</span>`)}${cell('<img alt="Custom Letter" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="16" height="16">')}${cell(sent)}` +
    `${cell('<button aria-label="Download Letter">⬇</button>')}</tr>`;
  const send =
    '<span class="tip" style="visibility: hidden">Mark Letter As Sent</span><button aria-label="Mark As Sent"><img alt="Mark as Sent" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="16" height="16"></button>';
  await page.setContent(`<table><thead><tr><th>Status</th><th>Is Custom</th><th>Letter Sent</th><th>Actions</th></tr></thead>
    <tbody>${row('Draft', '')}${row('Finalised', send)}</tbody></table>
    <script>customElements.define('shadow-cell', class extends HTMLElement { connectedCallback() { this.attachShadow({ mode: 'open' }).innerHTML = this.dataset.html; } });</script>`);
  const named = (await snapshot(page)).elements.map((e) => describe(e));
  assert.ok(
    named.includes(
      'button "Mark As Sent" (icon only) — in column "Letter Sent" of row 2 of table "" (Status: Finalised, Is Custom: image "Custom Letter", Letter Sent: button "Mark As Sent")',
    ),
    named.join('\n'),
  );
  assert.ok(
    named.some(
      (n) =>
        n.startsWith('button "Download Letter"') &&
        n.includes('— in row 1 of table "" (Status: Draft, Is Custom: image "Custom Letter")'),
    ),
    named.join('\n'),
  );
  const text = await pageText(page, 5000);
  assert.deepEqual(text.tables[0].rows, [
    { Status: 'Draft', 'Is Custom': 'image "Custom Letter"', 'Letter Sent': '' },
    {
      Status: 'Finalised',
      'Is Custom': 'image "Custom Letter"',
      'Letter Sent': 'button "Mark As Sent"',
    },
  ]);
  assert.deepEqual(
    text.actions.rows.map((r) => [r.row, r.actions]),
    [
      [1, ['Download Letter']],
      [2, ['Mark As Sent (in "Letter Sent")', 'Download Letter']],
    ],
  );
  assert.deepEqual(text.actions.other, []);
});

test('a node that loses its children while the snapshot walks the DOM is skipped, not fatal', async () => {
  // A redirect can detach a subtree mid-walk; the browser then reports a null `children` for it.
  await page.setContent(`<main><button>Keep going</button><section id="gone"><button>Removed</button></section></main>
    <script>Object.defineProperty(document.getElementById('gone'), 'children', { get: () => null });</script>`);
  const named = (await snapshot(page)).elements.map((e) => describe(e));
  assert.ok(
    named.some((n) => n.startsWith('button "Keep going"')),
    named.join('\n'),
  );
  assert.ok((await pageText(page, 5000)).visibleText.includes('Keep going'));
});
