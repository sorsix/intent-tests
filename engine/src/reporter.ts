// Custom Playwright reporter: writes <reports>/report.html (self-contained) and <reports>/results.json.
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
  TestStep,
} from '@playwright/test/reporter';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from './config.ts';
import { deciderSettings } from './decider/index.ts';
import { appDir, testsFilter } from './app.ts';
import { annotatedCase, narrow, parseAll } from './parse.ts';
import type { StepRecord } from './steps.ts';

type PlanStep = { number: number; label?: string; line: number; text: string; kind: string };

type TestReport = {
  title: string;
  kind: 'test' | 'session';
  /** Test file (relative to the tests folder); "Sessions" for session setups. */
  group: string;
  session?: string;
  tags: string[];
  line: number | null;
  outcome: 'passed' | 'failed' | 'expected-fail' | 'unexpected-pass' | 'skipped' | 'flaky';
  durationMs: number;
  error?: string;
  plan: PlanStep[];
  steps: StepRecord[];
};

// eslint-disable-next-line no-control-regex -- matching the ESC of ANSI colour codes is the point
const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');
const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${n} ms`);

function body(a: TestResult['attachments'][number]): string | null {
  if (a.body) return a.body.toString('utf8');
  if (a.path) return readFileSync(a.path, 'utf8');
  return null;
}

export default class AtReporter implements Reporter {
  outputDir: string;
  tests: TestReport[] = [];
  startedAt = new Date();
  root: Suite | null = null;
  seen = new Set<string>();

  constructor(options: { outputDir?: string } = {}) {
    this.outputDir = resolve(options.outputDir ?? 'reports');
  }

  workers = 0;

  // Live progress, written to <outputDir>/progress.json after every step (see writeProgress).
  planned = new Map<string, number>();
  running = new Map<
    string,
    { title: string; stepsDone: number; stepsTotal: number; current?: string }
  >();
  finished: { title: string; outcome: string; failedStep?: string; error?: string }[] = [];
  stepsDone = 0;

  onBegin(config: FullConfig, suite: Suite) {
    this.workers = config.workers;
    this.startedAt = new Date();
    this.root = suite;
    // Planned steps per test, so progress and the ETA can be shown as a share of the whole run.
    try {
      // A template's cases all have its number of steps; their titles are only known from the listed tests.
      const parsed = narrow(parseAll(appDir()), testsFilter());
      for (const tc of parsed.files.flatMap((f) => f.cases))
        this.planned.set(tc.name, tc.steps.length);
      for (const test of suite.allTests()) {
        const note = (type: string) => test.annotations.find((a) => a.type === type)?.description;
        const tc = annotatedCase(
          parsed,
          note('at-client-test-id'),
          note('at-template-client-test-id'),
          note('at-parameters'),
        );
        if (tc) this.planned.set(test.title, tc.test.steps.length);
      }
    } catch {
      /* progress without totals is still useful */
    }
  }

  onTestBegin(test: TestCase) {
    if (this.isSession(test)) return;
    this.running.set(test.id, {
      title: test.title,
      stepsDone: 0,
      stepsTotal: this.planned.get(test.title) ?? 0,
    });
    this.writeProgress();
  }

  /** Counts the numbered steps of a test (not its seed or API login) as they finish. */
  onStepEnd(test: TestCase, _result: TestResult, step: TestStep) {
    const live = this.running.get(test.id);
    if (
      !live ||
      step.category !== 'test.step' ||
      step.parent ||
      /^(seed|log in as)\b/.test(step.title)
    )
      return;
    live.stepsDone++;
    live.current = step.title;
    this.stepsDone++;
    this.writeProgress();
  }

  private isSession(test: TestCase) {
    return test.parent.project()?.name === 'sessions';
  }

  private writeProgress() {
    const tests = (this.root?.allTests() ?? []).filter((t) => !this.isSession(t));
    const elapsedSec = (Date.now() - this.startedAt.getTime()) / 1000;
    const remainingSteps = tests.reduce((n, t) => {
      if (this.finished.some((f) => f.title === t.title)) return n;
      const live = this.running.get(t.id);
      return n + Math.max(0, (this.planned.get(t.title) ?? 0) - (live?.stepsDone ?? 0));
    }, 0);
    const rate = this.stepsDone >= 5 ? this.stepsDone / elapsedSec : 0;
    const progress = {
      startedAt: this.startedAt.toISOString(),
      updatedAt: new Date().toISOString(),
      state: 'running',
      elapsedSec: Math.round(elapsedSec),
      tests: {
        total: tests.length,
        finished: this.finished.length,
        failed: this.finished.filter((f) => f.outcome === 'failed').length,
      },
      steps: { done: this.stepsDone, remaining: remainingSteps },
      etaSec: rate ? Math.round(remainingSteps / rate) : null,
      running: [...this.running.values()],
      failed: this.finished.filter((f) => f.outcome === 'failed'),
    };
    try {
      mkdirSync(this.outputDir, { recursive: true });
      writeFileSync(join(this.outputDir, 'progress.json'), JSON.stringify(progress));
    } catch {
      /* progress is best effort */
    }
  }

  onTestEnd(test: TestCase, result: TestResult) {
    this.seen.add(test.id);
    if (!this.isSession(test) && this.running.has(test.id)) {
      const live = this.running.get(test.id)!;
      this.running.delete(test.id);
      const failed = result.status === 'failed' || result.status === 'timedOut';
      this.finished.push({
        title: test.title,
        outcome: failed ? 'failed' : result.status,
        ...(failed
          ? {
              failedStep: live.current ? `after "${live.current}"` : 'before the first step',
              error: stripAnsi(result.errors[0]?.message ?? '')
                .split('\n')[0]
                .slice(0, 200),
            }
          : {}),
      });
      this.writeProgress();
    }
    let plan: PlanStep[] = [];
    const steps: StepRecord[] = [];
    let line: number | null = null;
    for (const a of result.attachments) {
      const raw = a.contentType === 'application/json' ? body(a) : null;
      if (!raw) continue;
      if (a.name === 'at-plan') {
        const p = JSON.parse(raw);
        plan = p.steps;
        line = p.line;
      } else if (a.name.startsWith('at-step-')) {
        steps.push(JSON.parse(raw));
      }
    }
    steps.sort((a, b) => a.number - b.number);

    const expectedFail = test.expectedStatus === 'failed';
    let outcome: TestReport['outcome'];
    if (result.status === 'skipped') outcome = 'skipped';
    else if (test.outcome() === 'flaky') outcome = 'flaky';
    else if (expectedFail && result.status === 'failed') outcome = 'expected-fail';
    else if (expectedFail && result.status === 'passed') outcome = 'unexpected-pass';
    else outcome = result.status === 'passed' ? 'passed' : 'failed';

    const note = (type: string) => test.annotations.find((a) => a.type === type)?.description;
    const kind = test.parent.project()?.name === 'sessions' ? 'session' : 'test';
    const session = note('at-session');
    let error =
      result.errors
        .map((e) => stripAnsi(e.message ?? e.value ?? ''))
        .filter(Boolean)
        .join('\n\n') || undefined;
    if (outcome === 'skipped' && !error && session)
      error = `Not run: session "${session}" could not be set up (see Sessions).`;
    this.tests.push({
      title: test.title,
      kind,
      group: kind === 'session' ? 'Sessions' : (note('at-file') ?? 'tests'),
      session,
      tags: test.tags,
      line,
      outcome,
      durationMs: result.duration,
      error,
      plan,
      steps,
    });
  }

  onEnd(result: FullResult) {
    if (this.seen.size === 0) return; // nothing ran (e.g. `--list`): keep the previous report
    if (this.finished.length || this.running.size) {
      try {
        writeFileSync(
          join(this.outputDir, 'progress.json'),
          JSON.stringify({
            ...JSON.parse(readFileSync(join(this.outputDir, 'progress.json'), 'utf8')),
            state: 'finished',
            etaSec: 0,
            status: result.status,
          }),
        );
      } catch {
        /* best effort */
      }
    }
    // Tests that never started (their session setup failed) get no onTestEnd; list them as skipped.
    for (const test of this.root?.allTests() ?? []) {
      if (this.seen.has(test.id)) continue;
      const session = test.annotations.find((a) => a.type === 'at-session')?.description;
      this.tests.push({
        title: test.title,
        kind: 'test',
        group: test.annotations.find((a) => a.type === 'at-file')?.description ?? 'tests',
        session,
        tags: test.tags,
        line: null,
        outcome: 'skipped',
        durationMs: 0,
        plan: [],
        steps: [],
        error: `Not run: ${session ? `session "${session}"` : 'a session setup'} failed, and Playwright skips all tests that depend on the sessions.`,
      });
    }
    mkdirSync(this.outputDir, { recursive: true });
    const finishedAt = new Date();
    const order = (t: TestReport) =>
      ['failed', 'unexpected-pass', 'flaky', 'expected-fail', 'passed', 'skipped'].indexOf(
        t.outcome,
      );
    const groupKey = (t: TestReport) => (t.kind === 'session' ? '' : t.group);
    this.tests.sort(
      (a, b) =>
        groupKey(a).localeCompare(groupKey(b)) ||
        order(a) - order(b) ||
        (a.line ?? 0) - (b.line ?? 0),
    );
    const tests = this.tests.filter((t) => t.kind === 'test');
    const sessions = this.tests.filter((t) => t.kind === 'session');

    const allSteps = this.tests.flatMap((t) => t.steps);
    const calls = allSteps.flatMap((s) => s.calls);
    const tokens = calls.reduce((n, c) => n + c.inputTokens, 0);
    const decider = deciderSettings();
    const summary = {
      status: result.status,
      startedAt: this.startedAt.toISOString(),
      durationMs: finishedAt.getTime() - this.startedAt.getTime(),
      tests: tests.length,
      passed: tests.filter((t) => t.outcome === 'passed').length,
      expectedFail: tests.filter((t) => t.outcome === 'expected-fail').length,
      skipped: tests.filter((t) => t.outcome === 'skipped').length,
      failed: this.tests.filter((t) => ['failed', 'unexpected-pass', 'flaky'].includes(t.outcome))
        .length,
      sessions: sessions.length,
      sessionsFailed: sessions.filter((t) => t.outcome !== 'passed').length,
      steps: allSteps.length,
      modelCalls: calls.length,
      avgLatencyMs: calls.length
        ? Math.round(calls.reduce((n, c) => n + c.latencyMs, 0) / calls.length)
        : 0,
      avgCertainty: avgCertainty(allSteps),
      inputTokens: tokens,
      costUsd: (tokens / 1_000_000) * decider.usdPerMInput,
      decider: { name: decider.name, model: decider.model, host: new URL(decider.url).host },
      thresholds: { choice: config.choiceThreshold, yesNo: config.yesNoThreshold },
      /** Everything the run was configured with, for comparing runs. */
      settings: {
        decider: decider.name,
        description: decider.description,
        model: decider.model,
        endpoint: new URL(decider.url).host,
        sendImages: config.sendImages,
        imageMode: config.imageMode,
        choiceThreshold: config.choiceThreshold,
        yesNoThreshold: config.yesNoThreshold,
        maxOptions: decider.maxOptions,
        usdPerMInput: decider.usdPerMInput,
        resolveTimeoutMs: config.resolveTimeoutMs,
        pollIntervalMs: config.pollIntervalMs,
        minLooks: config.minLooks,
        settleMs: config.settleMs,
        maxPageTextChars: config.maxPageTextChars,
        testTimeoutMs: config.testTimeoutMs,
        workers: this.workers,
      },
    };

    const json = {
      summary,
      tests: this.tests.map((t) => ({ ...t, steps: t.steps.map(({ screenshot, ...s }) => s) })),
    };
    writeFileSync(join(this.outputDir, 'results.json'), JSON.stringify(json, null, 2));
    writeFileSync(join(this.outputDir, 'report.html'), renderHtml(summary, this.tests));
  }

  printsToStdio() {
    return false;
  }
}

/**
 * Average certainty of the passed steps the model decided: "clicks" are the element picks (click, fill, select,
 * check), "checks" the expect steps (the yes probability of the look that passed). Null when there were none.
 */
function avgCertainty(steps: StepRecord[]): { clicks: number | null; checks: number | null } {
  const passed = steps.filter((s) => s.status === 'passed');
  const avg = (xs: number[]) => (xs.length ? xs.reduce((n, x) => n + x, 0) / xs.length : null);
  const picks = passed.flatMap((s) => (s.chosen ? [s.chosen.confidence] : []));
  const checks = passed
    .filter((s) => s.kind === 'expect')
    .flatMap((s) => {
      const yes = [...s.calls].reverse().find((c) => c.type === 'yesno')?.yes;
      return yes === undefined ? [] : [yes];
    });
  return { clicks: avg(picks), checks: avg(checks) };
}

const OUTCOME: Record<TestReport['outcome'], { label: string; cls: string }> = {
  passed: { label: 'Passed', cls: 'ok' },
  'expected-fail': { label: 'Failed as expected', cls: 'ok' },
  failed: { label: 'Failed', cls: 'bad' },
  'unexpected-pass': { label: 'Passed, but should fail', cls: 'bad' },
  flaky: { label: 'Flaky', cls: 'warn' },
  skipped: { label: 'Skipped', cls: 'muted' },
};

function renderStep(s: StepRecord | undefined, p: PlanStep): string {
  if (!s) {
    return `<tr class="step notrun"><td class="num">${esc(p.label ?? p.number)}</td><td><span class="dot muted" title="Not run"></span></td>
      <td class="text">${esc(p.text)}</td><td colspan="4" class="muted">not run</td></tr>`;
  }
  const conf = s.chosen?.confidence;
  const lastYes = [...s.calls].reverse().find((c) => c.type === 'yesno')?.yes;
  const meter = conf ?? lastYes;
  const meterLabel = conf !== undefined ? 'confidence' : lastYes !== undefined ? 'probability' : '';
  const decision = [
    s.chosen ? `<div class="target">${esc(s.chosen.description)}</div>` : '',
    s.condition ? `<div class="outcome">${esc(s.condition)}</div>` : '',
    s.outcome ? `<div class="outcome">${esc(s.outcome)}</div>` : '',
    s.narrowed ? `<div class="outcome">options narrowed: ${esc(s.narrowed)}</div>` : '',
    s.dropTarget ? `<div class="target">dropped on ${esc(s.dropTarget.description)}</div>` : '',
    s.dropNarrowed ? `<div class="outcome">drop slots narrowed: ${esc(s.dropNarrowed)}</div>` : '',
    s.screenshotFallback
      ? '<div class="outcome">resolved with a screenshot after an unsure text-only answer</div>'
      : '',
  ].join('');
  const top = s.top?.length
    ? `<details class="top"><summary>Top candidates</summary><ol>${s.top.map((t) => `<li><b>${(t.p * 100).toFixed(1)}%</b> ${esc(t.id)}: ${esc(t.description)}</li>`).join('')}</ol></details>`
    : '';
  const dropTop = s.dropTop?.length
    ? `<details class="top"><summary>Top drop slots</summary><ol>${s.dropTop.map((t) => `<li><b>${(t.p * 100).toFixed(1)}%</b> ${esc(t.id)}: ${esc(t.description)}</li>`).join('')}</ol></details>`
    : '';
  const calls = s.calls.length
    ? `${s.calls.length} call${s.calls.length > 1 ? 's' : ''} · ${ms(s.modelMs)} · ${s.inputTokens.toLocaleString()} tok`
    : '—';
  const img = s.screenshot
    ? `<img class="thumb" loading="lazy" alt="Screenshot of step ${s.number}" src="data:image/jpeg;base64,${s.screenshot}">`
    : '';
  return `<tr class="step ${s.status}">
    <td class="num">${esc(s.label ?? s.number)}</td>
    <td><span class="dot ${s.status === 'passed' ? 'ok' : 'bad'}" title="${s.status}"></span></td>
    <td class="text">${s.window ? `<div class="small muted">in the window of "${esc(s.window)}"</div>` : ''}<code>${esc(s.text)}</code>${s.error ? `<pre class="err">${esc(s.error)}</pre>` : ''}</td>
    <td class="decision">${decision}${top}${dropTop}</td>
    <td class="meter">${meter !== undefined ? `<div class="bar" title="${meterLabel}"><span style="width:${(meter * 100).toFixed(0)}%"></span></div><div class="small">${meter.toFixed(2)} ${meterLabel}</div>` : ''}</td>
    <td class="small nowrap">${calls}<br>${ms(s.durationMs)} total</td>
    <td class="shot">${img}</td>
  </tr>`;
}

function renderTest(t: TestReport): string {
  const o = OUTCOME[t.outcome];
  const byNumber = new Map(t.steps.map((s) => [s.number, s]));
  const plan = t.plan.length
    ? t.plan
    : t.steps.map((s) => ({
        number: s.number,
        label: s.label,
        line: s.line,
        text: s.text,
        kind: s.kind,
      }));
  const ran = t.steps.length;
  const open = o.cls !== 'ok' ? ' open' : '';
  const errorNote =
    t.error && !t.steps.some((s) => s.error) ? `<pre class="err">${esc(t.error)}</pre>` : '';
  return `<details class="test ${o.cls}"${open}>
    <summary>
      <span class="pill ${o.cls}">${o.label}</span>
      <span class="name">${esc(t.title)}</span>
      ${t.tags
        .filter((g) => g !== '@session')
        .map((g) => `<span class="tag">${esc(g)}</span>`)
        .join('')}
      ${t.session && t.kind === 'test' ? `<span class="tag">session: ${esc(t.session)}</span>` : ''}
      <span class="spacer"></span>
      <span class="small">${ran}/${plan.length} steps · ${ms(t.durationMs)}${t.line ? ` · line ${t.line}` : ''}</span>
    </summary>
    ${errorNote}
    ${
      plan.length === 0
        ? ''
        : `<div class="table-wrap"><table class="steps">
      <thead><tr><th>#</th><th></th><th>Step</th><th>Decision</th><th>Certainty</th><th>Model</th><th>Screen</th></tr></thead>
      <tbody>${plan.map((p) => renderStep(byNumber.get(p.number), p)).join('')}</tbody>
    </table></div>`
    }
  </details>`;
}

function renderGroups(tests: TestReport[]): string {
  const groups = new Map<string, TestReport[]>();
  for (const t of tests) groups.set(t.group, [...(groups.get(t.group) ?? []), t]);
  return [...groups]
    .map(([name, items]) => {
      const bad = items.filter((t) => OUTCOME[t.outcome].cls !== 'ok').length;
      const counts = bad
        ? `<span class="bad-text">${bad} of ${items.length} not OK</span>`
        : `${items.length} OK`;
      return `<section class="group"><h2>${esc(name)} <span class="small">${counts}</span></h2>${items.map(renderTest).join('\n')}</section>`;
    })
    .join('\n');
}

function renderHtml(s: Record<string, any>, tests: TestReport[]): string {
  const ok = s.failed === 0;
  const tile = (label: string, value: string, cls = '') =>
    `<div class="tile ${cls}"><div class="label">${label}</div><div class="value">${value}</div></div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Test report</title>
<style>
:root {
  --bg: #f6f7f9; --panel: #fff; --text: #17202b; --muted: #637083; --border: #dfe3e8;
  --ok: #15803d; --ok-bg: #e6f4ea; --bad: #b91c1c; --bad-bg: #fdecec; --warn: #a16207; --warn-bg: #fdf6e3;
  --accent: #0b6e6e; --bar-bg: #e6e9ee;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #11161c; --panel: #19202a; --text: #e6eaef; --muted: #98a3b3; --border: #2b3542;
    --ok: #4ade80; --ok-bg: #173323; --bad: #f87171; --bad-bg: #3a1c1f; --warn: #facc15; --warn-bg: #352d12;
    --accent: #5eead4; --bar-bg: #2b3542;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1280px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { margin: 0 0 4px; font-size: 22px; }
.sub { color: var(--muted); margin-bottom: 20px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 24px; }
.tile { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; }
.tile .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
.tile .value { font-size: 22px; font-weight: 650; margin-top: 2px; }
.tile.small-value .value { font-size: 17px; padding-top: 4px; }
.tile.ok .value { color: var(--ok); } .tile.bad .value { color: var(--bad); }
details.test { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; margin-bottom: 10px; overflow: hidden; }
details.test.bad { border-color: var(--bad); }
details.test > summary { display: flex; align-items: center; gap: 10px; padding: 12px 14px; cursor: pointer; list-style: none; flex-wrap: wrap; }
details.test > summary::-webkit-details-marker { display: none; }
details.test > summary::before { content: "▸"; color: var(--muted); }
details.test[open] > summary::before { content: "▾"; }
.name { font-weight: 600; }
.spacer { flex: 1; }
.pill { font-size: 12px; font-weight: 650; padding: 2px 9px; border-radius: 999px; }
.pill.ok { background: var(--ok-bg); color: var(--ok); } .pill.bad { background: var(--bad-bg); color: var(--bad); }
.pill.warn { background: var(--warn-bg); color: var(--warn); } .pill.muted { background: var(--bar-bg); color: var(--muted); }
.tag { font-size: 12px; color: var(--muted); border: 1px solid var(--border); border-radius: 6px; padding: 0 6px; }
.small { font-size: 12px; color: var(--muted); }
.muted { color: var(--muted); }
.nowrap { white-space: nowrap; }
.table-wrap { overflow-x: auto; }
table.steps { width: 100%; border-collapse: collapse; }
table.steps th { text-align: left; font-size: 12px; color: var(--muted); font-weight: 600; padding: 6px 10px; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
table.steps td { padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
tr.step.failed { background: var(--bad-bg); }
tr.step.notrun td { color: var(--muted); }
td.num { color: var(--muted); width: 28px; }
td.text { width: 30%; }
td.text code { font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; }
td.decision { width: 32%; }
.target { font-size: 13px; }
.outcome { font-size: 12px; color: var(--muted); margin-top: 2px; }
td.meter { width: 110px; }
.bar { height: 6px; background: var(--bar-bg); border-radius: 3px; overflow: hidden; margin-top: 6px; }
.bar span { display: block; height: 100%; background: var(--accent); }
tr.step.failed .bar span { background: var(--bad); }
.dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-top: 4px; }
.dot.ok { background: var(--ok); } .dot.bad { background: var(--bad); } .dot.muted { background: var(--border); }
pre.err { white-space: pre-wrap; font: 12px/1.4 ui-monospace, Menlo, monospace; color: var(--bad); background: var(--bad-bg); padding: 8px 10px; border-radius: 6px; margin: 8px 0 0; }
details.test > pre.err { margin: 0 14px 12px; }
details.top summary { font-size: 12px; color: var(--muted); cursor: pointer; margin-top: 4px; }
details.top ol { margin: 4px 0 0; padding-left: 18px; font-size: 12px; }
img.thumb { width: 120px; border: 1px solid var(--border); border-radius: 4px; cursor: zoom-in; display: block; }
dialog#lightbox { padding: 0; border: 0; background: transparent; max-width: 95vw; max-height: 95vh; }
dialog#lightbox::backdrop { background: rgba(0,0,0,.75); }
dialog#lightbox img { max-width: 95vw; max-height: 95vh; display: block; cursor: zoom-out; }
footer { margin-top: 24px; color: var(--muted); font-size: 13px; }
section.group { margin-bottom: 22px; }
section.group > h2 { font-size: 15px; margin: 0 0 8px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
section.group > h2 .small { font-family: system-ui, sans-serif; font-weight: 400; margin-left: 6px; }
.bad-text { color: var(--bad); }
a { color: var(--accent); }
@media (max-width: 760px) {
  td.shot, th:last-child { display: none; }
  td.text, td.decision { width: auto; }
}
</style>
</head>
<body>
<main>
  <h1>Test report</h1>
  <div class="sub">${esc(new Date(s.startedAt).toLocaleString())} · ${ms(s.durationMs)} · decision model ${esc(s.decider.name)} / ${esc(s.decider.model)} · thresholds: choice ≥ ${s.thresholds.choice}, yes/no ≥ ${s.thresholds.yesNo}</div>
  <div class="tiles">
    ${tile('Result', ok ? 'All good' : `${s.failed} failing`, ok ? 'ok' : 'bad')}
    ${tile('Passed', String(s.passed))}
    ${tile('Failed as expected', String(s.expectedFail))}
    ${s.skipped ? tile('Skipped', String(s.skipped), 'bad') : ''}
    ${s.sessions ? tile('Sessions', s.sessionsFailed ? `${s.sessionsFailed}/${s.sessions} failed` : `${s.sessions} ok`, s.sessionsFailed ? 'bad' : '') : ''}
    ${tile('Steps run', String(s.steps))}
    ${tile('Model calls', String(s.modelCalls))}
    ${tile('Avg model latency', ms(s.avgLatencyMs))}
    ${s.avgCertainty ? tile('Avg certainty', `clicks ${s.avgCertainty.clicks?.toFixed(2) ?? '—'} · checks ${s.avgCertainty.checks?.toFixed(2) ?? '—'}`, 'small-value') : ''}
    ${tile('Input tokens', s.inputTokens.toLocaleString())}
    ${tile('Est. cost', `$${s.costUsd.toFixed(4)}`)}
  </div>
  ${renderGroups(tests)}
  <footer>Traces for failed tests: <a href="playwright/index.html">Playwright report</a> · raw data: <a href="results.json">results.json</a></footer>
</main>
<dialog id="lightbox"><img alt="Screenshot"></dialog>
<script>
  const box = document.getElementById('lightbox');
  document.addEventListener('click', (e) => {
    if (e.target.matches('img.thumb')) { box.querySelector('img').src = e.target.src; box.showModal(); }
    else if (box.open && (e.target === box || e.target.closest('#lightbox'))) box.close();
  });
</script>
</body>
</html>`;
}
