// bin/intent-test.mjs is the package's command. The published package runs dist/; a source checkout without a build
// runs src/ directly. test:package covers dist; this runs the same bin against the TypeScript sources.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const engine = fileURLToPath(new URL('..', import.meta.url));
const fixture = join(engine, 'test', 'fixture');
const clean = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/^(AT_|BASE_URL$)/.test(key)),
);

test('the bin runs every command from source when there is no build', (t) => {
  // A copy of the package without dist/: the bin and package.json, with src/ linked to the real sources.
  const root = mkdtempSync(join(tmpdir(), 'intent-engine-bin-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'bin'));
  copyFileSync(join(engine, 'bin', 'intent-test.mjs'), join(root, 'bin', 'intent-test.mjs'));
  copyFileSync(join(engine, 'package.json'), join(root, 'package.json'));
  symlinkSync(join(engine, 'src'), join(root, 'src'), 'dir');
  const bin = (...args: string[]) =>
    spawnSync(process.execPath, [join(root, 'bin', 'intent-test.mjs'), ...args], {
      env: { ...clean, AT_APP_DIR: fixture },
      encoding: 'utf8',
    });

  const version = JSON.parse(readFileSync(join(engine, 'package.json'), 'utf8')).version;
  assert.equal(bin('--version').stdout.trim(), version);
  assert.match(bin('help').stdout, /Usage: intent-engine <run\|/);
  const parsed = bin('parse');
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.match(parsed.stdout, /OK: [1-9]\d* tests/);
  const catalog = bin('catalog');
  assert.equal(catalog.status, 0, catalog.stderr);
  assert.equal(JSON.parse(catalog.stdout).kind, 'intent-catalog');
  // replay runs through its exported entry point, not as the main script.
  const replay = bin('replay');
  assert.equal(replay.status, 1);
  assert.match(replay.stderr, /Usage: intent-test replay <spool-directory>/);
  const unknown = bin('nope');
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown Intent Engine command: nope/);
});
