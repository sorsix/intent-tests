// Executes parsed steps: snapshot → ask the decision model → act with Playwright → record everything.
import type { Locator, Page, Request } from '@playwright/test';
import type { StepTestInfo } from './develop/test-context.ts';
import { failureFor, markFailure } from './failure.ts';
import type { Failure, FailureKind } from './failure.ts';
import { config } from './config.ts';
import { getDecider, type DecisionCall } from './decider/index.ts';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { appDir } from './app.ts';
import { notShownStatement, type ParsedStep } from './parse.ts';
import { apiLogin, apiLoginCredentials, freshCookiesFor, startFresh } from './login.ts';
import { sessionFile } from './paths.ts';
import { bindSeedVars } from './seeds.ts';
import { decisionCaptureWarnings, setDecisionContext } from './decider/log.ts';
import { pagePath, ROW_CLICK_BOOKKEEPING } from './row-click.ts';
import { mentionsColour } from './colour.ts';
import {
  describe,
  OPTION_SELECTOR,
  pageColours,
  pageText,
  snapshot,
  type ElementKind,
  type PageText,
  type SnapElement,
} from './snapshot.ts';

export type Ranked = { id: string; p: number; description: string };

/** What `StepRunner.verify` found: the element a run would act on, without acting. */
export type StepVerification = {
  chosen?: { id: string; description: string; confidence: number };
  /** The model's ranked answers, best first. */
  top: Ranked[];
  /** The elements offered as answer options in the last question. */
  candidates: { id: string; description: string }[];
  /** Why nothing was chosen. */
  reason?: string;
  calls: DecisionCall[];
};

type ElementStepKind = 'click' | 'fill' | 'select' | 'check' | 'uncheck' | 'upload';
/** What `resolve` looks for: an element step's element, or the two ends of a `drag` (the dragged element, the slot). */
type ResolveKind = ElementStepKind | 'drag' | 'drop';

export type StepRecord = {
  number: number;
  /** "3" or "3.2" for a step that comes from a `use`d block. */
  label: string;
  file: string;
  line: number;
  text: string;
  kind: ParsedStep['kind'];
  status: 'passed' | 'failed';
  durationMs: number;
  /** Time spent in decision-model calls. */
  modelMs: number;
  inputTokens: number;
  calls: DecisionCall[];
  /** Element the step acted on. */
  chosen?: { id: string; description: string; confidence: number };
  /** Set when the element was found among a shorter list, e.g. `3 of 120 elements, by "Arrive"`. */
  narrowed?: string;
  /** AT_DECIDER_IMAGES=fallback: the element was resolved by the second question, the one with a screenshot. */
  screenshotFallback?: boolean;
  /** Top options from the last Choice call (for the report). For `drag`: the dragged element's question. */
  top?: Ranked[];
  /** `drag`: the drop slot it was dropped on (`chosen` is the dragged element). */
  dropTarget?: { id: string; description: string; confidence: number };
  /** `drag`: top options of the drop slot's question. */
  dropTop?: Ranked[];
  /** `drag`: how the drop slots were narrowed, e.g. `1 of 420 drop slots, by "Tue 03 Nov 11:30 AM", "Dr Smith"`. */
  dropNarrowed?: string;
  /** For an optional step with an "only if …" condition that held: how it was checked. */
  condition?: string;
  /** Human-readable result, e.g. "yes 0.94 ≥ 0.80". */
  outcome?: string;
  error?: string;
  failure?: Failure;
  /** Base64 JPEG. For actions: taken just before acting, with the target outlined. */
  screenshot?: string;
  /** Once the test has switched windows: the session whose window the step started in. */
  window?: string;
};

const KINDS: Record<ResolveKind, ElementKind[]> = {
  // drag/drop also take ordinary elements flagged `draggable` / `drop` (see `accepts` in resolve)
  drag: ['draggable'],
  drop: ['slot'],
  click: ['button', 'link', 'checkbox', 'radio'],
  fill: ['textbox'],
  select: ['select'],
  check: ['checkbox', 'radio'],
  uncheck: ['checkbox'],
  // A file input (or the label that opens a hidden one), or the button or link that opens the file picker.
  upload: ['file', 'button', 'link'],
};

/** How long an `upload` step waits for the file picker after clicking its target. */
const FILE_CHOOSER_TIMEOUT_MS = 5000;

const NONE = 'none';
/** How long a held drag waits for the page to uncover the drop slot before the step fails. */
const DRAG_UNCOVER_MS = 2000;
/**
 * A text-only "none" at least this sure isn't re-asked with a screenshot: the element isn't on the page (yet), and a
 * screenshot can't add one. A full suite run, 30 Oct 2026: all 86 such re-asks (P(none) 0.94-1.0) stayed "none"; the
 * fallback's 3 rescues all followed an unsure lean to an element.
 */
const CONFIDENT_NONE = 0.9;

/**
 * How to read the "#" lines of the page text (outline.ts), for yes/no questions (`expect` steps and conditions of
 * optional steps). Kept short and about headings only: a longer note that pointed the model at visibleText and tables
 * pulled checks of dialogs and fields down (a "dialog with a text field" check: 0.94 without a note, 0.69 with it).
 */
const PAGE_TEXT_NOTE =
  'In the page text, a line starting with "#" is a section heading; the lines after it belong to that section.';
const SCREENSHOT_NOTE =
  'The screenshot shows only the part of the page currently in view; elements and text listed here may be scrolled out of it.';
/** Sent only with a statement about colours (colour.ts `mentionsColour`), next to the page's `colours` list. */
const COLOURS_NOTE =
  'The page\'s "colours" list gives the background colour of each coloured area (a tile, a chip, a button, a row), by the text inside it, as a colour name and its exact value.';

/**
 * The note on the open dialog for a choice question. A dialog without a title is still open (snapshot gives ""): an app's
 * "Search Participant" and confirmation dialogs have none, and "No dialog is open" next to that dialog's buttons made
 * jev-1.14.0 doubt exact matches ("Yes": 0.64-0.72; 0.97-0.98 with this note).
 */
export function dialogNote(dialog: string | null): string {
  if (dialog === null) return 'No dialog is open.';
  return `A modal dialog${dialog ? ` "${dialog}"` : ''} is open; only its elements can be used.`;
}

/**
 * The state of a yes/no question about the page. `colours` (pageColours) is sent only for a statement about colours,
 * so every other question gets exactly the page text it always did.
 */
export function yesNoState(
  task: string,
  assertion: string,
  page: PageText,
  screenshot = false,
  colours?: string[],
) {
  return {
    task,
    assertion,
    notes: [
      PAGE_TEXT_NOTE,
      ...(screenshot ? [SCREENSHOT_NOTE] : []),
      ...(colours ? [COLOURS_NOTE] : []),
    ],
    page: colours ? { ...page, colours } : page,
  };
}

class StepFailure extends Error {
  constructor(message: string, kind: FailureKind = 'unknown') {
    super(message);
    markFailure(this, kind);
  }
}

/** The chosen element vanished before the action landed (e.g. a grid re-rendered its rows). */
class StaleElement extends Error {
  constructor(message: string) {
    super(message);
    markFailure(this, 'browser');
  }
}

function rank(
  probabilities: Record<string, number>,
  descriptions: Record<string, string>,
  n = 3,
): Ranked[] {
  return Object.entries(probabilities)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([id, p]) => ({ id, p, description: descriptions[id] ?? id }));
}

function formatTop(top: Ranked[]): string {
  return top
    .map((t) => `  ${(t.p * 100).toFixed(1).padStart(5)}%  ${t.id}: ${t.description}`)
    .join('\n');
}

/** The first "quoted" text in a step's target, e.g. `the "Arrive" action in the row for "…"` → `Arrive`. */
function quotedLabel(target: string): string | null {
  return target.match(/"([^"]+)"/)?.[1].trim() || null;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * The elements whose own name contains the step's quoted label (case and spacing ignored), or null when there is no
 * quoted label, nothing is named like it, or every element is. Fewer options let the model concentrate its
 * probability on the right one instead of spreading it over the whole page.
 */
function narrowByLabel(elements: SnapElement[], target: string): SnapElement[] | null {
  const label = quotedLabel(target);
  if (!label) return null;
  const want = norm(label);
  const hits = elements.filter((e) => norm(e.name).includes(want));
  if (hits.length === 0 || hits.length === elements.length) return null;
  return hits.slice(0, config.maxCandidates);
}

/** Every "quoted" text in a step's target, e.g. `the "Tue 03 Nov 11:30 AM" slot for "Dr Smith"` → both. */
function quotedLabels(target: string): string[] {
  return [...target.matchAll(/"([^"]+)"/g)].map((m) => m[1].trim()).filter(Boolean);
}

/**
 * `drag`'s drop slots whose label or section contains every quoted text of the target (case and spacing ignored).
 * Unlike `narrowByLabel` there is no fallback to the whole list: a slot is never chosen by anything but its name.
 */
function narrowByAllLabels(elements: SnapElement[], labels: string[]): SnapElement[] {
  const want = labels.map(norm);
  return elements.filter((e) => {
    const text = norm(`${e.name} ${e.section ?? ''}`);
    return want.every((w) => text.includes(w));
  });
}

/** Keep the candidates most likely to matter when a page has more than Choice allows. */
function limitCandidates(elements: SnapElement[], target: string): SnapElement[] {
  if (elements.length <= config.maxCandidates) return elements;
  const words = new Set(target.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const score = (e: SnapElement) =>
    (
      describe(e)
        .toLowerCase()
        .match(/[\p{L}\p{N}]+/gu) ?? []
    ).filter((w) => words.has(w)).length;
  return [...elements].sort((a, b) => score(b) - score(a)).slice(0, config.maxCandidates);
}

export class StepRunner {
  page: Page;
  /** Playwright's TestInfo in a run; a DevelopTestContext in `intent-test develop`. */
  testInfo: StepTestInfo;
  /** Values from the test's seed, used for `{{seed.<key>}}`. */
  seedVars: Record<string, string>;
  /** Values saved by `call … and save "<field>" as "<name>"`, used as `{{saved.<name>}}` in later steps. */
  saved: Record<string, string> = {};
  records: StepRecord[] = [];
  /** The elements offered as answer options by the last element question (develop mode shows them). */
  offered: { id: string; description: string }[] = [];
  /** Each window's API calls (fetch / XHR) still in flight, with when they started. */
  private inFlight = new WeakMap<Page, Map<Request, number>>();
  /**
   * `switch to window`: the test's windows by session name, the first one under the test's `session:`. Empty for a
   * test that never switches windows (and in develop mode, where `openWindow` is not set).
   */
  windows = new Map<string, Page>();
  /** The window the steps run in, once the test has more than one. */
  window?: string;
  /** Opens a separate window logged in as a session; set by the runner of a test that can have windows. */
  openWindow?: (session: string) => Promise<Page>;
  /** The test's own session, the name of its first window. */
  firstWindow?: string;

  constructor(page: Page, testInfo: StepTestInfo, seedVars: Record<string, string> = {}) {
    this.page = page;
    this.testInfo = testInfo;
    this.seedVars = seedVars;
    this.watch(page);
  }

  /** The current window's API calls still in flight: a background window's polling never holds up a step. */
  private get pending(): Map<Request, number> {
    return this.inFlight.get(this.page)!;
  }

  private watch(page: Page): void {
    const pending = new Map<Request, number>();
    this.inFlight.set(page, pending);
    const api = (r: Request) => r.resourceType() === 'fetch' || r.resourceType() === 'xhr';
    page.on('request', (r) => {
      if (api(r)) pending.set(r, Date.now());
    });
    page.on('requestfinished', (r) => void pending.delete(r));
    page.on('requestfailed', (r) => void pending.delete(r));
  }

  /** `switch to window "<session>"`: makes that session's window current, opening it the first time. */
  private async switchWindow(session: string, rec: StepRecord): Promise<void> {
    if (!this.openWindow || !this.firstWindow)
      throw new StepFailure(
        'switch to window is not available here: it runs only in a test run, from a test with a "session:" line',
      );
    if (this.windows.size === 0) this.windows.set(this.firstWindow, this.page);
    let page = this.windows.get(session);
    const opened = !page;
    if (!page) {
      page = await this.openWindow(session);
      this.watch(page);
      this.windows.set(session, page);
    }
    this.page = page;
    this.window = session;
    await page.bringToFront();
    rec.outcome = opened
      ? `opened a new window as session "${session}"`
      : `back in the window of session "${session}" (${pagePath(page.url())})`;
  }

  /** Fills `{{seed.<key>}}` in every text field of the step. */
  private bind(step: ParsedStep): ParsedStep {
    const where = `${step.file}:${step.line}`;
    const out: Record<string, unknown> = { ...step };
    for (const k of [
      'text',
      'path',
      'source',
      'target',
      'value',
      'option',
      'assertion',
      'session',
    ] as const) {
      if (typeof out[k] === 'string')
        out[k] = this.bindSaved(bindSeedVars(out[k] as string, this.seedVars, where), where);
    }
    return out as ParsedStep;
  }

  /** Replaces `{{saved.<name>}}` with a value saved by an earlier `call … and save` step. */
  private bindSaved(s: string, where: string): string {
    return s.replace(/\{\{\s*saved\.([A-Za-z0-9_]+)\s*\}\}/g, (_, name) => {
      if (!(name in this.saved))
        throw new StepFailure(
          `${where}: {{saved.${name}}} has not been saved by an earlier "call … and save" step`,
        );
      return this.saved[name];
    });
  }

  async run(rawStep: ParsedStep): Promise<void> {
    const step = this.bind(rawStep);
    const rec: StepRecord = {
      number: step.number,
      label: step.label,
      file: step.file,
      line: step.line,
      text: step.text,
      kind: step.kind,
      status: 'passed',
      durationMs: 0,
      modelMs: 0,
      inputTokens: 0,
      calls: [],
    };
    const t0 = performance.now(),
      captureWarningsBefore = decisionCaptureWarnings();
    if (this.window) rec.window = this.window;
    this.offered = [];
    this.setContext(step);
    try {
      await this.execute(step, rec);
      if (!rec.screenshot) rec.screenshot = await this.shot();
    } catch (e) {
      rec.status = 'failed';
      rec.error = e instanceof Error ? e.message : String(e);
      rec.failure = failureFor(e);
      rec.screenshot ??= await this.shot().catch(() => undefined);
      throw e;
    } finally {
      rec.durationMs = Math.round(performance.now() - t0);
      rec.modelMs = rec.calls.reduce((n, c) => n + c.latencyMs, 0);
      rec.inputTokens = rec.calls.reduce((n, c) => n + c.inputTokens, 0);
      this.records.push(rec);
      setDecisionContext(null);
      await this.testInfo.attach(`at-step-${step.number}`, {
        body: JSON.stringify(rec),
        contentType: 'application/json',
      });
      if (decisionCaptureWarnings() > captureWarningsBefore)
        await this.testInfo
          .attach('at-capture-warning', {
            body: 'Some original decision records could not be captured.',
            contentType: 'text/plain',
          })
          .catch(() => undefined);
    }
  }

  private setContext(step: ParsedStep): void {
    setDecisionContext({
      test: this.testInfo.title,
      file: step.file,
      line: step.line,
      step: step.number,
      stepText: step.text,
      clientTestId:
        this.testInfo.annotations.find((a) => a.type === 'at-client-test-id')?.description ??
        this.testInfo.testId,
      attempt: this.testInfo.retry + 1,
      clientStepId: String(step.number),
      pass: process.env.AT_DASHBOARD_PHASE || this.testInfo.project.name,
    });
  }

  /**
   * Resolves an element step (click, fill, select, check, uncheck) on the page as it is now, the way `run` would, but
   * neither acts nor records a step: develop mode's verify_step and the check of a recorded step. It looks for at most
   * the optional-step window (resolveTimeoutMs), because it answers about the page the person is looking at. A
   * condition (`…, only if …`) is not checked. Other step kinds throw: they have no element to resolve.
   */
  async verify(rawStep: ParsedStep): Promise<StepVerification> {
    const { step } = this.splitCondition(this.bind(rawStep));
    const question = this.elementQuestion(step);
    if (!question)
      throw new StepFailure(
        `a ${step.kind} step has no element to resolve; only click, fill, select, check and uncheck steps can be verified`,
      );
    const rec: StepRecord = {
      number: step.number,
      label: step.label,
      file: step.file,
      line: step.line,
      text: step.text,
      kind: step.kind,
      status: 'passed',
      durationMs: 0,
      modelMs: 0,
      inputTokens: 0,
      calls: [],
    };
    this.offered = [];
    this.setContext(step);
    try {
      const el = await this.resolve(
        question.stepText,
        question.target,
        question.kind,
        rec,
        question.question,
        true,
      );
      return {
        ...(el && rec.chosen ? { chosen: rec.chosen } : {}),
        top: rec.top ?? [],
        candidates: this.offered,
        ...(el ? {} : { reason: rec.outcome?.replace(/^skipped \(optional\): /, '') }),
        calls: rec.calls,
      };
    } finally {
      setDecisionContext(null);
    }
  }

  /** How an element step asks for its element: the step as the model reads it, the kinds it may pick, the question. */
  private elementQuestion(
    step: ParsedStep,
  ): { stepText: string; target: string; kind: ElementStepKind; question: string } | null {
    switch (step.kind) {
      case 'click':
        return {
          stepText: this.stepText(step),
          target: step.target,
          kind: step.kind,
          question: 'Which element should be clicked to perform exactly this test step?',
        };
      case 'fill':
        // The value is never sent to the model: it only needs to find the field.
        return {
          stepText: `fill ${step.target}`,
          target: step.target,
          kind: step.kind,
          question: 'Which text field is this test step about?',
        };
      case 'check':
      case 'uncheck':
        return {
          stepText: this.stepText(step),
          target: step.target,
          kind: step.kind,
          question: `Which checkbox or radio button should be ${step.kind === 'check' ? 'checked' : 'unchecked'} for this test step?`,
        };
      case 'upload':
        // The file is not sent to the model: it only needs to find what opens the file picker.
        return {
          stepText: `upload a file to ${step.target}`,
          target: step.target,
          kind: step.kind,
          question:
            'Which element opens the file picker for this test step: a file upload control, or the button or link that opens it?',
        };
      case 'select':
        return {
          stepText: `select an option in ${step.target}`,
          target: step.target,
          kind: step.kind,
          question: 'Which dropdown is this test step about?',
        };
      default:
        return null;
    }
  }

  /** The element an element step acts on (see `elementQuestion`), or null for a skipped optional step. */
  private find(step: ParsedStep, rec: StepRecord): Promise<SnapElement | null> {
    const q = this.elementQuestion(step)!;
    return this.resolve(q.stepText, q.target, q.kind, rec, q.question, step.optional);
  }

  /** Runs the step; if the chosen element was replaced mid-action, reads the page again and retries once. */
  private async execute(step: ParsedStep, rec: StepRecord): Promise<void> {
    try {
      await this.executeOnce(step, rec);
    } catch (e) {
      if (!(e instanceof StaleElement)) throw e;
      rec.outcome = `retried: ${e.message}`;
      await this.page.waitForTimeout(config.pollIntervalMs);
      await this.executeOnce(step, rec);
    }
  }

  private async executeOnce(rawStep: ParsedStep, rec: StepRecord): Promise<void> {
    const page = this.page;
    const split = this.splitCondition(rawStep);
    if (split.condition && !(await this.conditionHolds(split.condition, rec))) return;
    const step = split.step;
    switch (step.kind) {
      case 'open':
        await page.goto(step.path);
        rec.outcome = `opened ${step.path}`;
        return;
      case 'press':
        await page.keyboard.press(step.key);
        await this.settle();
        rec.outcome = `pressed ${step.key}`;
        return;
      case 'wait':
        await page.waitForTimeout(step.seconds * 1000);
        rec.outcome = `waited ${step.seconds}s`;
        return;
      case 'expect':
        await this.expectStep(step.assertion, rec, step.withinSeconds);
        return;
      case 'switch': {
        // Continue as another user: a fresh API login for login blocks, otherwise that session's saved state.
        // Leave the previous user's page first: its requests (polling, websocket refreshes) still running while the
        // cookies are swapped can bring back a new anonymous session cookie that replaces the login (RD-07 landed on
        // the login page right after switching). Every switch is followed by an `open` step or an API call.
        await page.goto('about:blank');
        const creds = apiLoginCredentials(step.session);
        if (creds) {
          await apiLogin(page.context(), process.env.BASE_URL!, creds);
          rec.outcome = `now logged in as ${creds.username} (API login)`;
          return;
        }
        const state = JSON.parse(readFileSync(sessionFile(step.session), 'utf8')) as {
          cookies: Parameters<import('@playwright/test').BrowserContext['addCookies']>[0];
          origins?: { origin: string; localStorage: { name: string; value: string }[] }[];
        };
        const context = page.context();
        // A session that isn't a login continues afresh (see startFresh in login.ts), otherwise with its saved cookies.
        if (freshCookiesFor(step.session)) await startFresh(page, step.session);
        else {
          await context.clearCookies();
          await context.addCookies(state.cookies);
        }
        for (const o of state.origins ?? []) {
          await context.addInitScript(
            ({ origin, items }) => {
              if (location.origin !== origin) return;
              for (const { name, value } of items) localStorage.setItem(name, value);
            },
            { origin: o.origin, items: o.localStorage },
          );
        }
        rec.outcome = `now logged in as session "${step.session}"`;
        return;
      }
      case 'window':
        await this.switchWindow(step.session, rec);
        return;
      case 'call': {
        // 30 s like seed calls: API helpers and manual job triggers are slower than the UI action timeout. Server
        // errors are retried: job triggers like "send scheduled notifications" fail when parallel tests fire them at once.
        let res = await page.request.fetch(step.path, { method: step.method, timeout: 30_000 });
        for (let attempt = 1; attempt <= 3 && res.status() >= 500; attempt++) {
          await page.waitForTimeout(2000 * attempt);
          res = await page.request.fetch(step.path, { method: step.method, timeout: 30_000 });
        }
        rec.outcome = `${step.method} ${step.path} → ${res.status()}`;
        if (!res.ok())
          throw new StepFailure(
            `API call failed: ${step.method} ${step.path} → ${res.status()} ${(await res.text()).slice(0, 300)}`,
          );
        if (step.save) {
          // "data.token" walks into nested objects; the value is kept as text for {{saved.<name>}}.
          const body = await res.json().catch(() => {
            throw new StepFailure(
              `${step.method} ${step.path} did not return JSON, so "${step.save!.field}" can't be saved`,
            );
          });
          const value = step.save.field
            .split('.')
            .reduce<any>((o, k) => (o == null ? undefined : o[k]), body);
          if (value == null || typeof value === 'object')
            throw new StepFailure(
              `The response of ${step.method} ${step.path} has no value "${step.save.field}" (got: ${JSON.stringify(body).slice(0, 200)})`,
            );
          this.saved[step.save.name] = String(value);
          rec.outcome += `; saved ${step.save.field} as {{saved.${step.save.name}}}`;
        }
        await this.settle();
        return;
      }
      case 'drag':
        await this.drag(step, rec);
        return;
      case 'click': {
        const el = await this.find(step, rec);
        if (!el) return;
        await this.act(el, rec, (l) => l.click(), { watchLostClick: true });
        return;
      }
      case 'upload':
        await this.upload(step, rec);
        return;
      case 'fill': {
        const el = await this.find(step, rec);
        if (!el) return;
        await this.act(el, rec, async (l) => {
          // Focusing blurs the previous field, and its change handler may rewrite this one (e.g. end time = start + duration).
          // Let that land first, or fill's select-all is lost and the text gets appended to the new value.
          await l.focus();
          await this.page.waitForTimeout(config.settleMs);
          await l.fill(step.value);
          // Leave the field as a user would: some inputs only parse what was typed on blur (e.g. some date pickers).
          await l.blur().catch(() => undefined);
        });
        rec.outcome = el.secret
          ? 'filled with (hidden password)'
          : `filled with ${JSON.stringify(step.value.length > 40 ? step.value.slice(0, 40) + '…' : step.value)}`;
        return;
      }
      case 'check':
      case 'uncheck': {
        const el = await this.find(step, rec);
        if (!el) return;
        // A visible host of a hidden input (Material image radio) can't be "checked" directly: click it instead.
        await this.act(el, rec, async (l) => {
          const native = await l.evaluate((n) => n.tagName === 'INPUT').catch(() => true);
          if (native) await (step.kind === 'check' ? l.check() : l.uncheck());
          else {
            const want = step.kind === 'check';
            // A host with an input inside, or an ARIA control with no input at all (Material slide toggle:
            // <button role="switch" aria-checked>), itself or inside a host: reading only the input would click a switch
            // on, then off again.
            const isChecked = () =>
              l.evaluate(
                (n) =>
                  n.getAttribute('aria-checked') === 'true' ||
                  !!n.querySelector(
                    'input:checked, [role="switch"][aria-checked="true"], [role="checkbox"][aria-checked="true"]',
                  ),
              );
            if ((await isChecked()) !== want) await l.click();
            // Under load a re-rendering form can drop the click: check it took, and click again once if not.
            await this.page.waitForTimeout(300);
            if ((await isChecked().catch(() => want)) !== want) await l.click();
          }
        });
        return;
      }
      case 'select': {
        const el = await this.find(step, rec);
        if (!el) return;
        await this.act(el, rec, async (l) => {
          if (await l.evaluate((n) => n.tagName === 'SELECT')) {
            const options = await l.evaluate((s: HTMLSelectElement) =>
              [...s.options].map((o) => ({ label: o.label.trim(), value: o.value })),
            );
            const index = await this.pickOption(options, step.option, rec);
            await l.selectOption({ index });
            // A form re-rendering under load can drop the choice (seen with the date-of-birth dropdowns): check it
            // stuck and select again once if not.
            await this.page.waitForTimeout(300);
            if ((await l.inputValue().catch(() => options[index].value)) !== options[index].value)
              await l.selectOption({ index });
          } else {
            await this.selectCustom(l, step.option, rec, step.optional);
          }
        });
        return;
      }
    }
  }

  /**
   * An optional step can carry a condition: `optionally click "Next dates" …, only if the day "Tue 13" is not shown`.
   * Choosing the element and judging the condition in one question was unreliable (openai clicked "Next dates" with
   * the day in view at 0.61), so the condition is split off here and checked on its own by `conditionHolds`.
   */
  private splitCondition(step: ParsedStep): { step: ParsedStep; condition?: string } {
    if (!step.optional || !('target' in step)) return { step };
    const m = step.target.match(/^(.*?),\s*(?:only\s+)?if\s+(.+)$/i);
    if (!m) return { step };
    const text = step.text.replace(/,\s*(?:only\s+)?if\s+.+$/i, '');
    return { step: { ...step, target: m[1], text } as ParsedStep, condition: m[2] };
  }

  /**
   * Checks a step's condition as a yes/no question about the page, like an `expect` step. "… is not shown" and
   * "no … is shown" are asked the positive way round and the answer inverted: a negative statement confused openai
   * (BK-03, 0.16 for a true "does not show"). An unmet condition skips the step.
   */
  private async conditionHolds(condition: string, rec: StepRecord): Promise<boolean> {
    // A trailing explanation in brackets ("(it can fall in the next week)") is for the reader, not the question.
    const c = condition.replace(/\s*\([^()]*\)\s*$/, '').trim();
    let statement = c,
      inverted = false,
      m: RegExpMatchArray | null;
    if (
      (m = c.match(
        /^(.+?)\s+is\s+(?:still\s+)?not\s+(shown|visible|open|listed|displayed)\b(.*)$/i,
      ))
    ) {
      statement = `${m[1]} is ${m[2]}${m[3]}`;
      inverted = true;
    } else if (
      (m = c.match(/^no\s+(.+?)\s+is\s+(shown|visible|open|listed|displayed)(?:\s+yet)?\b(.*)$/i))
    ) {
      statement = `a ${m[1]} is ${m[2]}${m[3]}`;
      inverted = true;
    }
    const text = await pageText(this.page, config.maxPageTextChars);
    const colours = mentionsColour(statement) ? await pageColours(this.page) : undefined;
    const images = await this.images();
    const call = await getDecider().yesNo(
      yesNoState(
        'Check a condition of an automated UI test step against the current page.',
        statement,
        text,
        !!images,
        colours,
      ),
      `Is this statement true for the page as it is currently shown? Statement: ${statement}`,
      {
        true: 'The current page clearly shows that the statement is true.',
        false:
          'The page does not show this, shows something different, or it cannot be confirmed from the page.',
      },
      images,
    );
    rec.calls.push(call);
    const p = call.yes ?? 0;
    const holds = inverted ? p < 0.5 : p >= 0.5;
    const asked = `"${statement}": yes ${p.toFixed(2)}`;
    if (!holds)
      rec.outcome = `skipped (optional): condition not met (${asked}${inverted ? ', so it is shown' : ''})`;
    else rec.condition = `condition met (${asked}${inverted ? ', so it is not shown' : ''})`;
    return holds;
  }

  /** The step as the model should read it: without the `optionally` prefix (which stays in the report). */
  private stepText(step: ParsedStep): string {
    return step.text.replace(/^((?:.* › )?)optionally\s+/i, '$1');
  }

  /**
   * Snapshot → Choice, retried until resolveTimeoutMs. Throws with the top candidates if unresolved,
   * or, for an optional step, records it as skipped and returns null.
   */
  private async resolve(
    stepText: string,
    target: string,
    kind: ResolveKind,
    rec: StepRecord,
    question: string,
    optional = false,
  ): Promise<SnapElement | null> {
    const drag = kind === 'drag' || kind === 'drop';
    // A drop slot is named only by the quoted texts of the target: without one, no slot can be told apart.
    const slotLabels = kind === 'drop' ? quotedLabels(target) : [];
    if (kind === 'drop' && slotLabels.length === 0)
      throw new StepFailure(
        `Could not resolve step "${stepText}": quote the drop slot's label, e.g. the "Tue 03 Nov 11:30 AM" slot for "Dr Smith"`,
        'target-not-found',
      );
    // A required step keeps looking longer than an optional one: a form or dialog that loads slowly (self-service
    // booking form, reading dialog, with 4 workers) showed up after the 3 s an optional step gets, and the model then
    // rightly answered "none" for a button that wasn't on the page yet. An optional step still gives up quickly.
    const lookFor = optional ? config.resolveTimeoutMs : config.requiredResolveTimeoutMs;
    let deadline = Date.now() + lookFor;
    // A page with no elements at all is still loading (e.g. the app shell waiting for its startup calls, slow when
    // tests run in parallel): that doesn't count against the step's time, up to 20 s.
    const loadingCap = Date.now() + 20_000;
    let looks = 0;
    let reason = '';
    let failureKind: FailureKind = 'target-not-found';
    let top: Ranked[] = [];
    let lastCandidates: SnapElement[] = [];

    for (;;) {
      looks++;
      await this.waitUntilIdle();
      await this.waitForPageData();
      const snap = await snapshot(this.page, drag ? { drag: true } : undefined);
      const images = await this.images();
      if (snap.elements.length === 0 && Date.now() < loadingCap) {
        deadline = Math.max(deadline, Math.min(Date.now() + lookFor, loadingCap));
        looks = 0;
      }
      // A click on a field ("click the date field …", e.g. to open a date picker's calendar) may target a textbox;
      // other clicks only buttons, links and choices, so a step like "click Search" never lands in a search box.
      const kinds =
        kind === 'click' && /\bfield\b/i.test(target)
          ? [...KINDS.click, 'textbox' as ElementKind]
          : KINDS[kind];
      const accepts = (e: SnapElement) =>
        kinds.includes(e.kind) ||
        (kind === 'drag' && !!e.draggable) ||
        (kind === 'drop' && !!e.drop);
      const all = snap.elements.filter(accepts);
      // Drop slots: only those named by every quoted text, and nothing else, not even as page context (a week of a
      // calendar has well over a thousand). Too many matches fail rather than being cut to an arbitrary few.
      const slots = kind === 'drop' ? narrowByAllLabels(all, slotLabels) : null;
      const tooMany = !!slots && slots.length > config.maxCandidates;
      const listed = slots ? (tooMany ? [] : slots) : limitCandidates(all, stepText);
      // The answer options are first only the elements named like the step's quoted label; if that gives no
      // confident answer (or nothing is named like it), every element is an option, as before. The model always
      // sees the whole page, so conditions like "only if no date … is shown" can still be judged.
      const narrowed = slots ? null : narrowByLabel(all, target);
      const rounds = slots
        ? listed.length
          ? [listed]
          : []
        : narrowed
          ? [narrowed, listed]
          : [listed];
      const descriptions: Record<string, string> = Object.fromEntries(
        listed.map((e) => [e.id, describe(e)]),
      );
      for (const e of narrowed ?? []) descriptions[e.id] ??= describe(e);

      if (all.length === 0) {
        failureKind = 'target-not-found';
        reason = `no ${kind === 'drop' ? 'drop slot' : kinds.join('/')} elements on the page${snap.dialog !== null ? ` (dialog ${snap.dialog ? `"${snap.dialog}"` : 'without a title'} is open)` : ''}`;
      } else if (slots && !listed.length) {
        failureKind = 'target-not-found';
        const quoted = slotLabels.map((l) => `"${l}"`).join(', ');
        const example = all
          .slice(0, 3)
          .map((e) => describe(e))
          .join('; ');
        reason = tooMany
          ? `${slots.length} drop slots match ${quoted}; quote more of the slot (its date, time and group)`
          : `no drop slot matches ${quoted} (${all.length} drop slots on the page, e.g. ${example})`;
      }
      // One question about `candidates`: the element if it resolves the step, 'disabled' for a disabled match.
      const ask = async (
        candidates: SnapElement[],
        shots?: string[],
      ): Promise<SnapElement | 'disabled' | null> => {
        lastCandidates = candidates;
        this.offered = candidates.map((e) => ({ id: e.id, description: descriptions[e.id] }));
        const options: Record<string, string> = Object.fromEntries(
          candidates.map((e) => [e.id, descriptions[e.id]]),
        );
        const criteria = { ...options, [NONE]: 'No element on this page matches the step exactly' };
        const state = {
          task: 'Resolve one step of an automated UI test to the single element on the current page it refers to.',
          step: stepText,
          page: {
            url: snap.url,
            title: snap.title,
            openDialog: snap.dialog === '' ? '(no title)' : snap.dialog,
            headings: snap.headings,
          },
          notes: [
            'Row numbers count from 1 at the top of each table as currently displayed.',
            dialogNote(snap.dialog),
            'A similar-looking element is not a match. If nothing matches exactly, the answer is "none".',
            ...(shots ? [SCREENSHOT_NOTE] : []),
          ],
          elements: listed.map((e) => ({ id: e.id, description: descriptions[e.id] })),
        };
        // A long worklist (every row action carries its row) can overflow the model's input, since descriptions are
        // sent both here and as the answer options: then the page list names rows by number only.
        if (
          JSON.stringify(state).length + JSON.stringify(criteria).length >
          config.maxRequestChars
        ) {
          state.elements = listed.map((e) => ({
            id: e.id,
            description: describe(e, { compact: true }),
          }));
        }
        const call = await getDecider().choose(
          state,
          `${question}\nStep: ${stepText}`,
          criteria,
          shots,
        );
        rec.calls.push(call);
        top = rank(call.probabilities!, criteria);
        rec.top = top;

        const picked = candidates.find((e) => e.id === call.choice);
        const conf = call.confidence ?? 0;
        if (!picked) {
          failureKind = 'target-not-found';
          reason = 'the model answered "none": no element matches the step';
        } else if (conf < config.choiceThreshold) {
          failureKind = 'low-confidence';
          reason = `the model is unsure (confidence ${conf.toFixed(2)} < ${config.choiceThreshold})`;
        } else if (picked.disabled) {
          failureKind = 'target-not-found';
          reason = `the matching element is disabled: ${descriptions[picked.id]}`;
          return 'disabled';
        } else {
          rec.chosen = { id: picked.id, description: descriptions[picked.id], confidence: conf };
          if (candidates === narrowed)
            rec.narrowed = `${narrowed.length} of ${all.length} elements, by "${quotedLabel(target)}"`;
          if (slots)
            rec.narrowed = `${slots.length} of ${all.length} drop slots, by ${slotLabels.map((l) => `"${l}"`).join(', ')}`;
          return picked;
        }
        return null;
      };

      let answer: SnapElement | 'disabled' | null = null;
      for (const candidates of all.length ? rounds : []) {
        if (!candidates.length) continue;
        answer = await ask(candidates, images);
        if (answer) break; // a disabled match stays a disabled match with more candidates; only "none" or unsure is re-asked
      }
      // AT_DECIDER_IMAGES=fallback: an unsure text-only answer is asked again with a screenshot, scrolled to the element
      // the model leaned to (Playwright would scroll there to click it anyway); that answer decides, at the same threshold.
      // A confident "none" isn't (see CONFIDENT_NONE).
      const confidentNone = top[0]?.id === NONE && top[0].p >= CONFIDENT_NONE;
      if (!answer && all.length && config.imageMode === 'fallback' && !confidentNone) {
        const lead = top.find(
          (t) => t.id !== NONE && t.p > 0 && lastCandidates.some((e) => e.id === t.id),
        );
        if (lead)
          await this.page
            .locator(`[data-at-id="${lead.id}"]`)
            .scrollIntoViewIfNeeded({ timeout: 2000 })
            .catch(() => undefined);
        answer = await ask(lastCandidates, [`data:image/jpeg;base64,${await this.modelShot()}`]);
        if (answer && answer !== 'disabled') rec.screenshotFallback = true;
      }
      if (answer && answer !== 'disabled') return answer;

      // Give up when the time is up, but only after the minimum number of looks: a slow model can spend the whole
      // window on one call, while the page was still loading when it looked.
      if (Date.now() + config.pollIntervalMs > deadline && looks >= config.minLooks) {
        if (optional) {
          rec.outcome = `skipped (optional): ${reason}`;
          return null;
        }
        // AT_DEBUG=true lists every candidate, to see how a page is described when writing steps.
        const all =
          process.env.AT_DEBUG === 'true' && lastCandidates.length
            ? `\nAll candidates (${lastCandidates.length}):\n${lastCandidates.map((e) => `  ${e.id}: ${describe(e)}`).join('\n')}`
            : '';
        throw new StepFailure(
          `Could not resolve step "${stepText}": ${reason}${top.length ? `\nTop candidates:\n${formatTop(top)}` : ''}${all}`,
          failureKind,
        );
      }
      await this.page.waitForTimeout(config.pollIntervalMs);
      // Not resolved yet: if the page is still loading something, let it finish before the next look.
      if (!optional) await this.waitForQuiet();
    }
  }

  /**
   * `drag <source> to <target>`: two questions, each quoting only its own end (the dragged element among draggable
   * elements, then the drop slot among slots named by every quoted text), then a native HTML5 drag-and-drop
   * (Playwright's dragTo: dragstart, dragover and drop with a real dataTransfer, at the slot's centre).
   */
  private async drag(step: Extract<ParsedStep, { kind: 'drag' }>, rec: StepRecord): Promise<void> {
    const source = await this.resolve(
      `drag ${step.source}`,
      step.source,
      'drag',
      rec,
      'Which element should be dragged to perform exactly this test step?',
    );
    if (!source) return;
    // The slot's snapshot renumbers the page, so the dragged element keeps its own mark.
    const clearMark = () =>
      this.page.evaluate(() =>
        document
          .querySelectorAll('[data-at-drag-source]')
          .forEach((n) => n.removeAttribute('data-at-drag-source')),
      );
    await clearMark();
    const from = this.page.locator('[data-at-drag-source]');
    await this.page
      .locator(`[data-at-id="${source.id}"]`)
      .evaluate((n) => n.setAttribute('data-at-drag-source', ''));
    const slot: StepRecord = { ...rec, chosen: undefined, top: undefined, narrowed: undefined };
    let to: SnapElement | null;
    try {
      to = await this.resolve(
        `drop on ${step.target}`,
        step.target,
        'drop',
        slot,
        'Which drop slot should the element be dropped on to perform exactly this test step?',
      );
    } finally {
      rec.dropTop = slot.top;
      rec.dropNarrowed = slot.narrowed;
    }
    if (!to) return;
    rec.dropTarget = slot.chosen;
    const target = this.page.locator(`[data-at-id="${to.id}"]`);
    const outline = (on: boolean) =>
      Promise.all(
        [from, target].map((l) =>
          l
            .evaluate((node: HTMLElement, on) => {
              if (on) {
                node.dataset.atPrevOutline = node.style.outline;
                node.style.outline = '3px solid #e11d48';
                node.style.outlineOffset = '2px';
              } else {
                node.style.outline = node.dataset.atPrevOutline ?? '';
                node.style.outlineOffset = '';
                delete node.dataset.atPrevOutline;
              }
            }, on)
            .catch(() => undefined),
        ),
      );
    await outline(true);
    rec.screenshot = await this.shot();
    await outline(false);
    await this.dismissCoveringToasts(from);
    try {
      await this.dragAndDrop(from, target);
    } catch (e) {
      if ((await from.count().catch(() => 0)) === 0)
        throw new StaleElement(`dragged element ${source.id} was replaced while dragging it`);
      if ((await target.count().catch(() => 0)) === 0)
        throw new StaleElement(`drop slot ${to.id} was replaced while dragging to it`);
      throw e;
    } finally {
      // The page may have redrawn the dragged element: clear the mark wherever it is, without waiting for it.
      await clearMark().catch(() => undefined);
    }
    await this.settle();
  }

  /**
   * A native drag from `from` to the centre of `to`. Not Playwright's dragTo: that presses on the source and only then
   * scrolls to the slot, so a slot further along a scrolling calendar (the care calendar's week) moves the source away
   * from the pressed point and no drag starts. Here the drag starts first, then the slot is scrolled into view. When
   * something else covers the slot's centre, the drag ends back on the source (nothing is dropped) and the step reads
   * the page again.
   */
  private async dragAndDrop(from: Locator, to: Locator): Promise<void> {
    const mouse = this.page.mouse;
    const centre = async (l: Locator) => {
      await l.evaluate((n) => n.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
      const box = await l.boundingBox({ timeout: config.settleMs * 4 });
      if (!box) throw new StaleElement('the dragged element or the drop slot is no longer shown');
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    };
    const start = await centre(from);
    await mouse.move(start.x, start.y);
    await mouse.down();
    try {
      // A few pixels starts the drag (dragstart), before anything scrolls.
      await mouse.move(start.x + 8, start.y + 8, { steps: 2 });
      const end = await centre(to);
      // Pages often re-layer once a drag is under way (a calendar may raise its drop cells above the session layer
      // 200 ms after dragstart), so wait for the slot to be the element under its centre while the drag is held.
      const onSlot = await to.evaluate(
        (n, p) =>
          new Promise<boolean>((done) => {
            const until = Date.now() + p.waitMs;
            const check = () => {
              const hit = document.elementFromPoint(p.x, p.y);
              if (hit && (n === hit || n.contains(hit))) return done(true);
              if (Date.now() >= until) return done(false);
              setTimeout(check, 50);
            };
            check();
          }),
        { ...end, waitMs: DRAG_UNCOVER_MS },
      );
      if (!onSlot) {
        const back = await centre(from);
        await mouse.move(back.x, back.y, { steps: 5 });
        throw new StaleElement('something covers the drop slot');
      }
      await mouse.move(end.x, end.y, { steps: 5 });
    } finally {
      await mouse.up();
    }
  }

  /** Outline the target, screenshot, perform the action, let the UI settle. */
  private async act(
    el: SnapElement,
    rec: StepRecord,
    action: (l: Locator) => Promise<void>,
    opts: { watchLostClick?: boolean } = {},
  ): Promise<void> {
    const locator = this.page.locator(`[data-at-id="${el.id}"]`);
    await locator
      .evaluate((node: HTMLElement) => {
        node.dataset.atPrevOutline = node.style.outline;
        node.style.outline = '3px solid #e11d48';
        node.style.outlineOffset = '2px';
      })
      .catch(() => undefined);
    rec.screenshot = await this.shot();
    await locator
      .evaluate((node: HTMLElement) => {
        node.style.outline = node.dataset.atPrevOutline ?? '';
        node.style.outlineOffset = '';
        delete node.dataset.atPrevOutline;
      })
      .catch(() => undefined);
    await this.dismissCoveringToasts(locator);
    await this.waitForTableToSettle(locator);
    const watch = opts.watchLostClick ? await this.watchClick(locator) : null;
    try {
      try {
        await action(locator);
      } catch (e) {
        if ((await locator.count().catch(() => 0)) === 0)
          throw new StaleElement(`element ${el.id} was replaced while acting on it`);
        // Something opened over the element after the page was read (e.g. a warning dialog shown after a slow request,
        // more likely when tests run in parallel): read the page again and resolve the step once more.
        if (/intercepts pointer events/.test(String((e as Error).message)))
          throw new StaleElement(`element ${el.id} was covered by something that opened over it`);
        throw e;
      }
      await this.settle();
      const result = await watch?.result();
      if (result?.kind === 'lost')
        throw new StaleElement(
          `the row of element ${el.id} was redrawn as it was clicked and nothing happened`,
        );
      if (result?.kind === 'redrawn')
        rec.outcome = `the clicked row was redrawn by the page; the click had an effect: ${result.effect}`;
    } finally {
      watch?.stop();
    }
  }

  /**
   * Watches a click on an element in a table row for being lost. A worklist redraws its rows when the server reports a
   * change (e.g. a grid fed by a websocket, very often when tests run in parallel), and a click that lands while its row is
   * being replaced does nothing: no page change, no menu, no request (FIN-01 and RD-05 failed like that). The click is
   * "lost" when the clicked element is no longer on the page afterwards and nothing happened: the page's path, the
   * open dialogs/menus and the number of tabs are unchanged and no saving (non-GET) request was sent. GET requests
   * don't count, as the redraw itself fetches the row, nor do the row click's and the redraw's own non-GET requests
   * (ROW_CLICK_BOOKKEEPING), nor a change of the query string only (the redrawn grid writes its filters there). A row
   * that wasn't redrawn is never treated as lost.
   */
  private async watchClick(locator: Locator): Promise<{
    result: () => Promise<{ kind: 'ok' | 'redrawn' | 'lost'; effect?: string }>;
    stop: () => void;
  } | null> {
    const inRow = await locator.evaluate((n) => !!n.closest('tr, [role="row"]')).catch(() => false);
    const handle = inRow ? await locator.elementHandle().catch(() => null) : null;
    if (!handle) return null;
    const page = this.page;
    const layers = () =>
      page
        .evaluate(
          () =>
            [
              ...document.querySelectorAll(
                '[role="dialog"], dialog[open], mat-dialog-container, [role="menu"], .mat-mdc-menu-panel, .cdk-overlay-pane',
              ),
            ].filter((e) => (e as HTMLElement).checkVisibility()).length,
        )
        .catch(() => -1);
    const before = { url: page.url(), tabs: page.context().pages().length, layers: await layers() };
    // The element around the clicked row's table, which outlives a redraw of the table itself: a calendar or picker
    // grid replaces itself when a cell is clicked (a year → that year's months), while a list that redraws its rows
    // shows the clicked element again.
    // Angular Material swaps the whole view component, so the nearest of the table's ancestors still on the page is used.
    const container = await handle
      .evaluateHandle((n) => {
        const out: Element[] = [];
        for (
          let e = n.closest(
            'table, [role="grid"], [role="table"], [role="treegrid"]',
          )?.parentElement;
          e && out.length < 6;
          e = e.parentElement
        )
          out.push(e);
        return out;
      })
      .catch(() => null);
    const clicked = await handle
      .evaluate((n) => ({
        tag: n.tagName,
        text: (n as HTMLElement).innerText.replace(/\s+/g, ' ').trim(),
      }))
      .catch(() => null);
    let writes = 0;
    const writeUrls: string[] = [];
    const onRequest = (r: Request) => {
      if (
        r.method() !== 'GET' &&
        (r.resourceType() === 'fetch' || r.resourceType() === 'xhr') &&
        !ROW_CLICK_BOOKKEEPING.test(r.url())
      ) {
        writes++;
        writeUrls.push(`${r.method()} ${new URL(r.url()).pathname}`);
      }
    };
    page.on('request', onRequest);
    const stop = () => {
      page.off('request', onRequest);
      void handle.dispose().catch(() => undefined);
      void container?.dispose().catch(() => undefined);
    };
    // What changed since the click, for the report ('' when nothing did).
    const changed = async () => {
      const what = [];
      if (writes) what.push(`${writes} saving request(s): ${writeUrls.slice(0, 2).join(', ')}`);
      if (pagePath(page.url()) !== pagePath(before.url)) what.push(`URL now ${page.url()}`);
      if (page.context().pages().length !== before.tabs) what.push('a tab opened');
      const now = await layers();
      if (now !== before.layers) what.push(`dialogs/menus ${before.layers} → ${now}`);
      if (container && clicked?.text) {
        const gone = await container
          .evaluate((ancestors, k) => {
            const c = ancestors.find((e) => e.isConnected);
            return (
              !!c &&
              ![...c.querySelectorAll(k.tag)].some(
                (e) => (e as HTMLElement).innerText.replace(/\s+/g, ' ').trim() === k.text,
              )
            );
          }, clicked)
          .catch(() => false);
        if (gone) what.push(`the table was replaced by one without "${clicked.text}"`);
      }
      return what.join('; ');
    };
    return {
      stop,
      result: async () => {
        if (await handle.evaluate((n) => n.isConnected).catch(() => false))
          return { kind: 'ok' as const };
        // A navigation or dialog can follow a slow request: let the page's calls finish before deciding nothing happened.
        let effect = await changed();
        if (!effect) {
          await this.waitForQuiet();
          effect = await changed();
        }
        return effect ? { kind: 'redrawn' as const, effect } : { kind: 'lost' as const };
      },
    };
  }

  /** A notification toast lying over the target (e.g. "Saved" over a dialog's close button) is clicked away first. */
  private async dismissCoveringToasts(locator: Locator): Promise<void> {
    for (let i = 0; i < 5; i++) {
      const covered = await locator
        .evaluate((node: HTMLElement) => {
          const r = node.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          if (!hit || node.contains(hit) || hit.contains(node)) return false;
          const toast = hit.closest(
            '.ngx-toastr, .toast, .mat-mdc-snack-bar-container, .p-toast-message, [role="alert"]',
          );
          if (!toast) return false;
          (toast as HTMLElement).click();
          return true;
        })
        .catch(() => false);
      if (!covered) return;
      await this.page.waitForTimeout(400);
    }
  }

  /** Open a custom dropdown, narrow it with its search box if it has one, and click the matching option. */
  private async selectCustom(
    trigger: Locator,
    wanted: string,
    rec: StepRecord,
    optional = false,
  ): Promise<void> {
    // Already showing the wanted option (e.g. a dialog that fills in the current site): nothing to do. Opening it anyway
    // can fail for nothing, when its list is fetched on open and is slow under load (AS-01, SP-2: "opened no options").
    const showsWanted = async () =>
      wanted.trim() !== '*' &&
      (await trigger.innerText().catch(() => ''))
        .split('\n')
        .map((t) => t.replace(/\s+/g, ' ').trim().toLowerCase())
        .includes(wanted.trim().toLowerCase());
    if (await showsWanted()) {
      rec.outcome = `"${wanted.trim()}" was already selected`;
      return;
    }
    // Remember what's at the page corner, to recognise the dropdown's own backdrop later (see the end).
    await this.page.evaluate(() =>
      document.elementFromPoint(2, 2)?.setAttribute('data-at-corner', ''),
    );
    await trigger.click();
    await this.page.waitForTimeout(config.settleMs);
    // Long lists are often virtualised (only the visible rows exist), so type into the panel's search box when it takes focus.
    const searchFocused = await trigger.evaluate((t) => {
      let a = document.activeElement;
      while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
      return (
        !!a &&
        a !== t &&
        (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') &&
        !(a as HTMLInputElement).readOnly
      );
    });
    if (searchFocused && wanted.trim() !== '*') {
      await this.page.keyboard.insertText(wanted);
      await this.page.waitForTimeout(config.settleMs);
    }

    const options = this.page.locator(OPTION_SELECTOR).filter({ visible: true });
    try {
      // A list fetched when it opens can be slow under load (an "Episode status" or "Site" list took over 3 s while
      // parallel tests ran): a required step waits as long as it would look for an element.
      await options
        .first()
        .waitFor({ timeout: optional ? config.resolveTimeoutMs : config.requiredResolveTimeoutMs });
    } catch {
      // A dialog can fill in the field itself just after it opens (SP-2: "Book a slot" sets its default site), and
      // its list then never shows. The field showing exactly the wanted value is the selection, not a guess.
      if (await showsWanted()) {
        rec.outcome = `"${wanted.trim()}" was already selected (filled in by the page while the dropdown opened)`;
        return;
      }
      throw new StepFailure(
        `The dropdown opened no options${searchFocused ? ` matching "${wanted}"` : ''}`,
        'target-not-found',
      );
    }
    const read = async () =>
      (await options.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
    let labels = await read();
    // Options can load after the panel opens (a "Name" list fetched per role), and until then other visible options
    // may be all there is: re-read for a while if none contains the wanted text yet.
    const w = wanted.trim().toLowerCase();
    for (
      const until = Date.now() + 5000;
      w !== '*' && !labels.some((l) => l.toLowerCase().includes(w)) && Date.now() < until;
    ) {
      await this.page.waitForTimeout(500);
      labels = await read();
    }
    const index = await this.pickOption(
      labels.map((label) => ({ label, value: '' })),
      wanted,
      rec,
    );
    await options.nth(index).click();
    // A multi-select stays open after a pick; close it so it doesn't cover the next field. Escape can also close
    // a dialog the dropdown sits in, so click the dropdown's backdrop when it has one (a new layer at the corner).
    await this.page.waitForTimeout(config.settleMs);
    const ownBackdrop = await this.page.evaluate(() => {
      const hit = document.elementFromPoint(2, 2);
      const isNew = !!hit && !hit.hasAttribute('data-at-corner');
      document
        .querySelectorAll('[data-at-corner]')
        .forEach((e) => e.removeAttribute('data-at-corner'));
      return isNew;
    });
    // A single-select usually closes by itself, but its panel can still be fading out: give it a moment first.
    await options
      .first()
      .waitFor({ state: 'hidden', timeout: 1000 })
      .catch(() => undefined);
    if (await options.count()) {
      if (ownBackdrop) await this.page.mouse.click(2, 2);
      // Escape would also close a dialog the dropdown sits in (e.g. "Add item"), so only use it outside dialogs.
      else if (
        !(await this.page
          .locator('[role="dialog"], dialog[open], mat-dialog-container')
          .filter({ visible: true })
          .count())
      )
        await this.page.keyboard.press('Escape');
    }
  }

  /** Match the option text deterministically; ask the model only if that is ambiguous. */
  private async pickOption(
    options: { label: string; value: string }[],
    wanted: string,
    rec: StepRecord,
  ): Promise<number> {
    const w = wanted.trim().toLowerCase();
    // select "*" in …: the first real option, for lists whose values depend on the environment's reference data.
    if (w === '*') {
      // (skipping placeholders and Material icon names such as "arrow_downward" that sit in some option lists)
      const first = options.findIndex(
        (o) =>
          o.label !== '' && !/^-+$|^select\b/i.test(o.label) && !/^[a-z]+(_[a-z]+)+$/.test(o.label),
      );
      if (first >= 0) {
        rec.outcome = `selected "${options[first].label}" (the first option)`;
        return first;
      }
    }
    let idx = options.findIndex(
      (o) => o.label.toLowerCase() === w || (o.value !== '' && o.value.toLowerCase() === w),
    );
    if (idx < 0) {
      const partial = options
        .map((o, i) => (o.label.toLowerCase().includes(w) ? i : -1))
        .filter((i) => i >= 0);
      if (partial.length === 1) idx = partial[0];
    }
    if (idx >= 0) {
      rec.outcome = `selected "${options[idx].label}"`;
      return idx;
    }
    const criteria: Record<string, string> = Object.fromEntries(
      options.map((o, i) => [`o${i}`, o.label || '(empty)']),
    );
    criteria[NONE] = 'None of the options matches';
    const call = await getDecider().choose(
      { wanted, options: options.map((o) => o.label) },
      `Which dropdown option matches "${wanted}"?`,
      criteria,
    );
    rec.calls.push(call);
    const conf = call.confidence ?? 0;
    if (call.choice === NONE || conf < config.choiceThreshold) {
      throw new StepFailure(
        `No option matching "${wanted}". Options: ${options.map((o) => o.label).join(', ')}`,
        call.choice === NONE ? 'target-not-found' : 'low-confidence',
      );
    }
    idx = Number(call.choice!.slice(1));
    rec.outcome = `selected "${options[idx].label}" (via the model, confidence ${conf.toFixed(2)})`;
    return idx;
  }

  /** Yes/no question on the visible page text, retried until it passes or resolveTimeoutMs runs out. */
  private async expectStep(
    assertion: string,
    rec: StepRecord,
    withinSeconds?: number,
  ): Promise<void> {
    const deadline = Date.now() + (withinSeconds ? withinSeconds * 1000 : config.resolveTimeoutMs);
    // Long waits poll less often, to keep the number of model calls down.
    const pollMs = withinSeconds ? Math.max(config.pollIntervalMs, 2000) : config.pollIntervalMs;
    let looks = 0;
    // `expect X is not shown` asks whether X is shown (notShownStatement) and passes on a confident no.
    const shown = notShownStatement(assertion);
    if (shown) return this.expectNotShown(assertion, shown, rec, deadline, pollMs);
    // A statement about colours ("the Monday tile is green") also gets the page's coloured areas (pageColours).
    const withColours = mentionsColour(assertion);
    for (;;) {
      looks++;
      const text = await pageText(this.page, config.maxPageTextChars);
      const colours = withColours ? await pageColours(this.page) : undefined;
      const images = await this.images();
      const call = await this.askStatement(assertion, text, images, colours);
      rec.calls.push(call);
      const p = call.yes ?? 0;
      rec.outcome = `yes ${p.toFixed(2)} ${p >= config.yesNoThreshold ? '≥' : '<'} ${config.yesNoThreshold}`;
      if (p >= config.yesNoThreshold) return;
      if (Date.now() + pollMs > deadline && looks >= config.minLooks) {
        // AT_DEBUG=true shows what the model was given: the dialog, the table rows with their actions, other actions.
        const debug =
          process.env.AT_DEBUG === 'true'
            ? `\nPage seen by the model:${text.dialog ? `\n  dialog "${text.dialog.title}"` : ''}${text.actions.rows
                .map(
                  (r) =>
                    `\n  row ${r.row} (${Object.values(r.cells).filter(Boolean).slice(0, 6).join(' | ')}): ${r.actions.join(', ')}`,
                )
                .join('')}\n  other actions: ${text.actions.other.slice(0, 40).join(', ')}`
            : '';
        // A colour check names the colours it was given, so the report shows what the page actually had.
        const seen = colours
          ? colours.length
            ? `\nColours on the page:${colours
                .slice(0, 20)
                .map((c) => `\n  ${c}`)
                .join('')}${colours.length > 20 ? `\n  … ${colours.length - 20} more` : ''}`
            : '\nColours on the page: none found'
          : '';
        throw new StepFailure(
          `Expectation not met: ${assertion} (probability ${p.toFixed(2)}, threshold ${config.yesNoThreshold}${withinSeconds ? `, waited ${withinSeconds}s` : ''})${seen}${debug}`,
          'assertion',
        );
      }
      await this.page.waitForTimeout(pollMs);
      await this.waitForQuiet();
    }
  }

  /** The yes/no question of an `expect`: is the statement true for the page as shown? */
  private askStatement(
    statement: string,
    text: Awaited<ReturnType<typeof pageText>>,
    images: string[] | undefined,
    colours?: string[],
  ): Promise<DecisionCall> {
    return getDecider().yesNo(
      yesNoState(
        'Check an assertion of an automated UI test against the current page.',
        statement,
        text,
        !!images,
        colours,
      ),
      `Is this statement true for the page as it is currently shown? Statement: ${statement}`,
      {
        true: 'The current page clearly shows that the statement is true.',
        false:
          'The page does not show this, shows something different, or it cannot be confirmed from the page.',
      },
      images,
    );
  }

  /**
   * `expect X is not shown`: asks whether "X is shown" and passes when the model is confident it is not
   * (yes ≤ 1 − threshold) on `minLooks` looks in a row, after the page has settled. A single "no" could come from a page
   * that has not drawn X yet; an unsure answer never counts. Within N seconds it waits for X to go away. Past the
   * deadline it only finishes a streak already under way, so it ends at most minLooks − 1 looks late.
   */
  private async expectNotShown(
    assertion: string,
    shown: string,
    rec: StepRecord,
    deadline: number,
    pollMs: number,
  ): Promise<void> {
    const most = Math.round((1 - config.yesNoThreshold) * 100) / 100;
    const needed = Math.max(1, config.minLooks);
    let looks = 0,
      streak = 0;
    await this.settle();
    for (;;) {
      looks++;
      const text = await pageText(this.page, config.maxPageTextChars);
      const colours = mentionsColour(shown) ? await pageColours(this.page) : undefined;
      const call = await this.askStatement(shown, text, await this.images(), colours);
      rec.calls.push(call);
      const p = call.yes ?? 0;
      streak = p <= most ? streak + 1 : 0;
      rec.outcome = `asked "${shown}": yes ${p.toFixed(2)} ${p <= most ? '≤' : '>'} ${most}${
        p <= most ? `, so it is not shown (${streak}/${needed} looks)` : ''
      }`;
      if (streak >= needed) return;
      if (streak === 0 && Date.now() + pollMs > deadline && looks >= config.minLooks)
        throw new StepFailure(
          `Expectation not met: ${assertion} (asked "${shown}": probability ${p.toFixed(2)} that it is shown, passes at ${most} or less on ${needed} looks in a row)`,
          'assertion',
        );
      await this.page.waitForTimeout(pollMs);
      await this.waitForQuiet();
    }
  }

  /**
   * `upload "<file>" to <target>`: clicks the target and chooses the file in the file picker it opens (Playwright's
   * file chooser, so no native dialog appears). A target that opens no file picker fails the step: the wrong element
   * was chosen, or the page needs another step first.
   */
  private async upload(
    step: Extract<ParsedStep, { kind: 'upload' }>,
    rec: StepRecord,
  ): Promise<void> {
    const file = resolve(appDir(), step.attachment);
    const el = await this.find(step, rec);
    if (!el) return;
    await this.act(el, rec, async (l) => {
      const chooser = this.page.waitForEvent('filechooser', { timeout: FILE_CHOOSER_TIMEOUT_MS });
      chooser.catch(() => undefined);
      await l.click();
      const picker = await chooser.catch(() => null);
      if (!picker)
        throw new StepFailure(
          `Clicking ${describe(el)} did not open a file picker within ${FILE_CHOOSER_TIMEOUT_MS / 1000} s; name the file field, or the button or link that opens it`,
          'target-not-found',
        );
      await picker.setFiles(file);
    });
    rec.outcome = `uploaded "${step.attachment}" (${statSync(file).size} bytes)`;
  }

  private async settle(): Promise<void> {
    await this.page.waitForTimeout(config.settleMs);
    await this.page.waitForLoadState('load');
    await this.waitUntilIdle();
  }

  /** Waits (up to 20 s) while a loading indicator is visible: spinners and progress bars block clicks in many apps. */
  /**
   * Worklists re-render their rows when the data changes (some refresh them over a websocket whenever any
   * participant on the page changes, which happens a lot when tests run in parallel). A click that lands while its row
   * is being replaced is lost, so before acting on an element in a table, wait until the table has not changed for
   * 400 ms (at most 3 s).
   */
  private async waitForTableToSettle(locator: Locator): Promise<void> {
    await locator
      .evaluate(
        (node) =>
          new Promise<void>((done) => {
            const table = node.closest('table');
            if (!table) return done();
            let timer = setTimeout(finish, 400);
            const observer = new MutationObserver(() => {
              clearTimeout(timer);
              timer = setTimeout(finish, 400);
            });
            const cap = setTimeout(finish, 3000);
            observer.observe(table, { childList: true, subtree: true, characterData: true });
            function finish() {
              observer.disconnect();
              clearTimeout(timer);
              clearTimeout(cap);
              done();
            }
          }),
        undefined,
        { timeout: 5000 },
      )
      .catch(() => undefined);
  }

  /**
   * Before acting on an element: API calls the page started just now without any loading indicator can hold data a
   * control depends on (a booking calendar that refuses "Next dates" until its due date has loaded; SP-3 clicked 1.25 s
   * into a 3 s request). Wait for them a little; a call older than that, or one that never ends (a long poll), holds
   * nothing up. Not after every action: an `expect` that follows must look at once, before a short-lived message
   * ("Deferral expired successfully", DF-04) is gone.
   */
  private async waitForPageData(): Promise<void> {
    const recent = () => [...this.pending.values()].some((t) => Date.now() - t < 8000);
    const quietBy = Date.now() + 5000;
    while (Date.now() < quietBy && recent()) await this.page.waitForTimeout(100);
  }

  private async waitUntilIdle(): Promise<void> {
    const busy = () =>
      this.page
        .evaluate(() =>
          [
            ...document.querySelectorAll(
              'mat-spinner, mat-progress-spinner, mat-progress-bar, [role="progressbar"], .spinner, .loading-overlay, .p-progress-spinner',
            ),
          ].some((e) => {
            const r = e.getBoundingClientRect();
            if (!(
              r.width > 0 &&
              r.height > 0 &&
              (e as HTMLElement).checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
            ))
              return false;
            // Only loading indicators that hold up the page count: an overlay, a large spinner, or a progress bar across
            // the page or a table. A small spinner inside one form field blocks nothing.
            return (
              e.matches('.loading-overlay') ||
              (r.width >= 100 && r.height >= 100) ||
              r.width >= window.innerWidth * 0.5
            );
          }),
        )
        .catch(() => false);
    // A loading indicator that stays on with nothing loading is stuck (e.g. a top loading bar while the arrival form
    // is open: a question in it starts the bar and never stops it), so it only holds things up while the page has
    // API calls in flight, or for its first second.
    const loading = () => [...this.pending.values()].some((t) => Date.now() - t < 10_000);
    const deadline = Date.now() + 20_000,
      since = Date.now();
    while (Date.now() < deadline && (await busy()) && (loading() || Date.now() - since < 1000))
      await this.page.waitForTimeout(200);
    // A dialog that is still animating in (e.g. a warning opened over another dialog) isn't "visible" yet, so the
    // snapshot would still pick the dialog underneath it: let finite animations finish first (at most 1.5 s).
    const animating = () =>
      this.page
        .evaluate(() =>
          document
            .getAnimations()
            .some(
              (a) =>
                a.playState === 'running' &&
                Number(a.effect?.getComputedTiming().endTime) !== Infinity,
            ),
        )
        .catch(() => false);
    const until = Date.now() + 1500;
    while (Date.now() < until && (await animating())) await this.page.waitForTimeout(100);
  }

  /**
   * After a look that didn't settle the step ("none", an unsure pick, a check not met yet): wait until the page's API
   * calls are done before looking again, since a form or dialog may still be fetching its content (the self-service
   * booking step showed its tab titles while its questions and Submit were still loading). Quiet twice in a row, as
   * one call often triggers the next; at most `maxMs`, and a call running for over 10 s (long polling) doesn't count.
   * Only used then: pages that keep polling (dashboards, worklists) would otherwise cost the full wait on every step.
   */
  private async waitForQuiet(maxMs = 3000): Promise<void> {
    const recent = () => [...this.pending.values()].filter((t) => Date.now() - t < 10_000).length;
    const until = Date.now() + maxMs;
    for (let quiet = 0; Date.now() < until;) {
      quiet = recent() === 0 ? quiet + 1 : 0;
      if (quiet >= 2) return;
      await this.page.waitForTimeout(100);
    }
  }

  /** With AT_DECIDER_IMAGES=true (always), the viewport as the model sees it next to the page text; otherwise nothing. */
  private async images(): Promise<string[] | undefined> {
    return config.imageMode === 'always'
      ? [`data:image/jpeg;base64,${await this.modelShot()}`]
      : undefined;
  }

  /** The viewport scaled down to the model's longest accepted side (a 1600 px viewport for Jev's 1568), else as is. Quality 80
   *  (reports use 60): small labels stay sharper, and the models count an image's tokens by its size, not its bytes. */
  private async modelShot(): Promise<string> {
    const vp = this.page.viewportSize();
    const scale =
      config.maxImageSide && vp ? config.maxImageSide / Math.max(vp.width, vp.height) : 1;
    if (!vp || scale >= 1) return this.shot(80);
    // Playwright cannot scale a screenshot; Chromium's own capture can. The clip is in page coordinates.
    const cdp = await this.page.context().newCDPSession(this.page);
    try {
      const { cssVisualViewport: v } = await cdp.send('Page.getLayoutMetrics');
      const { data } = await cdp.send('Page.captureScreenshot', {
        format: 'jpeg',
        quality: 80,
        clip: { x: v.pageX, y: v.pageY, width: vp.width, height: vp.height, scale },
      });
      return data;
    } finally {
      await cdp.detach().catch(() => {});
    }
  }

  private async shot(quality = 60): Promise<string> {
    const buf = await this.page.screenshot({ type: 'jpeg', quality });
    return buf.toString('base64');
  }
}
