// `intent-test parse-all`: validates the tests of every app in intent-tests/ (no browser, no decision model, no node_modules).
// Each app is parsed in its own process, since an app's config and env are loaded once per process. Used by CI.
import './node-check.ts';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const { knownApps } = await import('../app.ts');
// parse.ts from source, parse.js in the compiled package.
const parse = fileURLToPath(
  new URL(import.meta.url.endsWith('.ts') ? './parse.ts' : './parse.js', import.meta.url),
);
let failed = 0;
for (const app of knownApps()) {
  const res = spawnSync(process.execPath, [parse, '--app', app], { encoding: 'utf8' });
  const out = `${res.stdout}${res.stderr}`.trim().split('\n');
  console.log(`${app}: ${res.status === 0 ? out.at(-1) : 'FAILED'}`);
  if (res.status !== 0) {
    console.error(out.slice(-20).join('\n'));
    failed++;
  }
}
process.exit(failed ? 1 : 0);
