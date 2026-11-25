// An element with `display: contents` has no box, so checkVisibility() is false for it, but its children render. The
// page and dialog text walk into such wrappers instead of skipping them (a component library renders a dialog's
// component in `.p-dialog-component-host { display: contents }`, and only the title and buttons were read), while
// content hidden inside them stays out.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from '@playwright/test';

process.env.AT_APP_DIR = fileURLToPath(new URL('./fixture/', import.meta.url));
process.env.AT_DECIDER = 'stub';
const { pageText } = await import('../src/snapshot.ts');

let browser: Browser;
let page: Page;
before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
});
after(async () => {
  await browser?.close();
});

// A component library's dialog as it renders: surface > component host (display: contents) > the component's own markup.
const libraryDialog = (
  title: string,
  body: string,
) => `<main><h1>Bookings</h1><p>Behind the dialog</p></main>
  <style>.p-dialog-component-host { display: contents }</style>
  <div class="cdk-overlay-pane"><div role="dialog" aria-modal="true" aria-labelledby="t" class="p-dialog-container" style="width:600px">
    <div class="p-dialog-surface"><div class="p-dialog-component-host"><app-confirm>
      <div class="p-dialog-header"><h2 id="t" class="p-dialog-title">${title}</h2><button aria-label="Close">x</button></div>
      <div class="p-dialog-content">${body}</div>
      <div class="p-dialog-actions"><button>Keep Original Appointment</button><button>Proceed to Cancel Appointment</button></div>
    </app-confirm></div></div></div></div>`;

test("a component library dialog's message is read through its display: contents host", async () => {
  await page.setContent(
    libraryDialog('Cancel Appointment', '<p>Are you sure you want to cancel?</p>'),
  );
  const text = await pageText(page, 5000);
  assert.equal(text.dialog?.title, 'Cancel Appointment');
  assert.match(text.dialog!.text, /Are you sure you want to cancel\?/);
  assert.match(text.dialog!.text, /# Cancel Appointment/);
  assert.match(text.visibleText, /Are you sure you want to cancel\?/);
});

test('content hidden inside a display: contents host stays out', async () => {
  await page.setContent(
    libraryDialog(
      'Cancel Appointment',
      `<p>Are you sure you want to cancel?</p><p style="display:none">This appointment is chargeable</p>
       <div style="display:contents"><p>Nested wrapper text</p><span hidden>Hidden in nested wrapper</span></div>`,
    ),
  );
  const text = await pageText(page, 5000);
  assert.match(text.dialog!.text, /Are you sure you want to cancel\?/);
  assert.match(text.dialog!.text, /Nested wrapper text/);
  assert.doesNotMatch(text.dialog!.text, /chargeable/);
  assert.doesNotMatch(text.dialog!.text, /Hidden in nested wrapper/);
  assert.doesNotMatch(text.visibleText, /chargeable|Hidden in nested wrapper/);
});

test('a display: contents host inside a hidden element shows nothing', async () => {
  await page.setContent(`<main><h1>Page</h1><div style="display:none"><div style="display:contents"><p>Never shown</p></div></div>
    <div style="display:none"><x-host style="display:contents"></x-host></div></main>
    <script>customElements.define('x-host', class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<p>Hidden shadow</p>'; } });</script>`);
  const text = await pageText(page, 5000);
  assert.doesNotMatch(text.visibleText, /Never shown|Hidden shadow/);
});

test('a label and an editor inside the host are read, as is the section of a table in it', async () => {
  // A "Description" editor case (the "Description" editor's label is plain text) and ad-03 (the email list in a "Preview Emails" dialog).
  await page.setContent(
    libraryDialog(
      'Resource',
      `<label>Name <input value="Cate Turton (P)"></label><div>Description</div><div contenteditable="true"><p>Biography</p></div>
       <h3>Emails</h3><table><thead><tr><th>Subject</th></tr></thead><tbody><tr><td>Appointment Booked Successfully!</td></tr></tbody></table>`,
    ),
  );
  const text = await pageText(page, 5000);
  assert.match(text.dialog!.text, /Description/);
  assert.match(text.dialog!.text, /Biography/);
  const emails = text.tables.find((t) => t.rows[0]?.Subject);
  assert.ok(emails, JSON.stringify(text.tables));
  assert.match(emails.section ?? '', /Emails/);
});

test('a web component whose host is display: contents shows its shadow text', async () => {
  await page.setContent(`<main><h1>Page</h1><x-note style="display:contents"></x-note></main>
    <script>customElements.define('x-note', class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<p>Shadow note</p>'; } });</script>`);
  const text = await pageText(page, 5000);
  assert.equal(text.visibleText.split('Shadow note').length, 2, text.visibleText);
});
