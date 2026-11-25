import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { findAppsDir } from '../src/app.ts';
import {
  reportingDashboard,
  reportingIdentity,
  reportingProduct,
  reportingTarget,
  WORKSPACE_FILE,
} from '../src/dashboard/catalog.ts';

function workspace(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'intent-product-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const apps = join(root, 'intent-tests'),
    app = join(apps, 'clinic');
  mkdirSync(app, { recursive: true });
  return { apps, app };
}

test('the committed workspace file names the product; an app folder may override it', (t) => {
  const { apps, app } = workspace(t);
  writeFileSync(join(apps, WORKSPACE_FILE), '{ "product": "clinic" }');
  assert.deepEqual(reportingProduct(app, {}), {
    key: 'clinic',
    source: join(apps, WORKSPACE_FILE),
  });
  writeFileSync(join(app, WORKSPACE_FILE), '{ "product": "lab" }');
  assert.equal(reportingProduct(app, {}).key, 'lab');
  assert.deepEqual(reportingProduct(app, { AT_DASHBOARD_PRODUCT_KEY: 'demo' }), {
    key: 'demo',
    source: 'AT_DASHBOARD_PRODUCT_KEY',
  });
});

test('an invalid workspace file is an error that names the file', (t) => {
  const { apps, app } = workspace(t);
  writeFileSync(join(apps, WORKSPACE_FILE), '{ "project": "clinic" }');
  assert.throws(() => reportingProduct(app, {}), /intent-workspace\.json needs a "product" key/);
  writeFileSync(join(apps, WORKSPACE_FILE), '{ product: clinic }');
  assert.throws(() => reportingProduct(app, {}), /intent-workspace\.json is not valid JSON/);
});

test('without a workspace file the run stops with an error that names the file to create', (t) => {
  const { apps, app } = workspace(t);
  assert.throws(
    () => reportingProduct(app, {}),
    (error: Error) =>
      error.message.includes(join(apps, WORKSPACE_FILE)) && /"product"/.test(error.message),
  );
  assert.throws(() => reportingIdentity('clinic', app), /No intent-workspace\.json found/);
  assert.equal(reportingProduct(app, { AT_DASHBOARD_PRODUCT_KEY: 'demo' }).key, 'demo');
});

test('application names are the key unless AT_DASHBOARD_APP_NAME is set; there is no per-app special case', (t) => {
  const { apps, app } = workspace(t);
  writeFileSync(join(apps, WORKSPACE_FILE), '{ "product": "lab" }');
  assert.deepEqual(reportingIdentity('clinic', app).app, { key: 'clinic', name: 'clinic' });
});

test('the reporting envelope carries the product as its project', (t) => {
  const { apps, app } = workspace(t);
  writeFileSync(join(apps, WORKSPACE_FILE), '{ "product": "lab" }');
  assert.deepEqual(reportingIdentity('clinic', app).project, { key: 'lab', name: 'lab' });
});

test('the apps folder is ./intent-tests, or the standalone test folder the engine runs inside', (t) => {
  const { apps, app } = workspace(t);
  const root = join(apps, '..');
  assert.equal(findAppsDir(root, {}), apps);
  assert.equal(
    findAppsDir(apps, {}),
    join(apps, 'intent-tests'),
    'without the workspace file the old default stays',
  );
  writeFileSync(join(apps, WORKSPACE_FILE), '{ "product": "clinic" }');
  assert.equal(findAppsDir(apps, {}), apps);
  assert.equal(findAppsDir(app, {}), apps);
  assert.equal(findAppsDir(root, {}), apps);
  assert.equal(findAppsDir(app, { AT_APPS_DIR: root }), root);
});

const DASHBOARD = 'https://dashboard.example.test';
const TOKEN = 'pit_pat_' + 'a'.repeat(32) + '_' + 'b'.repeat(43);

test('the dashboard URL comes from AT_DASHBOARD_URL, else the workspace file', (t) => {
  const { apps, app } = workspace(t);
  assert.equal(reportingDashboard(app, {}), undefined, 'no workspace file');
  writeFileSync(join(apps, WORKSPACE_FILE), '{ "product": "clinic" }');
  assert.equal(reportingDashboard(app, {}), undefined, 'no "dashboard" key');
  writeFileSync(
    join(apps, WORKSPACE_FILE),
    JSON.stringify({ product: 'clinic', dashboard: DASHBOARD + '/' }),
  );
  assert.deepEqual(reportingDashboard(app, {}), {
    url: DASHBOARD,
    source: join(apps, WORKSPACE_FILE),
  });
  assert.deepEqual(reportingDashboard(app, { AT_DASHBOARD_URL: 'https://other.example.test' }), {
    url: 'https://other.example.test',
    source: 'AT_DASHBOARD_URL',
  });
  writeFileSync(join(apps, WORKSPACE_FILE), '{ "product": "clinic", "dashboard": 7 }');
  assert.throws(() => reportingDashboard(app, {}), /"dashboard" must be a URL string/);
  writeFileSync(join(apps, WORKSPACE_FILE), '{ "product": "clinic", "dashboard": "nope" }');
  assert.throws(() => reportingDashboard(app, {}), /is not a URL/);
});

test('a run reports when a dashboard is set, and is local only when nothing asks for one', (t) => {
  const { apps, app } = workspace(t);
  assert.equal(reportingTarget(app, {}), undefined, 'no file, no token, no product: local only');
  writeFileSync(join(apps, WORKSPACE_FILE), '{}');
  assert.equal(reportingTarget(app, {}), undefined, 'an empty workspace file: local only');
  writeFileSync(
    join(apps, WORKSPACE_FILE),
    JSON.stringify({ product: 'clinic', dashboard: DASHBOARD }),
  );
  assert.equal(reportingTarget(app, {})?.url, DASHBOARD);
  assert.equal(reportingTarget(app, { AT_DASHBOARD_TOKEN: TOKEN })?.url, DASHBOARD);
});

test('a token or a product without a dashboard URL stops the run instead of quietly not reporting', (t) => {
  const { apps, app } = workspace(t);
  const stops = (environment: NodeJS.ProcessEnv, reason: RegExp) =>
    assert.throws(
      () => reportingTarget(app, environment),
      (error: Error) =>
        reason.test(error.message) &&
        error.message.includes('"dashboard"') &&
        error.message.includes(join(apps, WORKSPACE_FILE)) &&
        /Tests were not started/.test(error.message),
    );
  stops({ AT_DASHBOARD_TOKEN: TOKEN }, /AT_DASHBOARD_TOKEN is set/);
  stops({ AT_DASHBOARD_PRODUCT_KEY: 'clinic' }, /AT_DASHBOARD_PRODUCT_KEY is set/);
  writeFileSync(join(apps, WORKSPACE_FILE), '{ "product": "clinic" }');
  stops({}, /names a product/);
});
