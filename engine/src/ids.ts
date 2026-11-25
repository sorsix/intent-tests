// Adds the `id:` line every `## Test:` needs (docs/test-format.md). It reads the files as text and does not use the parser,
// so it also fixes files the parser rejects. Pure over file contents; `src/cli/ids.ts` reads and writes the files.

const TEST_HEADING = /^##\s+Test:\s*(.+)$/i;
const SECTION_HEADING = /^#{1,2}\s/;
const ID_LINE = /^id:\s*(.*)$/i;
const MAX_SLUG = 60;

export type MissingId = { file: string; line: number; name: string; id: string };

/** `Check in a patient by name` becomes `check-in-a-patient-by-name`: lowercase `[a-z0-9-]`, at most 60 characters. */
export function slugify(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length <= MAX_SLUG) return slug || 'test';
  // Cut at a word boundary when that keeps a useful part of the title.
  const cut = slug.slice(0, MAX_SLUG + 1).lastIndexOf('-');
  return slug.slice(0, cut >= MAX_SLUG / 2 ? cut : MAX_SLUG);
}

type Heading = { index: number; name: string; hasId: boolean };

/** Lines (each with its line ending) and the `## Test:` headings among them. */
function scan(content: string): { lines: string[]; tests: Heading[]; ids: string[] } {
  const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const tests: Heading[] = [];
  const ids: string[] = [];
  let current: Heading | null = null;
  lines.forEach((raw, index) => {
    const text = raw.trim();
    let m: RegExpMatchArray | null;
    if ((m = text.match(TEST_HEADING))) {
      current = { index, name: m[1].trim(), hasId: false };
      tests.push(current);
    } else if (/^##\s+Steps:/i.test(text) || SECTION_HEADING.test(text)) {
      current = null;
    } else if (current && (m = text.match(ID_LINE))) {
      current.hasId = true;
      if (m[1].trim()) ids.push(m[1].trim());
    }
  });
  return { lines, tests, ids };
}

/**
 * The tests without an `id:` line in `files` (in the order given), each with the id `--write` would add: the slug of its
 * title, made unique among the ids already written and the ones generated before it (`-2`, `-3`, ...).
 */
export function missingIds(files: { file: string; content: string }[]): MissingId[] {
  const scanned = files.map((f) => ({ file: f.file, ...scan(f.content) }));
  const taken = new Set(scanned.flatMap((f) => f.ids).map((id) => id.toLowerCase()));
  const out: MissingId[] = [];
  for (const { file, tests } of scanned) {
    for (const test of tests) {
      if (test.hasId) continue;
      const base = slugify(test.name);
      let id = base;
      for (let n = 2; taken.has(id.toLowerCase()); n++) id = `${base}-${n}`;
      taken.add(id.toLowerCase());
      out.push({ file, line: test.index + 1, name: test.name, id });
    }
  }
  return out;
}

/** `content` with `id: <id>` inserted right under each listed test's heading; every other byte is kept. */
export function insertIds(content: string, missing: Pick<MissingId, 'line' | 'id'>[]): string {
  const ids = new Map(missing.map((m) => [m.line - 1, m.id]));
  return scan(content)
    .lines.map((raw, index) => {
      const id = ids.get(index);
      if (id === undefined) return raw;
      const eol = raw.match(/\r?\n$/)?.[0] ?? '\n';
      return raw.endsWith('\n') ? `${raw}id: ${id}${eol}` : `${raw}${eol}id: ${id}`;
    })
    .join('');
}
