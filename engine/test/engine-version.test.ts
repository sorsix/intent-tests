import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  allowOutdatedFromEnvironment,
  checkEngineVersion,
  compareVersions,
  ENGINE_VERSION,
} from '../src/dashboard/engine-version.ts';

test('the reported version is the installed package version', () => {
  assert.equal(
    ENGINE_VERSION,
    JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
  );
});
test('versions compare numerically, not as text', () => {
  assert.ok(compareVersions('0.9.0', '0.11.0') < 0);
  assert.ok(compareVersions('1.0.0', '0.99.99') > 0);
  assert.equal(compareVersions('0.11.0', '0.11.0'), 0);
});
test('below the minimum stops the run unless outdated engines are allowed', () => {
  assert.throws(
    () => checkEngineVersion({ latest: '0.12.0', minimum: '0.11.0' }, false, '0.10.2'),
    /below the dashboard's minimum supported version 0\.11\.0.*--allow-outdated.*INTENT_ALLOW_OUTDATED=1.*Tests were not started/,
  );
  const allowed = checkEngineVersion({ latest: '0.12.0', minimum: '0.11.0' }, true, '0.10.2');
  assert.match(allowed.warning!, /marked outdated/);
  assert.equal(allowed.allowOutdated, true);
});
test('behind the latest only warns, and latest or newer is silent', () => {
  assert.match(
    checkEngineVersion({ latest: '0.11.0', minimum: null }, false, '0.10.2').warning!,
    /older than the latest release 0\.11\.0/,
  );
  assert.equal(
    checkEngineVersion({ latest: '0.11.0', minimum: '0.11.0' }, false, '0.11.0').warning,
    undefined,
  );
  assert.equal(
    checkEngineVersion({ latest: '0.11.0', minimum: null }, false, '0.12.0').warning,
    undefined,
  );
});
test('older dashboards and non-release builds skip the check', () => {
  assert.equal(checkEngineVersion(undefined, false, '0.1.0').warning, undefined);
  assert.equal(
    checkEngineVersion({ latest: '0.11.0', minimum: '0.11.0' }, false, '0.11.0-dev').warning,
    undefined,
  );
});
test('INTENT_ALLOW_OUTDATED accepts explicit truthy values only', () => {
  for (const value of ['1', 'true', 'YES'])
    assert.equal(allowOutdatedFromEnvironment({ INTENT_ALLOW_OUTDATED: value }), true);
  for (const value of [undefined, '', '0', 'false'])
    assert.equal(allowOutdatedFromEnvironment({ INTENT_ALLOW_OUTDATED: value }), false);
});
