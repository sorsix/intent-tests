import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { captureSuite } from '../src/dashboard/catalog.ts';

const cli = fileURLToPath(new URL('../src/cli/catalog.ts', import.meta.url));
const fixture = fileURLToPath(new URL('fixture', import.meta.url));
const clean = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/^(AT_|BASE_URL$)/.test(key)),
);

test('catalog prints the same suite publish-suite captures, with presence-only credentials', async (t) => {
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  const { MICROSOFT_FOUNDRY_ENDPOINT: _endpoint, MICROSOFT_FOUNDRY_KEY: _key, ...rest } = clean;
  const output = execFileSync(process.execPath, [cli], {
    env: {
      ...rest,
      AT_APP_DIR: fixture,
      AT_DASHBOARD_TOKEN: 'catalog-token-123',
      OPENAI_API_KEY: 'openai-key-456',
    },
    encoding: 'utf8',
  });
  const catalog = JSON.parse(output);
  assert.equal(catalog.kind, 'intent-catalog');
  assert.equal(catalog.schema, 1);
  assert.match(catalog.engine, /^\d+\.\d+\.\d+/);
  assert.deepEqual(catalog.app, { key: 'fixture', name: 'fixture' });
  assert.deepEqual(catalog.profiles, ['dev']);
  assert.equal(catalog.dashboardToken, true);
  assert.ok(!output.includes('catalog-token-123'), 'The token value is never printed');
  // Decision models a person can pick: never the self-test stub; names of missing variables, never values.
  const deciders = new Map(
    catalog.deciders.options.map((option: { name: string; missing: string[] }) => [
      option.name,
      option.missing,
    ]),
  );
  assert.ok(deciders.has('jev') && !deciders.has('stub'));
  assert.deepEqual(deciders.get('openai'), []);
  assert.ok((deciders.get('microsoft') as string[]).includes('MICROSOFT_FOUNDRY_ENDPOINT'));
  assert.equal(typeof catalog.deciders.default, 'string');
  assert.ok(!output.includes('openai-key-456'));
  process.env.AT_APP_DIR = fixture;
  process.loadEnvFile(join(fixture, '.env.dev'));
  const expected = await captureSuite(fixture);
  assert.equal(catalog.suite.suiteHash, expected.suiteHash);
  assert.equal(catalog.suite.cases.length, expected.cases.length);
});

test('catalog lists app folders without --app and reports unknown apps', () => {
  const root = mkdtempSync(join(tmpdir(), 'intent-catalog-'));
  try {
    mkdirSync(join(root, 'intent-tests', 'clinic'), { recursive: true });
    mkdirSync(join(root, 'intent-tests', '.hidden'), { recursive: true });
    writeFileSync(join(root, 'intent-tests', 'README.md'), '# Apps\n');
    const list = JSON.parse(
      execFileSync(process.execPath, [cli], { cwd: root, env: clean, encoding: 'utf8' }),
    );
    assert.deepEqual(list.apps, ['clinic']);
    const missing = spawnSync(process.execPath, [cli, '--app', 'nope'], {
      cwd: root,
      env: clean,
      encoding: 'utf8',
    });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /no folder .*nope \(apps: clinic\)/);
    const unknown = spawnSync(process.execPath, [cli, '--json'], {
      cwd: root,
      env: clean,
      encoding: 'utf8',
    });
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /Unknown argument: --json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
