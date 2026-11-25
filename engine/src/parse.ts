// Deterministic parser for an app's .md test files (format: docs/test-format.md). The decision model never interprets the step grammar;
// it only resolves the free-text *target* of a step to an element on the page.
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export type Step =
  | { kind: 'open'; path: string }
  | { kind: 'click'; target: string }
  | { kind: 'fill'; target: string; value: string }
  | { kind: 'select'; target: string; option: string }
  | { kind: 'check' | 'uncheck'; target: string }
  /** Native drag-and-drop: `source` is the element to drag, `target` the drop slot. */
  | { kind: 'drag'; source: string; target: string }
  /**
   * Chooses a file in the file picker the target opens: `attachment` is the file's path relative to the app folder
   * (checked by `uploadPathProblem` when parsed, and to exist by `missingUploads` when the suite loads).
   */
  | { kind: 'upload'; attachment: string; target: string }
  | { kind: 'press'; key: string }
  | { kind: 'expect'; assertion: string; withinSeconds?: number }
  | { kind: 'wait'; seconds: number }
  /** Continue as another logged-in user: load the browser state saved for that `session:` block. */
  | { kind: 'switch'; session: string }
  /**
   * Continue in that user's own browser window: the first use opens a separate window (its own cookies and storage)
   * logged in as the `## Steps:` block, a later use returns to it as it was left. The test's `session:` names its
   * first window. Earlier windows stay open, so their pages keep running (websockets, polling) in the background.
   */
  | { kind: 'window'; session: string }
  /** A non-UI HTTP request sent with the current session's cookies (e.g. to trigger a background job). */
  | { kind: 'call'; method: string; path: string; save?: { field: string; name: string } };

/** Steps that may be written as `optionally <step>`: skipped instead of failing when no element matches. */
const OPTIONAL_KINDS = ['click', 'fill', 'select', 'check', 'uncheck'];

/** A step as written. `use` only exists here; it is expanded before anything runs. */
type RawStep = (Step | { kind: 'use'; block: string }) & {
  file: string;
  line: number;
  text: string;
};

export type ParsedStep = Step & {
  /** Written as `optionally <step>`. */
  optional?: boolean;
  /** Sequential index within the test (1..n), after `use` expansion. */
  number: number;
  /** Display label: "3" for a top-level step, "3.2" for the 2nd step of a block used at step 3. */
  label: string;
  /** Step text; prefixed with "<block> › " when it comes from a block. */
  text: string;
  file: string;
  line: number;
};

export type TestCase = {
  /** The `id:` metadata: the test's durable identity (a case of a template: `<id>[<row key>]`). */
  explicitId: string;
  name: string;
  tags: string[];
  expectFail: boolean;
  /**
   * Tagged `@draft`: left out of `intent-test run` unless AT_INCLUDE_DRAFTS=true; still in the catalog. The only kind
   * of test that may have no steps yet (a case just created in develop mode).
   */
  draft: boolean;
  /** The `refs:` line: references to other systems, e.g. TestRail case ids (`C1234`). */
  refs: string[];
  /** Name of a step block whose resulting browser state this test starts from. */
  session?: string;
  /** Name of a seed (from `<tests folder>/seeds.ts`) run before the steps; fills `{{seed.<key>}}`. */
  seed?: string;
  /** Name of a parameter set (from `<app>/parameters.ts`): the test is a template, one case per row. */
  parameterSet?: string;
  /** On a case expanded from a template: the template's identity and name as written. */
  template?: { clientTestId: string; name: string };
  /** On a case expanded from a template: its row, the values `{{param.<key>}}` were filled with. */
  parameters?: ParameterBinding;
  file: string;
  line: number;
  steps: ParsedStep[];
};

/** One row of a parameter set, as strings, with its stable key (part of the case identity). */
export type ParameterRow = { key: string; values: Record<string, string> };
export type ParameterBinding = ParameterRow & { set: string };

export type StepBlock = { name: string; file: string; line: number; steps: ParsedStep[] };

export type TestSuite = {
  root: string;
  files: { path: string; rel: string; cases: TestCase[] }[];
  blocks: Map<string, StepBlock>;
  /** Session names used by at least one test (`session:`, `switch to session` or `switch to window`), in first-use order. */
  sessions: string[];
};

export class ParseError extends Error {}

// One line: the dashboard's Features guide check reads this declaration (dashboard/frontend/scripts/features-sources.test.mjs).
// prettier-ignore
export const VERBS = 'optionally <step>, open, click, fill … with "…", select "…" in …, check, uncheck, drag … to …, upload "<file>" to …, press, expect … [within N seconds], wait N seconds, use "<steps name>", switch to session "<steps name>", switch to window "<steps name>", call <METHOD> "<path>" [and save "<field>" as "<name>"]';

/**
 * The positive statement behind an `expect <thing> is not shown|visible|displayed|listed`, or null for any other
 * assertion. The model judges negative statements poorly (BK-03: 0.16 for a true "does not show"), so such an `expect`
 * asks whether the thing is shown and passes when the answer is a confident no. Only this one strict form is
 * recognised: a single clause, nothing after the verb. Compound or differently worded negatives ("no longer lists …",
 * "no dialog is open and …", "is not "Enrolled"") keep being judged as written, as they were before.
 */
export function notShownStatement(assertion: string): string | null {
  const m = assertion.trim().match(/^(.+?)\s+is\s+not\s+(shown|visible|displayed|listed)$/i);
  if (!m) return null;
  const subject = m[1].trim();
  // A second clause or a list would be inverted as a whole, which changes its meaning.
  if (/,|;|\s(and|or|but|nor)\s/i.test(subject.replace(/"[^"]*"/g, '""'))) return null;
  return `${subject} is ${m[2].toLowerCase()}`;
}

/**
 * Why a file named in an `upload` step cannot be used, or null when it can: the path is relative to the app folder,
 * written with forward slashes, and stays inside it, so a test never reads files from elsewhere on the machine.
 */
export function uploadPathProblem(path: string): string | null {
  if (!path) return 'name the file, relative to the app folder';
  if (path.includes('\\')) return 'write the path with forward slashes (/)';
  if (/^(\/|[A-Za-z]:)/.test(path))
    return 'the path must be relative to the app folder, not absolute';
  if (path.split('/').some((part) => part === '..'))
    return 'the path must stay inside the app folder (no "..")';
  if (path.endsWith('/')) return 'name a file, not a folder';
  return null;
}

/**
 * The `upload` steps of the suite whose file is not a readable file inside the app folder, as `file:line: problem`
 * lines (empty when every file is there). A symbolic link may not lead out of the app folder.
 */
export function missingUploads(suite: TestSuite, appRoot: string): string[] {
  const root = realpathSync(resolve(appRoot));
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const file of suite.files)
    for (const test of file.cases)
      for (const step of test.steps) {
        if (step.kind !== 'upload') continue;
        const where = `${step.file}:${step.line}`;
        if (seen.has(where)) continue;
        seen.add(where);
        const path = resolve(root, step.attachment);
        let real: string;
        try {
          real = realpathSync(path);
        } catch {
          problems.push(`${where}: upload "${step.attachment}": no such file in the app folder`);
          continue;
        }
        if (relative(root, real).startsWith('..'))
          problems.push(`${where}: upload "${step.attachment}": leads out of the app folder`);
        else if (!statSync(real).isFile())
          problems.push(`${where}: upload "${step.attachment}": not a file`);
      }
  return problems;
}

export function substituteVars(s: string, where: string): string {
  return s.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_, name) => {
    const v = process.env[name];
    if (v === undefined)
      throw new ParseError(
        `${where}: environment variable ${name} is not set (shell, .env or .env.<AT_ENV>)`,
      );
    return v;
  });
}

/** One reference of a `refs:` line: letters, digits and `. _ : / -`, at most 50 characters. */
export const REF_TOKEN = /^[A-Za-z0-9._:/-]{1,50}$/;
/** At most this many references on one `refs:` line. */
export const MAX_REFS = 20;

/** Why these references cannot be written on a `refs:` line, or null when they can. */
export function refsProblem(refs: readonly string[]): string | null {
  if (refs.length > MAX_REFS) return `at most ${MAX_REFS} references, got ${refs.length}`;
  const bad = refs.find((ref) => !REF_TOKEN.test(ref));
  if (bad !== undefined)
    return `reference ${JSON.stringify(bad)} must be 1-50 letters, digits, ".", "_", ":", "/" or "-"`;
  const seen = new Set<string>();
  for (const ref of refs) {
    if (seen.has(ref)) return `reference "${ref}" is listed twice`;
    seen.add(ref);
  }
  return null;
}

/** The value of a `refs:` line (`C1, C2`) as a list; a malformed one is a parse error. */
export function parseRefs(value: string, where: string): string[] {
  const refs = value.split(',').map((ref) => ref.trim());
  const problem = refs.some((ref) => !ref)
    ? 'needs references separated by commas, e.g. "refs: C1234, C1235"'
    : refsProblem(refs);
  if (problem) throw new ParseError(`${where}: refs: ${problem}`);
  return refs;
}

/** Splits at the first `sep` (case-insensitive) outside "quotes": `"Move to ward" to "…"` keeps the label whole. */
function splitOutsideQuotes(s: string, sep: string): [string, string] | [] {
  const lower = s.toLowerCase();
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '"') quoted = !quoted;
    else if (!quoted && lower.startsWith(sep, i)) return [s.slice(0, i), s.slice(i + sep.length)];
  }
  return [];
}

export function parseStep(
  text: string,
  where = 'step',
): (Step & { optional?: boolean }) | { kind: 'use'; block: string } {
  const t = text.trim();
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^optionally\s+(.+)$/i))) {
    const inner = parseStep(m[1], where);
    if (!OPTIONAL_KINDS.includes(inner.kind))
      throw new ParseError(`${where}: only ${OPTIONAL_KINDS.join(', ')} steps can be optional`);
    return { ...(inner as Step), optional: true };
  }
  if ((m = t.match(/^open\s+"([^"]+)"$/i)))
    return { kind: 'open', path: substituteVars(m[1], where) };
  if ((m = t.match(/^fill\s+(.+?)\s+with\s+"(.*)"$/i)))
    return {
      kind: 'fill',
      target: substituteVars(m[1], where),
      value: substituteVars(m[2], where),
    };
  if (/^fill\s/i.test(t))
    throw new ParseError(`${where}: fill needs a quoted value: fill <field> with "<value>"`);
  if ((m = t.match(/^select\s+"([^"]+)"\s+(?:in|from)\s+(.+)$/i)))
    return {
      kind: 'select',
      option: substituteVars(m[1], where),
      target: substituteVars(m[2], where),
    };
  if (/^select\s/i.test(t))
    throw new ParseError(`${where}: select needs the form: select "<option>" in <dropdown>`);
  if ((m = t.match(/^uncheck\s+(.+)$/i)))
    return { kind: 'uncheck', target: substituteVars(m[1], where) };
  if ((m = t.match(/^check\s+(.+)$/i)))
    return { kind: 'check', target: substituteVars(m[1], where) };
  if ((m = t.match(/^drag\s+(.+)$/i))) {
    const [source, target] = splitOutsideQuotes(m[1], ' to ');
    if (!source?.trim() || !target?.trim())
      throw new ParseError(
        `${where}: drag needs the form: drag <element> to <slot>, e.g. drag the "Jane Doe" appointment to the "Tue 03 Nov 11:30 AM" slot for "Dr Smith"`,
      );
    return {
      kind: 'drag',
      source: substituteVars(source.trim(), where),
      target: substituteVars(target.trim(), where),
    };
  }
  if ((m = t.match(/^upload\s+"([^"]+)"\s+to\s+(.+)$/i))) {
    const attachment = substituteVars(m[1].trim(), where);
    const problem = uploadPathProblem(attachment);
    if (problem) throw new ParseError(`${where}: upload "${attachment}": ${problem}`);
    return { kind: 'upload', attachment, target: substituteVars(m[2].trim(), where) };
  }
  if (/^upload\s/i.test(t))
    throw new ParseError(
      `${where}: upload needs the form: upload "<file>" to <target>, e.g. upload "files/referral.pdf" to the "Upload Files" button (the file's path is relative to the app folder)`,
    );
  if ((m = t.match(/^click\s+(.+)$/i)))
    return { kind: 'click', target: substituteVars(m[1], where) };
  if ((m = t.match(/^press\s+"([^"]+)"$/i))) return { kind: 'press', key: m[1] };
  if ((m = t.match(/^expect\s+(.+?)\s+within\s+(\d+)\s*seconds?$/i)))
    return { kind: 'expect', assertion: substituteVars(m[1], where), withinSeconds: Number(m[2]) };
  if ((m = t.match(/^expect\s+(.+)$/i)))
    return { kind: 'expect', assertion: substituteVars(m[1], where) };
  if ((m = t.match(/^wait\s+(\d+(?:\.\d+)?)\s*seconds?$/i)))
    return { kind: 'wait', seconds: Number(m[1]) };
  if ((m = t.match(/^use\s+"([^"]+)"$/i))) return { kind: 'use', block: m[1].trim() };
  if ((m = t.match(/^switch\s+to\s+session\s+"([^"]+)"$/i)))
    return { kind: 'switch', session: m[1].trim() };
  if ((m = t.match(/^switch\s+to\s+window\s+"([^"]+)"$/i)))
    return { kind: 'window', session: m[1].trim() };
  if (/^switch\s+to\s+window\b/i.test(t))
    throw new ParseError(
      `${where}: switch to window needs the form: switch to window "<steps name>", e.g. switch to window "log in as second radiologist"`,
    );
  if (
    (m = t.match(
      /^call\s+(GET|POST|PUT|PATCH|DELETE)\s+"([^"]+)"(?:\s+and\s+save\s+"([^"]+)"\s+as\s+"([A-Za-z][A-Za-z0-9_]*)")?$/i,
    ))
  ) {
    return {
      kind: 'call',
      method: m[1].toUpperCase(),
      path: substituteVars(m[2], where),
      ...(m[3] ? { save: { field: m[3], name: m[4] } } : {}),
    };
  }
  if (/^call\s/i.test(t))
    throw new ParseError(
      `${where}: call needs the form: call <GET|POST|PUT|PATCH|DELETE> "<path>" [and save "<field>" as "<name>"]`,
    );
  throw new ParseError(`${where}: unknown step "${t}". Allowed: ${VERBS}`);
}

type RawTest = Omit<TestCase, 'steps'> & { raw: RawStep[] };
/** A test section while it is read: its `id:` line may still be missing. */
type DraftTest = Omit<RawTest, 'explicitId'> & { explicitId?: string };
type RawBlock = { name: string; file: string; line: number; raw: RawStep[] };

/** Pass 1: one file → tests and step blocks with unexpanded steps. */
function parseSource(source: string, file: string): { tests: RawTest[]; blocks: RawBlock[] } {
  const tests: DraftTest[] = [];
  const blocks: RawBlock[] = [];
  const withRefs = new WeakSet<DraftTest>();
  let current: DraftTest | RawBlock | null = null;

  source.split(/\r?\n/).forEach((rawLine, i) => {
    const line = i + 1;
    const where = `${file}:${line}`;
    const text = rawLine.trim();
    let m: RegExpMatchArray | null;

    if ((m = text.match(/^##\s+Test:\s*(.+)$/i))) {
      const name = m[1].trim();
      if (tests.some((t) => t.name === name))
        throw new ParseError(`${where}: duplicate test name "${name}" in this file`);
      current = { name, tags: [], expectFail: false, draft: false, refs: [], file, line, raw: [] };
      tests.push(current);
      return;
    }
    if ((m = text.match(/^##\s+Steps:\s*(.+)$/i))) {
      current = { name: m[1].trim(), file, line, raw: [] };
      blocks.push(current);
      return;
    }
    if (/^#{1,2}\s/.test(text)) {
      current = null; // any other heading ends the section
      return;
    }
    if (!current) return;
    const isTest = 'tags' in current;

    if ((m = text.match(/^id:\s*(.*)$/i))) {
      if (!isTest) throw new ParseError(`${where}: "id:" is only allowed in a "## Test:" section`);
      const test = current as DraftTest;
      if (test.explicitId) throw new ParseError(`${where}: duplicate id metadata`);
      const value = m[1].trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value))
        throw new ParseError(`${where}: invalid id metadata`);
      test.explicitId = value;
      return;
    }

    if ((m = text.match(/^tags:\s*(.+)$/i))) {
      if (!isTest)
        throw new ParseError(`${where}: "tags:" is only allowed in a "## Test:" section`);
      const t = current as DraftTest;
      t.tags = m[1]
        .split(/[\s,]+/)
        .filter(Boolean)
        .map((g) => (g.startsWith('@') ? g : `@${g}`));
      t.expectFail = t.tags.includes('@expect-fail');
      t.draft = t.tags.includes('@draft');
      return;
    }
    if ((m = text.match(/^refs:\s*(.*)$/i))) {
      if (!isTest)
        throw new ParseError(`${where}: "refs:" is only allowed in a "## Test:" section`);
      const t = current as DraftTest;
      if (withRefs.has(t)) throw new ParseError(`${where}: duplicate refs metadata`);
      withRefs.add(t);
      t.refs = parseRefs(m[1], where);
      return;
    }
    if ((m = text.match(/^seed:\s*(.+)$/i))) {
      if (!isTest)
        throw new ParseError(`${where}: "seed:" is only allowed in a "## Test:" section`);
      (current as DraftTest).seed = m[1].trim().replace(/^"(.*)"$/, '$1');
      return;
    }
    if ((m = text.match(/^parameters:\s*(.+)$/i))) {
      if (!isTest)
        throw new ParseError(`${where}: "parameters:" is only allowed in a "## Test:" section`);
      (current as DraftTest).parameterSet = m[1].trim().replace(/^"(.*)"$/, '$1');
      return;
    }
    if ((m = text.match(/^session:\s*(.+)$/i))) {
      if (!isTest)
        throw new ParseError(`${where}: "session:" is only allowed in a "## Test:" section`);
      (current as DraftTest).session = m[1].trim().replace(/^"(.*)"$/, '$1');
      return;
    }
    if ((m = text.match(/^(\d+)\.\s+(.+)$/))) {
      const number = Number(m[1]);
      const expected = current.raw.length + 1;
      if (number !== expected)
        throw new ParseError(`${where}: step numbered ${number}, expected ${expected}`);
      const step = parseStep(m[2], where);
      // The text is shown in the report and read by the decision model, so variables are filled in, except for `fill`, whose value may be a password.
      const text = step.kind === 'fill' ? m[2].trim() : substituteVars(m[2].trim(), where);
      current.raw.push({ ...step, file, line, text });
    }
  });

  for (const test of tests)
    if (test.explicitId === undefined)
      throw new ParseError(
        `${file}:${test.line}: test "${test.name}" has no id. Every "## Test:" needs an "id: <id>" line right under its heading (letters, digits, ., _ and -). Run "intent-test ids --write <paths>" to add one to every test that lacks it.`,
      );

  return { tests: tests as RawTest[], blocks };
}

/** Pass 2: expand `use` steps recursively, with cycle detection. */
function expand(
  raw: RawStep[],
  blocks: Map<string, RawBlock>,
  labelPrefix = '',
  textPrefix = '',
  stack: string[] = [],
): Omit<ParsedStep, 'number'>[] {
  const out: Omit<ParsedStep, 'number'>[] = [];
  raw.forEach((s, i) => {
    const label = `${labelPrefix}${i + 1}`;
    if (s.kind === 'use') {
      const block = blocks.get(s.block);
      if (!block) {
        const known = [...blocks.keys()].map((k) => `"${k}"`).join(', ') || 'none';
        throw new ParseError(`${s.file}:${s.line}: unknown steps "${s.block}". Defined: ${known}`);
      }
      if (stack.includes(s.block))
        throw new ParseError(
          `${s.file}:${s.line}: steps "${s.block}" use themselves (${[...stack, s.block].join(' → ')})`,
        );
      out.push(
        ...expand(block.raw, blocks, `${label}.`, `${textPrefix}${s.block} › `, [
          ...stack,
          s.block,
        ]),
      );
    } else {
      out.push({ ...s, label, text: `${textPrefix}${s.text}` });
    }
  });
  return out;
}

const number = (steps: Omit<ParsedStep, 'number'>[]): ParsedStep[] =>
  steps.map((s, i) => ({ ...s, number: i + 1 }) as ParsedStep);

/** Docs that live next to the tests and are not test files. */
const NOT_TESTS = /^(readme|agents|claude)\.md$/i;

/**
 * Every .md file under `root` (or `root` itself if it is a file), sorted. Skips docs (README.md, AGENTS.md,
 * CLAUDE.md), docs/, reports/ (Playwright writes error-context.md files there), node_modules/ and hidden folders.
 */
export function findTestFiles(root: string): string[] {
  const abs = resolve(root);
  if (statSync(abs).isFile()) return [abs];
  return (readdirSync(abs, { recursive: true }) as string[])
    .filter((f) => f.endsWith('.md'))
    .filter((f) => {
      const parts = f.split(sep);
      return (
        !NOT_TESTS.test(parts.at(-1)!) &&
        !parts
          .slice(0, -1)
          .some((p) => p === 'docs' || p === 'reports' || p === 'node_modules' || p.startsWith('.'))
      );
    })
    .map((f) => join(abs, f))
    .sort();
}

export function parseAll(root: string): TestSuite {
  const abs = resolve(root);
  const base = statSync(abs).isFile() ? resolve(abs, '..') : abs;
  const parsed = findTestFiles(abs).map((path) => {
    const rel = relative(base, path);
    return { path, rel, ...parseSource(readFileSync(path, 'utf8'), rel) };
  });
  if (parsed.length === 0) throw new ParseError(`no .md test files found under ${root}`);
  const seenIds = new Map<string, RawTest>();
  for (const test of parsed.flatMap((file) => file.tests)) {
    const prior = seenIds.get(test.explicitId);
    if (prior)
      throw new ParseError(
        `${test.file}:${test.line}: duplicate explicitId "${test.explicitId}" already declared at ${prior.file}:${prior.line}`,
      );
    seenIds.set(test.explicitId, test);
  }

  const rawBlocks = new Map<string, RawBlock>();
  for (const b of parsed.flatMap((p) => p.blocks)) {
    const dup = rawBlocks.get(b.name);
    if (dup)
      throw new ParseError(
        `${b.file}:${b.line}: steps "${b.name}" are already defined at ${dup.file}:${dup.line}`,
      );
    if (b.raw.length === 0)
      throw new ParseError(`${b.file}:${b.line}: steps "${b.name}" have no steps`);
    rawBlocks.set(b.name, b);
  }

  const blocks = new Map<string, StepBlock>();
  for (const b of rawBlocks.values()) {
    blocks.set(b.name, {
      name: b.name,
      file: b.file,
      line: b.line,
      steps: number(expand(b.raw, rawBlocks, '', '', [b.name])),
    });
  }

  const sessions: string[] = [];
  const files = parsed.map((p) => ({
    path: p.path,
    rel: p.rel,
    cases: p.tests.map(({ raw, ...t }): TestCase => {
      // A draft is work in progress and may still be empty; every other test has to do something.
      if (raw.length === 0 && !t.draft)
        throw new ParseError(`${t.file}:${t.line}: test "${t.name}" has no steps`);
      const useSession = (name: string, where: string) => {
        if (!blocks.has(name))
          throw new ParseError(`${where}: session "${name}" is not defined as "## Steps: ${name}"`);
        if (!sessions.includes(name)) sessions.push(name);
      };
      if (t.session) useSession(t.session, `${t.file}:${t.line}`);
      const steps = number(expand(raw, rawBlocks));
      for (const s of steps) {
        const name = stepSession(s);
        if (name) useSession(name, `${s.file}:${s.line}`);
        // The test's own session is its first window, so a test with windows has to name one to come back to.
        if (s.kind === 'window' && !t.session)
          throw new ParseError(
            `${s.file}:${s.line}: switch to window needs a "session: <steps name>" line on test "${t.name}"; that session is the test's first window`,
          );
      }
      const usesParams = PARAM.test(t.name) || steps.some((s) => PARAM.test(JSON.stringify(s)));
      if (t.parameterSet && !usesParams)
        throw new ParseError(
          `${t.file}:${t.line}: test "${t.name}" has "parameters: ${t.parameterSet}" but uses no {{param.<key>}}`,
        );
      if (!t.parameterSet && usesParams)
        throw new ParseError(
          `${t.file}:${t.line}: test "${t.name}" uses {{param.<key>}} without a "parameters: <set>" line`,
        );
      return { ...t, steps };
    }),
  }));
  // A session block runs on its own, before any test, so there is no row to fill it from.
  for (const name of sessions) {
    const block = blocks.get(name)!;
    // ... and in a single window: it is what a window starts from.
    const window = block.steps.find((s) => s.kind === 'window');
    if (window)
      throw new ParseError(
        `${window.file}:${window.line}: session "${name}" uses switch to window; only test steps can`,
      );
    const step = block.steps.find((s) => PARAM.test(JSON.stringify(s)));
    if (step)
      throw new ParseError(
        `${step.file}:${step.line}: session "${name}" uses {{param.<key>}}; only test steps can`,
      );
  }

  return { root: abs, files, blocks, sessions };
}

const PARAM = /\{\{\s*param\.[A-Za-z0-9_]+\s*\}\}/;

/** Replaces `{{param.<key>}}` in a string; a key the row does not have is a parse error. */
export function bindParams(s: string, values: Record<string, string>, where: string): string {
  return s.replace(/\{\{\s*param\.([A-Za-z0-9_]+)\s*\}\}/g, (_, key) => {
    if (!(key in values))
      throw new ParseError(
        `${where}: {{param.${key}}} is not in the parameter row (has: ${Object.keys(values).join(', ') || 'nothing'})`,
      );
    return values[key];
  });
}

const BOUND_FIELDS = [
  'text',
  'path',
  'source',
  'target',
  'value',
  'option',
  'assertion',
  'session',
] as const;

/** The step with `{{param.<key>}}` filled from a parameter row in every text field. */
export function bindStepParams(step: ParsedStep, values: Record<string, string>): ParsedStep {
  const out: Record<string, unknown> = { ...step };
  for (const k of BOUND_FIELDS)
    if (typeof out[k] === 'string')
      out[k] = bindParams(out[k] as string, values, `${step.file}:${step.line}`);
  return out as ParsedStep;
}

/**
 * One case of a template (a test with `parameters:`) for one row: `{{param.<key>}}` filled in the name and every step,
 * identity `<template identity>[<row key>]`. Pure, so the synchronous reporters rebuild exactly what the run used.
 */
export function expandCase(template: TestCase, binding: ParameterBinding): TestCase {
  const at = `${template.file}:${template.line}`;
  const steps = template.steps.map((step) => bindStepParams(step, binding.values));
  const { parameterSet: _set, ...rest } = template;
  return {
    ...rest,
    name: bindParams(template.name, binding.values, at),
    explicitId: `${template.explicitId}[${binding.key}]`,
    template: { clientTestId: clientTestId(template), name: template.name },
    parameters: binding,
    steps,
  };
}

/**
 * The parsed case a listed Playwright test runs, from its annotations, in a suite parsed without parameter sets: a
 * template's case is rebuilt from its `at-parameters` row, so the synchronous reporters need not load parameters.ts.
 */
export function annotatedCase(
  suite: TestSuite,
  id: string | undefined,
  templateId?: string,
  parameters?: string,
): { file: string; test: TestCase } | undefined {
  const cases = suite.files.flatMap((file) => file.cases.map((test) => ({ file: file.rel, test })));
  if (templateId && parameters) {
    const template = cases.find((candidate) => clientTestId(candidate.test) === templateId);
    return (
      template && {
        file: template.file,
        test: expandCase(template.test, JSON.parse(parameters) as ParameterBinding),
      }
    );
  }
  return cases.find((candidate) => clientTestId(candidate.test) === id);
}

/**
 * Replaces every template with its cases, one per row of its parameter set. `only` (AT_PARAMS) keeps a subset while
 * writing tests: `first` keeps each set's first row, otherwise a comma-separated list of row keys.
 */
export function expandExamples(
  suite: TestSuite,
  sets: Record<string, ParameterRow[]>,
  only = process.env.AT_PARAMS || '',
): TestSuite {
  const wanted = only
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  const matched = new Set<string>();
  const files = suite.files.map((file) => {
    const cases = file.cases.flatMap((tc) => {
      if (!tc.parameterSet) return [tc];
      const rows = sets[tc.parameterSet];
      if (!rows)
        throw new ParseError(
          `${tc.file}:${tc.line}: parameter set "${tc.parameterSet}" is not defined in parameters.ts (has: ${Object.keys(sets).join(', ') || 'none'})`,
        );
      const kept =
        wanted.length === 0
          ? rows
          : wanted.includes('first')
            ? rows.slice(0, 1)
            : rows.filter((row) => wanted.includes(row.key));
      for (const row of kept) matched.add(row.key);
      return kept.map((row) => expandCase(tc, { set: tc.parameterSet!, ...row }));
    });
    const names = new Set<string>();
    for (const tc of cases) {
      if (names.has(tc.name))
        throw new ParseError(
          `${tc.file}:${tc.line}: two cases of "${tc.template?.name ?? tc.name}" are both named "${tc.name}"; put {{param.<key>}} in the test name`,
        );
      names.add(tc.name);
    }
    return { ...file, cases };
  });
  const unknown = wanted.filter((k) => k !== 'first' && !matched.has(k));
  if (unknown.length)
    throw new ParseError(
      `AT_PARAMS: no parameter row has the key ${unknown.map((k) => `"${k}"`).join(', ')}`,
    );
  return { ...suite, files };
}

/**
 * The suite with only the test files at or under `only` (a file or folder); shared step blocks stay, and the sessions
 * are the ones the remaining tests use. `only` null: the suite as it is.
 */
export function narrow(suite: TestSuite, only: string | null): TestSuite {
  if (!only) return suite;
  const files = suite.files.filter((f) => f.path === only || f.path.startsWith(only + sep));
  if (files.length === 0) throw new ParseError(`no .md test files at ${only}`);
  const sessions = suite.sessions.filter((name) =>
    files.some((f) => f.cases.some((tc) => usesSession(tc, name))),
  );
  return { ...suite, files, sessions };
}

/** The session block a step continues as (`switch to session` or `switch to window`), if any. */
export function stepSession(step: Step): string | undefined {
  return step.kind === 'switch' || step.kind === 'window' ? step.session : undefined;
}

/** Whether the test starts from or continues as that session (`session:`, `switch to session`, `switch to window`). */
function usesSession(test: TestCase, name: string): boolean {
  return test.session === name || test.steps.some((step) => stepSession(step) === name);
}

/** The sessions the suite's cases use (`session:`, `switch to session`, `switch to window`), in the suite's order. */
function usedSessions(suite: TestSuite, files: TestSuite['files']): string[] {
  return suite.sessions.filter((name) =>
    files.some((file) => file.cases.some((test) => usesSession(test, name))),
  );
}

/**
 * The suite as `intent-test run` runs it: cases tagged `@draft` are left out (so neither `--list` nor dashboard discovery
 * sees them) unless `include` (AT_INCLUDE_DRAFTS=true). A draft without steps has nothing to run and is left out even
 * then. Sessions only the left-out cases use go with them.
 */
export function withoutDrafts(
  suite: TestSuite,
  include = process.env.AT_INCLUDE_DRAFTS === 'true',
): TestSuite {
  const runnable = (test: TestCase) => !test.draft || (include && test.steps.length > 0);
  if (suite.files.every((file) => file.cases.every(runnable))) return suite;
  const files = suite.files.map((file) => ({
    ...file,
    cases: file.cases.filter(runnable),
  }));
  return { ...suite, files, sessions: usedSessions(suite, files) };
}

/** The durable identity reporting and the dashboard use: `case:<id>`, a template's row `case:<id>[<row key>]`. */
export function clientTestId(test: Pick<TestCase, 'explicitId'>): string {
  return `case:${test.explicitId}`;
}

/** Exact durable-id filtering, independent of Playwright grep and file selection. */
export function selectCases(suite: TestSuite, ids = process.env.AT_CASE_IDS || ''): TestSuite {
  const wanted = [
    ...new Set(
      ids
        .split(/[\s,]+/)
        .filter(Boolean)
        .map((id) => id.replace(/^case:/, '')),
    ),
  ];
  if (!wanted.length) return suite;
  // A template's id selects all of its cases; `<id>[<row key>]` selects one.
  const idsOf = (test: TestCase) =>
    test.template
      ? [test.explicitId, test.template.clientTestId.replace(/^case:/, '')]
      : [test.explicitId];
  const known = new Set(suite.files.flatMap((file) => file.cases.flatMap(idsOf)));
  for (const id of wanted)
    if (!known.has(id)) throw new ParseError(`unknown case id "${id}" in selected suite`);
  const files = suite.files.map((file) => ({
    ...file,
    cases: file.cases.filter((test) => idsOf(test).some((id) => wanted.includes(id))),
  }));
  const sessions = suite.sessions.filter((name) =>
    files.some((file) => file.cases.some((test) => usesSession(test, name))),
  );
  return { ...suite, files, sessions };
}

/** File-system-safe name for a session's storage-state file. */
export function sessionSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'session'
  );
}
