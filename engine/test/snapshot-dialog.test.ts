// How an open dialog is named in a real browser: by its own label; else by its only tab when a tab list comes first
// (untitled with several tabs); else by its first heading when it comes before the dialog's content (fields, tables);
// and headings without a letter (counter badges) are not listed.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from '@playwright/test';

process.env.AT_APP_DIR = fileURLToPath(new URL('./fixture/', import.meta.url));
process.env.AT_DECIDER = 'stub';
const { snapshot, pageText } = await import('../src/snapshot.ts');

let browser: Browser;
let page: Page;
before(async () => {
  browser = await chromium.launch();
  page = await browser.newPage();
});
after(async () => {
  await browser?.close();
});

const dialog = (body: string, attrs = '') =>
  `<div role="dialog" aria-modal="true" style="width:600px" ${attrs}>${body}</div>`;
async function names(html: string) {
  await page.setContent(html);
  return {
    snapshot: (await snapshot(page)).dialog,
    pageText: (await pageText(page, 5000)).dialog?.title,
  };
}

test('a heading before the dialog content names it', async () => {
  // An "Add biopsy" dialog: the title, the participant line, then the form.
  const html = dialog(`<div><h2>Add biopsy</h2><button aria-label="Close">x</button></div>
    <p><b>DEMO-1</b> Test name</p><form><label>Type <input></label></form>`);
  assert.deepEqual(await names(html), { snapshot: 'Add biopsy', pageText: 'Add biopsy' });
});

test('a single tab before any heading names the dialog, not the section headings below it', async () => {
  // Participant alerts: a questionnaire shown without its title, one tab, then section headings.
  const html = dialog(`<div><b>Test name (DEMO-1)</b><button aria-label="Close">x</button></div>
    <div role="tablist"><button role="tab" aria-selected="true">Participant alerts</button></div>
    <div role="tabpanel"><h2>Communication impairments</h2><input type="checkbox" aria-label="Deaf"></div>`);
  assert.deepEqual(await names(html), {
    snapshot: 'Participant alerts',
    pageText: 'Participant alerts',
  });
  // "General Note": no heading at all, the single tab is the only title.
  const note =
    dialog(`<button aria-label="Close">x</button><div role="tablist"><button role="tab" aria-selected="true">General Note</button></div>
    <label>Note <textarea></textarea></label>`);
  assert.deepEqual(await names(note), { snapshot: 'General Note', pageText: 'General Note' });
});

test('a heading before a single tab still names the dialog', async () => {
  // A questionnaire dialog opened with a title: <h3>Treatment details</h3>, then the questionnaire's tab.
  const html = dialog(`<div><h3>Treatment details</h3><button aria-label="Close">x</button></div>
    <div role="tablist"><button role="tab" aria-selected="true">Lesions</button></div><input aria-label="Size">`);
  assert.deepEqual(await names(html), {
    snapshot: 'Treatment details',
    pageText: 'Treatment details',
  });
});

test('tabs with count badges and no title leave the dialog untitled, and the badges are not headings', async () => {
  // A participant details view: tabs with "0" badges, then the selected tab's content.
  await page.setContent(
    dialog(`<button aria-label="Close">x</button>
    <div role="tablist"><button role="tab" aria-selected="true">Episodes</button><h2>0</h2>
      <button role="tab">Appointments</button><h2>0</h2></div>
    <h2>Participant episodes</h2>`),
  );
  const snap = await snapshot(page);
  assert.equal(snap.dialog, '');
  assert.deepEqual(snap.headings, ['Participant episodes']);
});

test('a heading after a form field does not name the dialog', async () => {
  const html = dialog(
    `<label>Search <input></label><h3>Results</h3><table><tr><td>1</td></tr></table>`,
  );
  assert.deepEqual(await names(html), { snapshot: '', pageText: '' });
});

test("the dialog's own label wins over its headings", async () => {
  const body = `<div role="tablist"><button role="tab" aria-selected="true">Episodes</button></div><h2>Participant episodes</h2>`;
  assert.deepEqual(
    await names(`<h3 id="t">Cancel Session</h3>${dialog(body, 'aria-labelledby="t"')}`),
    { snapshot: 'Cancel Session', pageText: 'Cancel Session' },
  );
  assert.deepEqual(await names(dialog(body, 'aria-label="Participant details"')), {
    snapshot: 'Participant details',
    pageText: 'Participant details',
  });
});

test("a dialog button after a titled card is the dialog's, while the card keeps its own fields and buttons", async () => {
  // An "Add Collaborative Care Team Member" dialog: the title, then a form with a card per case (<h4> in its own row,
  // the Services field), then Save after the form. A button next to a heading in a header still belongs to it.
  await page.setContent(
    dialog(`<div><h3>Add Collaborative Care Team Member</h3><button aria-label="Close">x</button></div>
    <form><label><input type="radio" name="t" checked> Full Access</label>
      <div class="card"><div class="row"><h4>Intent Team</h4></div><div class="row"><span>Services</span></div>
        <select aria-label="Services"><option>TAO</option></select><button type="button">Add consent</button></div>
      <label>Care team roles <select><option></option></select></label></form>
    <div class="action-button"><button>Save</button></div>`),
  );
  const sections = Object.fromEntries(
    (await snapshot(page)).elements.map((e) => [e.name, e.section]),
  );
  assert.equal(sections.Save, 'Add Collaborative Care Team Member');
  assert.equal(sections['Add consent'], 'Intent Team');
  assert.equal(sections.Close, 'Add Collaborative Care Team Member');
});

test('outside a dialog a heading still names what follows its block', async () => {
  // A worklist's top bar: the title with its search field, then the grid's toolbar.
  await page.setContent(`<main><div class="bar"><div><h2>Referrals</h2></div><input aria-label="Search"></div>
    <section><button>Export</button></section></main>`);
  const exportButton = (await snapshot(page)).elements.find((e) => e.name === 'Export');
  assert.equal(exportButton?.section, 'Referrals');
});

test("a dialog's own buttons outside its sections take the dialog's name, not its first section heading", async () => {
  // Participant alerts: titled by its single tab, sections of checkboxes, then Confirm after the last section.
  await page.setContent(
    dialog(`<div><b>Test name (DEMO-1)</b><button aria-label="Close">x</button></div>
    <div role="tablist"><button role="tab" aria-selected="true">Participant alerts</button></div>
    <div role="tabpanel"><div><h2>Communication impairments</h2><label><input type="checkbox"> Deaf</label></div>
      <div><h2>MIT alert</h2><label><input type="checkbox"> MIT alert - Override</label><button>Remove alert</button></div></div>
    <div><button>Confirm</button></div>`),
  );
  const sections = Object.fromEntries(
    (await snapshot(page)).elements.map((e) => [e.name, e.section]),
  );
  assert.equal(sections.Confirm, 'Participant alerts');
  assert.equal(sections.Close, 'Participant alerts');
  assert.equal(sections['Remove alert'], 'MIT alert');
});
