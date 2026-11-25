// Elements that are clickable only through a script handler: some dashboard cards are
// <div class="collaborative-care-item-card hover-dashboard-item" (click)=…>, with no role, tabindex or link, so nothing
// in the DOM marks them clickable. recordClickListeners (an init script) remembers the elements that get a click
// listener, and the snapshot offers them as buttons when they name themselves.
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
const names = async () => (await snapshot(page)).elements.map((e) => describe(e));

test('a div with only a click listener is offered as a button, and clicking it runs the handler', async () => {
  // A collaborative care team panel: menu cards, then a service card with a status icon and an edit action.
  await page.goto('about:blank');
  await page.setContent(`<div class="scrollable-menu">
    <div data-click="core">Core Documents</div>
    <div data-click="events">Events &amp; Appointments</div>
    <div data-click="service">
      <span style="display: flex; flex-direction: column"><span>TAO (Team Allied Outreach)</span><span>Active</span><span>29/10/2026</span></span>
      <span title="Full access">person</span> <span data-click="edit" title="Update service details">edit</span>
    </div>
    <div>Plain text without a handler</div>
  </div>${listen}`);
  const elements = (await snapshot(page)).elements;
  assert.deepEqual(
    elements.map((e) => describe(e)),
    [
      'button "Core Documents"',
      'button "Events & Appointments"',
      'button "TAO (Team Allied Outreach) Active 29/10/2026 person edit"',
      'button "edit"',
    ],
  );
  await page.click(`[data-at-id="${elements[2].id}"]`);
  assert.deepEqual(
    await page.evaluate(() => (window as unknown as { clicked: string[] }).clicked),
    ['service'],
  );
});

test('handlers inside a control, on containers of controls, on the page or removed again are not offered', async () => {
  await page.goto('about:blank');
  await page.setContent(`<div data-click="wrapper">
      <button><span data-click="icon">Save</span></button>
      <a href="#x" data-click="wrapper2"><span data-click="inner">Open</span></a>
    </div>
    <div data-click="removed" id="removed">Gone</div>
    ${listen}
    <script>
      document.body.addEventListener('click', () => {});
      const fn = () => {};
      const el = document.getElementById('removed');
      el.addEventListener('click', fn);
      el.removeEventListener('click', fn);
    </script>`);
  // "Gone" keeps the listener from `listen`; the second one, added and removed, doesn't count twice.
  assert.deepEqual(await names(), ['button "Save"', 'link "Open"', 'button "Gone"']);
  await page.evaluate(() => {
    const el = document.getElementById('removed')!;
    const clone = el.cloneNode(true);
    el.replaceWith(clone); // a fresh element without listeners
  });
  assert.deepEqual(await names(), ['button "Save"', 'link "Open"']);
});

test('an onclick attribute or property counts as a click handler', async () => {
  await page.goto('about:blank');
  await page.setContent(`<div onclick="void 0">Attribute card</div><div id="p">Property card</div>
    <script>document.getElementById('p').onclick = () => {};</script>`);
  assert.deepEqual(await names(), ['button "Attribute card"', 'button "Property card"']);
});
