import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  launcherInstallationId,
  runAnnouncement,
  runBanner,
  runName,
  runPurpose,
} from '../src/dashboard/options.ts';

test('run names use the trimmed AT_RUN_NAME and otherwise the default', () => {
  assert.equal(
    runName('default', { AT_RUN_NAME: '  Developer clinic run  ' }),
    'Developer clinic run',
  );
  assert.equal(runName('default', { AT_RUN_NAME: ' \t ' }), 'default');
  assert.equal(runName('default', {}), 'default');
});

test('banner shows the stable run number, name and the dashboard link', () => {
  const input = {
    dashboard: 'https://dashboard.example.test',
    runId: '11111111-1111-1111-1111-111111111111',
    runNumber: 42,
    name: 'Named local run',
  };
  assert.equal(
    runBanner(input),
    'Dashboard run #42: Named local run\nhttps://dashboard.example.test/runs/11111111-1111-1111-1111-111111111111',
  );
  assert.equal(
    runBanner({ ...input, runNumber: null }).startsWith('Dashboard run: Named local run'),
    true,
  );
  assert.equal(runBanner({ ...input, name: 'A\nB\tC' }).split('\n').length, 2);
});

test('the machine-readable run line is one compact JSON line after a fixed prefix', () => {
  const input = {
    dashboard: 'https://dashboard.example.test',
    runId: '11111111-1111-1111-1111-111111111111',
  };
  assert.equal(
    runAnnouncement({ ...input, runNumber: 42 }),
    '@intent-run {"runId":"11111111-1111-1111-1111-111111111111","runNumber":42,"url":"https://dashboard.example.test/runs/11111111-1111-1111-1111-111111111111"}',
  );
  for (const runNumber of [null, undefined, 0, 1.5])
    assert.deepEqual(JSON.parse(runAnnouncement({ ...input, runNumber }).slice(12)), {
      runId: input.runId,
      runNumber: null,
      url: `https://dashboard.example.test/runs/${input.runId}`,
    });
});

test('the run purpose comes from AT_RUN_PURPOSE, then the app config, and must be a known value', () => {
  assert.equal(runPurpose({}), undefined);
  assert.equal(runPurpose({}, 'authoring'), 'authoring');
  assert.equal(runPurpose({ AT_RUN_PURPOSE: ' Verification ' }, 'authoring'), 'verification');
  assert.throws(() => runPurpose({ AT_RUN_PURPOSE: 'smoke' }), /verification or authoring/);
  assert.throws(() => runPurpose({}, 'smoke'), /verification or authoring/);
});

test('only a UUID counts as the Launcher installation', () => {
  const id = '4f0c1c0e-6c77-4b51-9d55-0f2c2d5b7e11';
  assert.equal(launcherInstallationId({ AT_LAUNCHER_INSTALLATION_ID: ` ${id} ` }), id);
  assert.equal(launcherInstallationId({ AT_LAUNCHER_INSTALLATION_ID: 'x' }), undefined);
  assert.equal(launcherInstallationId({}), undefined);
});
