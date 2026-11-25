// Parser unit tests: the markdown test format (docs/test-format.md) without a browser or a model.
// Run: node --test "engine/test/**/*.test.ts"   (or npm test)
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import {
  annotatedCase,
  clientTestId,
  expandExamples,
  findTestFiles,
  missingUploads,
  narrow,
  notShownStatement,
  parseAll,
  selectCases,
  ParseError,
  parseStep,
  withoutDrafts,
} from '../src/parse.ts';
import { loadSuite, resolveRows } from '../src/parameters.ts';

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A temporary app folder with these files (path → content). */
function app(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'intent-parse-'));
  dirs.push(dir);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

describe('parseStep', () => {
  test('every verb', () => {
    assert.deepEqual(parseStep('open "/app/home"'), { kind: 'open', path: '/app/home' });
    assert.deepEqual(parseStep('click the "Submit" button'), {
      kind: 'click',
      target: 'the "Submit" button',
    });
    assert.deepEqual(parseStep('fill the MRN field with "ABC1234"'), {
      kind: 'fill',
      target: 'the MRN field',
      value: 'ABC1234',
    });
    assert.deepEqual(parseStep('fill the note with ""'), {
      kind: 'fill',
      target: 'the note',
      value: '',
    });
    assert.deepEqual(parseStep('select "Māori" in the ethnicity dropdown'), {
      kind: 'select',
      option: 'Māori',
      target: 'the ethnicity dropdown',
    });
    assert.deepEqual(parseStep('select "Public" from insurance'), {
      kind: 'select',
      option: 'Public',
      target: 'insurance',
    });
    assert.deepEqual(parseStep('check "I agree"'), { kind: 'check', target: '"I agree"' });
    assert.deepEqual(parseStep('uncheck "I agree"'), { kind: 'uncheck', target: '"I agree"' });
    assert.deepEqual(
      parseStep('drag the "Jane Doe" appointment to the "Tue 03 Nov 11:30 AM" slot for "Dr Smith"'),
      {
        kind: 'drag',
        source: 'the "Jane Doe" appointment',
        target: 'the "Tue 03 Nov 11:30 AM" slot for "Dr Smith"',
      },
    );
    // Only a " to " outside quotes separates the two ends.
    assert.deepEqual(parseStep('Drag "Move to ward" To the "Ward 3" slot'), {
      kind: 'drag',
      source: '"Move to ward"',
      target: 'the "Ward 3" slot',
    });
    assert.deepEqual(parseStep('press "Escape"'), { kind: 'press', key: 'Escape' });
    assert.deepEqual(parseStep('expect the list is empty'), {
      kind: 'expect',
      assertion: 'the list is empty',
    });
    assert.deepEqual(parseStep('expect the list is empty within 20 seconds'), {
      kind: 'expect',
      assertion: 'the list is empty',
      withinSeconds: 20,
    });
    assert.deepEqual(parseStep('wait 1.5 seconds'), { kind: 'wait', seconds: 1.5 });
    assert.deepEqual(parseStep('use "log in"'), { kind: 'use', block: 'log in' });
    assert.deepEqual(parseStep('switch to session "log in as nurse"'), {
      kind: 'switch',
      session: 'log in as nurse',
    });
    assert.deepEqual(parseStep('switch to window "log in as second radiologist"'), {
      kind: 'window',
      session: 'log in as second radiologist',
    });
    assert.deepEqual(parseStep('Switch To Window "log in as nurse"'), {
      kind: 'window',
      session: 'log in as nurse',
    });
    assert.deepEqual(parseStep('call post "/api/jobs/run"'), {
      kind: 'call',
      method: 'POST',
      path: '/api/jobs/run',
    });
    assert.deepEqual(parseStep('call GET "/api/me" and save "data.id" as "userId"'), {
      kind: 'call',
      method: 'GET',
      path: '/api/me',
      save: { field: 'data.id', name: 'userId' },
    });
  });

  test('optionally, only for element steps', () => {
    assert.deepEqual(parseStep('optionally click "Next dates", only if the day is not shown'), {
      kind: 'click',
      target: '"Next dates", only if the day is not shown',
      optional: true,
    });
    assert.throws(
      () => parseStep('optionally expect the list is empty'),
      /only click, fill, select, check, uncheck steps can be optional/,
    );
    assert.throws(
      () => parseStep('optionally drag "Jane Doe" to the "Tue 03 Nov 11:30 AM" slot'),
      /only click, fill, select, check, uncheck steps can be optional/,
    );
  });

  test('environment variables are filled in at parse time; seed and saved values are left for the run', () => {
    process.env.PARSE_TEST_USER = 'nurse1';
    assert.deepEqual(parseStep('fill username with "{{PARSE_TEST_USER}}"'), {
      kind: 'fill',
      target: 'username',
      value: 'nurse1',
    });
    assert.deepEqual(parseStep('click "{{seed.name}}" in row "{{saved.id}}"'), {
      kind: 'click',
      target: '"{{seed.name}}" in row "{{saved.id}}"',
    });
    assert.throws(
      () => parseStep('open "{{PARSE_TEST_MISSING}}"', 'f.md:3'),
      /f\.md:3: environment variable PARSE_TEST_MISSING is not set/,
    );
  });

  test('malformed steps say how to write them', () => {
    assert.throws(() => parseStep('fill username'), /fill needs a quoted value/);
    assert.throws(() => parseStep('select Public in insurance'), /select needs the form/);
    assert.throws(() => parseStep('call FETCH "/x"'), /call needs the form/);
    for (const step of ['switch to window', 'switch to window log in as nurse'])
      assert.throws(
        () => parseStep(step, 'f.md:7'),
        (e: Error) =>
          e instanceof ParseError &&
          /^f\.md:7: switch to window needs the form: switch to window "<steps name>"/.test(
            e.message,
          ),
      );
    assert.throws(
      () => parseStep('jump over the card'),
      (e: Error) =>
        e instanceof ParseError &&
        /unknown step "jump over the card"\. Allowed:.*drag … to …/.test(e.message),
    );
    for (const step of [
      'drag the card',
      'drag "Move to ward"',
      'drag "Jane Doe" to ',
      'drag to "Dr Smith"',
    ])
      assert.throws(
        () => parseStep(step, 'f.md:4'),
        (e: Error) =>
          e instanceof ParseError &&
          /^f\.md:4: drag needs the form: drag <element> to <slot>/.test(e.message),
      );
  });
});

describe('parseAll', () => {
  const shared = `# Shared\n\n## Steps: log in\n1. open "/"\n2. fill username with "a"\n3. fill password with "b"\n4. click "Log in"\n\n## Steps: go home\n1. use "log in"\n2. open "/home"\n`;

  test('tests, tags, seeds, sessions and expanded blocks', () => {
    const dir = app({
      'shared/login.md': shared,
      'area/a-01-first.md': `# A-01\nAny text.\n\n## Test: First\nid: t1\nseed: "a seed"\nsession: log in\ntags: exclusive @expect-fail\nNote: ignored\n1. use "go home"\n2. switch to session "log in"\n3. expect done\n`,
    });
    const suite = parseAll(dir);
    assert.equal(suite.files.length, 2);
    const tc = suite.files.find((f) => f.rel.startsWith('area'))!.cases[0];
    assert.equal(tc.name, 'First');
    assert.equal(tc.seed, 'a seed');
    assert.equal(tc.session, 'log in');
    assert.deepEqual(tc.tags, ['@exclusive', '@expect-fail']);
    assert.equal(tc.expectFail, true);
    assert.deepEqual(
      tc.steps.map((s) => s.label),
      ['1.1.1', '1.1.2', '1.1.3', '1.1.4', '1.2', '2', '3'],
    );
    assert.deepEqual(
      tc.steps.map((s) => s.number),
      [1, 2, 3, 4, 5, 6, 7],
    );
    assert.equal(tc.steps[4].text, 'go home › open "/home"');
    assert.deepEqual(suite.sessions, ['log in']);
    assert.deepEqual([...suite.blocks.keys()], ['log in', 'go home']);
  });

  test('docs, docs/, reports and hidden folders are not test files', () => {
    const dir = app({
      'README.md': '## Test: not a test\n1. open "/"\n',
      'AGENTS.md': '## Test: not a test\n1. open "/"\n',
      'docs/analysis.md': '## Test: not a test\n1. open "/"\n',
      'reports/test-results/x/error-context.md': '## Test: not a test\n1. open "/"\n',
      '.hidden/x.md': '## Test: not a test\n1. open "/"\n',
      'b.md': '## Test: real\nid: t7\n1. open "/"\n',
    });
    assert.deepEqual(
      findTestFiles(dir).map((f) => f.slice(dir.length + 1)),
      ['b.md'],
    );
  });

  test('errors carry file and line', () => {
    const cases: [Record<string, string>, RegExp][] = [
      [
        { 'a.md': '## Test: T\nid: t8\n1. open "/"\n3. open "/"\n' },
        /a\.md:4: step numbered 3, expected 2/,
      ],
      [
        { 'a.md': '## Test: T\nid: t9\n1. open "/"\n## Test: T\nid: t10\n1. open "/"\n' },
        /a\.md:4: duplicate test name "T"/,
      ],
      [{ 'a.md': '## Test: T\nid: t11\n' }, /a\.md:1: test "T" has no steps/],
      [
        { 'a.md': '## Test: T\nid: t12\nsession: nobody\n1. open "/"\n' },
        /a\.md:1: session "nobody" is not defined/,
      ],
      [{ 'a.md': '## Test: T\nid: t13\n1. use "missing"\n' }, /a\.md:3: unknown steps "missing"/],
      [
        {
          'a.md':
            '## Steps: x\n1. use "y"\n## Steps: y\n1. use "x"\n## Test: T\nid: t14\n1. use "x"\n',
        },
        /use themselves/,
      ],
      [
        { 'a.md': '## Steps: x\n1. open "/"\n', 'b.md': '## Steps: x\n1. open "/"\n' },
        /steps "x" are already defined at a\.md:1/,
      ],
      [
        { 'a.md': '## Steps: x\ntags: @a\n1. open "/"\n' },
        /a\.md:2: "tags:" is only allowed in a "## Test:" section/,
      ],
      [
        { 'a.md': '## Test: Lonely\n1. open "/"\n' },
        /a\.md:1: test "Lonely" has no id.*intent-test ids --write <paths>/,
      ],
      [{ 'notes.txt': 'x' }, /no \.md test files/],
    ];
    for (const [files, error] of cases) assert.throws(() => parseAll(app(files)), error);
  });
});

describe('narrow', () => {
  test('keeps the files under the path, all blocks, and only the sessions those tests use', () => {
    const dir = app({
      'shared/login.md': '## Steps: as a\n1. open "/a"\n\n## Steps: as b\n1. open "/b"\n',
      'one/t.md': '## Test: One\nid: t15\nsession: as a\n1. open "/"\n',
      'two/t.md': '## Test: Two\nid: t16\nsession: as b\n1. open "/"\n',
    });
    const all = parseAll(dir);
    const one = narrow(all, join(dir, 'one'));
    assert.deepEqual(
      one.files.map((f) => f.rel),
      [join('one', 't.md')],
    );
    assert.equal(one.blocks.size, 2);
    assert.deepEqual(one.sessions, ['as a']);
    assert.equal(narrow(all, null), all);
    assert.throws(() => narrow(all, join(dir, 'three')), /no \.md test files at/);
  });
});

describe('switch to window', () => {
  const login =
    '## Steps: as a\n1. open "/a"\n\n## Steps: as b\n1. open "/b"\n\n## Steps: as c\n1. open "/c"\n';

  test('its session counts as used, by narrow, case selection and drafts', () => {
    const dir = app({
      'shared/login.md': login,
      'one/t.md':
        '## Test: One\nid: w1\nsession: as a\n1. open "/"\n2. switch to window "as b"\n3. switch to window "as a"\n',
      'two/t.md': '## Test: Two\nid: w2\nsession: as c\n1. open "/"\n',
      'three/t.md':
        '## Test: Three\nid: w3\ntags: @draft\nsession: as c\n1. switch to window "as a"\n',
    });
    const all = parseAll(dir);
    assert.deepEqual(all.sessions, ['as a', 'as b', 'as c']);
    const one = all.files.find((f) => f.rel === join('one', 't.md'))!.cases[0];
    assert.deepEqual(
      one.steps.map((s) => [s.kind, 'session' in s ? s.session : undefined]),
      [
        ['open', undefined],
        ['window', 'as b'],
        ['window', 'as a'],
      ],
    );
    assert.deepEqual(narrow(all, join(dir, 'one')).sessions, ['as a', 'as b']);
    assert.deepEqual(selectCases(all, 'w1').sessions, ['as a', 'as b']);
    assert.deepEqual(selectCases(all, 'w2').sessions, ['as c']);
    assert.deepEqual(withoutDrafts(all, false).sessions, ['as a', 'as b', 'as c']);
  });

  test('a block used in a test may switch windows', () => {
    const suite = parseAll(
      app({
        'a.md': `${login}\n## Steps: check as b\n1. switch to window "as b"\n2. open "/list"\n3. switch to window "as a"\n\n## Test: A\nid: w4\nsession: as a\n1. use "check as b"\n`,
      }),
    );
    assert.deepEqual(
      suite.files[0].cases[0].steps.map((s) => s.kind),
      ['window', 'open', 'window'],
    );
  });

  test('mistakes are parse errors with the line', () => {
    assert.throws(
      () =>
        parseAll(
          app({
            'a.md': `${login}\n## Test: A\nid: w5\n1. open "/"\n2. switch to window "as b"\n`,
          }),
        ),
      (e: Error) =>
        e instanceof ParseError &&
        /a\.md:\d+: switch to window needs a "session: <steps name>" line on test "A"/.test(
          e.message,
        ),
    );
    assert.throws(
      () =>
        parseAll(
          app({
            'a.md': `${login}\n## Test: A\nid: w6\nsession: as a\n1. switch to window "as z"\n`,
          }),
        ),
      /session "as z" is not defined as "## Steps: as z"/,
    );
    assert.throws(
      () =>
        parseAll(
          app({
            'a.md':
              '## Steps: as a\n1. open "/a"\n2. switch to window "as b"\n\n## Steps: as b\n1. open "/b"\n\n## Test: A\nid: w7\nsession: as a\n1. open "/"\n',
          }),
        ),
      /a\.md:3: session "as a" uses switch to window; only test steps can/,
    );
  });
});

describe('durable case identity', () => {
  test('IDs survive line movement and renames', () => {
    const content = '## Test: Named\nid: clinic.named\n1. open "/"\n';
    const original = parseAll(app({ 'a.md': content })).files[0].cases[0];
    const moved = parseAll(app({ 'a.md': '\n\n' + content })).files[0].cases[0];
    const renamed = parseAll(app({ 'b/c.md': content.replace('Named', 'Renamed') })).files[0]
      .cases[0];
    assert.equal(clientTestId(original), 'case:clinic.named');
    assert.equal(clientTestId(moved), clientTestId(original));
    assert.equal(clientTestId(renamed), clientTestId(original));
    assert.notEqual(moved.line, original.line);
  });
  test('a test without an id is a parse error naming the file and line', () => {
    assert.throws(
      () => parseAll(app({ 'old/x.md': '# X\n\n## Test: Old\n1. open "/"\n' })),
      (e: Error) =>
        e instanceof ParseError &&
        e.message.startsWith(`${join('old', 'x.md')}:3: test "Old" has no id`) &&
        e.message.includes('intent-test ids --write <paths>'),
    );
  });
  test('legacy-id is not metadata: the line is ignored and no alias is parsed', () => {
    const content = '## Test: Named\nid: clinic.named\nlegacy-id: source:a.md:1\n1. open "/"\n';
    const parsed = parseAll(app({ 'a.md': content })).files[0].cases[0];
    assert.ok(!('legacyClientTestId' in parsed));
    assert.equal(clientTestId(parsed), 'case:clinic.named');
  });
  test('malformed or duplicate identities fail deterministically across files', () => {
    assert.throws(
      () => parseAll(app({ 'a.md': '## Test: T\nid: a b\n1. open "/"\n' })),
      /invalid.*id/i,
    );
    for (const metadata of ['id: duplicate']) {
      assert.throws(
        () =>
          parseAll(
            app({
              'a.md': `## Test: A\n${metadata}\n1. open "/"\n`,
              'b.md': `## Test: B\n${metadata}\n1. open "/"\n`,
            }),
          ),
        /duplicate/,
      );
    }
    assert.throws(
      () => parseAll(app({ 'a.md': '## Steps: S\nid: a\n1. open "/"\n' })),
      /only allowed/,
    );
  });
  test('exact case filtering never selects a prefix or loses required sessions', () => {
    const suite = parseAll(
      app({
        'a.md':
          '## Steps: auth\n1. open "/"\n## Test: A\nid: app.a\nsession: auth\n1. open "/"\n## Test: AB\nid: app.ab\n1. open "/"\n',
      }),
    );
    const selected = selectCases(suite, 'case:app.a,app.a');
    assert.deepEqual(
      selected.files.flatMap((file) => file.cases.map((test) => test.explicitId)),
      ['app.a'],
    );
    assert.deepEqual(selected.sessions, ['auth']);
    assert.deepEqual(selectCases(suite, 'app.ab').sessions, []);
    assert.throws(() => selectCases(suite, 'app'), /unknown case id/);
  });
});

describe('parameters: (parameterized tests)', () => {
  const template =
    '## Test: Price {{param.age}} {{param.time}}\nid: shop.price\nparameters: pricing\n1. fill the age field with "{{param.age}}"\n2. expect the cost shows "{{param.price}}"\n';
  const rows = resolveRows('pricing', {
    rows: () => [
      { time: 'In', age: 10, price: 'Free' },
      { time: 'After', age: 25, price: '89.00' },
    ],
    key: (r) => `${r.time}|${r.age}`,
  });

  test('one case per row, with the row filled in the name and every step, and a stable identity', () => {
    const suite = expandExamples(parseAll(app({ 'a.md': template })), { pricing: rows }, '');
    const cases = suite.files[0].cases;
    assert.deepEqual(
      cases.map((c) => c.name),
      ['Price 10 In', 'Price 25 After'],
    );
    assert.deepEqual(cases.map(clientTestId), [
      'case:shop.price[In|10]',
      'case:shop.price[After|25]',
    ]);
    assert.equal(cases[1].steps[0].kind === 'fill' && cases[1].steps[0].value, '25');
    assert.equal(cases[1].steps[1].text, 'expect the cost shows "89.00"');
    assert.deepEqual(cases[0].template, {
      clientTestId: 'case:shop.price',
      name: 'Price {{param.age}} {{param.time}}',
    });
    assert.deepEqual(cases[0].parameters, {
      set: 'pricing',
      key: 'In|10',
      values: { time: 'In', age: '10', price: 'Free' },
    });
    assert.equal(cases[0].parameterSet, undefined);
  });
  test('a template without an id is a parse error', () => {
    assert.throws(
      () => parseAll(app({ 'a.md': template.replace('id: shop.price\n', '') })),
      /a\.md:1: test "Price \{\{param\.age\}\} \{\{param\.time\}\}" has no id/,
    );
  });
  test('the synchronous reporters rebuild a case from its annotations', () => {
    const parsed = parseAll(app({ 'a.md': template }));
    const expanded = expandExamples(parsed, { pricing: rows }, '').files[0].cases[1];
    const rebuilt = annotatedCase(
      parsed,
      clientTestId(expanded),
      expanded.template!.clientTestId,
      JSON.stringify(expanded.parameters),
    );
    assert.deepEqual(rebuilt?.test, expanded);
  });
  test('AT_PARAMS keeps the first row or named rows', () => {
    const suite = parseAll(app({ 'a.md': template }));
    assert.deepEqual(
      expandExamples(suite, { pricing: rows }, 'first').files[0].cases.map(
        (c) => c.parameters?.key,
      ),
      ['In|10'],
    );
    assert.deepEqual(
      expandExamples(suite, { pricing: rows }, 'After|25').files[0].cases.map(
        (c) => c.parameters?.key,
      ),
      ['After|25'],
    );
    assert.throws(
      () => expandExamples(suite, { pricing: rows }, 'Nope'),
      /AT_PARAMS: no parameter row has the key "Nope"/,
    );
  });
  test('a template id selects all its cases; id[key] selects one', () => {
    const suite = expandExamples(parseAll(app({ 'a.md': template })), { pricing: rows }, '');
    assert.equal(selectCases(suite, 'shop.price').files[0].cases.length, 2);
    assert.deepEqual(
      selectCases(suite, 'shop.price[After|25]').files[0].cases.map((c) => c.name),
      ['Price 25 After'],
    );
  });
  test('mistakes are parse errors', () => {
    assert.throws(
      () => parseAll(app({ 'a.md': '## Test: T\nid: t20\nparameters: pricing\n1. open "/"\n' })),
      /uses no \{\{param/,
    );
    assert.throws(
      () => parseAll(app({ 'a.md': '## Test: T\nid: t21\n1. open "/{{param.x}}"\n' })),
      /without a "parameters: <set>" line/,
    );
    assert.throws(
      () => parseAll(app({ 'a.md': '## Steps: S\nparameters: p\n1. open "/"\n' })),
      /only allowed/,
    );
    assert.throws(
      () =>
        parseAll(
          app({
            'a.md':
              '## Steps: S\n1. open "/{{param.x}}"\n## Test: T\nid: t22\nsession: S\nparameters: p\n1. open "/{{param.x}}"\n',
          }),
        ),
      /session "S" uses \{\{param/,
    );
    assert.throws(
      () => expandExamples(parseAll(app({ 'a.md': template })), {}, ''),
      /parameter set "pricing" is not defined/,
    );
    assert.throws(
      () =>
        expandExamples(
          parseAll(app({ 'a.md': template.replace('{{param.price}}', '{{param.cost}}') })),
          { pricing: rows },
          '',
        ),
      /a.md:5: \{\{param.cost\}\} is not in the parameter row/,
    );
    assert.throws(
      () =>
        expandExamples(
          parseAll(app({ 'a.md': template.replace(' {{param.time}}', '') })),
          {
            pricing: resolveRows('pricing', {
              rows: () => [
                { time: 'In', age: 10, price: '1' },
                { time: 'After', age: 10, price: '2' },
              ],
            }),
          },
          '',
        ),
      /both named "Price 10"/,
    );
    assert.throws(() => resolveRows('p', { rows: () => [] }), /has no rows/);
    assert.throws(
      () => resolveRows('p', { rows: () => [{ a: 1 }, { a: 1 }] }),
      /two rows have the key "1"/,
    );
    assert.throws(
      () => resolveRows('p', { rows: () => [{ a: 'x' }], key: () => 'a]b' }),
      /without "\]"/,
    );
    assert.throws(
      () => resolveRows('p', { rows: () => [{ a: { nested: 1 } as unknown as string }] }),
      /must be a string, number or boolean/,
    );
  });
  test('loadSuite reads parameters.ts from the app folder', async () => {
    const dir = app({
      'a.md': template,
      'parameters.ts':
        'export const parameters = { pricing: { rows: () => [{ time: "In", age: 10, price: "Free" }] } };\n',
    });
    const suite = await loadSuite(dir, null, { params: '', ids: '' });
    assert.deepEqual(suite.files[0].cases.map(clientTestId), ['case:shop.price[In|10|Free]']);
  });
});

describe('refs and drafts', () => {
  const file = `## Steps: as nurse
1. open "/"

## Test: Draft case
id: d1
tags: @draft, @smoke
refs: C1234, TR:9/a-b_c.d
session: as nurse
1. open "/a"

## Test: Kept case
id: k1
1. open "/b"
`;

  test('a refs: line becomes refs; @draft (with or without @) makes a draft', () => {
    const [draft, kept] = parseAll(app({ 'a.md': file })).files[0].cases;
    assert.deepEqual(draft.refs, ['C1234', 'TR:9/a-b_c.d']);
    assert.equal(draft.draft, true);
    assert.deepEqual(draft.tags, ['@draft', '@smoke']);
    assert.deepEqual([kept.refs, kept.draft], [[], false]);
    const bare = parseAll(app({ 'a.md': '## Test: A\nid: a\ntags: draft\n1. open "/"\n' }));
    assert.equal(bare.files[0].cases[0].draft, true);
  });

  test('malformed refs are parse errors with the line', () => {
    const bad = (line: string) => () =>
      parseAll(app({ 'a.md': `## Test: A\nid: a\n${line}\n1. open "/"\n` }));
    assert.throws(bad('refs:'), /a\.md:3: refs: needs references separated by commas/);
    assert.throws(bad('refs: C1 C2'), /a\.md:3: refs: reference "C1 C2"/);
    assert.throws(bad('refs: C1,,C2'), /separated by commas/);
    assert.throws(bad('refs: C1, C1'), /listed twice/);
    assert.throws(
      bad(`refs: ${Array.from({ length: 21 }, (_, i) => `C${i}`).join(', ')}`),
      /at most 20/,
    );
    assert.throws(bad(`refs: ${'x'.repeat(51)}`), /1-50/);
    assert.throws(bad('refs: C1\nrefs: C2'), /duplicate refs metadata/);
    assert.throws(
      () => parseAll(app({ 'a.md': '## Steps: b\nrefs: C1\n1. open "/"\n' })),
      /"refs:" is only allowed in a "## Test:" section/,
    );
  });

  test('run mode leaves drafts and the sessions only they use out, unless included', () => {
    const suite = parseAll(app({ 'a.md': file }));
    assert.deepEqual(suite.sessions, ['as nurse']);
    const run = withoutDrafts(suite, false);
    assert.deepEqual(
      run.files[0].cases.map((c) => c.explicitId),
      ['k1'],
    );
    assert.deepEqual(run.sessions, []);
    assert.equal(withoutDrafts(suite, true), suite);
    const noDrafts = parseAll(app({ 'a.md': '## Test: A\nid: a\n1. open "/"\n' }));
    assert.equal(withoutDrafts(noDrafts, false), noDrafts);
  });

  test('a draft may have no steps yet; any other test without steps is a parse error', () => {
    const suite = parseAll(
      app({
        'a.md':
          '## Test: Empty draft\nid: e1\ntags: @draft\n\n## Test: Kept\nid: k1\n1. open "/"\n',
      }),
    );
    const [empty, kept] = suite.files[0].cases;
    assert.deepEqual([empty.explicitId, empty.draft, empty.steps], ['e1', true, []]);
    assert.equal(kept.steps.length, 1);
    assert.throws(
      () => parseAll(app({ 'a.md': '## Test: Empty\nid: e2\ntags: @smoke\n' })),
      /a\.md:1: test "Empty" has no steps/,
    );
  });

  test('a draft without steps is never run, even when drafts are included; its session goes too', () => {
    const suite = parseAll(
      app({
        'a.md': [
          '## Steps: as nurse\n1. open "/"\n',
          '## Test: Empty draft\nid: e1\ntags: @draft\nsession: as nurse\n',
          '## Test: Stepped draft\nid: d1\ntags: @draft\n1. open "/a"\n',
          '## Test: Kept\nid: k1\n1. open "/b"\n',
        ].join('\n'),
      }),
    );
    assert.deepEqual(suite.sessions, ['as nurse']);
    const included = withoutDrafts(suite, true);
    assert.deepEqual(
      included.files[0].cases.map((c) => c.explicitId),
      ['d1', 'k1'],
    );
    assert.deepEqual(included.sessions, []);
    const excluded = withoutDrafts(suite, false);
    assert.deepEqual(
      excluded.files[0].cases.map((c) => c.explicitId),
      ['k1'],
    );
    assert.deepEqual(excluded.sessions, []);
    // Nothing to leave out: the same suite.
    const stepped = parseAll(app({ 'a.md': '## Test: D\nid: d\ntags: @draft\n1. open "/"\n' }));
    assert.equal(withoutDrafts(stepped, true), stepped);
  });

  test('templates keep refs and draft in every row case', () => {
    const suite = expandExamples(
      parseAll(
        app({
          'a.md':
            '## Test: T {{param.x}}\nid: t\ntags: @draft\nrefs: C7\nparameters: s\n1. open "/{{param.x}}"\n',
        }),
      ),
      { s: [{ key: 'one', values: { x: '1' } }] },
      '',
    );
    const [row] = suite.files[0].cases;
    assert.deepEqual([row.explicitId, row.refs, row.draft], ['t[one]', ['C7'], true]);
  });
});

describe('notShownStatement (expect … is not shown)', () => {
  test('the strict single-clause form becomes the positive statement', () => {
    assert.equal(
      notShownStatement('the "Debtors" menu item is not shown'),
      'the "Debtors" menu item is shown',
    );
    assert.equal(notShownStatement('"referral.pdf" is Not Visible'), '"referral.pdf" is visible');
    assert.equal(
      notShownStatement('the "Save" button is not displayed'),
      'the "Save" button is displayed',
    );
    assert.equal(
      notShownStatement('the "Ana, Petrova" row is not listed'),
      'the "Ana, Petrova" row is listed',
    );
  });

  test('every other wording keeps being judged as written', () => {
    // Negative expects already in use in consumer suites must not change meaning.
    for (const assertion of [
      'the worklist no longer lists "X" (No results found)',
      'no dialog is open and no error message is shown',
      'no dialog is open',
      'the programme status in the participant details is not "Enrolled"',
      'the appointment times offered include 10:00 and not 11:00',
      'the "Save" button is not shown and the "Cancel" button is shown',
      'the "Save" or "Cancel" button is not shown',
      'the "Save" button, "Cancel" button is not shown',
      'the "Save" button is not shown yet',
      'the "Save" button is still not shown',
      'the dialog is not open',
      'the page shows "Debtors"',
    ])
      assert.equal(notShownStatement(assertion), null, assertion);
  });

  test('the step itself parses as a plain expect', () => {
    assert.deepEqual(parseStep('expect the "Debtors" menu item is not shown within 10 seconds'), {
      kind: 'expect',
      assertion: 'the "Debtors" menu item is not shown',
      withinSeconds: 10,
    });
  });
});

describe('upload', () => {
  test('the file is quoted and relative to the app folder; the target is free text', () => {
    assert.deepEqual(parseStep('upload "files/referral.pdf" to the "Upload Files" button'), {
      kind: 'upload',
      attachment: 'files/referral.pdf',
      target: 'the "Upload Files" button',
    });
    assert.deepEqual(parseStep('Upload "a b.pdf" to the "Documents" section\'s upload card'), {
      kind: 'upload',
      attachment: 'a b.pdf',
      target: 'the "Documents" section\'s upload card',
    });
  });

  test('a path that leaves the app folder, or a malformed step, is a parse error with a hint', () => {
    for (const [step, message] of [
      ['upload "/etc/passwd" to the "Upload" button', /relative to the app folder, not absolute/],
      ['upload "C:/x.pdf" to the "Upload" button', /not absolute/],
      ['upload "../secrets.pdf" to the "Upload" button', /stay inside the app folder/],
      ['upload "files/../../x.pdf" to the "Upload" button', /stay inside the app folder/],
      ['upload "files\\x.pdf" to the "Upload" button', /forward slashes/],
      ['upload "files/" to the "Upload" button', /name a file, not a folder/],
      [
        'upload files/x.pdf to the "Upload" button',
        /upload needs the form: upload "<file>" to <target>/,
      ],
      ['upload "files/x.pdf"', /upload needs the form/],
    ] as const)
      assert.throws(
        () => parseStep(step, 'a.md:3'),
        (e: Error) => e instanceof ParseError && message.test(e.message),
        step,
      );
  });

  test('upload is not one of the optional steps', () => {
    assert.throws(
      () => parseStep('optionally upload "x.pdf" to the "Upload" button'),
      /only .* can be optional/,
    );
  });

  test('loading the suite fails on files that are missing or not files, with file:line', async () => {
    const dir = app({
      'files/referral.pdf': '%PDF',
      'tests/a.md':
        '## Test: Up\nid: up\n1. upload "files/referral.pdf" to the "Upload Files" button\n2. upload "files/missing.pdf" to the "Upload Files" button\n3. upload "files" to the "Upload Files" button\n',
    });
    await assert.rejects(loadSuite(dir, null, { params: '', ids: '' }), (e: Error) => {
      assert.ok(e instanceof ParseError);
      assert.equal(
        e.message,
        [
          'tests/a.md:4: upload "files/missing.pdf": no such file in the app folder',
          'tests/a.md:5: upload "files": not a file',
        ].join('\n'),
      );
      return true;
    });
    writeFileSync(
      join(dir, 'tests/a.md'),
      '## Test: Up\nid: up\n1. upload "files/referral.pdf" to the "Upload Files" button\n',
    );
    const suite = await loadSuite(dir, null, { params: '', ids: '' });
    assert.deepEqual(missingUploads(suite, dir), []);
  });
});
