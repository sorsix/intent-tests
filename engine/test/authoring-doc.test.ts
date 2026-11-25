// docs/authoring.md is the primer every agent reads before writing tests (served by Launcher's MCP server from the
// installed engine); it must keep naming every verb of the grammar in src/parse.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { VERBS } from '../src/parse.ts';

const primer = readFileSync(new URL('../docs/authoring.md', import.meta.url), 'utf8');
const verbs = [
  'open',
  'click',
  'fill',
  'select',
  'check',
  'uncheck',
  'drag',
  'upload',
  'press',
  'expect',
  'wait',
  'use',
  'switch to session',
  'call',
  'optionally',
];

test('docs/authoring.md names every step verb of the grammar', () => {
  for (const verb of verbs) {
    assert.ok(VERBS.includes(verb), `${verb} is in VERBS`);
    assert.ok(primer.includes(`\`${verb}`), `${verb} is in docs/authoring.md`);
  }
  for (const line of ['id:', 'session:', 'seed:', 'tags: @draft', 'refs:', '## Steps:'])
    assert.ok(primer.includes(line), `${line} is in docs/authoring.md`);
});
