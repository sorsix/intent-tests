// Develop mode's view of the app's cases (docs/develop-mode.md, section 3.3): the case list and the loaded case, built
// from the parser's output plus the case's section as written (own steps with their text and line, `use` steps with
// the steps they expand to). When the app does not parse, a case can still be read from its section's text, so a file
// the parser now rejects can be loaded and fixed.
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expandExamples, findTestFiles, parseAll, parseStep } from '../parse.ts';
import type { StepBlock, TestCase, TestSuite } from '../parse.ts';
import { loadParameters } from '../parameters.ts';
import { findBlock, findSection, sections, type Section } from './edit.ts';
import type { CaseSummary, DevelopBlock, DevelopCase, DevelopStep } from './protocol.ts';

const STEPS_HEADING = /^##\s+Steps:\s*(.+?)\s*$/gim;

/** The whole app as develop mode sees it: parsed, every template expanded into its row cases, drafts included. */
export async function parseApp(appDir: string): Promise<TestSuite> {
  return expandExamples(parseAll(appDir), await loadParameters(appDir), '');
}

/** The id written on the case's `id:` line: a template's own id for its row cases. */
export const sectionId = (test: TestCase): string =>
  test.template ? test.template.clientTestId.replace(/^case:/, '') : test.explicitId;

/** `<id>[<row key>]` → `<id>`. */
export const writtenId = (caseId: string): string =>
  caseId.replace(/^case:/, '').replace(/\[[^\]]*\]$/, '');

export function caseSummary(test: TestCase): CaseSummary {
  return {
    id: test.explicitId,
    name: test.name,
    file: test.file,
    line: test.line,
    tags: test.tags,
    draft: test.draft,
    refs: test.refs,
    ...(test.session ? { session: test.session } : {}),
    ...(test.seed ? { seed: test.seed } : {}),
    ...(test.template ? { template: sectionId(test) } : {}),
  };
}

/** Every case of the parsed app, in file order. */
export function listCases(suite: TestSuite): CaseSummary[] {
  return suite.files.flatMap((file) => file.cases.map(caseSummary));
}

/** Every `## Steps:` block of the parsed app (any can be a `session:`), the ones used as sessions first. */
export function sessionNames(suite: TestSuite): string[] {
  const used = suite.sessions.filter((name) => suite.blocks.has(name));
  return [...used, ...[...suite.blocks.keys()].filter((name) => !used.includes(name))];
}

/**
 * The app as written, for when it does not parse: every `## Test:` section that has an `id:` as a summary (template
 * rows not expanded), and every `## Steps:` block name, in file order.
 */
export function scanApp(appDir: string): { cases: CaseSummary[]; blocks: string[] } {
  const cases: CaseSummary[] = [];
  const blocks: string[] = [];
  for (const path of findTestFiles(appDir)) {
    const content = readFileSync(path, 'utf8');
    const file = relative(appDir, path);
    for (const section of sections(content))
      if (section.id)
        cases.push({
          id: section.id,
          name: section.name,
          file,
          line: section.line,
          tags: section.tags,
          draft: section.tags.includes('@draft'),
          refs: section.refs,
          ...(section.session ? { session: section.session } : {}),
          ...(section.seed ? { seed: section.seed } : {}),
          ...(section.parameters ? { template: section.id } : {}),
        });
    for (const match of content.matchAll(STEPS_HEADING))
      if (!blocks.includes(match[1])) blocks.push(match[1]);
  }
  return { cases, blocks };
}

/**
 * The case with this explicit id (`<id>`, `<id>[<row key>]`, `case:` optional). A template's own id picks its first
 * row, the case a run with AT_PARAMS=first would run.
 */
export function findCase(suite: TestSuite, caseId: string): TestCase | undefined {
  const id = caseId.replace(/^case:/, '');
  const all = suite.files.flatMap((file) => file.cases);
  return (
    all.find((test) => test.explicitId === id) ??
    all.find((test) => test.template && sectionId(test) === id)
  );
}

/** The own steps of a parsed case or block, from its section as written, each with the parsed steps it runs. */
export function ownSteps(test: Pick<TestCase, 'steps'>, section: Section): DevelopStep[] {
  return section.steps.map((written, index) => {
    const label = String(index + 1);
    const parsed = test.steps.filter(
      (step) => step.label === label || step.label.startsWith(`${label}.`),
    );
    const own = parsed.length === 1 && parsed[0].label === label ? parsed[0] : undefined;
    return {
      index,
      number: index + 1,
      label,
      text: written.text,
      kind: own ? own.kind : 'use',
      line: written.line,
      ...(own
        ? {}
        : {
            expanded: parsed.map((step) => ({
              label: step.label,
              text: step.text,
              kind: step.kind,
            })),
          }),
    };
  });
}

/** A parsed case for develop mode; `content` is its file's current text. */
export function developCase(test: TestCase, content: string): DevelopCase {
  const section = findSection(content, sectionId(test));
  if (!section)
    throw new Error(`${test.file}: no "## Test:" section with "id: ${sectionId(test)}"`);
  return {
    ...caseSummary(test),
    steps: ownSteps(test, section),
    ...(test.parameters ? { parameters: test.parameters.values } : {}),
  };
}

/** A written step as the parser reads it (environment variables stand in), or null when it rejects it. */
function parsedOf(text: string): ReturnType<typeof parseStep> | null {
  try {
    // Environment variables do not change a step's kind; one that is not set must not make it "invalid".
    return parseStep(text.replace(/\{\{\s*[A-Za-z0-9_]+\s*\}\}/g, 'x'));
  } catch {
    return null;
  }
}

/** The step kind of a written step, for a case read from text: `invalid` when the parser rejects it. */
const kindOf = (text: string): string => parsedOf(text)?.kind ?? 'invalid';

/** The steps of a section read from text alone, kinds from the parser. */
const writtenSteps = (section: Section): DevelopStep[] =>
  section.steps.map((step, index) => ({
    index,
    number: index + 1,
    label: String(index + 1),
    text: step.text,
    kind: kindOf(step.text),
    line: step.line,
  }));

type BlockUse = DevelopBlock['usedBy'][number];

/**
 * The cases that use the block `name`, in file order, from the sections as written: `session:` names it, a `use` step
 * inlines it, a `switch to session` or `switch to window` step continues as it. A template is named once, by its written id.
 */
function usersOf(appDir: string, name: string): BlockUse[] {
  return writtenSections(appDir).flatMap((section): BlockUse[] => {
    const id = section.id;
    if (!id) return [];
    const uses: BlockUse['as'][] = [];
    if (section.session === name) uses.push('session');
    for (const step of section.steps) {
      const parsed = parsedOf(step.text);
      if (parsed?.kind === 'use' && parsed.block === name && !uses.includes('use'))
        uses.push('use');
      // `switch to window` continues as the block too (in its own window): listed like `switch to session`.
      if (
        (parsed?.kind === 'switch' || parsed?.kind === 'window') &&
        parsed.session === name &&
        !uses.includes('switch')
      )
        uses.push('switch');
    }
    return uses.map((as) => ({ caseId: id, as }));
  });
}

/** Every `## Test:` section of the app as written, in file order (what `usedBy` is read from). */
function writtenSections(appDir: string): Section[] {
  return findTestFiles(appDir).flatMap((path) => sections(readFileSync(path, 'utf8')));
}

/** A parsed block for develop mode: its own steps as written, with their expansions, and the cases that use it. */
export function developBlock(suite: TestSuite, block: StepBlock): DevelopBlock {
  const content = readFileSync(join(suite.root, block.file), 'utf8');
  const section = findBlock(content, block.name);
  if (!section) throw new Error(`${block.file}: no "## Steps: ${block.name}" section`);
  return {
    name: block.name,
    file: block.file,
    line: block.line,
    steps: ownSteps(block, section),
    usedBy: usersOf(suite.root, block.name),
  };
}

/** A block read from its section's text alone (no parse): for files the parser rejects. */
export function sectionBlock(appDir: string, file: string, section: Section): DevelopBlock {
  return {
    name: section.name,
    file,
    line: section.line,
    steps: writtenSteps(section),
    usedBy: usersOf(appDir, section.name),
  };
}

/** The test file that holds the `## Steps:` block `name` (searched as text), or null. */
export function findBlockFile(
  appDir: string,
  name: string,
): { path: string; file: string; section: Section } | null {
  for (const path of findTestFiles(appDir)) {
    const section = findBlock(readFileSync(path, 'utf8'), name);
    if (section) return { path, file: relative(appDir, path), section };
  }
  return null;
}

/** A case read from its section's text alone (no parse): for files the parser rejects. */
export function sectionCase(caseId: string, file: string, section: Section): DevelopCase {
  const id = caseId.replace(/^case:/, '');
  return {
    id,
    name: section.name,
    file,
    line: section.line,
    tags: section.tags,
    draft: section.tags.includes('@draft'),
    refs: section.refs,
    ...(section.session ? { session: section.session } : {}),
    ...(section.seed ? { seed: section.seed } : {}),
    ...(section.parameters ? { template: section.id } : {}),
    steps: writtenSteps(section),
  };
}

/** The test file that holds the section of `caseId` (searched as text), or null. */
export function findCaseFile(
  appDir: string,
  caseId: string,
): { path: string; file: string; content: string; section: Section } | null {
  const id = writtenId(caseId);
  for (const path of findTestFiles(appDir)) {
    const content = readFileSync(path, 'utf8');
    const section = findSection(content, id);
    if (section) return { path, file: relative(appDir, path), content, section };
  }
  return null;
}
