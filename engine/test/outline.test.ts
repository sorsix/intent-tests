// The page text `expect` steps are judged on: headings as "#" lines so a section-scoped statement can be checked.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { formatOutline } from '../src/outline.ts';

describe('page text outline', () => {
  test('headings become "#" lines by level, text stays under them in order', () => {
    const text = formatOutline(
      [
        { heading: 'Dashboard', level: 1 },
        { text: 'What the archive holds.' },
        { heading: 'Studies received', level: 2 },
        { text: 'Last 7 days\n0' },
        { heading: 'Per hour, last 24 hours', level: 3 },
        { heading: 'Recently received', level: 2 },
        { text: 'Received Date Patient' },
      ],
      1000,
    );
    assert.equal(
      text,
      '# Dashboard\nWhat the archive holds.\n## Studies received\nLast 7 days\n0\n### Per hour, last 24 hours\n## Recently received\nReceived Date Patient',
    );
  });

  test('whitespace is cleaned as in the flat text: runs of spaces collapsed, no blank lines', () => {
    assert.equal(
      formatOutline(
        [{ text: '  a   b \n\n\n  c ' }, { text: '\n' }, { heading: ' Two\n words ', level: 2 }],
        100,
      ),
      'a b \n c\n## Two words',
    );
  });

  test('levels are kept between 1 and 6', () => {
    assert.equal(
      formatOutline(
        [
          { heading: 'A', level: 0 },
          { heading: 'B', level: 9 },
        ],
        100,
      ),
      '# A\n###### B',
    );
  });

  test('page text that looks like a heading line is escaped', () => {
    assert.equal(
      formatOutline([{ text: '# 1 priority\n#123 order' }], 100),
      '\\# 1 priority\n#123 order',
    );
  });

  test('the cap counts the markers', () => {
    const text = formatOutline(
      [{ heading: 'Studies received', level: 2 }, { text: 'x'.repeat(50) }],
      30,
    );
    assert.equal(text.length, 30);
    assert.ok(text.startsWith('## Studies received\nxxx'));
  });
});
