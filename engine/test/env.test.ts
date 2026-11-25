import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { loadAppEnv, loadSharedEnv } from '../src/env.ts';

function environment(t: TestContext) {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (/^(AT_|TYPESAFE_API_KEY$|BASE_URL$)/.test(key)) delete process.env[key];
  }
  const directory = mkdtempSync(join(tmpdir(), 'intent-env-'));
  const apps = join(directory, 'intent-tests');
  for (const app of ['first', 'second']) {
    mkdirSync(join(apps, app), { recursive: true });
    writeFileSync(join(apps, app, '.env.dev'), `BASE_URL=http://${app}.example.test\n`);
  }
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, apps };
}

for (const app of ['first', 'second']) {
  test(`shared credentials work for ${app} while its own dev profile supplies the app URL`, (t) => {
    const { apps } = environment(t);
    writeFileSync(
      join(apps, '.env'),
      'AT_DASHBOARD_TOKEN=fixture-personal\nTYPESAFE_API_KEY=fixture-model\n',
    );

    const files = loadAppEnv(join(apps, app), apps);

    assert.deepEqual(files, ['../.env', '.env.dev']);
    assert.equal(process.env.AT_DASHBOARD_TOKEN, 'fixture-personal');
    assert.equal(process.env.TYPESAFE_API_KEY, 'fixture-model');
    assert.equal(process.env.BASE_URL, `http://${app}.example.test`);
  });
}

test('process and CI credentials win; shared settings precede app overrides and profile defaults', (t) => {
  const { apps } = environment(t),
    app = join(apps, 'first');
  process.env.AT_DASHBOARD_TOKEN = 'fixture-ci';
  writeFileSync(
    join(apps, '.env'),
    'AT_DASHBOARD_TOKEN=fixture-personal\nTYPESAFE_API_KEY=shared-model\n',
  );
  writeFileSync(join(app, '.env'), 'TYPESAFE_API_KEY=app-model\nAT_WORKERS=5\n');
  writeFileSync(
    join(app, '.env.dev'),
    'TYPESAFE_API_KEY=profile-model\nAT_WORKERS=3\nBASE_URL=http://profile.example.test\n',
  );

  assert.deepEqual(loadAppEnv(app, apps), ['../.env', '.env', '.env.dev']);

  assert.equal(process.env.AT_DASHBOARD_TOKEN, 'fixture-ci');
  assert.equal(process.env.TYPESAFE_API_KEY, 'shared-model');
  assert.equal(process.env.AT_WORKERS, '5');
  assert.equal(process.env.BASE_URL, 'http://profile.example.test');
});

test('shared profile selection works and an explicitly missing profile still fails', (t) => {
  const { apps } = environment(t),
    app = join(apps, 'first');
  writeFileSync(join(apps, '.env'), 'AT_ENV=staging\n');
  writeFileSync(join(app, '.env.staging'), 'BASE_URL=http://staging.example.test\n');

  assert.deepEqual(loadAppEnv(app, apps), ['../.env', '.env.staging']);
  assert.equal(process.env.BASE_URL, 'http://staging.example.test');

  process.env.AT_ENV = 'missing';
  assert.throws(() => loadAppEnv(app, apps), /AT_ENV=missing.*does not exist/);
});

test('shared files are optional and external app fixtures do not read workspace credentials', (t) => {
  const { directory, apps } = environment(t);
  assert.deepEqual(loadAppEnv(join(apps, 'first'), apps), ['.env.dev']);
  writeFileSync(
    join(apps, '.env'),
    'AT_DASHBOARD_TOKEN=workspace-personal\nTYPESAFE_API_KEY=workspace-model\nAT_ENV=missing\n',
  );
  const external = join(directory, 'intent-tests-external', 'fixture');
  mkdirSync(external, { recursive: true });
  writeFileSync(join(external, '.env'), 'AT_DECIDER=stub\n');

  assert.deepEqual(loadAppEnv(external, apps), ['.env']);

  assert.equal(process.env.AT_DASHBOARD_TOKEN, undefined);
  assert.equal(process.env.TYPESAFE_API_KEY, undefined);
  assert.equal(process.env.AT_DECIDER, 'stub');
});

test('replay can load shared credentials without an app and keeps inherited credentials', (t) => {
  const { apps } = environment(t);
  writeFileSync(join(apps, '.env'), 'AT_DASHBOARD_TOKEN=fixture-personal\n');

  loadSharedEnv(apps);
  assert.equal(process.env.AT_DASHBOARD_TOKEN, 'fixture-personal');
  assert.equal(process.env.AT_APP_DIR, undefined);

  process.env.AT_DASHBOARD_TOKEN = 'fixture-ci';
  loadSharedEnv(apps);
  assert.equal(process.env.AT_DASHBOARD_TOKEN, 'fixture-ci');
});
