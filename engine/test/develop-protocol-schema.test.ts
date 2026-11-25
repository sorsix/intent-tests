// The committed develop-protocol schema (docs/contract/develop-protocol.schema.json) is generated from
// src/develop/protocol.ts; Launcher validates its mirrors against it. This fails when the file drifts from the types,
// and checks that what the engine builds (case views, step records) is valid under it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Ajv } from 'ajv';
import { developRecord } from '../src/develop/test-context.ts';
import { sectionCase } from '../src/develop/cases.ts';
import { findSection } from '../src/develop/edit.ts';
import type { StepRecord } from '../src/steps.ts';

const schemaPath = new URL('../docs/contract/develop-protocol.schema.json', import.meta.url);
const generator = new URL('../scripts/develop-contract.mjs', import.meta.url);

test('the committed develop schema matches src/develop/protocol.ts', async (t) => {
  let generated: string;
  try {
    const { generateSchemaText } = (await import(generator.href)) as {
      generateSchemaText: () => string;
    };
    generated = generateSchemaText();
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== 'MODULE_NOT_FOUND' && code !== 'ERR_MODULE_NOT_FOUND') throw error;
    // Only `npm --prefix dashboard/frontend ci` installs the generator.
    t.skip(`ts-json-schema-generator is not installed: ${(error as Error).message}`);
    return;
  }
  assert.equal(
    readFileSync(schemaPath, 'utf8'),
    generated,
    'engine/docs/contract/develop-protocol.schema.json is out of date: run `npm run contract:develop` and commit the result.',
  );
});

const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
  definitions: Record<string, unknown>;
};
const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
ajv.addSchema(schema, 'develop');
function valid(definition: string, value: unknown): void {
  const validate = ajv.getSchema(`develop#/definitions/${definition}`);
  assert.ok(validate, `the schema defines ${definition}`);
  assert.ok(validate(value), `${definition}: ${ajv.errorsText(validate.errors)}`);
}

test('the schema has the definitions Launcher validates against', () => {
  for (const name of ['DevelopRequest', 'DevelopReply', 'DevelopEvent', 'DevelopMessage'])
    assert.ok(schema.definitions[name], name);
  assert.equal(schema.definitions.isReply, undefined, 'type guards are not messages');
});

const base: StepRecord = {
  number: 2,
  label: '2',
  file: 'tests/a.md',
  line: 5,
  text: 'click "Save"',
  kind: 'click',
  status: 'passed',
  durationMs: 40,
  modelMs: 12,
  inputTokens: 300,
  calls: [],
  chosen: { id: 'e1', description: 'button "Save"', confidence: 0.97 },
  narrowed: '1 of 3 elements, by "Save"',
  top: [{ id: 'e1', description: 'button "Save"', p: 0.97 }],
  outcome: 'clicked',
  screenshot: 'AAAA',
};

test('step records the session builds are valid events', () => {
  const passed = developRecord(1, [base], [{ id: 'e1', description: 'button "Save"' }]);
  assert.equal(passed.status, 'passed');
  assert.deepEqual(passed.candidates, [{ id: 'e1', description: 'button "Save"' }]);
  valid('DevelopEvent', { event: 'step.finished', index: 1, record: passed });

  // A `use` step: several records, the failing one decides, durations add up.
  const failed = developRecord(
    0,
    [
      { ...base, label: '1.1', outcome: 'opened /' },
      {
        ...base,
        label: '1.2',
        status: 'failed',
        error: 'Could not resolve step',
        failure: { kind: 'target-not-found', summary: 'No match', origin: 'runner' },
        chosen: undefined,
      },
    ],
    [],
  );
  assert.equal(failed.status, 'failed');
  assert.equal(failed.durationMs, 80);
  assert.equal(failed.chosen, undefined);
  assert.equal(failed.outcome, 'opened /; clicked');
  assert.deepEqual(failed.failure, { kind: 'target-not-found', summary: 'No match' });
  valid('DevelopReply', { id: 'r1', ok: true, result: { record: failed } });
  valid('DevelopStepRecord', failed);

  // An error before any step ran (e.g. a session for a switch failed).
  const thrown = developRecord(3, [], [], new Error('session "nurse" failed'));
  assert.equal(thrown.status, 'failed');
  assert.equal(thrown.error, 'session "nurse" failed');
  valid('DevelopStepRecord', thrown);
});

test('a case read from text is a valid case event', () => {
  const content =
    '## Test: Book\nid: book\ntags: @draft\nrefs: C1, C2\nsession: reception\n1. open "/"\n2. clikc "Save"\n';
  const view = sectionCase('book', 'tests/book.md', findSection(content, 'book')!);
  assert.deepEqual(
    view.steps.map((s) => s.kind),
    ['open', 'invalid'],
  );
  assert.equal(view.draft, true);
  assert.deepEqual(view.refs, ['C1', 'C2']);
  valid('DevelopEvent', {
    event: 'case.updated',
    case: view,
    file: 'tests/book.md',
    saved: true,
    error: 'parse error',
  });
});
