// The recorder (docs/develop-mode.md, section 3.4): raw browser actions become grammar-valid steps. The coalescing is
// tested on synthetic actions; the browser side in a real Chromium with trusted input against the fixture's record.html.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from '@playwright/test';

process.env.AT_APP_DIR = fileURLToPath(new URL('./fixture/', import.meta.url));
process.env.AT_DECIDER = 'stub';
// `{{PASSWORD}}` is an environment variable to the parser; recorded password steps must parse where it is set.
process.env.PASSWORD ??= 'not-a-real-password';
const { Recorder, StepCoalescer, stepText, recorderInitScript, RECORDER_BINDING } =
  await import('../src/develop/recorder.ts');
const { parseStep } = await import('../src/parse.ts');
import type { RawAction } from '../src/develop/recorder.ts';
import type { RecordedStep } from '../src/develop/protocol.ts';
import type { SnapElement } from '../src/snapshot.ts';

const parses = (steps: RecordedStep[]) => {
  for (const step of steps) {
    const parsed = parseStep(step.text);
    assert.equal(parsed.kind, step.kind, step.text);
  }
};

// ---------------------------------------------------------------------------------------------------------------
// stepText

const el = (e: Partial<SnapElement>): SnapElement => ({ id: 'e1', kind: 'button', name: '', ...e });

test('stepText writes the quoted label, the kind word and the context of each kind', () => {
  const cases: [Parameters<typeof stepText>, string][] = [
    [
      ['click', el({ name: 'Save', section: 'Booking' }), undefined, { dialog: 'Booking' }],
      'click the "Save" button in the "Booking" dialog',
    ],
    [
      ['click', el({ name: 'Save', section: 'Booking' })],
      'click the "Save" button in the "Booking" section',
    ],
    [['click', el({ name: 'Home', kind: 'link' })], 'click the "Home" link'],
    [['click', el({ name: 'Deferrals', tab: true })], 'click the "Deferrals" tab'],
    [['click', el({ name: '', icon: 'close' })], 'click the "close" icon button'],
    [['click', el({ name: '', near: 'Version' })], 'click the button next to "Version"'],
    [
      [
        'click',
        el({
          name: 'Edit',
          row: {
            table: 'Patients',
            number: 1,
            cells: { Patient: 'Ana Petrova', Status: 'Scheduled' },
          },
        }),
      ],
      'click the "Edit" button in the row for "Ana Petrova"',
    ],
    [
      [
        'click',
        el({
          name: 'Edit',
          row: { table: 'Patients', number: 2, cells: { Patient: '' }, column: 'Notes' },
        }),
      ],
      'click the "Edit" button in the "Notes" column of row 2 of the "Patients" table',
    ],
    [
      ['fill', el({ kind: 'textbox', name: 'MRN' }), 'ABC1234'],
      'fill the "MRN" field with "ABC1234"',
    ],
    [
      ['fill', el({ kind: 'textbox', name: '', section: 'field "Reason"' }), 'cough'],
      'fill the "Reason" field with "cough"',
    ],
    [
      ['fill', el({ kind: 'textbox', name: 'Password', secret: true }), 'hunter2'],
      'fill the "Password" field with "{{PASSWORD}}"',
    ],
    [
      ['select', el({ kind: 'select', name: 'Ethnicity' }), 'Māori'],
      'select "Māori" in the "Ethnicity" dropdown',
    ],
    [['check', el({ kind: 'checkbox', name: 'I consent to enrol' })], 'check "I consent to enrol"'],
    [
      ['uncheck', el({ kind: 'checkbox', name: 'I consent to enrol', section: 'Consent' })],
      'uncheck "I consent to enrol" in the "Consent" section',
    ],
    [
      ['check', el({ kind: 'radio', name: 'Yes', section: 'question "Any allergies?"' })],
      'check the "Yes" radio button in the "Any allergies?" question',
    ],
    [['press', el({}), 'Enter'], 'press "Enter"'],
    [['open', el({}), '/app/home?tab=1'], 'open "/app/home?tab=1"'],
    [
      ['click', el({ name: 'Next', section: 'open calendar' })],
      'click the "Next" button in the open calendar',
    ],
    [
      ['click', el({ name: 'Cancel', section: 'Booking' }), undefined, { dialog: 'Review' }],
      'click the "Cancel" button in the "Booking" section of the "Review" dialog',
    ],
    // A required field's marker is not part of its label.
    [
      [
        'check',
        el({ kind: 'checkbox', name: 'I consent to enrol with the screening programme *' }),
      ],
      'check "I consent to enrol with the screening programme"',
    ],
    // A card's text that changes daily: its first sentence names it. A long checkbox label stays whole.
    [
      [
        'click',
        el({
          name: 'Harbour Imaging Northside. Fixed. 12 Example Street, Northside, 1010. Next available appointment Tuesday 03 November 2026',
        }),
      ],
      'click the "Harbour Imaging Northside" button',
    ],
    [
      [
        'check',
        el({
          kind: 'checkbox',
          name: 'I agree that by booking my appointment, I consent to be screened. Read more about screening.',
        }),
      ],
      'check "I agree that by booking my appointment, I consent to be screened. Read more about screening."',
    ],
  ];
  for (const [args, expected] of cases) {
    const text = stepText(...args);
    assert.equal(text, expected);
    assert.equal(parseStep(text).kind, args[0]);
  }
});

test('stepText never writes what the grammar cannot read: quotes, line breaks, variables', () => {
  const cases: Parameters<typeof stepText>[] = [
    ['click', el({ name: 'Say "hi" {{now}}' })],
    [
      'fill',
      el({ kind: 'textbox', name: 'Notes "x"' }),
      'line one\nline two with "quotes" and {{seed.x}}',
    ],
    ['fill', el({ kind: 'textbox', name: 'A' }), ''],
    ['select', el({ kind: 'select', name: 'Pick "one"' }), 'Option "A"'],
    ['select', el({ kind: 'select', name: 'Pick' }), ''],
    ['open', el({}), '/a"b'],
    ['click', el({ name: '', row: { table: '', number: 1, cells: { x: 'Ann "A" B' } } })],
  ];
  for (const args of cases) {
    const text = stepText(...args);
    assert.equal(parseStep(text).kind, args[0], text);
  }
  assert.equal(
    stepText('fill', el({ kind: 'textbox', name: 'Notes' }), 'a\nb'),
    'fill the "Notes" field with "a b"',
  );
});

// ---------------------------------------------------------------------------------------------------------------
// Coalescing, without a browser

let clock = 1_000_000;
const textbox = el({ id: 'e3', kind: 'textbox', name: 'MRN', section: 'Enrolment' });
const raw = (action: Partial<RawAction> & Pick<RawAction, 'type'>, gap = 20): RawAction => ({
  at: (clock += gap),
  url: 'http://app.test/enrol',
  key: 1,
  elementId: 'e3',
  kind: 'textbox',
  element: textbox,
  tag: 'input',
  ...action,
});
const run = (actions: RawAction[], origin?: string) => {
  const steps: RecordedStep[] = [];
  const coalescer = new StepCoalescer((s) => steps.push(s));
  coalescer.origin = origin;
  for (const a of actions) coalescer.push(a);
  coalescer.finish();
  parses(steps);
  return steps;
};

test('a click into a textbox and the typing after it are one fill with the final value', () => {
  const steps = run([
    raw({ type: 'click' }),
    raw({ type: 'input', value: 'A' }),
    raw({ type: 'input', value: 'AB' }),
    raw({ type: 'input', value: 'ABC1234' }),
    raw({ type: 'change', value: 'ABC1234' }),
  ]);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].kind, 'fill');
  assert.equal(steps[0].text, 'fill the "MRN" field in the "Enrolment" section with "ABC1234"');
  assert.equal(steps[0].value, 'ABC1234');
  assert.equal(steps[0].elementId, 'e3');
  assert.equal(steps[0].description, 'textbox "MRN" — in Enrolment');
});

test('clicking into a field and leaving it unchanged records nothing; typing without a click is a fill', () => {
  assert.deepEqual(
    run([
      raw({ type: 'click' }),
      raw({ type: 'click', kind: 'button', element: el({ name: 'Cancel' }), key: 2 }),
    ]).map((s) => s.kind),
    ['click'],
  );
  assert.deepEqual(
    run([raw({ type: 'input', value: 'x' })]).map((s) => s.text),
    ['fill the "MRN" field in the "Enrolment" section with "x"'],
  );
});

test('typing in two fields is two fills, in order, and a button click flushes the field first', () => {
  const other = el({ id: 'e4', kind: 'textbox', name: 'Email' });
  const steps = run([
    raw({ type: 'input', value: 'a' }),
    raw({ type: 'input', value: 'b', key: 2, elementId: 'e4', element: other }),
    raw({ type: 'click', key: 3, kind: 'button', element: el({ id: 'e5', name: 'Save' }) }),
  ]);
  assert.deepEqual(
    steps.map((s) => s.text),
    [
      'fill the "MRN" field in the "Enrolment" section with "a"',
      'fill the "Email" field with "b"',
      'click the "Save" button',
    ],
  );
  assert.ok(steps[0].at < steps[1].at && steps[1].at < steps[2].at);
});

test('Enter in a textbox is press "Enter" after its fill, and the change that follows is not a second fill', () => {
  const steps = run([
    raw({ type: 'input', value: 'ABC' }),
    raw({ type: 'key', keyName: 'Enter', value: 'ABC' }),
    raw({ type: 'change', value: 'ABC' }, 1),
    raw({
      type: 'key',
      keyName: 'Escape',
      kind: undefined,
      element: undefined,
      key: undefined,
      elementId: undefined,
    }),
  ]);
  assert.deepEqual(
    steps.map((s) => [s.kind, s.text]),
    [
      ['fill', 'fill the "MRN" field in the "Enrolment" section with "ABC"'],
      ['press', 'press "Enter"'],
      ['press', 'press "Escape"'],
    ],
  );
  // Typing the same value again afterwards is a new fill.
  assert.equal(
    run([
      raw({ type: 'input', value: 'ABC' }),
      raw({ type: 'change', value: 'ABC' }),
      raw({ type: 'input', value: 'ABC' }),
      raw({ type: 'change', value: 'ABC' }),
    ]).length,
    2,
  );
});

test('a native select is one select with the option label; opening it or choosing nothing is not a step', () => {
  const select = el({ id: 'e4', kind: 'select', name: 'Ethnicity' });
  const steps = run([
    raw({ type: 'click', kind: 'select', element: select, tag: 'select', key: 2 }),
    raw({ type: 'change', kind: 'select', element: select, tag: 'select', key: 2, value: 'Māori' }),
    raw({ type: 'change', kind: 'select', element: select, tag: 'select', key: 2, value: '' }),
  ]);
  assert.deepEqual(
    steps.map((s) => s.text),
    ['select "Māori" in the "Ethnicity" dropdown'],
  );
  assert.equal(steps[0].value, 'Māori');
  // A custom dropdown opened and left open when the recording stops is the click that opened it.
  const custom = el({ id: 'e5', kind: 'select', name: 'Clinic' });
  assert.deepEqual(
    run([raw({ type: 'click', kind: 'select', element: custom, tag: 'div', key: 3 })]).map(
      (s) => s.text,
    ),
    ['click the "Clinic" dropdown'],
  );
});

// A custom dropdown (a beyond-select, mat-select, p-select): its trigger, and an option of its open panel.
const status = el({ id: 'e46', kind: 'select', name: 'Screening Status', section: 'DNA worklist' });
const openStatus = (gap?: number) =>
  raw(
    { type: 'click', kind: 'select', element: status, elementId: 'e46', tag: 'input', key: 7 },
    gap,
  );
const option = (value: string, extra: Partial<RawAction> = {}) =>
  raw({
    type: 'option',
    value,
    kind: undefined,
    element: undefined,
    elementId: undefined,
    key: undefined,
    tag: undefined,
    ...extra,
  });

test('opening a custom dropdown and clicking an option is one select of that option in that dropdown', () => {
  const steps = run([openStatus(), option('Assigned to screening organization')]);
  assert.deepEqual(
    steps.map((s) => [s.kind, s.text]),
    [
      [
        'select',
        'select "Assigned to screening organization" in the "Screening Status" dropdown in the "DNA worklist" section',
      ],
    ],
  );
  assert.equal(steps[0].value, 'Assigned to screening organization');
  assert.equal(steps[0].elementId, 'e46'); // verified against the dropdown, as the select step resolves it
  // In a dialog the dropdown keeps the dialog in its context.
  const inDialog = el({ id: 'e9', kind: 'select', name: 'Site', section: 'Book a slot' });
  assert.deepEqual(
    run([
      raw({
        type: 'click',
        kind: 'select',
        element: inDialog,
        tag: 'mat-select',
        key: 9,
        dialog: 'Book a slot',
      }),
      option('Riverside'),
    ]).map((s) => s.text),
    ['select "Riverside" in the "Site" dropdown in the "Book a slot" dialog'],
  );
});

test('each option picked in an open multi-select is a select; closing it afterwards is not a step', () => {
  const save = el({ id: 'e2', name: 'Save' });
  const steps = run([
    openStatus(),
    option('Assigned to screening user', { multiple: true }),
    option('Returned to the Lead provider', { multiple: true }),
    raw({ type: 'activity', element: undefined, kind: undefined }), // the backdrop
    raw({ type: 'key', keyName: 'Escape', element: undefined, kind: undefined }),
    raw({ type: 'click', kind: 'button', element: save, key: 2 }),
  ]);
  assert.deepEqual(
    steps.map((s) => s.text),
    [
      'select "Assigned to screening user" in the "Screening Status" dropdown in the "DNA worklist" section',
      'select "Returned to the Lead provider" in the "Screening Status" dropdown in the "DNA worklist" section',
      'click the "Save" button',
    ],
  );
});

test('a dropdown opened and closed without a choice is no step; one followed by another action is the click it was', () => {
  const save = el({ id: 'e2', name: 'Save' });
  // Escape, or a second click on the trigger, closes it.
  assert.deepEqual(
    run([openStatus(), raw({ type: 'key', keyName: 'Escape', element: undefined })]),
    [],
  );
  assert.deepEqual(run([openStatus(), openStatus()]), []);
  // Something else first: the opening click is kept, so nothing the person did is lost.
  assert.deepEqual(
    run([openStatus(), raw({ type: 'click', kind: 'button', element: save, key: 2 })]).map(
      (s) => s.text,
    ),
    [
      'click the "Screening Status" dropdown in the "DNA worklist" section',
      'click the "Save" button',
    ],
  );
  // Another dropdown right after: the first one's click, then the second one's select.
  const lead = el({ id: 'e47', kind: 'select', name: 'Lead provider', section: 'DNA worklist' });
  assert.deepEqual(
    run([
      openStatus(),
      raw({ type: 'click', kind: 'select', element: lead, tag: 'input', key: 8 }),
      option('Central Screening Provider'),
    ]).map((s) => s.text),
    [
      'click the "Screening Status" dropdown in the "DNA worklist" section',
      'select "Central Screening Provider" in the "Lead provider" dropdown in the "DNA worklist" section',
    ],
  );
});

test("typing in the open dropdown's search field is part of the select, not a fill", () => {
  const search = el({ id: 'e73', kind: 'textbox', name: 'Search select options' });
  const inPanel = { element: search, kind: 'textbox' as const, key: 11, inPopup: true };
  const steps = run([
    openStatus(),
    raw({ type: 'click', ...inPanel }),
    raw({ type: 'input', ...inPanel, value: 'user' }),
    raw({ type: 'key', keyName: 'Enter', ...inPanel, value: 'user' }),
    option('Assigned to screening user', { multiple: true }),
  ]);
  assert.deepEqual(
    steps.map((s) => s.text),
    [
      'select "Assigned to screening user" in the "Screening Status" dropdown in the "DNA worklist" section',
    ],
  );
  // The same field with no dropdown seen opening is an ordinary fill.
  assert.deepEqual(
    run([
      raw({ type: 'click', ...inPanel }),
      raw({ type: 'input', ...inPanel, value: 'user' }),
    ]).map((s) => s.text),
    ['fill the "Search select options" field with "user"'],
  );
});

test('deselecting in a multi-select is written as the clicks it was, also for the options after it', () => {
  const steps = run([
    openStatus(),
    option('N/A', { multiple: true }),
    option('Assigned to screening organization', { multiple: true, selected: true }),
    option('Assigned to screening user', { multiple: true }),
  ]);
  assert.deepEqual(
    steps.map((s) => s.text),
    [
      'select "N/A" in the "Screening Status" dropdown in the "DNA worklist" section',
      'click the "Screening Status" dropdown in the "DNA worklist" section',
      'click the "Assigned to screening organization" button in the open pop-up',
      'click the "Assigned to screening user" button in the open pop-up',
    ],
  );
  // Choosing the option a single-select already shows is still that select.
  assert.deepEqual(
    run([openStatus(), option('N/A', { selected: true })]).map((s) => s.kind),
    ['select'],
  );
});

test('an option of a list nobody was seen opening is a click on it when the page lists it, else nothing', () => {
  const suggestion = el({ id: 'e20', name: 'City Hospital', section: 'open pop-up' });
  assert.deepEqual(
    run([
      option('City Hospital', {
        element: suggestion,
        kind: 'button',
        key: 20,
        elementId: 'e20',
      }),
    ]).map((s) => s.text),
    ['click the "City Hospital" button in the open pop-up'],
  );
  assert.deepEqual(run([option('Assigned to screening user')]), []);
});

test('a checkbox or radio click is check or uncheck from the state it ended in; a label and its input count once', () => {
  const box = el({ id: 'e5', kind: 'checkbox', name: 'I consent to enrol' });
  const radio = el({ id: 'e6', kind: 'radio', name: 'Yes' });
  const toggle = (checked: boolean, gap?: number) =>
    raw({ type: 'toggle', kind: 'checkbox', element: box, key: 5, tag: 'input', checked }, gap);
  const steps = run([
    toggle(true),
    toggle(true, 5), // the click the browser forwards from the label to the input
    toggle(false, 500),
    raw({ type: 'toggle', kind: 'radio', element: radio, key: 6, tag: 'input', checked: true }),
  ]);
  assert.deepEqual(
    steps.map((s) => [s.kind, s.text]),
    [
      ['check', 'check "I consent to enrol"'],
      ['uncheck', 'uncheck "I consent to enrol"'],
      ['check', 'check the "Yes" radio button'],
    ],
  );
});

test('a button or link click is a click; a click the page has no element for never reaches the recorder', () => {
  const steps = run([
    raw({
      type: 'click',
      kind: 'button',
      element: el({ id: 'e1', name: 'Save', section: 'Booking' }),
      key: 2,
    }),
    raw({
      type: 'click',
      kind: 'link',
      element: el({ id: 'e2', kind: 'link', name: 'Home' }),
      key: 3,
    }),
    raw({ type: 'activity', kind: undefined, element: undefined }),
  ]);
  assert.deepEqual(
    steps.map((s) => s.text),
    ['click the "Save" button in the "Booking" section', 'click the "Home" link'],
  );
});

test('a password is a secret fill with {{PASSWORD}} and no value anywhere in the step', () => {
  const field = el({
    id: 'e7',
    kind: 'textbox',
    name: 'Password',
    secret: true,
    value: '(hidden)',
  });
  const steps = run([
    raw({ type: 'input', element: field, isPassword: true, value: '' }),
    raw({ type: 'change', element: field, isPassword: true, value: '' }),
  ]);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].text, 'fill the "Password" field with "{{PASSWORD}}"');
  assert.equal(steps[0].secret, true);
  assert.ok(!('value' in steps[0]));
  assert.ok(!JSON.stringify(steps[0]).includes('hidden'));
});

test('a navigation nobody clicked is open "<path>"; one a click led to, or back/forward, is not', () => {
  const nav = (extra: Partial<RawAction>, gap = 5000): RawAction => ({
    type: 'navigate',
    via: 'load',
    at: (clock += gap),
    url: 'http://app.test/worklist?day=1#top',
    navType: 'navigate',
    referrer: '',
    ...extra,
  });
  const origin = 'http://app.test';
  assert.deepEqual(
    run([nav({})], origin).map((s) => s.text),
    ['open "/worklist?day=1#top"'],
  );
  assert.deepEqual(
    run([nav({ navType: 'reload', referrer: 'http://app.test/x' })], origin).map((s) => s.kind),
    ['open'],
  );
  assert.deepEqual(run([nav({ referrer: 'http://app.test/x' })], origin), []); // a link
  assert.deepEqual(run([nav({ navType: 'back_forward' })], origin), []);
  // A hash change right after the person's click is that click's effect.
  const click = raw({
    type: 'click',
    kind: 'link',
    element: el({ name: 'Go', kind: 'link' }),
    key: 2,
  });
  assert.deepEqual(
    run([click, nav({ via: 'hashchange' }, 100)], origin).map((s) => s.kind),
    ['click'],
  );
  assert.deepEqual(
    run([nav({ url: 'https://idp.test/login' })], origin).map((s) => s.text),
    ['open "https://idp.test/login"'],
  );
  // Without a known origin the first one fixes it.
  assert.deepEqual(
    run([nav({}), nav({ url: 'http://app.test/other' })]).map((s) => s.text),
    ['open "/worklist?day=1#top"', 'open "/other"'],
  );
});

// ---------------------------------------------------------------------------------------------------------------
// The browser side, in a real Chromium

let browser: Browser;
let page: Page;
let server: Server;
let base: string;
before(async () => {
  const root = fileURLToPath(new URL('./fixture/site/', import.meta.url));
  const types: Record<string, string> = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
  };
  server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    try {
      const body = await readFile(root + path);
      res.writeHead(200, {
        'content-type': types[path.slice(path.lastIndexOf('.'))] ?? 'text/plain',
      });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch();
  page = await browser.newPage();
});
after(async () => {
  await browser?.close();
  server?.close();
});

test('the init script is self-contained source that carries collectElements and the binding name', () => {
  const source = recorderInitScript();
  assert.ok(source.includes('data-at-id'));
  assert.ok(source.includes(JSON.stringify(RECORDER_BINDING)));
  assert.doesNotThrow(() => new Function(source));
});

test('what a person does on the page becomes steps; plain text and stopped recording record nothing', async () => {
  await page.goto(`${base}/record.html`);
  const seen: RecordedStep[] = [];
  const recorder = new Recorder(page, (s) => seen.push(s));
  await recorder.start();

  // Plain text, then the form: text fields, the password, a native select (opened, then chosen with the keyboard).
  await page.mouse.click(...(await centre('#plain-text')));
  assert.deepEqual(recorder.steps(), []);
  await page.mouse.click(...(await centre('#mrn')));
  await page.keyboard.type('ABC1234');
  await page.mouse.click(...(await centre('#password')));
  await page.keyboard.type('hunter2-secret');
  await page.keyboard.press('Tab'); // leaves the password: its change commits the fill
  await page.mouse.click(...(await centre('#ethnicity')));
  if (process.platform === 'darwin') {
    // Headless Chromium on macOS opens no popup and ignores arrow keys on a native select, and Enter would submit the
    // form; typing an option's first letter chooses it with a trusted change event.
    await page.keyboard.type('M');
  } else {
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
  }
  assert.equal(await page.inputValue('#ethnicity'), 'Māori');
  await page.mouse.click(...(await centre('#consent')));
  await page.mouse.click(...(await centre('#consent')));
  await page.mouse.click(...(await centre('#book')));
  await page.mouse.click(...(await centre('#open-dialog')));
  await page.mouse.click(...(await centre('#dialog-save')));
  await page.mouse.click(...(await centre('[data-row="Ana Petrova"]')));
  await page.mouse.click(...(await centre('#mrn')));
  await page.keyboard.press('Enter'); // submits the form: the browser clicks its default button, which is not a step
  await page.waitForTimeout(100);

  const steps = recorder.steps();
  assert.deepEqual(seen, steps);
  parses(steps);
  assert.deepEqual(
    steps.map((s) => [s.kind, s.text]),
    [
      ['fill', 'fill the "MRN" field in the "Enrolment" section with "ABC1234"'],
      ['fill', 'fill the "Password" field in the "Enrolment" section with "{{PASSWORD}}"'],
      ['select', 'select "Māori" in the "Ethnicity" dropdown in the "Enrolment" section'],
      ['check', 'check "I consent to enrol" in the "Enrolment" section'],
      ['uncheck', 'uncheck "I consent to enrol" in the "Enrolment" section'],
      ['click', 'click the "Book slot" button in the "Booking" section'],
      ['click', 'click the "Review booking" button in the "Booking" section'],
      ['click', 'click the "Save" button in the "Booking" dialog'],
      ['click', 'click the "Edit" button in the row for "Ana Petrova"'],
      ['press', 'press "Enter"'],
    ],
  );
  assert.equal(await page.textContent('#log'), 'Enrolled ABC1234');

  const password = steps[1];
  assert.equal(password.secret, true);
  assert.ok(!('value' in password));
  assert.ok(!JSON.stringify(steps).includes('hunter2'));
  assert.equal(steps[0].value, 'ABC1234');
  assert.equal(steps[0].elementId, 'e1');
  assert.match(steps[0].description ?? '', /^textbox "MRN"/);
  assert.equal(new Set(steps.map((s) => s.at)).size, steps.length);

  // After stop() the page is not recorded any more, and clear() empties what was.
  await recorder.stop();
  await page.mouse.click(...(await centre('#book')));
  await page.waitForTimeout(100);
  assert.equal(recorder.steps().length, steps.length);
  recorder.clear();
  assert.deepEqual(recorder.steps(), []);
});

test('links, typed addresses and later documents: a link click is a click, a typed address is open, later documents stay recorded', async () => {
  await page.goto(`${base}/record.html`);
  const recorder = new Recorder(page, () => undefined);
  await recorder.start();

  await page.mouse.click(...(await centre('#to-top'))); // a hash link: not an address-bar change
  await page.mouse.click(...(await centre('#again'))); // a link to another document
  await page.waitForURL(`${base}/record.html?again=1`);
  await page.mouse.click(...(await centre('#book'))); // the init script ran in this new document
  await page.waitForTimeout(1200); // longer than a click's navigation window
  await page.goto(`${base}/index.html`);
  await page.waitForTimeout(100);

  const steps = recorder.steps();
  parses(steps);
  assert.deepEqual(
    steps.map((s) => s.text),
    [
      'click the "Back to top" link in the "Booking" section',
      'click the "Practice again" link in the "Booking" section',
      'click the "Book slot" button in the "Booking" section',
      'open "/index.html"',
    ],
  );
  await recorder.stop();
});

test('start can be called again after stop on the same page, and a click on an unlisted element is ignored', async () => {
  await page.goto(`${base}/record.html`);
  const first = new Recorder(page, () => undefined);
  await first.start();
  await first.stop();
  const second = new Recorder(page, () => undefined);
  await second.start();
  await page.mouse.click(...(await centre('h1'))); // a heading is not an element the resolver lists
  await page.mouse.click(...(await centre('#book')));
  await page.waitForTimeout(100);
  assert.deepEqual(first.steps(), []);
  assert.deepEqual(
    second.steps().map((s) => s.kind),
    ['click'],
  );
  await second.stop();
});

test('custom dropdowns in a real page: opening one and clicking options are selects, its search and Escape are not steps', async () => {
  await page.goto(`${base}/record-dropdowns.html`);
  const recorder = new Recorder(page, () => undefined);
  await recorder.start();
  const option = (label: string) => page.locator('.beyond-option', { hasText: label });
  // Open "Screening Status" on its input and click an option's text, then another option's checkbox (the pointer passes
  // through it to the row, as in a beyond-select).
  await page.mouse.click(...(await centre('#screening')));
  await page.mouse.click(
    ...(await centre('.beyond-option:has-text("Assigned to screening organization") div')),
  );
  await page.mouse.click(
    ...(await centre('.beyond-option:has-text("Assigned to screening user") .mat-checkbox')),
  );
  // Narrow the list with its search field, choose, and close the panel with Escape.
  await page.mouse.click(...(await centre('#screening-search')));
  await page.keyboard.type('Ret');
  await option('Returned to the Lead provider').click();
  await page.keyboard.press('Escape');
  // Open it again on its arrow icon (the form field around the input), deselect one and close it again.
  await page.mouse.click(...(await centre('#screening-arrow')));
  await page.mouse.click(
    ...(await centre('.beyond-option:has-text("Assigned to screening user")')),
  );
  await page.keyboard.press('Escape');
  // A single-select combobox with role="option" items; the icon in an option is not part of its label.
  await page.mouse.click(...(await centre('#clinic')));
  await page.mouse.click(...(await centre('[role="option"]:has-text("Wellington")')));
  await page.mouse.click(...(await centre('#maori')));
  await page.mouse.click(...(await centre('#search')));
  await page.waitForTimeout(200);
  await recorder.stop();
  assert.equal(
    await page.locator('#screening').inputValue(),
    'Assigned to screening organization, Returned to the Lead provider',
  );
  const steps = recorder.steps();
  parses(steps);
  assert.deepEqual(
    steps.map((s) => s.text),
    [
      'select "Assigned to screening organization" in the "Screening Status" dropdown in the "DNA worklist" section',
      'select "Assigned to screening user" in the "Screening Status" dropdown in the "DNA worklist" section',
      'select "Returned to the Lead provider" in the "Screening Status" dropdown in the "DNA worklist" section',
      'click the "Screening Status" dropdown in the "DNA worklist" section',
      'click the "Assigned to screening user" button in the open pop-up',
      'select "Wellington" in the "Clinic" dropdown in the "DNA worklist" section',
      'check "Māori" in the "DNA worklist" section',
      'click the "Search" button in the "DNA worklist" section',
    ],
  );
  assert.deepEqual(
    steps.slice(0, 3).map((s) => s.description),
    Array(3).fill(steps[0].description),
  );
  assert.match(steps[0].description ?? '', /select "Screening Status"/);
});

async function centre(selector: string): Promise<[number, number]> {
  const box = await page.locator(selector).first().boundingBox();
  assert.ok(box, `${selector} is not visible`);
  return [box.x + box.width / 2, box.y + box.height / 2];
}
