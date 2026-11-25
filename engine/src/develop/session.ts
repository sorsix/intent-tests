// The engine side of develop mode (docs/develop-mode.md, sections 3.1-3.6): one browser context, kept alive between
// requests, in which the loaded case's steps run through the same StepRunner, snapshot and decider as in a run. It
// answers the requests of protocol.ts and emits its events through `emit`; src/cli/develop.ts connects it to
// stdin/stdout. Requests are processed one at a time in order; `input`, `screencast` and `record` are answered at once.
import { chromium, devices } from '@playwright/test';
import type { Browser, BrowserContext, BrowserContextOptions, Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { appConfig, authHook } from '../app-config.ts';
import { ENGINE_DIR } from '../app.ts';
import { config } from '../config.ts';
import { ENGINE_VERSION } from '../dashboard/engine-version.ts';
import { slugify } from '../ids.ts';
import {
  apiLogin,
  apiLoginCredentials,
  credentialsOf,
  freshCookiesFor,
  registerSessionCredentials,
  registerSessionFirstPage,
  startFresh,
} from '../login.ts';
import {
  bindStepParams,
  findTestFiles,
  ParseError,
  parseStep,
  substituteVars,
  VERBS,
  type ParsedStep,
  type StepBlock,
  type TestCase,
  type TestSuite,
} from '../parse.ts';
import { sessionFile } from '../paths.ts';
import { loadSeeds, seedContext, testIdFromFile, type Seed } from '../seeds.ts';
import {
  CLICK_LISTENERS,
  describe,
  pageSelection,
  pageText,
  recordClickListeners,
  snapshot,
} from '../snapshot.ts';
import { StepRunner, type StepRecord } from '../steps.ts';
import {
  developBlock,
  developCase,
  findBlockFile,
  findCase,
  findCaseFile,
  listCases,
  parseApp,
  scanApp,
  sectionBlock,
  sectionCase,
  sectionId,
  sessionNames,
  writtenId,
} from './cases.ts';
import {
  appendCase,
  deleteStep,
  EditError,
  findSection,
  insertStep,
  isCaseId,
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
  type EditTarget,
  type Section,
} from './edit.ts';
import type {
  BlockUpdate,
  CaseDiscarded,
  CaseSummary,
  CaseUpdate,
  DevelopBlock,
  DevelopCase,
  DevelopMessage,
  DevelopRequest,
  DevelopResults,
  DevelopStep,
  DevelopStepRecord,
  InputEvent,
  PromoteResult,
  PointDescription,
  ReadyInfo,
  RecordedStep,
  SessionState,
  SessionVariables,
  SnapshotResult,
  StepMatch,
  TextChange,
  Verification,
  DevelopRequestType,
} from './protocol.ts';
import { afterShot, pageActivity, type PageActivityCollector } from './page-activity.ts';
import type { PageActivity } from './protocol.ts';
import {
  pointDescription,
  pointScript,
  suggestedStep,
  SUGGEST_KINDS,
  type PointHit,
} from './describe.ts';
import { Recorder } from './recorder.ts';
import { inputProblem, PageView, type ScreencastOptions } from './screencast.ts';
import { DevelopTestContext, developRecord } from './test-context.ts';
import { sessionVariables, withVariables } from './variables.ts';
import {
  appendSection,
  caseText,
  duplicateCase as duplicateSection,
  renameCase as renameSection,
} from './edit.ts';
import type { CaseMoved } from './protocol.ts';

/** A request that cannot be done: replied `ok: false` with the message and, when there is one, a hint. */
/** Every request type `dispatch` answers, in the order of section 3.1; `hello` lists them and the refusal names them. */
export const REQUEST_TYPES: readonly DevelopRequestType[] = [
  'hello',
  'cases',
  'load',
  'load_block',
  'new_case',
  'start',
  'stop',
  'run_step',
  'run_from',
  'verify_step',
  'describe_point',
  'suggest_step',
  'edit_step',
  'insert_step',
  'delete_step',
  'set_meta',
  'discard_case',
  'promote',
  'duplicate_case',
  'rename_case',
  'move_case',
  'snapshot',
  'page_text',
  'page_selection',
  'search_steps',
  'replace_text',
  'navigate',
  'screencast',
  'input',
  'record',
  'recording',
  'clear_recording',
  'variables',
];

export class RequestError extends Error {
  hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.hint = hint;
  }
}

export type DevelopSessionOptions = {
  /** Writes one message (reply or event) to the client. */
  emit: (message: DevelopMessage) => void;
  /** Resolves when the client can take more output; frames are acknowledged only then. */
  drained?: () => Promise<void>;
  /** Logs for people (stderr). */
  log?: (message: string) => void;
  /** Opens a visible browser window too. */
  headed?: boolean;
  /** The app folder (absolute) and its name. */
  appDir: string;
  app: string;
};

/** Answered at once, not behind the request queue (`variables` reads what the session holds, also during a run). */
const IMMEDIATE = new Set(['input', 'screencast', 'record', 'variables']);
const ELEMENT_KINDS = ['click', 'fill', 'select', 'check', 'uncheck'];
const NOT_TESTS = /^(readme|agents|claude)\.md$/i;
/** The most steps `search_steps` returns. */
const MAX_STEP_MATCHES = 200;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The loaded case: parsed when the app parses, otherwise read from its section's text. */
type Loaded = {
  caseId: string;
  /** Relative to the app folder. */
  file: string;
  path: string;
  case: DevelopCase;
  parsed?: TestCase;
  /** The parser's message when the app does not parse. */
  error?: string;
};

/** The loaded `## Steps:` block (`load_block`): parsed when the app parses, otherwise read from its section's text. */
type LoadedBlock = {
  name: string;
  /** Relative to the app folder. */
  file: string;
  path: string;
  block: DevelopBlock;
  parsed?: StepBlock;
  /** The parser's message when the app does not parse. */
  error?: string;
};

/** What `run_step`, `run_from` and `verify_step` work on: the loaded block's or case's parsed steps and own steps. */
type Runnable = {
  what: 'case' | 'block';
  parsed: Pick<TestCase, 'steps' | 'file' | 'line' | 'parameters'>;
  own: DevelopStep[];
  runner: StepRunner;
};

/** Engine package root (docs/ lives there in the source and in the installed package). */
function packageRoot(): string {
  return dirname(createRequire(import.meta.url).resolve('@sorsix/intent-engine/package.json'));
}

/** Is the URL answering, as Playwright's webServer checks it (reuseExistingServer)? */
async function reachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: 'manual' });
    await response.body?.cancel().catch(() => undefined);
    return response.status >= 200 && response.status < 404;
  } catch {
    return false;
  }
}

/** A ParsedStep for one step text at a position of a case. `use` steps are rejected. */
function stepFrom(text: string, number: number, file: string, line: number): ParsedStep {
  const where = `${file}:${line}`;
  const step = parseStep(text, where);
  if (step.kind === 'use')
    throw new RequestError(
      'a "use" step runs a block of steps; it cannot be run or verified on its own here',
      'Edit it into the case, then run it with run_step.',
    );
  const trimmed = text.trim();
  // As the parser keeps it: variables filled in, except in `fill`, whose value may be a password.
  const shown = step.kind === 'fill' ? trimmed : substituteVars(trimmed, where);
  return { ...step, number, label: String(number), text: shown, file, line } as ParsedStep;
}

export class DevelopSession {
  private readonly emit: (message: DevelopMessage) => void;
  private readonly drained: () => Promise<void>;
  private readonly log: (message: string) => void;
  private readonly headed: boolean;
  private readonly app: string;
  private readonly appName: string;

  private queue: Promise<unknown> = Promise.resolve();
  private suite: TestSuite | null = null;
  private seeds: Record<string, Seed> | null = null;
  private loaded: Loaded | null = null;
  /** A `## Steps:` block in the rail instead of a case; `load` and `new_case` unload it. */
  private block: LoadedBlock | null = null;

  private state: SessionState = 'closed';
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private contextOptions: BrowserContextOptions = {};
  private page: Page | null = null;
  private runner: StepRunner | null = null;
  private readonly testContext = new DevelopTestContext('develop', 'develop');
  private view: PageView | null = null;
  private server: ChildProcess | null = null;
  /** The origin a `start` chose (`baseUrl`), kept for later starts; null while the default applies. */
  private chosenBase: string | null = null;
  /** BASE_URL as the profile set it, read once: `start` rewrites the variable to the session's base. */
  private readonly profileBase: string | undefined;
  private seedRun: {
    name: string;
    cleanup?: () => Promise<void>;
    dispose: () => Promise<void>;
  } | null = null;
  /** The last `variables` event's values (JSON), so a step that changed none sends no event; null while closed. */
  private variablesSent: string | null = null;
  /** Sessions whose browser state was saved in this session, for `switch to session`. */
  private readonly savedSessions = new Set<string>();

  private screencast: ScreencastOptions | null = null;
  private recorder: Recorder | null = null;
  private recordingWanted = false;
  private recorded: RecordedStep[] = [];
  /** Each own step's last record in this browser context, for `suggest_step` (cleared when indices or the page go). */
  private readonly lastRecords = new Map<number, DevelopStepRecord>();
  private closing = false;

  constructor(options: DevelopSessionOptions) {
    this.emit = options.emit;
    this.drained = options.drained ?? (() => Promise.resolve());
    this.log = options.log ?? ((line) => console.error(line));
    this.headed = !!options.headed;
    this.app = options.appDir;
    this.appName = options.app;
    this.profileBase = process.env.BASE_URL?.trim() || undefined;
  }

  /** The `ready` payload, also the reply to `hello`. */
  ready(): ReadyInfo {
    const baseUrl = this.profileBase || appConfig.webServer?.url;
    return {
      engineVersion: ENGINE_VERSION,
      app: this.appName,
      appDir: this.app,
      docs: {
        testFormat: join(packageRoot(), 'docs', 'test-format.md'),
        authoring: join(packageRoot(), 'docs', 'authoring.md'),
      },
      baseUrl: baseUrl || null,
      requests: [...REQUEST_TYPES],
    };
  }

  /** Takes one request (a parsed stdin line); answers it exactly once, unless it has no id to answer. */
  receive(request: unknown): Promise<void> {
    const r = request as { id?: unknown; type?: unknown } | null;
    if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !r.id) {
      this.event('error', 'ignored a request without a string "id"');
      return Promise.resolve();
    }
    if (IMMEDIATE.has(r.type as string)) return this.answer(r as DevelopRequest);
    const done = this.queue.then(() => this.answer(r as DevelopRequest));
    this.queue = done.catch(() => undefined);
    return done;
  }

  /** Runs `work` behind the requests already queued (recorded-step verification). */
  private enqueue(work: () => Promise<void>): void {
    this.queue = this.queue.then(work).catch((error) => this.event('error', message(error)));
  }

  private async answer(request: DevelopRequest): Promise<void> {
    try {
      const result = (await this.dispatch(request)) ?? {};
      this.emit({ id: request.id, ok: true, result: result as Record<string, unknown> });
    } catch (error) {
      const hint =
        error instanceof RequestError
          ? error.hint
          : error instanceof ParseError
            ? `The step grammar: ${VERBS}. See docs/test-format.md.`
            : undefined;
      this.emit({ id: request.id, ok: false, error: message(error), ...(hint ? { hint } : {}) });
    }
  }

  private dispatch(request: DevelopRequest): Promise<object | void> | object {
    const r = request as DevelopRequest & Record<string, unknown>;
    switch (request.type) {
      case 'hello':
        return this.ready();
      case 'cases':
        return this.cases();
      case 'load':
        return this.load(text(r.caseId, 'caseId'));
      case 'load_block':
        return this.loadBlock(text(r.name, 'name'));
      case 'new_case':
        return this.newCase(r);
      case 'start':
        return this.start(r.baseUrl);
      case 'stop':
        return this.stop().then(() => ({}));
      case 'run_step':
        return this.runStep(index(r.index)).then((record) => ({ record }));
      case 'run_from':
        return this.runFrom(index(r.index));
      case 'verify_step':
        return this.verifyStep(
          index(r.index),
          r.text === undefined ? undefined : text(r.text, 'text'),
        );
      case 'describe_point':
        return this.describePoint(r.x, r.y);
      case 'suggest_step':
        return this.suggestStep(index(r.index), text(r.elementId, 'elementId'));
      case 'edit_step':
        return this.editStep(index(r.index), text(r.text, 'text'));
      case 'insert_step':
        return this.insertStep(index(r.index), text(r.text, 'text'));
      case 'delete_step':
        return this.deleteStep(index(r.index));
      case 'set_meta':
        return this.setMeta(r.draft, r.refs, r.session, r.seed);
      case 'discard_case':
        return this.discardCase(text(r.caseId, 'caseId'));
      case 'promote':
        return this.promote(r.runs);
      case 'duplicate_case':
        return this.duplicateCase(text(r.caseId, 'caseId'), r.name, r.file);
      case 'rename_case':
        return this.renameCase(text(r.caseId, 'caseId'), r.newId, r.name);
      case 'move_case':
        return this.moveCase(text(r.caseId, 'caseId'), text(r.file, 'file'));
      case 'snapshot':
        return this.snapshot();
      case 'page_text':
        return pageText(this.requirePage(), config.maxPageTextChars);
      case 'page_selection':
        return pageSelection(this.requirePage());
      case 'search_steps':
        return this.searchSteps(text(r.query, 'query'));
      case 'replace_text':
        return this.replaceText(text(r.from, 'from'), text(r.to, 'to'), r.apply);
      case 'navigate':
        return this.navigate(text(r.path, 'path'));
      case 'screencast':
        return this.setScreencast(r.enabled, r.maxWidth, r.quality);
      case 'input':
        return this.input(r.event);
      case 'record':
        return this.record(r.enabled);
      case 'recording':
        return { steps: [...this.recorded] };
      case 'clear_recording':
        this.recorded = [];
        this.recorder?.clear();
        return {};
      case 'variables':
        return this.variables();
      default:
        throw new RequestError(
          `unknown request type ${JSON.stringify((request as { type?: unknown }).type)}`,
          `Requests: ${REQUEST_TYPES.join(', ')}.`,
        );
    }
  }

  // ---- events --------------------------------------------------------------------------------------------------

  private event(level: 'info' | 'warn' | 'error', line: string): void {
    this.log(`[develop] ${line}`);
    this.emit({ event: 'log', level, message: line });
  }

  private setState(state: SessionState, extra: { url?: string; error?: string } = {}): void {
    this.state = state;
    this.emit({ event: 'session.state', state, ...extra });
  }

  // ---- cases ---------------------------------------------------------------------------------------------------

  /** Parses the whole app (drafts included) and checks what a run checks before it starts. */
  private async parse(): Promise<TestSuite> {
    const suite = await parseApp(this.app);
    for (const [name, block] of suite.blocks) {
      registerSessionCredentials(name, credentialsOf(block.steps));
      registerSessionFirstPage(name, block.steps);
    }
    this.seeds ??= await loadSeeds(this.app);
    for (const test of suite.files.flatMap((file) => file.cases))
      if (test.seed && !this.seeds[test.seed])
        throw new ParseError(
          `${test.file}:${test.line}: seed "${test.seed}" is not defined in ${this.app}/seeds.ts (has: ${Object.keys(this.seeds).join(', ') || 'none'})`,
        );
    this.suite = suite;
    return suite;
  }

  private async cases(): Promise<DevelopResults['cases']> {
    const seeds = Object.entries(await this.loadSeeds()).map(([name, seed]) => ({
      name,
      ...(seed.description ? { description: seed.description } : {}),
    }));
    try {
      const suite = await this.parse();
      return { cases: listCases(suite), sessions: sessionNames(suite), seeds };
    } catch (error) {
      if (!(error instanceof ParseError)) throw error;
      // The app does not parse (a new case without steps yet, a half-edited file): list what is written.
      const { cases, blocks } = scanApp(this.app);
      return { cases, sessions: blocks, seeds, error: error.message };
    }
  }

  private async loadSeeds(): Promise<Record<string, Seed>> {
    this.seeds ??= await loadSeeds(this.app);
    return this.seeds;
  }

  /** The `## Steps:` blocks a `session:` may name: from the parsed app, else from the files as written. */
  private async blockNames(): Promise<string[]> {
    try {
      return sessionNames(await this.parse());
    } catch (error) {
      if (!(error instanceof ParseError)) throw error;
      return scanApp(this.app).blocks;
    }
  }

  /** Reads the case: from the parsed app, or from its section's text when the app does not parse. */
  private async read(caseId: string): Promise<Loaded> {
    const id = caseId.trim().replace(/^case:/, '');
    let suite: TestSuite | null = null;
    let error: string | undefined;
    try {
      suite = await this.parse();
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      error = e.message;
    }
    if (suite) {
      const test = findCase(suite, id);
      if (!test)
        throw new RequestError(`unknown case id "${id}"`, 'The cases request lists every case id.');
      const path = join(this.app, test.file);
      return {
        caseId: test.explicitId,
        file: test.file,
        path,
        case: developCase(test, readFileSync(path, 'utf8')),
        parsed: test,
      };
    }
    const found = findCaseFile(this.app, id);
    if (!found)
      throw new RequestError(
        `no case with "id: ${writtenId(id)}" in the app's test files`,
        `The app does not parse either: ${error}`,
      );
    return {
      caseId: id,
      file: found.file,
      path: found.path,
      case: sectionCase(id, found.file, found.section),
      error,
    };
  }

  private async load(caseId: string): Promise<{ case: DevelopCase; error?: string }> {
    const loaded = await this.read(caseId);
    this.loaded = loaded;
    this.block = null;
    this.lastRecords.clear();
    this.testContext.title = loaded.case.name;
    this.testContext.testId = `case:${loaded.caseId}`;
    this.testContext.annotations = [
      { type: 'at-client-test-id', description: `case:${loaded.caseId}` },
    ];
    this.emit({ event: 'case.loaded', case: loaded.case });
    return { case: loaded.case, ...(loaded.error ? { error: loaded.error } : {}) };
  }

  /** Reads a `## Steps:` block: from the parsed app, or from its section's text when the app does not parse. */
  private async readBlock(name: string): Promise<LoadedBlock> {
    let suite: TestSuite | null = null;
    let error: string | undefined;
    try {
      suite = await this.parse();
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      error = e.message;
    }
    if (suite) {
      const block = suite.blocks.get(name);
      if (!block)
        throw new RequestError(
          `unknown steps block "${name}"`,
          `The cases request lists every block name under sessions: ${[...suite.blocks.keys()].join(', ') || 'none'}.`,
        );
      return {
        name,
        file: block.file,
        path: join(this.app, block.file),
        block: developBlock(suite, block),
        parsed: block,
      };
    }
    const found = findBlockFile(this.app, name);
    if (!found)
      throw new RequestError(
        `no "## Steps: ${name}" section in the app's test files`,
        `The app does not parse either: ${error}`,
      );
    return {
      name,
      file: found.file,
      path: found.path,
      block: sectionBlock(this.app, found.file, found.section),
      error,
    };
  }

  /**
   * Loads a `## Steps:` block into the rail instead of a case (docs/develop-mode.md, section 3.6): its steps are
   * edited, run and verified in the open session; a case that was loaded is unloaded.
   */
  private async loadBlock(name: string): Promise<DevelopResults['load_block']> {
    const trimmed = name.trim();
    if (!trimmed) throw new RequestError('name must not be empty');
    const block = await this.readBlock(trimmed);
    this.block = block;
    this.loaded = null;
    this.lastRecords.clear();
    this.testContext.title = `Steps: ${trimmed}`;
    this.testContext.testId = `block:${trimmed}`;
    this.testContext.annotations = [{ type: 'at-client-test-id', description: `block:${trimmed}` }];
    this.emit({ event: 'block.loaded', block: block.block });
    return { block: block.block, ...(block.error ? { error: block.error } : {}) };
  }

  private requireLoaded(): Loaded {
    if (!this.loaded) throw new RequestError('no case is loaded', 'Send load or new_case first.');
    return this.loaded;
  }

  /** A request that applies to a case only (`set_meta`, `promote`, `discard_case`) is refused while a block is loaded. */
  private noBlock(what: string): void {
    if (!this.block) return;
    throw new RequestError(
      `a Steps block is loaded: ${what} applies to a case, not to "${this.block.name}"`,
      'Load a case with load or new_case first; the block stays as it is.',
    );
  }

  /** Forgets the loaded case (it was discarded); the browser session, if open, stays. */
  private unload(): void {
    this.loaded = null;
    this.lastRecords.clear();
    this.testContext.title = 'develop';
    this.testContext.testId = 'develop';
    this.testContext.annotations = [{ type: 'at-client-test-id', description: 'develop' }];
  }

  /** The id on the loaded case's `id:` line. */
  private sectionIdOf(loaded: Loaded): string {
    return loaded.parsed ? sectionId(loaded.parsed) : writtenId(loaded.caseId);
  }

  /** Writes the file, reloads the case and emits `case.updated`. A write that fails is an error. */
  private async save(loaded: Loaded, content: string): Promise<CaseUpdate> {
    try {
      writeFileSync(loaded.path, content);
    } catch (error) {
      const update = { case: loaded.case, file: loaded.file, saved: false, error: message(error) };
      this.emit({ event: 'case.updated', ...update });
      throw new RequestError(`could not save ${loaded.file}: ${message(error)}`);
    }
    let error: string | undefined;
    try {
      this.loaded = await this.read(loaded.caseId);
      error = this.loaded.error;
    } catch (e) {
      error = message(e);
    }
    const current = this.loaded ?? loaded;
    const update: CaseUpdate = {
      case: current.case,
      file: current.file,
      saved: true,
      ...(error ? { error } : {}),
    };
    this.emit({ event: 'case.updated', ...update });
    return update;
  }

  /** Applies a text edit to the loaded case's file and saves it. */
  private async edit(change: (content: string, id: string) => string): Promise<CaseUpdate> {
    const loaded = this.requireLoaded();
    const content = readFileSync(loaded.path, 'utf8');
    let next: string;
    try {
      next = change(content, this.sectionIdOf(loaded));
    } catch (error) {
      if (error instanceof EditError) throw new RequestError(error.message);
      throw error;
    }
    if (next === content) return { case: loaded.case, file: loaded.file, saved: true };
    return this.save(loaded, next);
  }

  /** A step edit: on the loaded block's section when one is loaded, else on the loaded case's. */
  private async editSteps(
    change: (content: string, target: EditTarget) => string,
  ): Promise<CaseUpdate | BlockUpdate> {
    const block = this.block;
    if (!block) return this.edit(change);
    const content = readFileSync(block.path, 'utf8');
    let next: string;
    try {
      next = change(content, { block: block.name });
    } catch (error) {
      if (error instanceof EditError) throw new RequestError(error.message);
      throw error;
    }
    if (next === content) return { block: block.block, file: block.file, saved: true };
    return this.saveBlock(block, next);
  }

  /** Writes the block's file, reloads the block and emits `block.updated`. A write that fails is an error. */
  private async saveBlock(loaded: LoadedBlock, content: string): Promise<BlockUpdate> {
    try {
      writeFileSync(loaded.path, content);
    } catch (error) {
      const update = {
        block: loaded.block,
        file: loaded.file,
        saved: false,
        error: message(error),
      };
      this.emit({ event: 'block.updated', ...update });
      throw new RequestError(`could not save ${loaded.file}: ${message(error)}`);
    }
    let error: string | undefined;
    try {
      this.block = await this.readBlock(loaded.name);
      error = this.block.error;
    } catch (e) {
      error = message(e);
    }
    const current = this.block ?? loaded;
    const update: BlockUpdate = {
      block: current.block,
      file: current.file,
      saved: true,
      ...(error ? { error } : {}),
    };
    this.emit({ event: 'block.updated', ...update });
    return update;
  }

  /** The step text as it will be written, checked by the parser. */
  private checkStep(value: string): string {
    const step = value.trim();
    if (!step) throw new RequestError('the step text is empty');
    if (/[\r\n]/.test(step))
      throw new RequestError('a step is one line; the text has a line break');
    try {
      parseStep(step, 'step');
    } catch (error) {
      if (error instanceof ParseError)
        throw new RequestError(
          error.message,
          `A step is one of: ${VERBS}. See ${this.ready().docs.testFormat}.`,
        );
      throw error;
    }
    return step;
  }

  private editStep(position: number, value: string): Promise<CaseUpdate | BlockUpdate> {
    const step = this.checkStep(value);
    return this.editSteps((content, target) => replaceStep(content, target, position, step));
  }

  private insertStep(position: number, value: string): Promise<CaseUpdate | BlockUpdate> {
    const step = this.checkStep(value);
    // The steps after it move: their records no longer have their index.
    this.lastRecords.clear();
    return this.editSteps((content, target) => insertStep(content, target, position, step));
  }

  private deleteStep(position: number): Promise<CaseUpdate | BlockUpdate> {
    this.lastRecords.clear();
    return this.editSteps((content, target) => deleteStep(content, target, position));
  }

  private async setMeta(
    draft: unknown,
    refs: unknown,
    session: unknown,
    seed: unknown,
  ): Promise<CaseUpdate> {
    this.noBlock('set_meta');
    if (draft === undefined && refs === undefined && session === undefined && seed === undefined)
      throw new RequestError('set_meta needs draft, refs, session or seed');
    if (draft !== undefined && typeof draft !== 'boolean')
      throw new RequestError('draft must be true or false');
    if (refs !== undefined && (!Array.isArray(refs) || refs.some((ref) => typeof ref !== 'string')))
      throw new RequestError('refs must be a list of strings');
    const list = (refs as string[] | undefined)?.map((ref) => ref.trim());
    const name = (value: unknown, what: 'session' | 'seed'): string | null | undefined => {
      if (value === undefined || value === null) return value;
      if (typeof value !== 'string' || !value.trim())
        throw new RequestError(`${what} must be a name, or null to remove the line`);
      return value.trim();
    };
    const block = name(session, 'session');
    const seedName = name(seed, 'seed');
    // Checked against the app before writing, so the file keeps parsing.
    if (block) {
      const blocks = await this.blockNames();
      if (!blocks.includes(block))
        throw new RequestError(
          `session "${block}" is not defined as "## Steps: ${block}"`,
          `Blocks: ${blocks.join(', ') || 'none'}.`,
        );
    }
    if (seedName) {
      const seeds = Object.keys(await this.loadSeeds());
      if (!seeds.includes(seedName))
        throw new RequestError(
          `seed "${seedName}" is not defined in ${this.appName}/seeds.ts`,
          `Seeds: ${seeds.join(', ') || 'none'}.`,
        );
    }
    return this.edit((content, id) => {
      let next = draft === undefined ? content : setDraft(content, id, draft as boolean);
      if (list) next = setRefs(next, id, list);
      if (block !== undefined) next = setMetaLine(next, id, 'session', block);
      if (seedName !== undefined) next = setMetaLine(next, id, 'seed', seedName);
      return next;
    });
  }

  private async newCase(
    r: Record<string, unknown>,
  ): Promise<{ case: DevelopCase; error?: string }> {
    const name = text(r.name, 'name').trim();
    if (!name) throw new RequestError('name must not be empty');
    const typed = r.file === undefined ? '' : text(r.file, 'file').trim();
    const { path, rel } = this.caseFile(typed, name);
    const session = r.session === undefined ? undefined : text(r.session, 'session').trim();
    const seed = r.seed === undefined ? undefined : text(r.seed, 'seed').trim();
    const taken = findTestFiles(this.app).flatMap((other) =>
      writtenIds(readFileSync(other, 'utf8')),
    );
    let id: string;
    if (r.caseId !== undefined) {
      id = text(r.caseId, 'caseId').trim();
      if (!isCaseId(id))
        throw new RequestError(
          `invalid id "${id}"`,
          'An id is 1-200 letters, digits, ".", "_" or "-", starting with a letter or digit.',
        );
      if (taken.includes(id)) throw new RequestError(`the id "${id}" is already used in the app`);
    } else id = uniqueId(slugify(name), taken);
    const content = existsSync(path) ? readFileSync(path, 'utf8') : '';
    let next: string;
    try {
      next = appendCase(content, { name, id, session, seed });
    } catch (error) {
      if (error instanceof EditError) throw new RequestError(error.message);
      throw error;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, next);
    this.log(`[develop] added "${name}" (id: ${id}) to ${rel}`);
    return this.load(id);
  }

  /**
   * Removes a draft's `## Test:` section from its file, and the file when nothing else is left in it. Only drafts: a
   * finished case is deleted by hand, in the file. The loaded case, when it is the one, is unloaded; recorded steps
   * were meant for it and are forgotten with it.
   */
  private async discardCase(caseId: string): Promise<CaseDiscarded> {
    this.noBlock('discard_case');
    const target = await this.read(caseId);
    if (!target.case.draft)
      throw new RequestError(
        `only drafts can be discarded: "${target.caseId}" is not tagged @draft`,
        'Tag it with set_meta { draft: true } first, or delete it in the file by hand.',
      );
    const id = this.sectionIdOf(target);
    const content = readFileSync(target.path, 'utf8');
    let next: string;
    try {
      next = removeCase(content, id);
    } catch (error) {
      if (error instanceof EditError) throw new RequestError(error.message);
      throw error;
    }
    // Nothing but whitespace left (so no other `## Test:` or `## Steps:` section): the file goes too.
    const fileRemoved = next.trim() === '';
    try {
      if (fileRemoved) unlinkSync(target.path);
      else writeFileSync(target.path, next);
    } catch (error) {
      throw new RequestError(`could not save ${target.file}: ${message(error)}`);
    }
    if (this.loaded && this.sectionIdOf(this.loaded) === id) {
      this.unload();
      this.recorded = [];
      this.recorder?.clear();
    }
    const result: CaseDiscarded = { caseId: target.caseId, file: target.file, fileRemoved };
    this.log(
      `[develop] discarded "${target.case.name}" (id: ${id}) from ${target.file}${fileRemoved ? ', removed the file' : ''}`,
    );
    this.emit({ event: 'case.discarded', ...result });
    return result;
  }

  /**
   * Promotes the loaded draft (docs/develop-mode.md, section 3.6): a fresh session exactly as `start` opens one (the
   * base last chosen, login, seed), every own step in order as `run_from 0` runs them, stopping at the first failure.
   * Only when all passed and the case has refs is `@draft` removed, through `set_meta`'s path (autosave,
   * `case.updated`). The session stays open on the final page. Not `intent-test run`: no dashboard token, no second
   * browser; Execute stays the place for the real suite run.
   */
  private async promote(runs: unknown): Promise<PromoteResult> {
    this.noBlock('promote');
    if (
      runs !== undefined &&
      (!Number.isInteger(runs) || (runs as number) < 1 || (runs as number) > 5)
    )
      throw new RequestError(
        'runs must be a whole number from 1 to 5',
        'Leave it out to run once; 2 catches most flaky wording.',
      );
    const count = (runs as number | undefined) ?? 1;
    const loaded = this.requireLoaded();
    if (!loaded.parsed)
      throw new RequestError(
        `the app does not parse: ${loaded.error}`,
        'Fix the file (edit_step, insert_step), then promote again.',
      );
    if (!loaded.case.draft)
      throw new RequestError(
        `only drafts can be promoted: "${loaded.caseId}" is not tagged @draft`,
        'It already runs with the suite; run it with run_from 0, or tag it with set_meta { draft: true } first.',
      );
    if (loaded.case.steps.length === 0)
      throw new RequestError(
        'the case has no steps yet',
        'Add the first step with insert_step at index 0.',
      );
    let ran = 0;
    let last: { records: DevelopStepRecord[]; stoppedAt?: number } = { records: [] };
    let passed = false;
    // Every run from a fresh session; the first failed run ends it.
    while (ran < count) {
      ran++;
      this.event(
        'info',
        `promoting "${loaded.case.name}": every step from a fresh session${count > 1 ? ` (run ${ran} of ${count})` : ''}`,
      );
      await this.start(undefined);
      last = await this.runFrom(0);
      passed =
        last.stoppedAt === undefined && last.records.every((record) => record.status === 'passed');
      if (!passed) break;
    }
    const { records, stoppedAt } = last;
    const base = {
      passed,
      runs: ran,
      records,
      ...(stoppedAt === undefined ? {} : { stoppedAt }),
    };
    if (!passed) return { ...base, promoted: false };
    if (!this.requireLoaded().case.refs.length)
      return { ...base, promoted: false, reason: 'add refs first' };
    await this.setMeta(false, undefined, undefined, undefined);
    this.event('info', `promoted "${loaded.case.name}": the @draft tag is removed`);
    return { ...base, promoted: true };
  }

  /** Every `id:` value written in the app's test files, for new ids that must be unused. */
  private takenIds(): string[] {
    return findTestFiles(this.app).flatMap((other) => writtenIds(readFileSync(other, 'utf8')));
  }

  /** Makes `loaded` the loaded case without a `case.loaded` event (the caller emits `case.updated`). */
  private adopt(loaded: Loaded): void {
    this.loaded = loaded;
    this.testContext.title = loaded.case.name;
    this.testContext.testId = `case:${loaded.caseId}`;
    this.testContext.annotations = [
      { type: 'at-client-test-id', description: `case:${loaded.caseId}` },
    ];
  }

  /** Runs a pure edit, turning its `EditError` into a refusal. */
  private static editing<T>(work: () => T): T {
    try {
      return work();
    } catch (error) {
      if (error instanceof EditError) throw new RequestError(error.message);
      throw error;
    }
  }

  /**
   * Copies a case's section as a new draft (docs/develop-mode.md, section 3.6): named `name` (else "Copy of <name>"),
   * with the name's slug as its id (else `<id>-copy`), made unique in the app, tagged `@draft`, without refs. It goes to
   * `file` with the `new_case` rules (a folder names the file after the copy), or to the end of the case's own file,
   * and is loaded.
   */
  private async duplicateCase(
    caseId: string,
    nameValue: unknown,
    fileValue: unknown,
  ): Promise<{ case: DevelopCase; error?: string }> {
    const source = await this.read(caseId);
    const sourceId = this.sectionIdOf(source);
    const content = readFileSync(source.path, 'utf8');
    const original = findSection(content, sourceId)!;
    const typedName = nameValue === undefined ? '' : text(nameValue, 'name').trim();
    const typedFile = fileValue === undefined ? '' : text(fileValue, 'file').trim();
    const target = typedFile
      ? this.caseFile(typedFile, typedName || `Copy of ${original.name}`)
      : { path: source.path, rel: source.file };
    const same = resolve(target.path) === resolve(source.path);
    const existing = same
      ? content
      : existsSync(target.path)
        ? readFileSync(target.path, 'utf8')
        : '';
    let name = typedName;
    if (!name) {
      // "Copy of <name>", then "Copy of <name> 2", …: a file holds one test per name.
      const names = new Set(sections(existing).map((section) => section.name));
      name = `Copy of ${original.name}`;
      for (let n = 2; names.has(name); n++) name = `Copy of ${original.name} ${n}`;
    }
    const id = uniqueId(typedName ? slugify(typedName) : `${sourceId}-copy`, this.takenIds());
    const next = DevelopSession.editing(() =>
      appendSection(existing, duplicateSection(content, sourceId, { name, id })),
    );
    mkdirSync(dirname(target.path), { recursive: true });
    writeFileSync(target.path, next);
    this.log(`[develop] copied "${original.name}" as "${name}" (id: ${id}) to ${target.rel}`);
    return this.load(id);
  }

  /**
   * Renames a case: `name` rewrites its `## Test:` heading, `newId` its `id:` line (a valid id no other case of the app
   * has). The case is loaded afterwards under its new id and `case.updated` is emitted. The dashboard keeps a case's
   * history under its id, so a new id starts a new history there.
   */
  private async renameCase(
    caseId: string,
    newId: unknown,
    nameValue: unknown,
  ): Promise<CaseUpdate> {
    if (newId === undefined && nameValue === undefined)
      throw new RequestError('rename_case needs newId or name');
    const target = await this.read(caseId);
    const id = this.sectionIdOf(target);
    const change: { id?: string; name?: string } = {};
    if (newId !== undefined) {
      const value = text(newId, 'newId').trim();
      if (!isCaseId(value))
        throw new RequestError(
          `invalid id "${value}"`,
          'An id is 1-200 letters, digits, ".", "_" or "-", starting with a letter or digit.',
        );
      const lower = value.toLowerCase();
      if (
        value !== id &&
        this.takenIds().some((other) => other !== id && other.toLowerCase() === lower)
      )
        throw new RequestError(`the id "${value}" is already used in the app`);
      if (value !== id) change.id = value;
    }
    if (nameValue !== undefined) {
      const value = text(nameValue, 'name').trim();
      if (!value) throw new RequestError('name must not be empty');
      change.name = value;
    }
    const content = readFileSync(target.path, 'utf8');
    const next = DevelopSession.editing(() => renameSection(content, id, change));
    try {
      if (next !== content) writeFileSync(target.path, next);
    } catch (error) {
      throw new RequestError(`could not save ${target.file}: ${message(error)}`);
    }
    // A template row keeps its row key under the new id.
    const row = target.caseId.slice(writtenId(target.caseId).length);
    const loaded = await this.read(change.id ? `${change.id}${row}` : target.caseId);
    this.adopt(loaded);
    if (change.id) this.log(`[develop] renamed the id "${id}" to "${change.id}" in ${loaded.file}`);
    const update: CaseUpdate = {
      case: loaded.case,
      file: loaded.file,
      saved: true,
      ...(loaded.error ? { error: loaded.error } : {}),
    };
    this.emit({ event: 'case.updated', ...update });
    return update;
  }

  /**
   * Moves a case's section to another file: cut as `discard_case` cuts a draft (any case here), appended to `file`
   * with the `new_case` rules (created when missing; a folder names the file after the case). The file it left is
   * deleted when nothing but whitespace is left. The case is loaded afterwards and `case.updated` names its new file.
   */
  private async moveCase(caseId: string, typedFile: string): Promise<CaseMoved> {
    const source = await this.read(caseId);
    const id = this.sectionIdOf(source);
    const content = readFileSync(source.path, 'utf8');
    const section = findSection(content, id)!;
    const typed = typedFile.trim();
    if (!typed) throw new RequestError('file must not be empty');
    const target = this.caseFile(typed, section.name);
    if (resolve(target.path) === resolve(source.path))
      throw new RequestError(`"${source.caseId}" is already in ${source.file}`);
    const created = !existsSync(target.path);
    const before = created ? '' : readFileSync(target.path, 'utf8');
    const next = DevelopSession.editing(() => appendSection(before, caseText(content, id)));
    const rest = DevelopSession.editing(() => removeCase(content, id));
    const fileRemoved = rest.trim() === '';
    // The new file first: a failure afterwards puts it back, so the case is never in neither file.
    try {
      mkdirSync(dirname(target.path), { recursive: true });
      writeFileSync(target.path, next);
    } catch (error) {
      throw new RequestError(`could not save ${target.rel}: ${message(error)}`);
    }
    try {
      if (fileRemoved) unlinkSync(source.path);
      else writeFileSync(source.path, rest);
    } catch (error) {
      if (created) unlinkSync(target.path);
      else writeFileSync(target.path, before);
      throw new RequestError(`could not save ${source.file}: ${message(error)}`);
    }
    const loaded = await this.read(source.caseId);
    this.adopt(loaded);
    this.log(
      `[develop] moved "${section.name}" (id: ${id}) from ${source.file} to ${loaded.file}${fileRemoved ? ', removed the file' : ''}`,
    );
    const error = loaded.error ? { error: loaded.error } : {};
    this.emit({
      event: 'case.updated',
      case: loaded.case,
      file: loaded.file,
      saved: true,
      ...error,
    });
    return { case: loaded.case, from: source.file, to: loaded.file, fileRemoved, ...error };
  }

  /**
   * A test file for `new_case`, `duplicate_case` and `move_case`, relative to the app folder: what was typed, or for a
   * folder ending in "/" (or nothing) the folder plus the slug of `name`. Refused outside the app folder, without a
   * file name, and where the parser reads no tests.
   */
  private caseFile(typed: string, name: string): { path: string; rel: string } {
    // No file, or a folder ("booking/"): the file is named after the case, so a case is one name away.
    const file =
      typed === '' || typed.endsWith('/') || typed.endsWith(sep)
        ? `${typed}${slugify(name)}.md`
        : typed;
    const path = resolve(this.app, file);
    const rel = relative(this.app, path);
    if (isAbsolute(file) || rel.startsWith('..') || isAbsolute(rel))
      throw new RequestError(`file must be a path inside the app folder, got "${file}"`);
    const parts = rel.split(sep);
    if (basename(rel).startsWith('.'))
      throw new RequestError(
        `"${file}" has no file name`,
        'Name the file (booking/appointments.md), or give only the folder (booking/) to name it after the case.',
      );
    if (
      !rel.endsWith('.md') ||
      NOT_TESTS.test(basename(rel)) ||
      parts
        .slice(0, -1)
        .some((p) => p === 'docs' || p === 'reports' || p === 'node_modules' || p.startsWith('.'))
    )
      throw new RequestError(
        `"${file}" is not a test file the parser reads`,
        'Use a .md file in the app folder, not README.md, AGENTS.md or CLAUDE.md and not under docs/, reports/, node_modules/ or a hidden folder.',
      );
    return { path, rel };
  }

  // ---- browser session -----------------------------------------------------------------------------------------

  /**
   * The origin of a `start` request's `baseUrl`: an absolute http(s) address without credentials. Launcher sends the
   * running environment the person picked; the agent's start carries none and follows that choice.
   */
  private static baseOrigin(value: unknown): string {
    const problem = new RequestError(
      'baseUrl must be an absolute http:// or https:// address, or null for the default',
      'Example: "http://localhost:4200".',
    );
    if (typeof value !== 'string') throw problem;
    let url: URL;
    try {
      url = new URL(value.trim());
    } catch {
      throw problem;
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw problem;
    return url.origin;
  }

  /** BASE_URL, or the app config's webServer URL, starting that server when it is not answering yet. */
  private async baseURL(): Promise<string> {
    if (this.profileBase) return this.profileBase;
    const server = appConfig.webServer;
    if (!server)
      throw new RequestError(
        'BASE_URL is not set (environment or app profile) and the app config has no webServer',
      );
    if (await reachable(server.url)) return server.url;
    if (!this.server) {
      this.event('info', `starting the app's webServer for ${server.url}`);
      // Like Playwright's webServer: a shell command, run from the engine's config folder.
      const child = spawn(server.command, {
        shell: true,
        cwd: ENGINE_DIR,
        env: { ...process.env, ...server.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
      child.stdout?.on('data', (bytes: Buffer) => process.stderr.write(bytes));
      child.stderr?.on('data', (bytes: Buffer) => process.stderr.write(bytes));
      child.once('exit', () => {
        if (this.server === child) this.server = null;
      });
      child.once('error', (error) => this.event('error', `webServer: ${message(error)}`));
      this.server = child;
    }
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (await reachable(server.url)) return server.url;
      if (!this.server)
        throw new RequestError(`the app's webServer exited before ${server.url} answered`);
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new RequestError(`the app's webServer did not answer at ${server.url} within 60 s`);
  }

  private stopServer(): void {
    const child = this.server;
    this.server = null;
    if (!child || child.exitCode !== null || !child.pid) return;
    try {
      if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
      else child.kill();
    } catch {
      child.kill();
    }
  }

  private async start(baseUrl: unknown): Promise<DevelopResults['start']> {
    // Checked before anything changes: a refused address leaves an open session as it is.
    if (baseUrl === null) this.chosenBase = null;
    else if (baseUrl !== undefined) this.chosenBase = DevelopSession.baseOrigin(baseUrl);
    if (this.context) await this.closeContext();
    this.setState('starting');
    try {
      const loaded = this.loaded;
      const unparsed =
        loaded && !loaded.parsed ? loaded : this.block && !this.block.parsed ? this.block : null;
      if (unparsed)
        throw new RequestError(
          `the app does not parse: ${unparsed.error}`,
          'Fix the file, then start again.',
        );
      const baseURL = this.chosenBase ?? (await this.baseURL());
      // Seeds (seedContext), `switch to session` API logins (steps.ts) and app hooks read BASE_URL: for this process
      // it is the session's base, so they reach the environment the browser opened, not the profile's.
      process.env.BASE_URL = baseURL;
      this.event('info', `opening ${baseURL}`);
      if (!this.browser?.isConnected()) {
        this.browser = await chromium.launch({ headless: !this.headed });
        this.browser.on('disconnected', () => {
          if (this.closing) return;
          this.browser = null;
          void this.closeContext().then(() =>
            this.setState('closed', { error: 'the browser closed' }),
          );
        });
      }
      // As playwright.intent.config.ts builds a test's browser: env > app config > Desktop Chrome.
      const size = process.env.VIEWPORT?.match(/^(\d+)x(\d+)$/);
      const viewport = size
        ? { width: Number(size[1]), height: Number(size[2]) }
        : appConfig.viewport;
      const timezone = process.env.TIMEZONE || appConfig.timezone;
      const { defaultBrowserType: _browserType, ...desktop } = devices['Desktop Chrome'];
      this.contextOptions = {
        ...desktop,
        ...(viewport ? { viewport } : {}),
        ...(timezone ? { timezoneId: timezone } : {}),
        baseURL,
        ignoreHTTPSErrors: process.env.IGNORE_HTTPS_ERRORS === 'true',
      };
      const context = await this.newContext();
      this.context = context;
      const page = await context.newPage();
      this.page = page;
      page.on('close', () => {
        if (this.page !== page || this.closing) return;
        void this.closeContext().then(() =>
          this.setState('closed', { error: 'the browser page was closed' }),
        );
      });
      this.runner = new StepRunner(page, this.testContext, {});
      this.view = new PageView(page, async (frame) => {
        this.emit({ event: 'frame', ...frame });
        await this.drained();
      });
      const test = loaded?.parsed;
      if (test?.session) await this.logIn(test.session, page, baseURL);
      if (test?.seed) await this.seed(test);
      // A loaded block opens the context bare, except a login block (the one a `session:` logs in with), which logs in.
      const block = this.block?.parsed;
      if (block && credentialsOf(block.steps)) await this.logIn(block.name, page, baseURL);
      const variables = this.emitVariables();
      if (this.screencast) await this.view.startScreencast(this.screencast);
      if (this.recordingWanted) await this.startRecorder();
      this.setState('ready', { url: page.url() });
      return { url: page.url(), variables };
    } catch (error) {
      this.setState('failed', { error: message(error) });
      throw error;
    }
  }

  /** A context like a test's, with the saved-click-listener init script. */
  private async newContext(): Promise<BrowserContext> {
    const context = await this.browser!.newContext(this.contextOptions);
    // As in runs: actionTimeout 5 s.
    context.setDefaultTimeout(5_000);
    context.setDefaultNavigationTimeout(30_000);
    await context.addInitScript(recordClickListeners, CLICK_LISTENERS);
    return context;
  }

  /** The case's `session:`: an API login for a plain login block when the app has one, else the block's steps. */
  private async logIn(session: string, page: Page, baseURL: string): Promise<void> {
    const creds = apiLoginCredentials(session);
    if (creds) {
      this.event('info', `logging in as ${creds.username} (API)`);
      await apiLogin(page.context(), baseURL, creds);
      // As the session setup does: load the app once so it sets up its local storage.
      await page.goto(authHook()!.homePath);
      await page.waitForURL((url) => !url.pathname.endsWith('/login'), { timeout: 30_000 });
      return;
    }
    const block = this.suite!.blocks.get(session)!;
    this.event('info', `running session "${session}" (${block.steps.length} steps)`);
    try {
      await this.runBlock(block.steps, this.runner!);
    } catch (error) {
      throw new RequestError(`session "${session}" failed: ${message(error)}`);
    }
    if (freshCookiesFor(session)) await startFresh(page, session);
  }

  private async runBlock(steps: ParsedStep[], runner: StepRunner): Promise<void> {
    try {
      for (const step of steps) await runner.run(step);
    } finally {
      runner.records.length = 0;
    }
  }

  private async seed(test: TestCase): Promise<void> {
    const name = test.seed!;
    const { ctx, dispose } = seedContext(
      (line) => this.event('info', `[seed ${name}] ${line}`),
      testIdFromFile(test.file),
      test.parameters?.values,
    );
    this.seedRun = { name, dispose };
    try {
      const result = await this.seeds![name].run(ctx);
      this.seedRun.cleanup = result.cleanup;
      this.runner!.seedVars = result.vars;
    } catch (error) {
      throw new RequestError(`seed "${name}" failed: ${message(error)}`);
    }
  }

  /**
   * `switch to session "<name>"` reads the state a session's setup saved. A run's setup project saves it; here the
   * block runs once in its own context of the same browser (login blocks with an API login need nothing).
   */
  private async prepareSwitches(steps: ParsedStep[]): Promise<void> {
    for (const step of steps) {
      if (step.kind !== 'switch' || this.savedSessions.has(step.session)) continue;
      if (apiLoginCredentials(step.session)) continue;
      const block = this.suite?.blocks.get(step.session);
      if (!block) throw new RequestError(`session "${step.session}" is not defined`);
      this.event('info', `preparing session "${step.session}" for the switch`);
      const context = await this.newContext();
      try {
        const page = await context.newPage();
        const context2 = new DevelopTestContext(
          `Session: ${step.session}`,
          `session:develop:${step.session}`,
        );
        await this.runBlock(block.steps, new StepRunner(page, context2, {}));
        const path = sessionFile(step.session);
        mkdirSync(dirname(path), { recursive: true });
        await context.storageState({ path });
        this.savedSessions.add(step.session);
      } catch (error) {
        throw new RequestError(`session "${step.session}" failed: ${message(error)}`);
      } finally {
        await context.close().catch(() => undefined);
      }
    }
  }

  /** Seed cleanup, recorder, screencast and context; the browser and web server stay unless `stop` closes them. */
  private async closeContext(): Promise<void> {
    const recorder = this.recorder;
    this.recorder = null;
    await recorder?.stop().catch(() => undefined);
    const view = this.view;
    this.view = null;
    await view?.close();
    const seed = this.seedRun;
    this.seedRun = null;
    if (seed?.cleanup && process.env.AT_KEEP_SEED !== 'true')
      await seed
        .cleanup()
        .catch((error) =>
          this.event('warn', `seed ${seed.name} cleanup failed: ${message(error)}`),
        );
    await seed?.dispose().catch(() => undefined);
    const context = this.context;
    this.context = null;
    this.page = null;
    this.runner = null;
    this.variablesSent = null;
    this.lastRecords.clear();
    await context?.close().catch(() => undefined);
  }

  /** `stop`: seed cleanup, closes the context, the browser and the web server. The process keeps running. */
  async stop(): Promise<void> {
    this.closing = true;
    try {
      await this.closeContext();
      const browser = this.browser;
      this.browser = null;
      await browser?.close().catch(() => undefined);
      this.stopServer();
      this.savedSessions.clear();
    } finally {
      this.closing = false;
    }
    this.setState('closed');
  }

  /** Closes everything for exit (stdin EOF, SIGINT, SIGTERM). */
  async close(): Promise<void> {
    await this.stop().catch(() => this.stopServer());
  }

  private requirePage(): Page {
    if (!this.page) throw new RequestError('the browser session is not open', 'Send start first.');
    return this.page;
  }

  // ---- steps ---------------------------------------------------------------------------------------------------

  /** The parsed steps and runner, for running and verifying: the loaded block's when one is loaded, else the case's. */
  private runnable(): Runnable {
    const block = this.block;
    const what = block ? 'block' : 'case';
    const target = block ?? this.requireLoaded();
    if (!target.parsed)
      throw new RequestError(
        `the app does not parse: ${target.error}`,
        'Fix the file (edit_step, insert_step), then run again.',
      );
    // A draft may be empty; there is nothing to run or verify until its first step is written.
    const own = block ? block.block.steps : (target as Loaded).case.steps;
    if (own.length === 0)
      throw new RequestError(
        `the ${what} has no steps yet`,
        'Add the first step with insert_step at index 0.',
      );
    if (!this.runner)
      throw new RequestError('the browser session is not open', 'Send start first.');
    return { what, parsed: target.parsed, own, runner: this.runner };
  }

  /** The own steps of what is loaded, as written (none while nothing is). */
  private ownSteps(): DevelopStep[] {
    return this.block?.block.steps ?? this.loaded?.case.steps ?? [];
  }

  /** The parsed steps own step `position` runs (several for a `use` step). */
  private stepsOf({ what, parsed, own }: Runnable, position: number): ParsedStep[] {
    const count = own.length;
    if (position >= count)
      throw new RequestError(
        `step index ${position} is out of range (the ${what} has ${count} steps)`,
      );
    const label = String(position + 1);
    return parsed.steps.filter((s) => s.label === label || s.label.startsWith(`${label}.`));
  }

  /**
   * Runs `work` (an engine action on the page) with the recorder paused, so the engine's own clicks and navigations are
   * not recorded as the person's.
   */
  private async paused<T>(work: () => Promise<T>): Promise<T> {
    const recorder = this.recordingWanted ? this.recorder : null;
    await recorder?.stop();
    try {
      return await work();
    } finally {
      if (recorder && this.recordingWanted && this.recorder === recorder)
        await recorder.start().catch((error) => this.event('warn', `recorder: ${message(error)}`));
    }
  }

  private runStep(position: number): Promise<DevelopStepRecord> {
    return this.paused(() => this.runOwnStep(position));
  }

  private async runOwnStep(position: number): Promise<DevelopStepRecord> {
    const runnable = this.runnable();
    const { runner } = runnable;
    const steps = this.stepsOf(runnable, position);
    const page = this.page;
    const activity = page ? pageActivity(page) : null;
    activity?.reset();
    this.emit({ event: 'step.started', index: position });
    const records: StepRecord[] = [];
    let offered: { id: string; description: string }[] = [];
    let thrown: unknown;
    try {
      await this.prepareSwitches(steps);
      for (const step of steps) {
        this.testContext.clear();
        try {
          await runner.run(step);
        } finally {
          const attached = this.testContext.attachments.find(
            (a) => a.name === `at-step-${step.number}`,
          );
          if (attached) records.push(JSON.parse(attached.body) as StepRecord);
          offered = runner.offered;
          // The records are kept here; the runner's list would grow with every screenshot.
          runner.records.length = 0;
        }
      }
    } catch (error) {
      thrown = error;
    }
    const record = developRecord(
      position,
      records,
      offered,
      thrown,
      await this.afterStep(page, activity),
    );
    this.lastRecords.set(position, record);
    this.emit({ event: 'step.finished', index: position, record });
    this.emitVariablesIfChanged();
    return record;
  }

  /** The screenshot after a step and what the page reported during it (section 3.6); a failed capture is left out. */
  private async afterStep(
    page: Page | null,
    activity: PageActivityCollector | null,
  ): Promise<{ after?: string; page?: PageActivity }> {
    const after = page ? await afterShot(page) : undefined;
    return { ...(after ? { after } : {}), ...(activity ? { page: activity.take() } : {}) };
  }

  private async runFrom(
    position: number,
  ): Promise<{ records: DevelopStepRecord[]; stoppedAt?: number }> {
    this.stepsOf(this.runnable(), position);
    return this.paused(async () => {
      const records: DevelopStepRecord[] = [];
      for (let i = position; i < this.ownSteps().length; i++) {
        const record = await this.runOwnStep(i);
        records.push(record);
        if (record.status === 'failed') return { records, stoppedAt: i };
      }
      return { records };
    });
  }

  // ---- variables (section 3.6) ---------------------------------------------------------------------------------

  /** What `{{seed.*}}`, `{{saved.*}}` and `{{param.*}}` stand for now, masked and cut; all empty while closed. */
  private variables(): SessionVariables {
    const runner = this.runner;
    if (!runner) return sessionVariables({});
    return sessionVariables({
      seed: runner.seedVars,
      saved: runner.saved,
      param: this.loaded?.case.parameters,
    });
  }

  private emitVariables(): SessionVariables {
    const variables = this.variables();
    this.variablesSent = JSON.stringify(variables);
    this.emit({ event: 'variables', variables });
    return variables;
  }

  /** After an own step: the `variables` event again when a value changed (a `call … and save`). */
  private emitVariablesIfChanged(): void {
    if (this.runner && JSON.stringify(this.variables()) !== this.variablesSent)
      this.emitVariables();
  }

  private async verifyStep(position: number, value?: string): Promise<Verification> {
    const runnable = this.runnable();
    const { parsed, own, runner } = runnable;
    let step: ParsedStep;
    if (value !== undefined) {
      const written = own[position];
      if (position > own.length) throw new RequestError(`step index ${position} is out of range`);
      step = stepFrom(
        this.checkStep(value),
        position + 1,
        parsed.file,
        written?.line ?? parsed.line,
      );
      if (parsed.parameters) step = bindStepParams(step, parsed.parameters.values);
    } else {
      const steps = this.stepsOf(runnable, position);
      if (steps.length !== 1 || steps[0].label !== String(position + 1))
        throw new RequestError(
          `step ${position + 1} is a "use" step`,
          "Verify the block's steps by passing their text, or run the step with run_step.",
        );
      step = steps[0];
    }
    if (!ELEMENT_KINDS.includes(step.kind))
      throw new RequestError(
        `verify_step resolves the element of click, fill, select, check and uncheck steps; this is a ${step.kind} step`,
        'Run it with run_step instead.',
      );
    const result = await runner.verify(step);
    return verification(result);
  }

  /**
   * Pick: the element at a viewport point (the frame of reference of `input`) with the wording the recorder would
   * write for it and steps to insert. Found and described by the same classification as a snapshot; no decider call.
   */
  private async describePoint(x: unknown, y: unknown): Promise<PointDescription> {
    const page = this.requirePage();
    if (!finite(x) || !finite(y))
      throw new RequestError(
        'x and y must be numbers (viewport CSS pixels)',
        'The same frame of reference as input and frame.viewport.',
      );
    const hit = (await page.evaluate(pointScript(x, y))) as PointHit | null;
    return pointDescription(hit);
  }

  /**
   * Quick fix: own step `position` rewritten to target an element, with the recorder's wording (`suggestedStep`).
   * For an element step the id comes from the step's last record in this session and must still name the element
   * that record described (ids are positions in a snapshot); for an expect, whose record lists no elements, from the
   * current page. Nothing is saved: the person or agent applies the text with `edit_step`.
   */
  private async suggestStep(position: number, elementId: string): Promise<{ text: string }> {
    const runnable = this.runnable();
    this.stepsOf(runnable, position);
    const written = runnable.own[position];
    if (!SUGGEST_KINDS.includes(written.kind))
      throw new RequestError(
        `suggest_step rewrites ${SUGGEST_KINDS.join(', ')} steps; step ${position + 1} is a ${written.kind} step`,
        'Edit it with edit_step.',
      );
    const page = this.requirePage();
    let described: string | undefined;
    if (written.kind !== 'expect') {
      const record = this.lastRecords.get(position);
      if (!record)
        throw new RequestError(
          `step ${position + 1} has not run in this session`,
          "Run it with run_step, then take an element id from its record's top or candidates.",
        );
      described = [...(record.top ?? []), ...(record.candidates ?? [])].find(
        (item) => item.id === elementId && item.id !== 'none',
      )?.description;
      if (described === undefined)
        throw new RequestError(
          `${JSON.stringify(elementId)} is not an element of step ${position + 1}'s last run`,
          "Take an id from the record's top or candidates (not none).",
        );
    }
    const snap = await snapshot(page);
    const element = snap.elements.find((item) => item.id === elementId);
    if (!element || (described !== undefined && describe(element) !== described))
      throw new RequestError(
        `element ${elementId} is no longer on the page`,
        'The page changed; run the step again.',
      );
    const suggestion = suggestedStep(written.text, element, snap.dialog, this.variables());
    if ('error' in suggestion) throw new RequestError(suggestion.error, suggestion.hint);
    return { text: this.checkStep(suggestion.text) };
  }

  // ---- page ----------------------------------------------------------------------------------------------------

  private async snapshot(): Promise<SnapshotResult> {
    const snap = await snapshot(this.requirePage());
    return {
      url: snap.url,
      title: snap.title,
      dialog: snap.dialog,
      headings: snap.headings,
      elements: snap.elements.map((e) => ({ id: e.id, kind: e.kind, description: describe(e) })),
    };
  }

  // ---- step text across the app (docs/develop-mode.md, section 3.6) ---------------------------------------------

  /**
   * Every case's own steps as written, in file order: from the parsed app (a template once, as its first row), or
   * from the files' sections when the app does not parse.
   */
  private async writtenCases(): Promise<
    { caseId: string; name: string; file: string; steps: StepMatch[] }[]
  > {
    let suite: TestSuite | null = null;
    try {
      suite = await this.parse();
    } catch (error) {
      if (!(error instanceof ParseError)) throw error;
    }
    const steps = (caseId: string, name: string, file: string, found: Section | null) =>
      (found?.steps ?? []).map((step, index) => ({
        caseId,
        name,
        file,
        line: step.line,
        index,
        text: step.text,
      }));
    const out: { caseId: string; name: string; file: string; steps: StepMatch[] }[] = [];
    if (suite) {
      for (const entry of suite.files) {
        const content = readFileSync(entry.path, 'utf8');
        const seen = new Set<string>();
        for (const test of entry.cases) {
          const id = sectionId(test);
          if (seen.has(id)) continue;
          seen.add(id);
          const found = findSection(content, id);
          out.push({
            caseId: test.explicitId,
            name: test.name,
            file: test.file,
            steps: steps(test.explicitId, test.name, test.file, found),
          });
        }
      }
      return out;
    }
    for (const path of findTestFiles(this.app)) {
      const file = relative(this.app, path);
      for (const found of sections(readFileSync(path, 'utf8')))
        if (found.id)
          out.push({
            caseId: found.id,
            name: found.name,
            file,
            steps: steps(found.id, found.name, file, found),
          });
    }
    return out;
  }

  /** The own steps whose text contains `query`, ignoring case: at most 200, in file order. */
  private async searchSteps(query: string): Promise<DevelopResults['search_steps']> {
    if (!query.trim()) throw new RequestError('query must not be empty');
    const needle = query.toLowerCase();
    const matches: StepMatch[] = [];
    for (const item of await this.writtenCases())
      for (const step of item.steps)
        if (step.text.toLowerCase().includes(needle)) {
          matches.push(step);
          if (matches.length === MAX_STEP_MATCHES) return { matches };
        }
    return { matches };
  }

  /**
   * Renames a quoted label in every step of the app (own steps and `## Steps:` blocks): lists the changes, and with
   * `apply` writes them (`replaceQuoted`), parses the app again and emits `case.updated` when the loaded case changed.
   */
  private async replaceText(
    from: string,
    to: string,
    apply: unknown,
  ): Promise<DevelopResults['replace_text']> {
    if (apply !== undefined && typeof apply !== 'boolean')
      throw new RequestError('apply must be true or false');
    const changes: TextChange[] = [];
    const writes: { path: string; file: string; next: string }[] = [];
    try {
      for (const path of findTestFiles(this.app)) {
        const content = readFileSync(path, 'utf8');
        const found = quotedChanges(content, from, to);
        if (!found.length) continue;
        const file = relative(this.app, path);
        for (const change of found) changes.push({ file, ...change });
        if (apply) writes.push({ path, file, next: replaceQuoted(content, from, to) });
      }
    } catch (error) {
      if (error instanceof EditError) throw new RequestError(error.message);
      throw error;
    }
    if (!writes.length) return { changes, applied: false };
    const written: string[] = [];
    for (const { path, file, next } of writes) {
      try {
        writeFileSync(path, next);
      } catch (error) {
        throw new RequestError(
          `could not save ${file}: ${message(error)}`,
          written.length ? `Already renamed in ${written.join(', ')}.` : undefined,
        );
      }
      written.push(file);
    }
    this.log(
      `[develop] renamed "${from}" to "${to}" in ${changes.length} step(s) of ${written.length} file(s)`,
    );
    try {
      await this.parse();
    } catch (error) {
      if (!(error instanceof ParseError)) throw error;
      this.event('warn', `the app no longer parses after the rename: ${error.message}`);
    }
    const loaded = this.loaded;
    if (loaded) {
      let next: Loaded | null = null;
      try {
        next = await this.read(loaded.caseId);
      } catch (error) {
        this.event('warn', `could not reload ${loaded.caseId}: ${message(error)}`);
      }
      if (next && JSON.stringify(next.case) !== JSON.stringify(loaded.case)) {
        this.loaded = next;
        const update: CaseUpdate = {
          case: next.case,
          file: next.file,
          saved: true,
          ...(next.error ? { error: next.error } : {}),
        };
        this.emit({ event: 'case.updated', ...update });
      }
    }
    return { changes, applied: true };
  }

  private async navigate(path: string): Promise<{ url: string }> {
    const page = this.requirePage();
    await this.paused(() => page.goto(path));
    return { url: page.url() };
  }

  private async setScreencast(
    enabled: unknown,
    maxWidth: unknown,
    quality: unknown,
  ): Promise<object> {
    if (typeof enabled !== 'boolean') throw new RequestError('enabled must be true or false');
    if (!enabled) {
      this.screencast = null;
      await this.view?.stopScreencast();
      return {};
    }
    const width = maxWidth === undefined ? 1280 : maxWidth;
    const q = quality === undefined ? 60 : quality;
    if (!Number.isInteger(width) || (width as number) < 100 || (width as number) > 4096)
      throw new RequestError('maxWidth must be a whole number from 100 to 4096');
    if (!Number.isInteger(q) || (q as number) < 1 || (q as number) > 100)
      throw new RequestError('quality must be a whole number from 1 to 100');
    this.screencast = { maxWidth: width as number, quality: q as number };
    // Without an open session, it starts with the next `start`.
    await this.view?.startScreencast(this.screencast);
    return {};
  }

  private async input(event: unknown): Promise<object> {
    const problem = inputProblem(event);
    if (problem) throw new RequestError(`input: ${problem}`);
    this.requirePage();
    await this.view!.input(event as InputEvent);
    return {};
  }

  // ---- recording -----------------------------------------------------------------------------------------------

  private async record(enabled: unknown): Promise<object> {
    if (typeof enabled !== 'boolean') throw new RequestError('enabled must be true or false');
    if (!enabled) {
      this.recordingWanted = false;
      await this.recorder?.stop();
      return {};
    }
    this.requirePage();
    this.recordingWanted = true;
    try {
      await this.startRecorder();
    } catch (error) {
      this.recordingWanted = false;
      throw error;
    }
    return {};
  }

  /** One Recorder per page, kept while the page lives (its binding and init script cannot be removed). */
  private async startRecorder(): Promise<void> {
    if (!this.page) return;
    this.recorder ??= new Recorder(this.page, (step) => this.onRecorded(step));
    await this.recorder.start();
  }

  /** A recorded step goes out at once, then is checked through the resolver (record, then verify). */
  private onRecorded(recorded: RecordedStep): void {
    // The seed makes new data every run: a recorded value that is one of the session's values is written as it.
    const text = withVariables(recorded.text, recorded.kind, this.variables());
    const step = text === recorded.text ? recorded : { ...recorded, text };
    this.recorded.push(step);
    this.emit({ event: 'recorded', step });
    this.enqueue(async () => {
      let result: { chosenId?: string; confidence?: number; matches: boolean; reason?: string };
      try {
        result = await this.verifyRecorded(step);
      } catch (error) {
        result = { matches: false, reason: message(error) };
      }
      this.emit({ event: 'recorded.verified', at: step.at, verification: result });
    });
  }

  private async verifyRecorded(
    step: RecordedStep,
  ): Promise<{ chosenId?: string; confidence?: number; matches: boolean; reason?: string }> {
    if (!ELEMENT_KINDS.includes(step.kind))
      return { matches: true, reason: `a ${step.kind} step has no element to resolve` };
    const runner = this.runner;
    if (!runner) return { matches: false, reason: 'the browser session closed' };
    const file = this.loaded?.file ?? this.block?.file ?? 'recording';
    let parsed: ParsedStep;
    try {
      parsed = stepFrom(step.text, 0, file, 0);
    } catch (error) {
      // A password field records `{{PASSWORD}}`; the value is not needed to find the field.
      if (!(error instanceof ParseError) || !/environment variable/.test(error.message))
        throw error;
      parsed = stepFrom(step.text.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, '$1'), 0, file, 0);
    }
    const result = await runner.verify(parsed);
    const chosen = result.chosen;
    const matches = !!chosen && !!step.elementId && chosen.id === step.elementId;
    return {
      ...(chosen ? { chosenId: chosen.id, confidence: chosen.confidence } : {}),
      matches,
      ...(matches
        ? {}
        : {
            reason: chosen
              ? `the step resolves to ${chosen.id} (${chosen.description}), not the recorded ${step.elementId ?? 'element'}`
              : (result.reason ?? 'nothing was chosen'),
          }),
    };
  }

  /** For tests and the CLI: the session's state. */
  get sessionState(): SessionState {
    return this.state;
  }
}

function verification(result: Awaited<ReturnType<StepRunner['verify']>>): Verification {
  const confidence = result.chosen?.confidence ?? result.top[0]?.p;
  return {
    ...(result.chosen ? { chosen: result.chosen } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    top: result.top,
    candidates: result.candidates,
    ...(result.reason ? { reason: result.reason } : {}),
  };
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new RequestError(`${name} must be a string`);
  return value;
}

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

function index(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0)
    throw new RequestError('index must be a whole number from 0');
  return value as number;
}
