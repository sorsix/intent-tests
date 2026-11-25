// `intent-test ids`: adds the `id:` line every test needs, from the file text, without the parser.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { insertIds, missingIds, slugify } from '../src/ids.ts';
import { parseAll } from '../src/parse.ts';

const bin = fileURLToPath(new URL('../bin/intent-test.mjs', import.meta.url));
const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function suite(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'intent-ids-'));
  dirs.push(dir);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}
const ids = (dir: string, ...args: string[]) =>
  spawnSync(process.execPath, [bin, 'ids', ...args], { cwd: dir, encoding: 'utf8' });

describe('slugify', () => {
  test('lowercase [a-z0-9-], readable, at most 60 characters', () => {
    assert.equal(slugify('Check in a patient by name'), 'check-in-a-patient-by-name');
    assert.equal(slugify("The page's  “Save” button — Šumadija"), 'the-pages-save-button-sumadija');
    assert.equal(slugify('Price {{param.age}}'), 'price-param-age');
    assert.equal(slugify('!!!'), 'test');
    const long = slugify(
      'A very long title that goes on and on well past the sixty character limit',
    );
    assert.ok(long.length <= 60 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(long), long);
    assert.equal(long, 'a-very-long-title-that-goes-on-and-on-well-past-the-sixty');
  });
});

describe('missingIds and insertIds', () => {
  test('ids are unique across files and never collide with written ids', () => {
    const found = missingIds([
      { file: 'a.md', content: '## Test: Same\n1. open "/"\n## Test: Taken\n1. open "/"\n' },
      {
        file: 'b.md',
        content: '## Test: Same\n1. open "/"\n## Test: Other\nid: taken\n1. open "/"\n',
      },
      { file: 'c.md', content: '## Test: Same\n1. open "/"\n' },
    ]);
    assert.deepEqual(
      found.map((m) => [m.file, m.line, m.id]),
      [
        ['a.md', 1, 'same'],
        ['a.md', 3, 'taken-2'],
        ['b.md', 1, 'same-2'],
        ['c.md', 1, 'same-3'],
      ],
    );
  });

  test('only the id line is inserted: other bytes, CRLF and a missing final newline are kept', () => {
    const content =
      '# T\r\n\r\n## Test: A\r\n1. open "/"\r\n\r\n## Steps: s\r\n1. open "/"\r\n## Test: B';
    const found = missingIds([{ file: 'x.md', content }]);
    assert.equal(
      insertIds(content, found),
      '# T\r\n\r\n## Test: A\r\nid: a\r\n1. open "/"\r\n\r\n## Steps: s\r\n1. open "/"\r\n## Test: B\nid: b',
    );
  });

  test('an id line in a test, or in another section, is respected', () => {
    const content =
      '## Test: A\nsession: x\nid: given\n1. open "/"\n## Steps: s\nid: not-a-test\n## Test: B\n1. open "/"\n';
    assert.deepEqual(
      missingIds([{ file: 'x.md', content }]).map((m) => m.name),
      ['B'],
    );
  });
});

describe('intent-test ids', () => {
  const files = {
    'one.md':
      '# One\n\n## Test: Log in\n1. open "/"\n\n## Test: Log out\nid: auth.out\n1. open "/"\n',
    'sub/two.md': '## Test: Log in\ntags: @a\n1. open "/"\n',
    'README.md': '## Test: not a test\n',
  };

  test('lists the tests without an id and fails; --write fixes them, idempotently', () => {
    const dir = suite(files);
    const listed = ids(dir, '.');
    assert.equal(listed.status, 1);
    assert.match(listed.stdout, /one\.md:3 {2}log-in {2}Log in/);
    assert.match(listed.stdout, /sub[/\\]two\.md:1 {2}log-in-2 {2}Log in/);
    assert.match(listed.stderr, /intent-test ids --write \./);
    assert.equal(readFileSync(join(dir, 'one.md'), 'utf8'), files['one.md']);

    assert.equal(ids(dir, '--write', '.').status, 0);
    assert.equal(
      readFileSync(join(dir, 'one.md'), 'utf8'),
      '# One\n\n## Test: Log in\nid: log-in\n1. open "/"\n\n## Test: Log out\nid: auth.out\n1. open "/"\n',
    );
    assert.equal(
      readFileSync(join(dir, 'sub/two.md'), 'utf8'),
      '## Test: Log in\nid: log-in-2\ntags: @a\n1. open "/"\n',
    );
    assert.equal(readFileSync(join(dir, 'README.md'), 'utf8'), files['README.md']);
    assert.equal(parseAll(dir).files.flatMap((f) => f.cases).length, 3);

    const again = ids(dir, '--write', '.');
    assert.equal(again.status, 0);
    assert.match(again.stdout, /Every test in 2 file\(s\) has an id/);
  });

  test('works on files the parser rejects, and takes files as well as folders', () => {
    const dir = suite({ 'bad.md': '## Test: Broken\n1. nonsense step\n' });
    assert.throws(() => parseAll(dir));
    assert.equal(ids(dir, '--write', 'bad.md').status, 0);
    assert.equal(
      readFileSync(join(dir, 'bad.md'), 'utf8'),
      '## Test: Broken\nid: broken\n1. nonsense step\n',
    );
  });

  test('rejects missing paths and unknown options', () => {
    const dir = suite({ 'a.md': '## Test: A\nid: a\n1. open "/"\n' });
    assert.equal(ids(dir).status, 2);
    assert.equal(ids(dir, '--bogus', '.').status, 2);
    assert.equal(ids(dir, 'nowhere').status, 2);
  });
});
