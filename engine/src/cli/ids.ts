// `intent-test ids [--write] <suite file or folder>...`: lists the tests that have no `id:` line, or with --write adds
// one under each heading. Reads the files as text, so it works on suites the parser rejects. No app, env or browser.
import './node-check.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findTestFiles } from '../parse.ts';
import { insertIds, missingIds } from '../ids.ts';

const USAGE = 'Usage: intent-test ids [--write] <suite file or folder>...';

/** Returns the exit code: 0 when every test has an id (or --write added them), 1 when ids are missing, 2 on bad usage. */
export function main(args: string[], cwd = process.cwd()): number {
  const write = args.includes('--write');
  const flags = args.filter((a) => a.startsWith('-') && a !== '--write');
  const paths = args.filter((a) => !a.startsWith('-'));
  if (flags.length || paths.length === 0) {
    console.error(flags.length ? `Unknown option ${flags[0]}. ${USAGE}` : USAGE);
    return 2;
  }
  let found: string[];
  try {
    found = [...new Set(paths.flatMap((p) => findTestFiles(resolve(cwd, p))))].sort();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 2;
  }
  if (found.length === 0) {
    console.error(`No .md test files under ${paths.join(', ')}.`);
    return 2;
  }
  const files = found.map((path) => ({ path, file: relative(cwd, path) || path }));
  const contents = new Map(files.map((f) => [f.file, readFileSync(f.path, 'utf8')]));
  const missing = missingIds(files.map((f) => ({ file: f.file, content: contents.get(f.file)! })));
  if (missing.length === 0) {
    console.log(`Every test in ${files.length} file(s) has an id.`);
    return 0;
  }
  for (const m of missing) console.log(`${m.file}:${m.line}  ${m.id}  ${m.name}`);
  if (!write) {
    console.error(
      `\n${missing.length} test(s) have no id. Run "intent-test ids --write ${paths.join(' ')}" to add them.`,
    );
    return 1;
  }
  for (const f of files) {
    const mine = missing.filter((m) => m.file === f.file);
    if (mine.length) writeFileSync(f.path, insertIds(contents.get(f.file)!, mine));
  }
  console.log(`\nAdded ${missing.length} id(s). Review them and commit the changes.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
