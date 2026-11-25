// Develop mode's case list and loaded case (src/develop/cases.ts), and refs/draft in the catalog the dashboard gets.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  developCase,
  findCase,
  findCaseFile,
  listCases,
  parseApp,
  sectionCase,
} from '../src/develop/cases.ts';
import { caseSnapshot, captureSuite } from '../src/dashboard/catalog.ts';

const dir = mkdtempSync(join(tmpdir(), 'intent-develop-cases-'));
after(() => rmSync(dir, { recursive: true, force: true }));
writeFileSync(
  join(dir, 'a.md'),
  `## Steps: log in
1. open "/login"
2. click "Log in"

## Test: Uses a block
id: uses
tags: @draft
refs: C1
session: log in
1. use "log in"
2. optionally click "Close"

## Test: Price {{param.age}}
id: price
parameters: ages
1. open "/price/{{param.age}}"
`,
);
writeFileSync(
  join(dir, 'parameters.ts'),
  'export const parameters = { ages: { rows: () => [{ age: 10 }, { age: 70 }] } };\n',
);

test('the case list has every case, drafts and template rows included', async () => {
  const suite = await parseApp(dir);
  assert.deepEqual(listCases(suite), [
    {
      id: 'uses',
      name: 'Uses a block',
      file: 'a.md',
      line: 5,
      tags: ['@draft'],
      draft: true,
      refs: ['C1'],
      session: 'log in',
    },
    {
      id: 'price[10]',
      name: 'Price 10',
      file: 'a.md',
      line: 13,
      tags: [],
      draft: false,
      refs: [],
      template: 'price',
    },
    {
      id: 'price[70]',
      name: 'Price 70',
      file: 'a.md',
      line: 13,
      tags: [],
      draft: false,
      refs: [],
      template: 'price',
    },
  ]);
});

test('a loaded case shows its own steps as written, a use step with its expansion', async () => {
  const suite = await parseApp(dir);
  const content = readFileSync(join(dir, 'a.md'), 'utf8');
  const uses = developCase(findCase(suite, 'case:uses')!, content);
  assert.deepEqual(uses.steps, [
    {
      index: 0,
      number: 1,
      label: '1',
      text: 'use "log in"',
      kind: 'use',
      line: 10,
      expanded: [
        { label: '1.1', text: 'log in › open "/login"', kind: 'open' },
        { label: '1.2', text: 'log in › click "Log in"', kind: 'click' },
      ],
    },
    {
      index: 1,
      number: 2,
      label: '2',
      text: 'optionally click "Close"',
      kind: 'click',
      line: 11,
    },
  ]);
  // A template's own id loads its first row; the row's text stays as written, its values come along.
  const price = developCase(findCase(suite, 'price')!, content);
  assert.equal(price.id, 'price[10]');
  assert.deepEqual(price.parameters, { age: '10' });
  assert.equal(price.steps[0].text, 'open "/price/{{param.age}}"');
  assert.equal(findCase(suite, 'price[70]')!.name, 'Price 70');
  assert.equal(findCase(suite, 'nope'), undefined);
});

test('a case is found as text when the app does not parse', () => {
  const found = findCaseFile(dir, 'price[70]')!;
  assert.equal(found.file, 'a.md');
  const view = sectionCase('price[70]', found.file, found.section);
  assert.deepEqual(
    [view.id, view.template, view.steps.map((s) => s.kind)],
    ['price[70]', 'price', ['open']],
  );
  assert.equal(findCaseFile(dir, 'missing'), null);
});

test('the catalog carries refs and draft only when present, outside the intent hash', async () => {
  const suite = await parseApp(dir);
  const [uses, price] = suite.files[0].cases;
  const snapshot = caseSnapshot(uses);
  assert.deepEqual(snapshot.refs, ['C1']);
  assert.equal(snapshot.draft, true);
  const plain = caseSnapshot(price);
  assert.equal('refs' in plain, false);
  assert.equal('draft' in plain, false);
  // Refs are not part of the intent: changing them keeps the case version.
  assert.equal(caseSnapshot({ ...uses, refs: ['C2'] }).intentHash, snapshot.intentHash);
  const captured = await captureSuite(dir);
  assert.equal(captured.cases.length, 3, 'the catalog lists drafts');
});
