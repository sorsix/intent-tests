// Icons that are click targets with no name until hovered. A patient files table shows
// <p-icon fontIcon="attach" pTooltip="Open file" (click)=…> and a delete icon per row: the library's pTooltip renders its
// text and aria-describedby only while open, and p-icon is aria-hidden with no role, so the snapshot dropped them and
// "click the … icon in the row for …" answered none. They are now offered by the icon they show.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from '@playwright/test';

process.env.AT_APP_DIR = fileURLToPath(new URL('./fixture/', import.meta.url));
process.env.AT_DECIDER = 'stub';
const { snapshot, describe, CLICK_LISTENERS, recordClickListeners } =
  await import('../src/snapshot.ts');

let browser: Browser;
let page: Page;
before(async () => {
  browser = await chromium.launch();
  const context = await browser.newContext();
  await context.addInitScript(recordClickListeners, CLICK_LISTENERS);
  page = await context.newPage();
});
after(async () => {
  await browser?.close();
});

// Adds listeners the way a framework does, after the init script ran: every element with data-click gets one.
const listen = `<script>
  window.clicked = [];
  for (const el of document.querySelectorAll('[data-click]')) el.addEventListener('click', () => clicked.push(el.dataset.click));
</script>`;
// p-icon draws its glyph with CSS; here a fixed 24px box stands in for it.
const style = `<style>p-icon { display: inline-block; width: 24px; height: 24px; }</style>`;
const names = async () => (await snapshot(page)).elements.map((e) => describe(e));

test('row icons with only a click handler and a hover tooltip are offered by their icon, in their row', async () => {
  // As rendered: the static fontIcon stays as an attribute, p-icon adds icon_<name>, after the app's own classes. The
  // second row's icons have a bound fontIcon, so only the class names them.
  await page.goto('about:blank');
  await page.setContent(`${style}<table><tbody>
    <tr class="grey-text"><td>File name</td><td>Open</td><td>Delete</td></tr>
    <tr><td>referral.pdf</td>
      <td><p-icon fonticon="attach" class="icon-attached clickable size-6 p-icon icon_attach" aria-hidden="true" data-click="open-1"></p-icon></td>
      <td><p-icon fonticon="delete" class="icon-not-attached clickable size-6 p-icon icon_delete" aria-hidden="true" data-click="delete-1"></p-icon></td></tr>
    <tr><td>prior exams.jpg</td>
      <td><p-icon class="icon-attached size-6 p-icon icon_attach" aria-hidden="true" data-click="open-2"></p-icon></td>
      <td><p-icon class="icon-not-attached size-6 p-icon icon_delete" aria-hidden="true" data-click="delete-2"></p-icon></td></tr>
  </tbody></table>${listen}`);
  const elements = (await snapshot(page)).elements;
  assert.deepEqual(
    elements.map((e) => [describe(e), e.row?.cells.col1]),
    [
      [
        'button "attach" (icon only), next to "referral.pdf" — in row 2 of table "" (col1: referral.pdf)',
        'referral.pdf',
      ],
      [
        'button "delete" (icon only), next to "referral.pdf" — in row 2 of table "" (col1: referral.pdf)',
        'referral.pdf',
      ],
      [
        'button "attach" (icon only), next to "prior exams.jpg" — in row 3 of table "" (col1: prior exams.jpg)',
        'prior exams.jpg',
      ],
      [
        'button "delete" (icon only), next to "prior exams.jpg" — in row 3 of table "" (col1: prior exams.jpg)',
        'prior exams.jpg',
      ],
    ],
  );
  await page.click(`[data-at-id="${elements[3].id}"]`);
  assert.deepEqual(
    await page.evaluate(() => (window as unknown as { clicked: string[] }).clicked),
    ['delete-2'],
  );
});

test('a wrapper around a clickable icon is offered once, and a Material icon by its ligature', async () => {
  await page.goto('about:blank');
  await page.setContent(`${style}
    <span data-click="upload-wrapper"><p-icon class="p-icon icon_upload" data-click="upload"></p-icon></span>
    <span class="clickable" style="display: inline-block"><p-icon fonticon="info" class="p-icon icon_info"></p-icon></span>
    <span data-click="svg"><mat-icon svgicon="right_arrow" style="display: inline-block; width: 24px; height: 24px"></mat-icon></span>
    ${listen}`);
  assert.deepEqual(await names(), [
    'button "upload" (icon only)',
    'button "info" (icon only)',
    'button "right arrow" (icon only)',
  ]);
});

test('nameless targets without an icon, larger than an icon or inside a named target stay out', async () => {
  await page.goto('about:blank');
  await page.setContent(`${style}
    <span data-click="empty" style="display: inline-block; width: 24px; height: 24px"></span>
    <div data-click="backdrop" style="width: 400px; height: 300px"><p-icon class="p-icon icon_spinner"></p-icon></div>
    <span class="clickable" style="display: inline-block; height: 24px">Mark as DNA<p-icon class="p-icon icon_check" data-click="glyph"></p-icon></span>
    <button><p-icon class="p-icon icon_close" data-click="in-button"></p-icon></button>
    ${listen}`);
  // The button is a real control and keeps its description from before (named by the icon it contains).
  assert.deepEqual(await names(), [
    'button "Mark as DNA"',
    'button "close" (icon only), next to "Mark as DNA"',
  ]);
});

test('a named icon target keeps its name and description; the icon is only a fallback', async () => {
  await page.goto('about:blank');
  await page.setContent(`${style}
    <p-icon class="p-icon icon_attach" aria-label="Open file" data-click="named"></p-icon>
    <p-icon class="p-icon icon_delete" title="Delete file" data-click="titled"></p-icon>
    ${listen}`);
  // Unchanged from before: the shown icon names only targets without a name of their own.
  assert.deepEqual(await names(), [
    'button "Open file" (icon only)',
    'button "Delete file" (icon only)',
  ]);
});
