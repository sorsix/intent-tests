// `drag <element> to <slot>`: drop slots are elements with their own `drop` listener (a calendar's day-grid cells:
// an empty <div class="event-field" aria-label="Tue 03 Nov 11:30 AM" (dragover) (drop)>), named by their aria-label
// and sectioned by the named group around them (a care-calendar resource column, role="group" aria-label="Dr Smith").
// Only a drag snapshot offers them, and draggable="true" elements, so every other step sees the page as before.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from '@playwright/test';

process.env.AT_APP_DIR = fileURLToPath(new URL('./fixture/', import.meta.url));
process.env.AT_DECIDER = 'stub';
const { snapshot, describe, pageText, CLICK_LISTENERS, recordClickListeners } =
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

const calendar = `<button>Today</button>
  <div class="calendar-column" role="group" aria-label="Dr Smith">
    <div class="event-field" aria-label="Tue 03 Nov 09:00 AM" style="height: 30px"></div>
    <div class="event-field" aria-label="Tue 03 Nov 09:30 AM" style="height: 30px"></div>
    <div class="appointment-block" draggable="true">Jane Doe 09:00 AM - 09:30 AM</div>
  </div>
  <div class="calendar-column" role="group" aria-label="Dr Jones">
    <div class="event-field" aria-label="Tue 03 Nov 09:00 AM" style="height: 30px"></div>
    <div class="unlisted" aria-label="No longer a slot" style="height: 30px"></div>
    <div class="by-attribute" aria-label="Tue 03 Nov 10:00 AM" ondrop="void 0" style="height: 30px"></div>
    <div class="appointment-block" draggable="true" data-click>Tom Brown 10:00 AM - 10:30 AM</div>
  </div>
  <script>
    for (const el of document.querySelectorAll('.event-field, .unlisted')) {
      el.addEventListener('dragover', (e) => e.preventDefault());
      el.addEventListener('drop', drop);
    }
    function drop() {}
    document.querySelector('.unlisted').removeEventListener('drop', drop);
    for (const el of document.querySelectorAll('[data-click]')) el.addEventListener('click', () => {});
  </script>`;

test('the ordinary snapshot and page text are unchanged by drop slots and draggable elements', async () => {
  await page.goto('about:blank');
  await page.setContent(calendar);
  assert.deepEqual(
    (await snapshot(page)).elements.map((e) => describe(e)),
    ['button "Today"', 'button "Tom Brown 10:00 AM - 10:30 AM"'],
  );
  const text = JSON.stringify(await pageText(page, 20_000));
  assert.doesNotMatch(text, /Tue 03 Nov|slot/);
});

test('a drag snapshot adds draggable elements and drop slots, named by aria-label and their group', async () => {
  await page.goto('about:blank');
  await page.setContent(calendar);
  assert.deepEqual(
    (await snapshot(page, { drag: true })).elements.map((e) => describe(e)),
    [
      'button "Today"',
      'button "Tom Brown 10:00 AM - 10:30 AM", draggable',
      'slot "Tue 03 Nov 09:00 AM" — in group "Dr Smith"',
      'slot "Tue 03 Nov 09:30 AM" — in group "Dr Smith"',
      'draggable "Jane Doe 09:00 AM - 09:30 AM" — in group "Dr Smith"',
      'slot "Tue 03 Nov 09:00 AM" — in group "Dr Jones"',
      'slot "Tue 03 Nov 10:00 AM" — in group "Dr Jones"',
    ],
  );
  // The next ordinary snapshot forgets them again.
  assert.equal((await snapshot(page)).elements.length, 2);
  assert.equal(await page.locator('[data-at-id]').count(), 2);
});

test('dragging an element found by a drag snapshot onto a slot runs the native drag-and-drop handlers', async () => {
  await page.goto('about:blank');
  await page.setContent(`<div id="result">nothing</div>
    <div draggable="true" id="card">Jane Doe</div>
    <div role="group" aria-label="Dr Lee"><div id="slot" aria-label="Wed 04 Nov 01:00 PM" style="height: 40px"></div></div>
    <script>
      card.addEventListener('dragstart', (e) => e.dataTransfer.setData('application/json', JSON.stringify({ who: 'Jane Doe' })));
      slot.addEventListener('dragover', (e) => e.preventDefault());
      slot.addEventListener('drop', (e) => {
        result.textContent = JSON.parse(e.dataTransfer.getData('application/json')).who + ' at ' + slot.getAttribute('aria-label');
      });
    </script>`);
  const elements = (await snapshot(page, { drag: true })).elements;
  const card = elements.find((e) => e.kind === 'draggable')!;
  const slot = elements.find((e) => e.kind === 'slot')!;
  await page.locator(`[data-at-id="${card.id}"]`).dragTo(page.locator(`[data-at-id="${slot.id}"]`));
  assert.equal(await page.textContent('#result'), 'Jane Doe at Wed 04 Nov 01:00 PM');
});

test('a week of a calendar (about 1,400 slots) is read in reasonable time', async () => {
  await page.goto('about:blank');
  const columns = Array.from(
    { length: 35 },
    (_, c) =>
      `<div role="group" aria-label="Resource ${c % 5} day ${Math.floor(c / 5)}" style="display:inline-block;width:40px">${Array.from(
        { length: 40 },
        (_, r) =>
          `<div class="cell" aria-label="Day ${Math.floor(c / 5)} ${r}:00" style="height:8px"></div>`,
      ).join('')}</div>`,
  ).join('');
  await page.setContent(
    `<div style="white-space:nowrap">${columns}</div><script>for (const el of document.querySelectorAll('.cell')) el.addEventListener('drop', () => {});</script>`,
  );
  const started = Date.now();
  const slots = (await snapshot(page, { drag: true })).elements.filter((e) => e.kind === 'slot');
  assert.equal(slots.length, 1400);
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
});
