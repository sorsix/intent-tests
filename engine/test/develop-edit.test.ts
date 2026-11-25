// Develop mode's text edits (src/develop/edit.ts): only the touched lines change, steps are renumbered, every other
// byte of the file is kept (CRLF, trailing text, unterminated last lines, other sections).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  appendCase,
  appendSection,
  caseText,
  deleteStep,
  duplicateCase,
  renameCase,
  EditError,
  findBlock,
  findSection,
  insertStep,
  quotedChanges,
  removeCase,
  replaceQuoted,
  replaceStep,
  sections,
  setDraft,
  setMetaLine,
  setRefs,
  uniqueId,
  writtenIds,
} from '../src/develop/edit.ts';
import { parseAll } from '../src/parse.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Trailing whitespace after a step, kept by edits of other lines (and written out so editors keep it here). */
const TRAIL = '   ';
const FILE = `# Booking

Intro text that is not a test.

## Test: Book a slot
id: book
session: log in
1. open "/booking"
2. click "Next"${TRAIL}
3. expect the page shows "Booked"
Note: trailing notes stay.

## Steps: log in
1. open "/"
2. click "Log in"

## Test: Cancel
id: cancel
tags: @smoke
  1. open "/cancel"
  2. click "Cancel"
`;

const crlf = (s: string) => s.replace(/\n/g, '\r\n');

/** The lines of `after` that differ from `before`, as [line number, text] (same line count only). */
function changed(before: string, after: string): [number, string][] {
  const a = before.split('\n'),
    b = after.split('\n');
  assert.equal(a.length, b.length, 'same number of lines');
  return b.flatMap((line, i) => (line === a[i] ? [] : [[i + 1, line] as [number, string]]));
}

describe('reading sections', () => {
  test('sections, ids and steps as written', () => {
    const all = sections(FILE);
    assert.deepEqual(
      all.map((s) => [s.name, s.id, s.line, s.session]),
      [
        ['Book a slot', 'book', 5, 'log in'],
        ['Cancel', 'cancel', 17, undefined],
      ],
    );
    assert.deepEqual(findSection(FILE, 'book')!.steps, [
      { line: 8, number: 1, text: 'open "/booking"' },
      { line: 9, number: 2, text: 'click "Next"' },
      { line: 10, number: 3, text: 'expect the page shows "Booked"' },
    ]);
    assert.deepEqual(findSection(FILE, 'cancel')!.tags, ['@smoke']);
    assert.equal(findSection(FILE, 'missing'), null);
    assert.deepEqual(writtenIds(FILE), ['book', 'cancel']);
  });
});

describe('replaceStep', () => {
  test('changes only that line, keeping its indentation and ending', () => {
    const out = replaceStep(FILE, 'book', 1, 'click "Continue"');
    assert.deepEqual(changed(FILE, out), [[9, '2. click "Continue"']]);
    const indented = replaceStep(FILE, 'cancel', 0, 'open "/x"');
    assert.deepEqual(changed(FILE, indented), [[20, '  1. open "/x"']]);
  });

  test('CRLF files keep CRLF', () => {
    const out = replaceStep(crlf(FILE), 'book', 0, 'open "/b"');
    assert.equal(out, crlf(replaceStep(FILE, 'book', 0, 'open "/b"')));
    assert.ok(!/[^\r]\n/.test(out));
  });

  test('rejects an unknown case, an index out of range and multi-line text', () => {
    assert.throws(() => replaceStep(FILE, 'nope', 0, 'open "/"'), EditError);
    assert.throws(() => replaceStep(FILE, 'book', 3, 'open "/"'), /out of range/);
    assert.throws(() => replaceStep(FILE, 'book', -1, 'open "/"'), /out of range/);
    assert.throws(() => replaceStep(FILE, 'book', 0, 'open "/"\n4. click "x"'), /line break/);
    assert.throws(() => replaceStep(FILE, 'book', 0, '   '), /empty/);
  });
});

describe('insertStep', () => {
  test('before a step renumbers the ones after it', () => {
    const out = insertStep(FILE, 'book', 1, 'wait 1 second');
    assert.equal(
      out,
      FILE.replace(
        '2. click "Next"   \n3. expect',
        '2. wait 1 second\n3. click "Next"   \n4. expect',
      ),
    );
  });

  test('at the end appends after the last step, before trailing notes', () => {
    const out = insertStep(FILE, 'book', 3, 'press "Enter"');
    assert.equal(
      out,
      FILE.replace(
        '3. expect the page shows "Booked"\n',
        '3. expect the page shows "Booked"\n4. press "Enter"\n',
      ),
    );
  });

  test('uses the section indentation and keeps other sections', () => {
    const out = insertStep(FILE, 'cancel', 0, 'wait 1 second');
    assert.ok(out.endsWith('  1. wait 1 second\n  2. open "/cancel"\n  3. click "Cancel"\n'), out);
    assert.equal(
      out.slice(0, out.indexOf('## Test: Cancel')),
      FILE.slice(0, FILE.indexOf('## Test: Cancel')),
    );
  });

  test('a file without a final line ending stays without one', () => {
    const file = FILE.replace(/\n$/, '');
    const out = insertStep(file, 'cancel', 2, 'wait 1 second');
    assert.ok(
      out.endsWith('  2. click "Cancel"\n  3. wait 1 second'),
      JSON.stringify(out.slice(-40)),
    );
  });

  test('the first step of a case without steps goes under its metadata', () => {
    const file = '## Test: New\nid: new\ntags: @draft\n\n## Test: Other\nid: other\n1. open "/"\n';
    const out = insertStep(file, 'new', 0, 'open "/start"');
    assert.equal(
      out,
      '## Test: New\nid: new\ntags: @draft\n1. open "/start"\n\n## Test: Other\nid: other\n1. open "/"\n',
    );
    assert.throws(() => insertStep(file, 'new', 1, 'open "/"'), /out of range/);
  });

  test('CRLF: the new line ends with CRLF too', () => {
    const out = insertStep(crlf(FILE), 'book', 3, 'press "Enter"');
    assert.equal(out, crlf(insertStep(FILE, 'book', 3, 'press "Enter"')));
    const unterminated = insertStep(crlf(FILE).replace(/\r\n$/, ''), 'cancel', 2, 'wait 1 second');
    assert.ok(unterminated.endsWith('click "Cancel"\r\n  3. wait 1 second'));
  });
});

describe('deleteStep', () => {
  test('removes the line and renumbers, nothing else changes', () => {
    const out = deleteStep(FILE, 'book', 0);
    assert.equal(
      out,
      FILE.replace(
        '1. open "/booking"\n2. click "Next"   \n3. expect',
        '1. click "Next"   \n2. expect',
      ),
    );
  });

  test('deleting the unterminated last line leaves the new last line unterminated', () => {
    const file = FILE.replace(/\n$/, '');
    assert.ok(deleteStep(file, 'cancel', 1).endsWith('  1. open "/cancel"'));
  });

  test('insert then delete is the identity, also on CRLF', () => {
    for (const file of [FILE, crlf(FILE), FILE.replace(/\n$/, '')])
      for (const [id, at] of [
        ['book', 0],
        ['book', 3],
        ['cancel', 2],
      ] as const)
        assert.equal(deleteStep(insertStep(file, id, at, 'wait 2 seconds'), id, at), file);
  });

  test('steps numbered wrongly by hand are renumbered by any edit', () => {
    const file = '## Test: A\nid: a\n1. open "/"\n3. click "x"\n7. click "y"\n';
    assert.equal(deleteStep(file, 'a', 0), '## Test: A\nid: a\n1. click "x"\n2. click "y"\n');
  });
});

describe('a ## Steps: block as the target', () => {
  const block = { block: 'log in' } as const;

  test('findBlock reads the block and its steps; sections lists tests only', () => {
    const found = findBlock(FILE, 'log in')!;
    assert.equal(found.kind, 'steps');
    assert.equal(found.line, 13);
    assert.deepEqual(found.steps, [
      { line: 14, number: 1, text: 'open "/"' },
      { line: 15, number: 2, text: 'click "Log in"' },
    ]);
    assert.equal(findBlock(FILE, 'book'), null);
    assert.ok(sections(FILE).every((section) => section.kind === 'test'));
    // A line that looks like metadata inside a block is just a line: no case is found by it.
    const odd = '## Steps: odd\nid: odd\n1. open "/"\n';
    assert.equal(findSection(odd, 'odd'), null);
    assert.deepEqual(findBlock(odd, 'odd')!.steps, [{ line: 3, number: 1, text: 'open "/"' }]);
  });

  test('replaceStep changes only that line of the block', () => {
    const out = replaceStep(FILE, block, 1, 'click the "Log in" button');
    assert.deepEqual(changed(FILE, out), [[15, '2. click the "Log in" button']]);
    assert.equal(
      replaceStep(crlf(FILE), block, 0, 'open "/x"'),
      crlf(replaceStep(FILE, block, 0, 'open "/x"')),
    );
  });

  test('insertStep and deleteStep renumber the block and leave the cases alone', () => {
    const inserted = insertStep(FILE, block, 1, 'wait 1 second');
    assert.equal(
      inserted,
      FILE.replace(
        '1. open "/"\n2. click "Log in"\n',
        '1. open "/"\n2. wait 1 second\n3. click "Log in"\n',
      ),
    );
    const appended = insertStep(FILE, block, 2, 'expect the page shows "Home"');
    assert.ok(
      appended.includes('2. click "Log in"\n3. expect the page shows "Home"\n\n## Test: Cancel'),
    );
    for (const file of [FILE, crlf(FILE), FILE.replace(/\n$/, '')])
      for (const at of [0, 1, 2])
        assert.equal(deleteStep(insertStep(file, block, at, 'wait 2 seconds'), block, at), file);
    assert.equal(
      deleteStep(FILE, block, 0),
      FILE.replace('1. open "/"\n2. click "Log in"\n', '1. click "Log in"\n'),
    );
    // The first step of an emptied block goes right under its heading.
    const empty = '## Steps: bare\n\n## Test: T\nid: t\n1. open "/"\n';
    assert.equal(
      insertStep(empty, { block: 'bare' }, 0, 'open "/"'),
      '## Steps: bare\n1. open "/"\n\n## Test: T\nid: t\n1. open "/"\n',
    );
  });

  test('a block name never matches a case and a case id never matches a block', () => {
    assert.throws(() => replaceStep(FILE, 'log in', 0, 'open "/"'), /no "## Test:" section/);
    assert.throws(
      () => replaceStep(FILE, { block: 'book' }, 0, 'open "/"'),
      /no "## Steps: book" section/,
    );
    assert.throws(() => insertStep(FILE, { block: 'nope' }, 0, 'open "/"'), EditError);
    assert.throws(() => deleteStep(FILE, block, 2), /out of range/);
  });

  test('the result parses: the edited block reaches the session and the use step', () => {
    const dir = mkdtempSync(join(tmpdir(), 'develop-edit-block-'));
    try {
      const withUse = insertStep(FILE, 'cancel', 0, 'use "log in"');
      writeFileSync(
        join(dir, 'a.md'),
        insertStep(withUse, block, 2, 'expect the page shows "Home"'),
      );
      const suite = parseAll(dir);
      assert.deepEqual(
        suite.blocks.get('log in')!.steps.map((step) => step.kind),
        ['open', 'click', 'expect'],
      );
      const cancel = suite.files[0].cases.find((test) => test.explicitId === 'cancel')!;
      assert.deepEqual(
        cancel.steps.map((step) => step.label),
        ['1.1', '1.2', '1.3', '2', '3'],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('setDraft', () => {
  test('adds a tags line under id when there is none, and removes it again', () => {
    const out = setDraft(FILE, 'book', true);
    assert.ok(out.includes('id: book\ntags: @draft\nsession: log in\n'));
    assert.equal(setDraft(out, 'book', false), FILE);
    assert.equal(setDraft(FILE, 'book', false), FILE, 'already not a draft');
  });

  test('adds to and removes from an existing tags line', () => {
    const out = setDraft(FILE, 'cancel', true);
    assert.ok(out.includes('tags: @smoke @draft\n'));
    assert.equal(setDraft(out, 'cancel', true), out, 'already a draft');
    assert.equal(setDraft(out, 'cancel', false), FILE);
    const commas = '## Test: A\nid: a\ntags: @a, draft, @b\n1. open "/"\n';
    assert.equal(setDraft(commas, 'a', false), '## Test: A\nid: a\ntags: @a, @b\n1. open "/"\n');
    assert.equal(
      setDraft('## Test: A\nid: a\ntags: @a, @b\n1. open "/"\n', 'a', true),
      '## Test: A\nid: a\ntags: @a, @b, @draft\n1. open "/"\n',
    );
  });

  test('CRLF', () => {
    const out = setDraft(crlf(FILE), 'book', true);
    assert.equal(out, crlf(setDraft(FILE, 'book', true)));
    assert.equal(setDraft(out, 'book', false), crlf(FILE));
  });
});

describe('setRefs', () => {
  test('writes a refs line under id (after a tags line right under it), rewrites and removes it', () => {
    const out = setRefs(FILE, 'cancel', ['C1', 'TR:2']);
    assert.ok(out.includes('id: cancel\ntags: @smoke\nrefs: C1, TR:2\n'));
    const rewritten = setRefs(out, 'cancel', ['C3']);
    assert.deepEqual(changed(out, rewritten), [[20, 'refs: C3']]);
    assert.equal(setRefs(rewritten, 'cancel', []), FILE);
    assert.ok(setRefs(FILE, 'book', ['C9']).includes('id: book\nrefs: C9\nsession: log in\n'));
    assert.equal(setRefs(FILE, 'book', []), FILE);
  });

  test('rejects references the grammar does not allow', () => {
    assert.throws(() => setRefs(FILE, 'book', ['has space']), /reference/);
    assert.throws(() => setRefs(FILE, 'book', ['C1', 'C1']), /twice/);
    assert.throws(
      () =>
        setRefs(
          FILE,
          'book',
          Array.from({ length: 21 }, (_, i) => `C${i}`),
        ),
      /20/,
    );
    assert.throws(() => setRefs(FILE, 'book', ['x'.repeat(51)]), /reference/);
  });

  test('the result parses: refs and draft reach the parsed case', () => {
    const dir = mkdtempSync(join(tmpdir(), 'intent-develop-edit-'));
    try {
      writeFileSync(join(dir, 'a.md'), setDraft(setRefs(FILE, 'book', ['C1', 'C2']), 'book', true));
      const [book, cancel] = parseAll(dir).files[0].cases;
      assert.deepEqual([book.refs, book.draft, book.tags], [['C1', 'C2'], true, ['@draft']]);
      assert.deepEqual([cancel.refs, cancel.draft], [[], false]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('setMetaLine', () => {
  test('writes, rewrites and removes session and seed lines after the last metadata line', () => {
    const seeded = setMetaLine(FILE, 'book', 'seed', 'demo');
    assert.ok(seeded.includes('id: book\nsession: log in\nseed: demo\n1. open "/booking"\n'));
    assert.equal(seeded.length, FILE.length + 'seed: demo\n'.length);
    assert.equal(setMetaLine(seeded, 'book', 'seed', null), FILE);
    const switched = setMetaLine(FILE, 'book', 'session', ' other ');
    assert.ok(switched.includes('id: book\nsession: other\n1. open "/booking"\n'));
    assert.equal(switched.length, FILE.length - 'log in'.length + 'other'.length);
    assert.equal(setMetaLine(switched, 'book', 'session', 'log in'), FILE);
    assert.ok(!setMetaLine(FILE, 'book', 'session', null).includes('session: log in\n'));
    // After `tags:`, keeping the section's indentation style of the metadata lines.
    const cancel = setMetaLine(FILE, 'cancel', 'session', 'log in');
    assert.ok(cancel.includes('id: cancel\ntags: @smoke\nsession: log in\n  1. open "/cancel"\n'));
    assert.equal(setMetaLine(FILE, 'cancel', 'seed', null), FILE);
    assert.throws(() => setMetaLine(FILE, 'book', 'seed', ' '), EditError);
    assert.throws(() => setMetaLine(FILE, 'book', 'seed', 'a\nb'), EditError);
    assert.throws(() => setMetaLine(FILE, 'nobody', 'seed', 'x'), EditError);
  });

  test('the result parses: the session reaches the parsed case', () => {
    const dir = mkdtempSync(join(tmpdir(), 'intent-develop-edit-'));
    try {
      writeFileSync(join(dir, 'a.md'), setMetaLine(FILE, 'cancel', 'session', 'log in'));
      const [book, cancel] = parseAll(dir).files[0].cases;
      assert.equal(book.session, 'log in');
      assert.equal(cancel.session, 'log in');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('removeCase', () => {
  const THREE = `# Notes

## Test: A
id: a
1. open "/a"

## Test: B
id: b
tags: @draft

## Test: C
id: c
1. open "/c"
`;

  test('the first, a middle and the last section go with the blank lines that separated them', () => {
    assert.equal(
      removeCase(THREE, 'a'),
      '# Notes\n\n## Test: B\nid: b\ntags: @draft\n\n## Test: C\nid: c\n1. open "/c"\n',
    );
    assert.equal(
      removeCase(THREE, 'b'),
      '# Notes\n\n## Test: A\nid: a\n1. open "/a"\n\n## Test: C\nid: c\n1. open "/c"\n',
    );
    assert.equal(
      removeCase(THREE, 'c'),
      '# Notes\n\n## Test: A\nid: a\n1. open "/a"\n\n## Test: B\nid: b\ntags: @draft\n',
    );
    assert.equal(removeCase(crlf(THREE), 'b'), crlf(removeCase(THREE, 'b')));
  });

  test('a section followed by a Steps block, the only section of a file, an unterminated last line', () => {
    assert.equal(
      removeCase(FILE, 'book'),
      `# Booking\n\nIntro text that is not a test.\n\n## Steps: log in\n1. open "/"\n2. click "Log in"\n\n## Test: Cancel\nid: cancel\ntags: @smoke\n  1. open "/cancel"\n  2. click "Cancel"\n`,
    );
    assert.equal(removeCase('## Test: N\nid: n\ntags: @draft\n', 'n'), '');
    assert.equal(removeCase(appendCase('x\n', { name: 'N', id: 'n' }), 'n'), 'x\n');
    assert.equal(
      removeCase('## Test: A\nid: a\n1. open "/"\n\n## Test: B\nid: b', 'b'),
      '## Test: A\nid: a\n1. open "/"\n',
    );
    assert.throws(() => removeCase(FILE, 'nope'), EditError);
  });
});

describe('appendCase', () => {
  test('appends a draft section after a blank line, keeping the file', () => {
    const out = appendCase(FILE, {
      name: 'New one',
      id: 'new-one',
      session: 'reception',
      seed: 'patient',
    });
    assert.equal(
      out,
      `${FILE}\n## Test: New one\nid: new-one\ntags: @draft\nsession: reception\nseed: patient\n`,
    );
    assert.deepEqual(findSection(out, 'new-one')!.steps, []);
  });

  test('an unterminated or CRLF file, a file ending in a blank line, a new file', () => {
    assert.equal(appendCase('x', { name: 'N', id: 'n' }), 'x\n\n## Test: N\nid: n\ntags: @draft\n');
    assert.equal(
      appendCase('x\r\n', { name: 'N', id: 'n' }),
      'x\r\n\r\n## Test: N\r\nid: n\r\ntags: @draft\r\n',
    );
    assert.equal(
      appendCase('x\n\n', { name: 'N', id: 'n' }),
      'x\n\n## Test: N\nid: n\ntags: @draft\n',
    );
    assert.equal(appendCase('', { name: 'N', id: 'n' }), '## Test: N\nid: n\ntags: @draft\n');
  });

  test('rejects a duplicate name, an invalid id and line breaks', () => {
    assert.throws(() => appendCase(FILE, { name: 'Cancel', id: 'x' }), /already has a test named/);
    assert.throws(() => appendCase(FILE, { name: 'X', id: '-bad' }), /invalid id/);
    assert.throws(() => appendCase(FILE, { name: 'X\nY', id: 'x' }), /one non-empty line/);
  });

  test('uniqueId adds -2, -3 to a taken slug, ignoring case', () => {
    assert.equal(uniqueId('book', ['cancel']), 'book');
    assert.equal(uniqueId('book', ['Book', 'book-2']), 'book-3');
  });
});

describe('replaceQuoted', () => {
  const LABELS = `# Labels

Note: the "Next" button moved; heading and notes keep their quotes.

## Test: Click "Next"
id: next
session: log in
1. click "Next"${TRAIL}
2. expect the page shows "Next" and "Next step"
3. click "Back" in "Next"
4. use "Next"
5. optionally click the "Next" button
6. fill "Next" with "x" in "Next
Note: "Next" here is a note.

## Steps: log in
1. click "Next"
2. switch to session "Next"

## Test: Other
id: other
  1. click "Nextt"
  2. click "a" Next "b"
`;

  test('renames exactly the quoted label in step lines, keeping every other byte', () => {
    const out = replaceQuoted(LABELS, 'Next', 'Continue');
    assert.deepEqual(changed(LABELS, out), [
      [8, `1. click "Continue"${TRAIL}`],
      [9, '2. expect the page shows "Continue" and "Next step"'],
      [10, '3. click "Back" in "Continue"'],
      [12, '5. optionally click the "Continue" button'],
      // The last quote is unpaired: it opens nothing.
      [13, '6. fill "Continue" with "x" in "Next'],
      [17, '1. click "Continue"'],
    ]);
    assert.deepEqual(changed(crlf(LABELS), replaceQuoted(crlf(LABELS), 'Next', 'Continue')), [
      [8, `1. click "Continue"${TRAIL}\r`],
      [9, '2. expect the page shows "Continue" and "Next step"\r'],
      [10, '3. click "Back" in "Continue"\r'],
      [12, '5. optionally click the "Continue" button\r'],
      [13, '6. fill "Continue" with "x" in "Next\r'],
      [17, '1. click "Continue"\r'],
    ]);
    assert.equal(
      replaceQuoted(crlf(LABELS), 'Next', 'Continue'),
      crlf(replaceQuoted(LABELS, 'Next', 'Continue')),
    );
  });

  test('a label inside another label, between labels, or a block name is not it', () => {
    assert.equal(replaceQuoted(LABELS, 'Next s', 'X'), LABELS);
    assert.equal(replaceQuoted(LABELS, ' Next ', 'X'), LABELS, 'the text between two labels');
    assert.equal(replaceQuoted(LABELS, 'log in', 'X'), LABELS, 'headings and session lines stay');
    assert.equal(replaceQuoted(LABELS, 'next', 'X'), LABELS, 'case matters');
    assert.deepEqual(changed(LABELS, replaceQuoted(LABELS, 'Next step', 'Then')), [
      [9, '2. expect the page shows "Next" and "Then"'],
    ]);
  });

  test('quotedChanges lists each changed step with its case, before and after', () => {
    assert.deepEqual(quotedChanges(LABELS, 'Back', 'Previous'), [
      {
        line: 10,
        caseId: 'next',
        before: 'click "Back" in "Next"',
        after: 'click "Previous" in "Next"',
      },
    ]);
    const all = quotedChanges(LABELS, 'Next', 'Go on');
    assert.deepEqual(
      all.map((change) => [change.line, change.caseId]),
      [
        [8, 'next'],
        [9, 'next'],
        [10, 'next'],
        [12, 'next'],
        [13, 'next'],
        [17, undefined],
      ],
    );
    assert.equal(all[0].before, 'click "Next"', 'trailing text trimmed');
    assert.deepEqual(quotedChanges(LABELS, 'Nothing', 'X'), []);
  });

  test('an unterminated last line, and renaming back restores the bytes', () => {
    const file = '## Test: T\nid: t\n1. click "Save"';
    assert.equal(replaceQuoted(file, 'Save', 'Store'), '## Test: T\nid: t\n1. click "Store"');
    const renamed = replaceQuoted(crlf(FILE), 'Next', 'Onward');
    assert.notEqual(renamed, crlf(FILE));
    assert.equal(replaceQuoted(renamed, 'Onward', 'Next'), crlf(FILE));
  });

  test('refuses an empty label, a quote in the new one and line breaks', () => {
    assert.throws(() => replaceQuoted(FILE, '', 'X'), EditError);
    assert.throws(() => replaceQuoted(FILE, 'Next', 'Say "hi"'), /double quote/);
    assert.throws(() => quotedChanges(FILE, 'Next', 'a\nb'), /line break/);
  });
});

describe('caseText and appendSection: a section moves byte for byte', () => {
  test('the section without the blank lines after it; an unterminated last line gets an ending', () => {
    assert.equal(
      caseText(FILE, 'book'),
      `## Test: Book a slot\nid: book\nsession: log in\n1. open "/booking"\n2. click "Next"${TRAIL}\n3. expect the page shows "Booked"\nNote: trailing notes stay.\n`,
    );
    assert.equal(
      caseText('## Test: A\nid: a\n1. open "/"', 'a'),
      '## Test: A\nid: a\n1. open "/"\n',
    );
    assert.equal(caseText(crlf(FILE), 'cancel'), crlf(caseText(FILE, 'cancel')));
    assert.throws(() => caseText(FILE, 'nope'), EditError);
  });

  test('cut and append: the case leaves one file whole and ends the other after a blank line', () => {
    const moved = caseText(FILE, 'cancel');
    const into = appendSection('# Other\n\n## Test: X\nid: x\n1. open "/x"\n', moved);
    assert.equal(into, `# Other\n\n## Test: X\nid: x\n1. open "/x"\n\n${moved}`);
    assert.equal(appendSection('', moved), moved, 'a new file is the section alone');
    assert.equal(appendSection('x', moved), `x\n\n${moved}`);
    assert.equal(appendSection('x\n\n', moved), `x\n\n${moved}`);
    // Into a CRLF file the lines take CRLF; out of one into LF, LF.
    assert.equal(appendSection('x\r\n', moved), `x\r\n\r\n${crlf(moved)}`);
    assert.equal(appendSection('x\n', caseText(crlf(FILE), 'cancel')), `x\n\n${moved}`);
    // Cut, then appended back: the file is what removeCase and appendSection make of it, nothing else.
    assert.equal(appendSection(removeCase(FILE, 'cancel'), moved), FILE);
    assert.throws(() => appendSection(FILE, moved), /already has a test named "Cancel"/);
    assert.throws(() => appendSection(FILE, 'no section\n'), EditError);
  });
});

describe('renameCase', () => {
  test('rewrites only the heading and the id line, keeping spelling and endings', () => {
    const named = renameCase(FILE, 'book', { name: 'Book two slots' });
    assert.deepEqual(changed(FILE, named), [[5, '## Test: Book two slots']]);
    const ided = renameCase(FILE, 'cancel', { id: 'cancel-2' });
    assert.deepEqual(changed(FILE, ided), [[18, 'id: cancel-2']]);
    const both = renameCase(crlf(FILE), 'cancel', { id: 'c2', name: 'Cancel it' });
    assert.equal(
      both,
      crlf(FILE.replace('## Test: Cancel\nid: cancel', '## Test: Cancel it\nid: c2')),
    );
    assert.equal(
      renameCase('##   Test:  Old  \n  ID: old\n', 'old', { name: 'New', id: 'new' }),
      '##   Test:  New  \n  ID: new\n',
    );
    // Renamed back: byte-identical.
    assert.equal(renameCase(both, 'c2', { id: 'cancel', name: 'Cancel' }), crlf(FILE));
  });

  test('refuses a name another test of the file has, an invalid id and line breaks', () => {
    assert.throws(() => renameCase(FILE, 'book', { name: 'Cancel' }), /already has a test named/);
    assert.equal(renameCase(FILE, 'book', { name: 'Book a slot' }), FILE, 'its own name is fine');
    assert.throws(() => renameCase(FILE, 'book', { id: '-x' }), /invalid id/);
    assert.throws(() => renameCase(FILE, 'book', { name: 'a\nb' }), /one non-empty line/);
    assert.throws(() => renameCase(FILE, 'nope', { name: 'x' }), EditError);
  });
});

describe('duplicateCase', () => {
  test('a draft copy: new name and id, @draft added, refs dropped, everything else as written', () => {
    assert.equal(
      duplicateCase(FILE, 'book', { name: 'Copy of Book a slot', id: 'book-copy' }),
      `## Test: Copy of Book a slot\nid: book-copy\ntags: @draft\nsession: log in\n1. open "/booking"\n2. click "Next"${TRAIL}\n3. expect the page shows "Booked"\nNote: trailing notes stay.\n`,
    );
    const tagged = setRefs(FILE, 'cancel', ['C1', 'C2']);
    assert.equal(
      duplicateCase(tagged, 'cancel', { name: 'Cancel again', id: 'cancel-again' }),
      '## Test: Cancel again\nid: cancel-again\ntags: @smoke @draft\n  1. open "/cancel"\n  2. click "Cancel"\n',
    );
    assert.equal(
      duplicateCase(crlf(FILE), 'cancel', { name: 'C', id: 'c' }),
      crlf(duplicateCase(FILE, 'cancel', { name: 'C', id: 'c' })),
    );
  });

  test('appended to the same file it parses, the original untouched', () => {
    const copy = duplicateCase(FILE, 'book', { name: 'Copy of Book a slot', id: 'book-copy' });
    const out = appendSection(FILE, copy);
    assert.ok(out.startsWith(FILE));
    const dir = mkdtempSync(join(tmpdir(), 'develop-duplicate-'));
    try {
      writeFileSync(join(dir, 'booking.md'), out);
      const parsed = parseAll(dir).files[0].cases.find((test) => test.explicitId === 'book-copy')!;
      assert.equal(parsed.name, 'Copy of Book a slot');
      assert.equal(parsed.draft, true);
      assert.deepEqual(parsed.refs, []);
      assert.equal(parsed.steps.length, 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
