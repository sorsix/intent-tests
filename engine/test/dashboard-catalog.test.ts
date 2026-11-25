import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { captureSuite, canonicalJson } from '../src/dashboard/catalog.ts';
import { digest } from '../src/dashboard/spool.ts';
import { failureFor, markFailure, withFailureDiagnosis } from '../src/failure.ts';
import type { Decider } from '../src/decider/types.ts';

test('suite hashes describe sanitized captured bytes, are deterministic, and keep stable identity through movement', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'suite-capture-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const old = process.env.CATALOG_PASSWORD;
  process.env.CATALOG_PASSWORD = 'catalog-password-123';
  t.after(() => {
    if (old === undefined) delete process.env.CATALOG_PASSWORD;
    else process.env.CATALOG_PASSWORD = old;
  });
  const source =
    '## Test: Credential\nid: app.credential\n1. fill "Password" with "catalog-password-123"\n2. click "Save"\n';
  writeFileSync(join(dir, 'a.md'), source);
  const first = await captureSuite(dir, 'revision-one'),
    again = await captureSuite(dir, 'revision-two');
  assert.equal(first.suiteHash, again.suiteHash, 'Revision does not alter the content hash');
  assert.equal(
    first.suiteHash,
    digest(canonicalJson({ cases: first.cases, sources: first.sources })),
  );
  assert.equal(first.sources[0].sha256, digest(first.sources[0].content));
  assert.ok(!first.sources[0].content.includes('catalog-password-123'));
  assert.ok(first.sources[0].content.includes('[REDACTED]'));
  assert.equal(
    readFileSync(join(dir, 'a.md'), 'utf8'),
    source,
    'Capture never changes source bytes',
  );
  assert.equal(first.cases[0].clientTestId, 'case:app.credential');
  writeFileSync(join(dir, 'a.md'), '\n\n' + source);
  const moved = await captureSuite(dir);
  assert.equal(
    moved.cases[0].intentHash,
    first.cases[0].intentHash,
    'Heading movement is not a semantic intent change',
  );
  assert.notEqual(moved.suiteHash, first.suiteHash);
  assert.ok(!('legacyClientTestId' in moved.cases[0]), 'No alias is captured');
  writeFileSync(join(dir, 'a.md'), source.replace('click "Save"', 'click "Submit"'));
  assert.notEqual((await captureSuite(dir)).cases[0].intentHash, first.cases[0].intentHash);
});

test('canonical JSON uses ordinal keys and omits absent optional fields', () => {
  assert.equal(
    canonicalJson({ z: 1, Z: 2, a: { x: undefined, B: 3, A: 4 }, array: [2, 1] }),
    '{"Z":2,"a":{"A":4,"B":3},"array":[2,1],"z":1}',
  );
});

test('structured diagnosis preserves thrown errors and keeps explicit conditions distinct', async () => {
  const transport = new Error('Connection reset');
  const inner: Decider = {
    name: 'fixture',
    model: 'fixture',
    host: 'fixture.invalid',
    limits: { maxOptions: 10 },
    pricing: { usdPerMInput: 0 },
    async choose() {
      throw transport;
    },
    async yesNo() {
      throw transport;
    },
  };
  const wrapped = withFailureDiagnosis(inner);
  await assert.rejects(wrapped.choose({}, 'Click', {}), (error) => error === transport);
  assert.equal(failureFor(transport).kind, 'model-transport');
  assert.equal(transport.message, 'Connection reset');
  for (const kind of [
    'seed',
    'setup',
    'target-not-found',
    'low-confidence',
    'assertion',
    'browser',
  ] as const) {
    const error = new Error(`Original ${kind}`);
    markFailure(error, kind);
    markFailure(error, 'unknown');
    assert.equal(failureFor(error).kind, kind);
    assert.equal(failureFor(error).detail, error.message);
    assert.equal(failureFor(error).origin, 'runner');
  }
  assert.equal(failureFor(new Error('An unclassified failure')).kind, 'unknown');
  const timeout = new Error('Original timeout');
  timeout.name = 'TimeoutError';
  markFailure(timeout, 'unknown');
  assert.equal(failureFor(timeout).kind, 'browser');
});

test('the catalog lists every case of a template, whatever AT_PARAMS and AT_CASE_IDS select', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'suite-capture-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const old = { params: process.env.AT_PARAMS, ids: process.env.AT_CASE_IDS };
  process.env.AT_PARAMS = 'first';
  process.env.AT_CASE_IDS = 'shop.price[a]';
  t.after(() => {
    for (const [key, value] of [
      ['AT_PARAMS', old.params],
      ['AT_CASE_IDS', old.ids],
    ] as const)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  writeFileSync(
    join(dir, 'a.md'),
    '## Test: Price {{param.k}}\nid: shop.price\nparameters: prices\n1. expect the cost shows "{{param.price}}"\n',
  );
  writeFileSync(
    join(dir, 'parameters.ts'),
    'export const parameters = { prices: { rows: () => [{ k: "a", price: "1.00" }, { k: "b", price: "2.00" }], key: (r) => r.k } };\n',
  );
  const { cases } = await captureSuite(dir);
  assert.deepEqual(
    cases.map((c) => c.clientTestId),
    ['case:shop.price[a]', 'case:shop.price[b]'],
  );
  assert.deepEqual(cases[1].template, {
    clientTestId: 'case:shop.price',
    name: 'Price {{param.k}}',
  });
  assert.deepEqual(cases[1].parameters, {
    set: 'prices',
    key: 'b',
    values: { k: 'b', price: '2.00' },
  });
  assert.notEqual(cases[0].intentHash, cases[1].intentHash);
});
