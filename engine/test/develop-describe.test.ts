// Pick (`describe_point`, docs/develop-mode.md section 3.6): the suggestion builder on synthetic hits, and the browser
// side against the fixture clinic's login page in a real Chromium.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from '@playwright/test';

process.env.AT_APP_DIR = fileURLToPath(new URL('./fixture/', import.meta.url));
process.env.AT_DECIDER = 'stub';
process.env.PASSWORD ??= 'not-a-real-password';
const { pointDescription, pointScript, suggestedStep, TEXT_LIMIT } =
  await import('../src/develop/describe.ts');
const { parseStep } = await import('../src/parse.ts');
import type { PointHit } from '../src/develop/describe.ts';
import type { SnapElement } from '../src/snapshot.ts';

const el = (e: Partial<SnapElement>): SnapElement => ({ id: 'e1', kind: 'button', name: '', ...e });
const hit = (element: SnapElement, dialog: string | null = null): PointHit => ({ element, dialog });

/** Every suggested step must parse as its own kind. */
const parses = (steps: { kind: string; text: string }[]) => {
  for (const step of steps) assert.equal(parseStep(step.text).kind, step.kind, step.text);
};

test('an actionable element: description, target, context and the steps its kind allows', () => {
  const save = pointDescription(hit(el({ name: 'Save', section: 'Booking' }), 'Booking'));
  assert.equal(save.element?.description, 'button "Save" — in Booking');
  assert.equal(save.element?.kind, 'button');
  assert.equal(save.target, 'the "Save" button');
  assert.equal(save.context, 'in the "Booking" dialog');
  assert.deepEqual(save.steps, [
    { kind: 'click', text: 'click the "Save" button in the "Booking" dialog' },
  ]);
  assert.equal(save.reason, undefined);

  const link = pointDescription(hit(el({ kind: 'link', name: 'Home' })));
  assert.equal(link.context, undefined, 'no context when the element has none');
  assert.deepEqual(link.steps, [{ kind: 'click', text: 'click the "Home" link' }]);

  const tab = pointDescription(hit(el({ name: 'Deferrals', tab: true })));
  assert.equal(tab.target, 'the "Deferrals" tab');

  const action = pointDescription(
    hit(
      el({
        name: 'Check in',
        row: { table: 'Worklist', number: 1, cells: { Time: '08:30', Patient: 'Ana Petrova' } },
      }),
    ),
  );
  assert.equal(action.context, 'in the row for "08:30"');
  assert.deepEqual(action.steps, [
    { kind: 'click', text: 'click the "Check in" button in the row for "08:30"' },
  ]);

  const field = pointDescription(
    hit(el({ kind: 'textbox', name: 'Username', section: 'Staff login', value: 'reception1' })),
  );
  assert.equal(
    field.element?.description,
    'textbox "Username", current value "reception1" — in Staff login',
  );
  assert.deepEqual(field.steps, [
    { kind: 'fill', text: 'fill the "Username" field in the "Staff login" section with ""' },
  ]);
  const password = pointDescription(hit(el({ kind: 'textbox', name: 'Password', secret: true })));
  assert.deepEqual(password.steps, [
    { kind: 'fill', text: 'fill the "Password" field with "{{PASSWORD}}"' },
  ]);

  // The grammar needs an option: the current value stands in, or "(blank)".
  const select = pointDescription(hit(el({ kind: 'select', name: 'Status', value: 'All' })));
  assert.deepEqual(select.steps, [
    { kind: 'select', text: 'select "All" in the "Status" dropdown' },
  ]);
  const empty = pointDescription(hit(el({ kind: 'select', name: 'Status' })));
  assert.deepEqual(empty.steps, [
    { kind: 'select', text: 'select "(blank)" in the "Status" dropdown' },
  ]);

  // Checkboxes: the action that changes the state first.
  const unchecked = pointDescription(
    hit(el({ kind: 'checkbox', name: 'I consent', checked: false })),
  );
  assert.deepEqual(
    unchecked.steps.map((s) => s.kind),
    ['check', 'uncheck'],
  );
  assert.equal(unchecked.steps[0].text, 'check "I consent"');
  const checked = pointDescription(hit(el({ kind: 'checkbox', name: 'I consent', checked: true })));
  assert.deepEqual(
    checked.steps.map((s) => s.kind),
    ['uncheck', 'check'],
  );
  const radio = pointDescription(
    hit(el({ kind: 'radio', name: 'Yes', section: 'question "Any allergies?"', checked: false })),
  );
  assert.deepEqual(radio.steps, [
    { kind: 'check', text: 'check the "Yes" radio button in the "Any allergies?" question' },
  ]);

  for (const result of [save, link, tab, action, field, select, empty, unchecked, checked, radio])
    parses(result.steps);
});

test('plain text: one expect scoped like a target; nothing under the point gives a reason', () => {
  const page = pointDescription({ dialog: null, text: 'Welcome back' });
  assert.deepEqual(page, {
    steps: [{ kind: 'expect', text: 'expect the page shows "Welcome back"' }],
  });

  const section = pointDescription({
    dialog: null,
    text: 'Last 7 days',
    section: 'Studies received',
  });
  assert.equal(section.context, 'in the "Studies received" section');
  assert.deepEqual(section.steps, [
    { kind: 'expect', text: 'expect the "Studies received" section shows "Last 7 days"' },
  ]);

  const dialog = pointDescription({ dialog: 'Booking', text: 'Saved', section: 'Booking' });
  assert.equal(dialog.steps[0].text, 'expect the "Booking" dialog shows "Saved"');
  const part = pointDescription({ dialog: 'Booking', text: 'Saved', section: 'Details' });
  assert.equal(
    part.steps[0].text,
    'expect the "Details" section of the "Booking" dialog shows "Saved"',
  );
  const untitled = pointDescription({ dialog: '', text: 'Saved' });
  assert.equal(untitled.steps[0].text, 'expect the dialog shows "Saved"');

  const row = pointDescription({
    dialog: null,
    text: 'Scheduled',
    row: { table: 'Worklist', number: 3, cells: { Time: '', Patient: 'Ana Petrova' } },
  });
  assert.equal(row.steps[0].text, 'expect the row for "Ana Petrova" shows "Scheduled"');
  const numbered = pointDescription({
    dialog: null,
    text: 'x',
    row: { table: 'Totals', number: 2, cells: { A: '' } },
  });
  assert.equal(numbered.steps[0].text, 'expect row 2 of the "Totals" table shows "x"');

  // Quotes, line breaks and variables never reach the grammar.
  const odd = pointDescription({ dialog: null, text: 'Say "hi"\nto {{everyone}}' });
  assert.equal(odd.steps[0].text, 'expect the page shows "Say \'hi\' to { {everyone}}"');
  for (const result of [page, section, dialog, part, untitled, row, numbered, odd])
    parses(result.steps);

  assert.deepEqual(pointDescription(null), { steps: [], reason: 'nothing is at this point' });
  assert.deepEqual(pointDescription({ dialog: null }), {
    steps: [],
    reason: 'no actionable element or visible text at this point',
  });
  assert.deepEqual(pointDescription({ dialog: 'Booking', text: '' }).steps, []);
});

// ---------------------------------------------------------------------------------------------------------------
// The browser side, against the fixture's login page

let server: Server;
let origin: string;
let browser: Browser;
let page: Page;

before(async () => {
  const root = fileURLToPath(new URL('./fixture/site/', import.meta.url));
  server = createServer(async (request, response) => {
    const file = (request.url ?? '/').split('?')[0].replace(/^\/$/, '/index.html');
    try {
      const body = await readFile(new URL(`.${file}`, `file://${root}`));
      const type = file.endsWith('.js')
        ? 'text/javascript'
        : file.endsWith('.css')
          ? 'text/css'
          : 'text/html';
      response.writeHead(200, { 'content-type': type });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as { port: number };
  origin = `http://127.0.0.1:${port}`;
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`${origin}/index.html`);
});

after(async () => {
  await browser?.close();
  await new Promise<void>((done) => server?.close(() => done()));
});

/** The centre of an element in viewport CSS pixels. */
async function centre(selector: string) {
  const box = (await page.locator(selector).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
const at = async (x: number, y: number) =>
  (await page.evaluate(pointScript(x, y))) as PointHit | null;

test('the page side finds the actionable element at a point and climbs to it from its text', async () => {
  const button = await centre('#card-login');
  const card = await at(button.x, button.y);
  assert.equal(card?.element?.name, 'Sign in with staff card');
  assert.equal(card?.element?.kind, 'button');
  assert.equal(card?.element?.section, 'Staff login');
  assert.equal(card?.dialog, null);
  assert.equal(
    pointDescription(card).steps[0].text,
    'click the "Sign in with staff card" button in the "Staff login" section',
  );
  const field = await centre('#username');
  const username = await at(field.x, field.y);
  assert.equal(username?.element?.kind, 'textbox');
  assert.equal(
    pointDescription(username).steps[0].text,
    'fill the "Username" field in the "Staff login" section with ""',
  );
  // The label is not actionable: it is text in the form's section.
  const label = await centre('label[for="username"]');
  const text = await at(label.x, label.y);
  assert.equal(text?.element, undefined);
  assert.equal(text?.text, 'Username');
  assert.equal(text?.section, 'Staff login');
  assert.equal(
    pointDescription(text).steps[0].text,
    'expect the "Staff login" section shows "Username"',
  );
  // A heading names itself, scoped to the page.
  const title = await centre('h2');
  const heading = await at(title.x, title.y);
  assert.equal(heading?.text, 'Staff login');
  assert.equal(heading?.section, undefined);
  assert.equal(pointDescription(heading).steps[0].text, 'expect the page shows "Staff login"');
  // Outside the viewport, or on the bare page: nothing.
  assert.equal(await at(-5, -5), null);
  const corner = await at(2, 2);
  assert.equal(corner?.element, undefined);
  assert.equal(corner?.text, undefined);
  assert.deepEqual(pointDescription(corner).steps, []);
  assert.ok(TEXT_LIMIT >= 80);
});

test('suggest_step wording: the target changes, everything else stays as written', () => {
  const save = el({ name: 'Save', section: 'Booking' });
  const text = (written: string, element = save, dialog: string | null = 'Booking') => {
    const result = suggestedStep(written, element, dialog);
    assert.ok('text' in result, JSON.stringify(result));
    return result.text;
  };
  assert.equal(text('click "Store"'), 'click the "Save" button in the "Booking" dialog');
  assert.equal(
    text('optionally click "Store", only if a draft is shown'),
    'optionally click the "Save" button in the "Booking" dialog, only if a draft is shown',
  );
  const name = el({ kind: 'textbox', name: 'Name' });
  // The value is kept exactly, variables and passwords included.
  assert.equal(
    text('fill the "Nmae" field with "{{seed.name}}"', name, null),
    'fill the "Name" field with "{{seed.name}}"',
  );
  assert.equal(
    text('Fill the login box With "{{PASSWORD}}"', name, null),
    'Fill the "Name" field With "{{PASSWORD}}"',
  );
  const insurance = el({ kind: 'select', name: 'Insurance' });
  assert.equal(
    text('select "Private" from the "Cover" dropdown', insurance, null),
    'select "Private" from the "Insurance" dropdown',
  );
  const consent = el({ kind: 'checkbox', name: 'Consent form signed' });
  assert.equal(text('uncheck "Consent"', consent, null), 'uncheck "Consent form signed"');
  // An expect keeps its statement and `within`; its subject becomes the element.
  assert.equal(
    text('expect the "Nmae" field shows "Ana" within 5 seconds', name, null),
    'expect the "Name" field shows "Ana" within 5 seconds',
  );
  assert.equal(
    text('expect the "Is it" box is empty', name, null),
    'expect the "Name" field is empty',
  );
  // Session values become variables in the target, as a recorded step writes them; the value stays.
  const ana = el({
    kind: 'button',
    name: 'Open',
    row: { table: 'Patients', number: 1, cells: { Patient: 'Ana Petrova' } },
  });
  const variables = { seed: { patient: 'Ana Petrova' }, saved: {}, param: {} };
  const withVars = suggestedStep('click "Open" in the row for "Ana"', ana, null, variables);
  assert.deepEqual(withVars, { text: 'click the "Open" button in the row for "{{seed.patient}}"' });
  for (const written of ['click "Store"', 'expect the page shows "x" within 3 seconds'])
    assert.notEqual(parseStep(text(written)).kind, undefined);
  // Nothing to rewrite: refused with a hint.
  const refused = suggestedStep('expect "Saved"', name, null);
  assert.ok('error' in refused && refused.hint);
  const press = suggestedStep('press "Enter"', name, null);
  assert.ok('error' in press);
});
