// Body of `intent-test parse --app <name> [file-or-folder]` (run through parse.ts): validates test files without a browser or a decision model.
// A file or folder argument is resolved against the app folder (e.g. `booking` or `booking/bk-01-slot-filters.md`).
import { appDir, testsFilter } from '../app.ts';
import { loadEnv } from '../env.ts';
import { resolve } from 'node:path';
import { ParseError } from '../parse.ts';
import { loadParameters, loadSuite } from '../parameters.ts';
import { loadSeeds } from '../seeds.ts';

const arg = process.argv[2]; // parse.ts has taken --app out already
try {
  const envFiles = loadEnv();
  const suite = await loadSuite(appDir(), arg ? resolve(appDir(), arg) : testsFilter());
  console.log(`App: ${appDir()}`);
  console.log(`Env files: ${envFiles.join(', ') || 'none'}`);

  // Seeds live in the app folder, also when only part of it is parsed.
  const seeds = await loadSeeds(appDir());
  if (Object.keys(seeds).length) {
    console.log('\nSeeds:');
    for (const [name, seed] of Object.entries(seeds))
      console.log(`  "${name}"${seed.description ? `: ${seed.description}` : ''}`);
  }
  const parameters = await loadParameters(appDir());
  if (Object.keys(parameters).length) {
    console.log('\nParameter sets:');
    for (const [name, rows] of Object.entries(parameters))
      console.log(`  "${name}" (${rows.length} rows)`);
  }
  for (const tc of suite.files.flatMap((f) => f.cases)) {
    if (tc.seed && !seeds[tc.seed])
      throw new ParseError(
        `${tc.file}:${tc.line}: seed "${tc.seed}" is not defined in ${appDir()}/seeds.ts`,
      );
  }

  if (suite.blocks.size) {
    console.log('\nShared steps:');
    for (const b of suite.blocks.values())
      console.log(`  "${b.name}" (${b.steps.length} steps, ${b.file}:${b.line})`);
  }
  for (const f of suite.files) {
    if (f.cases.length === 0) continue;
    console.log(`\n== ${f.rel}`);
    for (const tc of f.cases) {
      const meta = [
        tc.parameters && `parameters: ${tc.parameters.set} [${tc.parameters.key}]`,
        tc.seed && `seed: ${tc.seed}`,
        tc.session && `session: ${tc.session}`,
        ...tc.tags,
      ]
        .filter(Boolean)
        .join('  ');
      console.log(`\n${tc.name}${meta ? `  [${meta}]` : ''}`);
      for (const s of tc.steps) console.log(`  ${s.label.padStart(4)}. [${s.kind}] ${s.text}`);
    }
  }
  const tests = suite.files.reduce((n, f) => n + f.cases.length, 0);
  const steps = suite.files.reduce(
    (n, f) => n + f.cases.reduce((m, c) => m + c.steps.length, 0),
    0,
  );
  console.log(
    `\nOK: ${tests} tests, ${steps} steps, ${suite.blocks.size} shared step blocks, ${suite.sessions.length} sessions in ${suite.files.length} files`,
  );
} catch (e) {
  if (e instanceof ParseError) {
    console.error(`Parse error: ${e.message}`);
    process.exit(1);
  }
  if (e instanceof Error && /^(No app chosen|AT_APP)/.test(e.message)) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
}
