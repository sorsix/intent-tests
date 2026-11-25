// Develop mode's edits of a test file (docs/develop-mode.md, section 3.5). Pure functions over the file's text, like
// src/ids.ts: lines keep their endings, only the touched lines change, and every other byte of the file is preserved.
// A case is found by its `id:` line (a template's id for its row cases), a `## Steps:` block by its name; the steps
// are the numbered lines of the section, renumbered 1..n after every change. The caller parses step text before
// writing it.
import { refsProblem } from '../parse.ts';

const TEST_HEADING = /^##\s+Test:\s*(.+)$/i;
const STEPS_HEADING = /^##\s+Steps:\s*(.+)$/i;
const SECTION_HEADING = /^#{1,2}\s/;
const STEP_LINE = /^(\d+)\.\s+(.+)$/;
const META_LINE = /^(id|tags|seed|session|parameters|refs):\s*(.*)$/i;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export class EditError extends Error {}

/** One numbered step line of a section, as written. */
export type SectionStep = {
  /** 1-based line number in the file. */
  line: number;
  /** The number written in front of it. */
  number: number;
  /** The step text after `N. `, trimmed. */
  text: string;
};

/** A `## Test:` or `## Steps:` section as text: what the parser would read from it, without validating anything. */
export type Section = {
  kind: 'test' | 'steps';
  /** 1-based line of the heading. */
  line: number;
  /** The test name, or the block name. */
  name: string;
  id?: string;
  tags: string[];
  refs: string[];
  session?: string;
  seed?: string;
  parameters?: string;
  steps: SectionStep[];
};

type Line = { raw: string; text: string; eol: string };
type Bounds = {
  /** 0-based index of the heading line. */
  start: number;
  /** 0-based index after the section's last line. */
  end: number;
  section: Section;
  /** 0-based indexes of the step lines, in order. */
  stepLines: number[];
  /** 0-based index of the last metadata line, or of the heading when there is none. */
  lastMeta: number;
  idLine?: number;
  tagsLine?: number;
  refsLine?: number;
  /** The last `session:` / `seed:` line, the one the parser keeps. */
  sessionLine?: number;
  seedLine?: number;
};

/** The file's lines, each with its own line ending (the last one may have none). */
function split(content: string): Line[] {
  return (content.match(/[^\n]*\n|[^\n]+$/g) ?? []).map((raw) => {
    const eol = raw.match(/\r?\n$/)?.[0] ?? '';
    return { raw, text: raw.slice(0, raw.length - eol.length).trim(), eol };
  });
}

/** The file's line ending: CRLF when its first line ending is one, otherwise LF. */
function fileEol(content: string): string {
  const first = content.match(/\r?\n/);
  return first ? first[0] : '\n';
}

const tagsOf = (value: string) =>
  value
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((tag) => (tag.startsWith('@') ? tag : `@${tag}`));

const unquote = (value: string) => value.trim().replace(/^"(.*)"$/, '$1');

/** Every `## Test:` and `## Steps:` section of the file, read like the parser reads it. */
function scan(lines: Line[]): Bounds[] {
  const out: Bounds[] = [];
  let current: Bounds | null = null;
  const open = (index: number, kind: Section['kind'], name: string) => {
    if (current) current.end = index;
    current = {
      start: index,
      end: lines.length,
      section: { kind, line: index + 1, name, tags: [], refs: [], steps: [] },
      stepLines: [],
      lastMeta: index,
    };
    out.push(current);
  };
  lines.forEach((line, index) => {
    let m: RegExpMatchArray | null;
    if ((m = line.text.match(TEST_HEADING))) return open(index, 'test', m[1].trim());
    if ((m = line.text.match(STEPS_HEADING))) return open(index, 'steps', m[1].trim());
    if (SECTION_HEADING.test(line.text)) {
      if (current) current.end = index;
      current = null;
      return;
    }
    if (!current) return;
    const section = current.section;
    // Metadata belongs to tests; in a block the parser rejects it, and here it is just a line.
    if (section.kind === 'test' && (m = line.text.match(META_LINE))) {
      const key = m[1].toLowerCase();
      const value = m[2].trim();
      current.lastMeta = index;
      if (key === 'id') {
        current.idLine ??= index;
        section.id ??= value;
      } else if (key === 'tags') {
        current.tagsLine = index;
        section.tags = tagsOf(value);
      } else if (key === 'refs') {
        current.refsLine ??= index;
        section.refs = value
          .split(',')
          .map((ref) => ref.trim())
          .filter(Boolean);
      } else if (key === 'seed') {
        current.seedLine = index;
        section.seed = unquote(value);
      } else if (key === 'session') {
        current.sessionLine = index;
        section.session = unquote(value);
      } else if (key === 'parameters') section.parameters = unquote(value);
      return;
    }
    if ((m = line.text.match(STEP_LINE))) {
      current.stepLines.push(index);
      section.steps.push({ line: index + 1, number: Number(m[1]), text: m[2].trim() });
    }
  });
  return out;
}

/** Every `## Test:` section of a file. */
export function sections(content: string): Section[] {
  return scan(split(content))
    .map((bounds) => bounds.section)
    .filter((section) => section.kind === 'test');
}

/** The section whose `id:` line is `id`, or null. */
export function findSection(content: string, id: string): Section | null {
  return sections(content).find((section) => section.id === id) ?? null;
}

/** The `## Steps:` section named `name` (the first, as the parser reports a duplicate), or null. */
export function findBlock(content: string, name: string): Section | null {
  return (
    scan(split(content)).find((b) => b.section.kind === 'steps' && b.section.name === name)
      ?.section ?? null
  );
}

/** Every `id:` value written in the file (for unique new ids). */
export function writtenIds(content: string): string[] {
  return sections(content).flatMap((section) => (section.id ? [section.id] : []));
}

/** What a step edit works on: a case by its `id:`, or a `## Steps:` block by its name. */
export type EditTarget = string | { block: string };

function locate(lines: Line[], target: EditTarget): Bounds {
  const bounds =
    typeof target === 'string'
      ? scan(lines).find((b) => b.section.kind === 'test' && b.section.id === target)
      : scan(lines).find((b) => b.section.kind === 'steps' && b.section.name === target.block);
  if (!bounds)
    throw new EditError(
      typeof target === 'string'
        ? `no "## Test:" section with "id: ${target}" in this file`
        : `no "## Steps: ${target.block}" section in this file`,
    );
  return bounds;
}

/** A step text that fits on one numbered line. */
function stepText(text: string): string {
  const t = text.trim();
  if (!t) throw new EditError('the step text is empty');
  if (/[\r\n]/.test(t)) throw new EditError('a step is one line; the text contains a line break');
  return t;
}

/** Renumbers the step lines of the section 1..n, changing only the digits of lines that are off. */
function renumber(lines: Line[], target: EditTarget): Line[] {
  const bounds = locate(lines, target);
  bounds.stepLines.forEach((index, i) => {
    const line = lines[index];
    const raw = line.raw.replace(/^(\s*)\d+\./, `$1${i + 1}.`);
    if (raw !== line.raw) lines[index] = { ...line, raw };
  });
  return lines;
}

const join = (lines: Line[]) => lines.map((line) => line.raw).join('');

/**
 * Inserts `raws` (lines without endings) after line `after` (0-based). The new lines take the line ending of the line
 * they follow, or the file's; a last line without an ending gets one, and the inserted lines then end the file.
 */
function insertAfter(lines: Line[], after: number, raws: string[], eol: string): Line[] {
  const prev = lines[after];
  const ending = prev?.eol || eol;
  const added = raws.map((raw) => ({ raw: `${raw}${ending}`, text: raw.trim(), eol: ending }));
  if (prev && !prev.eol) {
    lines[after] = { ...prev, raw: `${prev.raw}${ending}`, eol: ending };
    const last = added[added.length - 1];
    added[added.length - 1] = { ...last, raw: last.raw.slice(0, -ending.length), eol: '' };
  }
  lines.splice(after + 1, 0, ...added);
  return lines;
}

/** The leading whitespace of the section's step lines (the first one's), or none. */
function stepIndent(lines: Line[], bounds: Bounds): string {
  const first = bounds.stepLines[0];
  return first === undefined ? '' : (lines[first].raw.match(/^\s*/)?.[0] ?? '');
}

function checkIndex(index: number, max: number, what: string): void {
  if (!Number.isInteger(index) || index < 0 || index > max)
    throw new EditError(`${what} ${index} is out of range (0..${max})`);
}

/** Replaces step `index` (0-based) of the case `id` (or the block) with `text`. */
export function replaceStep(
  content: string,
  target: EditTarget,
  index: number,
  text: string,
): string {
  const lines = split(content);
  const bounds = locate(lines, target);
  checkIndex(index, bounds.stepLines.length - 1, 'step');
  const at = bounds.stepLines[index];
  const line = lines[at];
  const indent = line.raw.match(/^\s*/)?.[0] ?? '';
  const raw = `${indent}${index + 1}. ${stepText(text)}${line.eol}`;
  lines[at] = { raw, text: raw.trim(), eol: line.eol };
  return join(renumber(lines, target));
}

/**
 * Inserts `text` as step `index` (0-based; `index === steps.length` appends) of the case `id` (or the block),
 * renumbering the rest.
 */
export function insertStep(
  content: string,
  target: EditTarget,
  index: number,
  text: string,
): string {
  const lines = split(content);
  const bounds = locate(lines, target);
  checkIndex(index, bounds.stepLines.length, 'insert position');
  const raw = `${stepIndent(lines, bounds)}0. ${stepText(text)}`;
  const eol = fileEol(content);
  if (index < bounds.stepLines.length) {
    // Before an existing step: same ending as that step's line.
    const at = bounds.stepLines[index];
    const ending = lines[at].eol || eol;
    lines.splice(at, 0, { raw: `${raw}${ending}`, text: raw.trim(), eol: ending });
  } else {
    const after = bounds.stepLines.length ? bounds.stepLines.at(-1)! : bounds.lastMeta;
    insertAfter(lines, after, [raw], eol);
  }
  return join(renumber(lines, target));
}

/** Removes step `index` (0-based) of the case `id` (or the block), renumbering the rest. */
export function deleteStep(content: string, target: EditTarget, index: number): string {
  const lines = split(content);
  const bounds = locate(lines, target);
  checkIndex(index, bounds.stepLines.length - 1, 'step');
  const at = bounds.stepLines[index];
  const removed = lines[at];
  lines.splice(at, 1);
  // The removed line ended the file without a line ending: so does the line now last.
  if (!removed.eol && at === lines.length && at > 0) {
    const last = lines[at - 1];
    lines[at - 1] = { ...last, raw: last.raw.slice(0, last.raw.length - last.eol.length), eol: '' };
  }
  return join(renumber(lines, target));
}

/** Removes line `at`; when it ended the file without a line ending, the line now last loses its ending too. */
function removeLine(lines: Line[], at: number): Line[] {
  const removed = lines[at];
  lines.splice(at, 1);
  if (!removed.eol && at === lines.length && at > 0) {
    const last = lines[at - 1];
    lines[at - 1] = { ...last, raw: last.raw.slice(0, last.raw.length - last.eol.length), eol: '' };
  }
  return lines;
}

/**
 * Writes the case's `session:` or `seed:` line, or removes it for null. A new line goes after the section's last
 * metadata line, so it stays above the steps and below `id:`, `tags:` and `refs:`.
 */
export function setMetaLine(
  content: string,
  id: string,
  key: 'session' | 'seed',
  value: string | null,
): string {
  const lines = split(content);
  const bounds = locate(lines, id);
  const at = key === 'session' ? bounds.sessionLine : bounds.seedLine;
  if (value === null) return at === undefined ? content : join(removeLine(lines, at));
  const v = value.trim();
  if (!v || /[\r\n]/.test(v)) throw new EditError(`${key} must be one non-empty line`);
  if (at !== undefined) {
    lines[at] = withValue(lines[at], v);
    return join(lines);
  }
  const after = bounds.lastMeta;
  const indent = after === bounds.start ? '' : (lines[after].raw.match(/^\s*/)?.[0] ?? '');
  return join(insertAfter(lines, after, [`${indent}${key}: ${v}`], fileEol(content)));
}

/** Rewrites a metadata line's value, keeping its indentation, key spelling and ending. */
function withValue(line: Line, value: string): Line {
  const m = line.raw.match(/^(\s*[A-Za-z]+:)\s*/)!;
  const raw = `${m[1]} ${value}${line.eol}`;
  return { raw, text: raw.trim(), eol: line.eol };
}

/** Where a new metadata line goes: right under `id:` (or the heading). */
const underId = (bounds: Bounds) => bounds.idLine ?? bounds.start;

/** Adds or removes the `@draft` tag of the case `id`; a `tags:` line is created or removed as needed. */
export function setDraft(content: string, id: string, draft: boolean): string {
  const lines = split(content);
  const bounds = locate(lines, id);
  if (bounds.section.tags.includes('@draft') === draft) return content;
  if (draft) {
    if (bounds.tagsLine === undefined) {
      const indent = lines[underId(bounds)].raw.match(/^\s*/)?.[0] ?? '';
      return join(insertAfter(lines, underId(bounds), [`${indent}tags: @draft`], fileEol(content)));
    }
    const line = lines[bounds.tagsLine];
    const value = line.text.replace(/^tags:\s*/i, '');
    lines[bounds.tagsLine] = withValue(line, `${value}${value.includes(',') ? ', ' : ' '}@draft`);
    return join(lines);
  }
  // A `tags:` line can be repeated; the parser keeps the last one, which is the one changed here.
  const line = lines[bounds.tagsLine!];
  const value = line.text.replace(/^tags:\s*/i, '');
  const kept = value.split(/[\s,]+/).filter((tag) => tag && tag !== '@draft' && tag !== 'draft');
  if (kept.length === 0) lines.splice(bounds.tagsLine!, 1);
  else lines[bounds.tagsLine!] = withValue(line, kept.join(value.includes(',') ? ', ' : ' '));
  return join(lines);
}

/**
 * Writes the case's `refs:` line (`refs: C1, C2`), or removes it for an empty list. A new line goes right under `id:`,
 * after a `tags:` line that directly follows it.
 */
export function setRefs(content: string, id: string, refs: readonly string[]): string {
  const problem = refsProblem(refs);
  if (problem) throw new EditError(`refs: ${problem}`);
  const lines = split(content);
  const bounds = locate(lines, id);
  if (bounds.refsLine !== undefined) {
    if (refs.length === 0) lines.splice(bounds.refsLine, 1);
    else lines[bounds.refsLine] = withValue(lines[bounds.refsLine], refs.join(', '));
    return join(lines);
  }
  if (refs.length === 0) return content;
  let after = underId(bounds);
  if (bounds.tagsLine === after + 1) after = bounds.tagsLine;
  const indent = lines[underId(bounds)].raw.match(/^\s*/)?.[0] ?? '';
  return join(insertAfter(lines, after, [`${indent}refs: ${refs.join(', ')}`], fileEol(content)));
}

/**
 * Removes the `## Test:` section of the case `id`: its heading up to the next `#`/`##` heading or the end of the file,
 * with the blank lines that separated it from what follows (for the last section, from what precedes it), so the
 * remaining text keeps its spacing. Every other byte is kept.
 */
export function removeCase(content: string, id: string): string {
  const lines = split(content);
  const { start, end } = locate(lines, id);
  let from = start;
  // The last section of the file: the blank lines above it only separated it from what stays.
  if (end === lines.length) while (from > 0 && lines[from - 1].text === '') from--;
  lines.splice(from, end - from);
  return join(lines);
}

export type NewCase = { name: string; id: string; session?: string; seed?: string };

/** A valid `id:` value. */
export const isCaseId = (id: string) => ID.test(id);

/** `name`'s slug (src/ids.ts rules) made unique among `taken` (case-insensitive) with `-2`, `-3`, … */
export function uniqueId(slug: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((id) => id.toLowerCase()));
  let id = slug;
  for (let n = 2; used.has(id.toLowerCase()); n++) id = `${slug}-${n}`;
  return id;
}

/**
 * Appends a `## Test:` section without steps, tagged `@draft`, to the file, separated from what is above by a blank
 * line. The existing text is kept byte for byte, apart from a line ending added to an unterminated last line.
 */
export function appendCase(content: string, test: NewCase): string {
  const oneLine = (what: string, value: string) => {
    const v = value.trim();
    if (!v || /[\r\n]/.test(v)) throw new EditError(`${what} must be one non-empty line`);
    return v;
  };
  const name = oneLine('the test name', test.name);
  if (!isCaseId(test.id))
    throw new EditError(
      `invalid id "${test.id}": 1-200 letters, digits, ".", "_" or "-", starting with a letter or digit`,
    );
  if (sections(content).some((section) => section.name === name))
    throw new EditError(`this file already has a test named "${name}"`);
  const eol = fileEol(content);
  let out = content;
  if (out && !out.endsWith('\n')) out += eol;
  if (out && !/(?:^|\n)\s*\r?\n$/.test(out)) out += eol;
  const meta = [
    `## Test: ${name}`,
    `id: ${test.id}`,
    'tags: @draft',
    ...(test.session ? [`session: ${oneLine('the session', test.session)}`] : []),
    ...(test.seed ? [`seed: ${oneLine('the seed', test.seed)}`] : []),
  ];
  return out + meta.map((line) => `${line}${eol}`).join('');
}

/** One step line a label rename changes: the step text before and after, and the case it belongs to. */
export type QuotedChange = {
  /** 1-based line in the file. */
  line: number;
  /** The `id:` of the `## Test:` section; absent for a step of a `## Steps:` block. */
  caseId?: string;
  before: string;
  after: string;
};

const STEPS_SECTION = /^##\s+Steps:/i;
/** Steps whose quoted text names a block, not a label on the page: renaming it would break the reference. */
const BLOCK_REFERENCE = /^(?:use|switch\s+to\s+session)\s+"/i;

/**
 * `text` with every quoted label that is exactly `from` written as `to`. Quotes pair from the left, as a step is
 * read, so the text between two labels (`"a" in "b"`) and a label that only contains `from` stay as they are.
 */
function requote(text: string, from: string, to: string): string {
  const parts = text.split('"');
  // An unpaired last quote opens nothing.
  const paired = parts.length % 2 === 0 ? parts.length - 1 : parts.length;
  for (let i = 1; i < paired; i += 2) if (parts[i] === from) parts[i] = to;
  return parts.join('"');
}

function checkLabels(from: string, to: string): void {
  if (!from) throw new EditError('the label to rename is empty');
  if (/[\r\n]/.test(from) || /[\r\n]/.test(to))
    throw new EditError('a label is one line; the text has a line break');
  if (to.includes('"')) throw new EditError('the new label must not contain a double quote');
}

/** The step lines of every `## Test:` section and `## Steps:` block, rewritten, with what changed. */
function renameQuoted(
  content: string,
  from: string,
  to: string,
): { lines: Line[]; changes: QuotedChange[] } {
  checkLabels(from, to);
  const lines = split(content);
  const changes: QuotedChange[] = [];
  let section: 'test' | 'steps' | null = null;
  let caseId: string | undefined;
  lines.forEach((line, index) => {
    if (TEST_HEADING.test(line.text)) {
      section = 'test';
      caseId = undefined;
      return;
    }
    if (STEPS_SECTION.test(line.text)) {
      section = 'steps';
      caseId = undefined;
      return;
    }
    if (SECTION_HEADING.test(line.text)) {
      section = null;
      return;
    }
    if (!section) return;
    const meta = line.text.match(META_LINE);
    if (meta) {
      if (section === 'test' && meta[1].toLowerCase() === 'id') caseId ??= meta[2].trim();
      return;
    }
    const step = line.text.match(STEP_LINE);
    if (!step || BLOCK_REFERENCE.test(step[2].replace(/^optionally\s+/i, ''))) return;
    // The number, indentation, trailing text and line ending hold no quotes, so the whole line can be requoted.
    const body = line.raw.slice(0, line.raw.length - line.eol.length);
    const next = requote(body, from, to);
    if (next === body) return;
    lines[index] = { raw: `${next}${line.eol}`, text: next.trim(), eol: line.eol };
    changes.push({
      line: index + 1,
      ...(section === 'test' && caseId ? { caseId } : {}),
      before: step[2].trim(),
      after: next.trim().match(STEP_LINE)![2].trim(),
    });
  });
  return { lines, changes };
}

/**
 * The step lines `replaceQuoted` would change, in file order: every own step of a `## Test:` section and every step of
 * a `## Steps:` block that quotes `from` exactly. Headings, metadata, notes and `use`/`switch to session` steps are
 * never touched.
 */
export function quotedChanges(content: string, from: string, to: string): QuotedChange[] {
  return renameQuoted(content, from, to).changes;
}

/**
 * Renames a label: every quoted `"<from>"` (the exact text between the quotes) in the file's step lines becomes
 * `"<to>"`. Only those quotes change; every other byte of the file, line endings included, is kept.
 */
export function replaceQuoted(content: string, from: string, to: string): string {
  const { lines, changes } = renameQuoted(content, from, to);
  return changes.length ? join(lines) : content;
}

/**
 * The text of the case `id`'s `## Test:` section, as `removeCase` cuts it: its heading up to the next `#`/`##`
 * heading or the end of the file, without the blank lines after it. Lines keep their endings; a last line without
 * one gets the file's.
 */
export function caseText(content: string, id: string): string {
  const lines = split(content);
  const { start, end } = locate(lines, id);
  let last = end;
  while (last > start + 1 && lines[last - 1].text === '') last--;
  const kept = lines.slice(start, last);
  const tail = kept[kept.length - 1];
  if (!tail.eol) kept[kept.length - 1] = { ...tail, raw: `${tail.raw}${fileEol(content)}` };
  return join(kept);
}

/**
 * Appends a section (`caseText`) to the file, separated from what is above by a blank line, as `appendCase` does. Its
 * lines take the file's line ending (an empty file keeps the section's). The existing text is kept byte for byte,
 * apart from a line ending added to an unterminated last line. A file with a test of the same name is refused.
 */
export function appendSection(content: string, text: string): string {
  const name = sections(text)[0]?.name;
  if (!name) throw new EditError('the text is not a "## Test:" section');
  if (sections(content).some((section) => section.name === name))
    throw new EditError(`this file already has a test named "${name}"`);
  if (!content) return text;
  const eol = fileEol(content);
  let out = content;
  if (!out.endsWith('\n')) out += eol;
  if (!/(?:^|\n)\s*\r?\n$/.test(out)) out += eol;
  return out + text.replace(/\r?\n/g, eol);
}

/**
 * Renames the case `id`: `name` rewrites its `## Test:` heading (keeping the heading's spelling and the line's
 * ending), `id` its `id:` line (keeping indentation and key spelling). Nothing else changes. The new id must be valid;
 * whether another case of the app has it is the caller's check. A name another test of the file has is refused.
 */
export function renameCase(
  content: string,
  id: string,
  change: { id?: string; name?: string },
): string {
  const lines = split(content);
  const bounds = locate(lines, id);
  if (change.name !== undefined) {
    const name = change.name.trim();
    if (!name || /[\r\n]/.test(name))
      throw new EditError('the test name must be one non-empty line');
    if (scan(lines).some((other) => other.start !== bounds.start && other.section.name === name))
      throw new EditError(`this file already has a test named "${name}"`);
    const line = lines[bounds.start];
    const body = line.raw.slice(0, line.raw.length - line.eol.length);
    const m = body.match(/^(\s*##\s+Test:\s*)(.*?)(\s*)$/i)!;
    const raw = `${m[1]}${name}${m[3]}${line.eol}`;
    lines[bounds.start] = { raw, text: raw.trim(), eol: line.eol };
  }
  if (change.id !== undefined) {
    if (!isCaseId(change.id))
      throw new EditError(
        `invalid id "${change.id}": 1-200 letters, digits, ".", "_" or "-", starting with a letter or digit`,
      );
    lines[bounds.idLine!] = withValue(lines[bounds.idLine!], change.id);
  }
  return join(lines);
}

/**
 * The case `id`'s section as a new draft, ready for `appendSection`: named `copy.name`, with the id `copy.id`, tagged
 * `@draft` (a `tags:` line is added under `id:` when there is none), and without its `refs:` line (the references
 * belong to the original). Steps, the session, seed and parameters lines and every other line are copied as written.
 */
export function duplicateCase(
  content: string,
  id: string,
  copy: { name: string; id: string },
): string {
  const renamed = renameCase(caseText(content, id), id, copy);
  return setRefs(setDraft(renamed, copy.id, true), copy.id, []);
}
