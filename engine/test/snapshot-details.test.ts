// A <details> is titled by its <summary> in a real browser: its controls take the summary's text as their section, the
// summary's own buttons and icons are not part of that title, nothing after the <details> is named by it, and the page
// text outlines the summary as a heading. Health questionnaires put each section's title and its "+ Add" /
// "Archive" buttons in the summary of a collapsible, inside a full-screen participant-details dialog without a title.
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

// As health-question templates render a section (open only when it has records).
const healthSection = (title: string, open = true) =>
  `<details class="collapsible" ${open ? 'open' : ''}>
    <summary class="collapsible-header">
      <div class="heading-with-button-content">
        <div class="header-name">${title}</div>
        <button class="archive-button">Archive</button>
        <button class="add-data-button">+ Add
          <span class="tooltipHover tooltipText" style="display:none">Add ${title.toLowerCase()}</span>
        </button>
        <span class="material-icons">expand_more</span>
      </div>
    </summary>
    <div class="collapsible-content">
      <table><thead><tr><th>Family member</th></tr></thead><tbody><tr><td>Mother</td></tr></tbody></table>
      <label>${title} general comments <textarea></textarea></label>
    </div>
  </details>`;

/** [name, section] of every element, in page order. */
async function sections(html: string) {
  await page.setContent(html);
  return (await snapshot(page)).elements.map((e) => [e.name, e.section ?? ''] as const);
}

test("each summary's buttons and its section's fields take the summary's title", async () => {
  // The participant details: a full-screen dialog without a title, so nothing else names these sections.
  const list = await sections(
    `<div role="dialog" aria-modal="true" style="position:fixed;inset:0">
      ${healthSection('Family history of breast cancer')}
      ${healthSection('Family history of ovarian cancer')}
    </div>`,
  );
  assert.deepEqual(list, [
    ['Archive', 'Family history of breast cancer'],
    ['+ Add', 'Family history of breast cancer'],
    ['Family history of breast cancer general comments', 'Family history of breast cancer'],
    ['Archive', 'Family history of ovarian cancer'],
    ['+ Add', 'Family history of ovarian cancer'],
    ['Family history of ovarian cancer general comments', 'Family history of ovarian cancer'],
  ]);
});

test('a details section outside any dialog, form or section is still named by its summary', async () => {
  const list = await sections(
    healthSection('Previous breast cancer', false) + healthSection('Breast operations'),
  );
  assert.deepEqual(list, [
    ['Archive', 'Previous breast cancer'],
    ['+ Add', 'Previous breast cancer'],
    ['Archive', 'Breast operations'],
    ['+ Add', 'Breast operations'],
    ['Breast operations general comments', 'Breast operations'],
  ]);
});

test('a summary names nothing after its details, even a details without controls', async () => {
  const list = await sections(
    `<form><h2>Referral</h2>
      <details open><summary>What counts as urgent?</summary><p>Anything within two weeks.</p></details>
      <button>Save</button></form>`,
  );
  assert.deepEqual(list, [['Save', 'Referral']]);
});

test('a heading inside the details names what follows it there', async () => {
  const list = await sections(
    `<details open><summary>Assessment</summary>
      <button>Edit assessment</button>
      <div><h3>Lesions</h3><button>Add lesion</button></div>
    </details>`,
  );
  assert.deepEqual(list, [
    ['Edit assessment', 'Assessment'],
    ['Add lesion', 'Lesions'],
  ]);
});

test("a dialog's footer keeps the dialog's name next to a details section", async () => {
  const list = await sections(
    `<div role="dialog" aria-modal="true" aria-label="Health questions" style="width:600px">
      ${healthSection('Family history of breast cancer')}
      <div><button>Submit</button></div>
    </div>`,
  );
  assert.deepEqual(list.at(-1), ['Submit', 'Health questions']);
  assert.deepEqual(list[1], ['+ Add', 'Family history of breast cancer']);
});

test('a details menu in the navigation keeps the navigation as its section', async () => {
  const list = await sections(
    `<nav aria-label="Main"><details open><summary>Reports</summary><a href="#d">Daily</a></details></nav>`,
  );
  assert.deepEqual(list, [['Daily', 'navigation "Main"']]);
});

test('the page text outlines a summary as a heading, without its buttons and icons', async () => {
  await page.setContent(
    `<h1>Health and medical information</h1>
    ${healthSection('Family history of breast cancer')}
    ${healthSection('Family history of ovarian cancer', false)}`,
  );
  const text = (await pageText(page, 5000)).visibleText;
  assert.match(text, /^## Family history of breast cancer$/m);
  assert.match(text, /^## Family history of ovarian cancer$/m);
  assert.match(text, /Family member\s+Mother/);
  assert.doesNotMatch(text, /\+ Add|Archive|expand_more/);
});
