import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { presets } from '../src/decider/presets.ts';

// docs/reference.json is the engine reference shown on the dashboard. These checks keep it in step with the source.
const root = new URL('..', import.meta.url).pathname;
type Row = { name: string; tags?: string[] } & Record<string, unknown>;
type Group = { title: string; columns?: { key: string }[]; rows?: Row[]; items?: string[] };
const reference = JSON.parse(readFileSync(join(root, 'docs/reference.json'), 'utf8')) as {
  schemaVersion: number;
  sections: { id: string; groups: Group[] }[];
};
const groups = reference.sections.flatMap((section) => section.groups);
const table = (title: string) => {
  const group = groups.find((item) => item.title === title);
  assert.ok(group?.rows, `reference table "${title}"`);
  return group.rows;
};

function files(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? files(path) : /\.(ts|mjs)$/.test(name) ? [path] : [];
  });
}
const source = [
  ...files(join(root, 'src')),
  join(root, 'bin/intent-test.mjs'),
  join(root, 'playwright.intent.config.ts'),
]
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n');
const variables = new Set(
  groups
    .flatMap((group) => group.rows || [])
    .flatMap((row) => row.name.split(/,\s*/).filter((name) => /^[A-Z][A-Z0-9_]+$/.test(name))),
);

test('every group is a table whose rows fill its columns, or a list', () => {
  assert.equal(reference.schemaVersion, 1);
  assert.equal(
    new Set(reference.sections.map((section) => section.id)).size,
    reference.sections.length,
  );
  for (const group of groups) {
    assert.ok(!!group.rows !== !!group.items, group.title);
    for (const row of group.rows || []) {
      assert.deepEqual(
        Object.keys(row).filter((key) => key !== 'tags'),
        group.columns!.map((column) => column.key),
        `${group.title}: ${row.name}`,
      );
      for (const tag of row.tags || []) assert.ok(['secret', 'internal'].includes(tag), tag);
    }
  }
});

test('every engine environment variable is documented', () => {
  const read = new Set(source.match(/\b(AT|INTENT|PW)_[A-Z0-9_]+\b/g));
  const missing = [...read].filter((name) => !variables.has(name));
  assert.deepEqual(missing, [], 'add these to docs/reference.json');
});

test('every documented variable is still read by the engine', () => {
  const stale = [...variables].filter((name) => !new RegExp(`\\b${name}\\b`).test(source));
  assert.deepEqual(stale, [], 'remove these from docs/reference.json');
});

test('commands, presets and config keys match the source', () => {
  const bin = readFileSync(join(root, 'bin/intent-test.mjs'), 'utf8');
  const dispatched = Object.keys(
    Object.fromEntries(
      [...bin.matchAll(/^\s+'?([a-z-]+)'?: '[a-z-]+',$/gm)].map((match) => [match[1], true]),
    ),
  );
  assert.deepEqual(
    table('Commands')
      .map((row) => row.name)
      .filter((name) => !name.startsWith('-'))
      .sort(),
    [...dispatched, 'help', 'run'].sort(),
  );
  assert.deepEqual(
    table('Presets')
      .map((row) => row.name)
      .sort(),
    Object.keys(presets).sort(),
  );
  const config = readFileSync(join(root, 'src/define-config.ts'), 'utf8');
  const keys = [
    ...config.slice(config.indexOf('export type AppConfig')).matchAll(/^ {2}(\w+)\?:/gm),
  ].map((match) => match[1]);
  assert.deepEqual(
    table('intent-tests.config.ts')
      .map((row) => row.name)
      .sort(),
    keys.sort(),
  );
});

test('the README settings tables list exactly the AT_ variables the engine source reads', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const settings = readme.slice(
    readme.indexOf('## Settings'),
    readme.indexOf('## How it uses Playwright'),
  );
  const documented = new Set(
    settings
      .split('\n')
      .filter((line) => line.startsWith('| `'))
      .flatMap((line) => line.split('|')[1].match(/\bAT_[A-Z0-9_]+/g) ?? []),
  );
  const read = new Set(
    files(join(root, 'src')).flatMap(
      (path) => readFileSync(path, 'utf8').match(/\bAT_[A-Z0-9_]+/g) ?? [],
    ),
  );
  assert.deepEqual(
    [...read].filter((name) => !documented.has(name)).sort(),
    [],
    'add to the README settings',
  );
  assert.deepEqual(
    [...documented].filter((name) => !read.has(name)).sort(),
    [],
    'remove from the README settings',
  );
});
