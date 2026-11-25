// Shared by both spec files: loads env + test files once, and runs a list of steps as test.steps.
import {
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { failureFor, markFailure } from './failure.ts';
import { appDir, testsFilter } from './app.ts';
import { loadEnv } from './env.ts';
import { ParseError, withoutDrafts, type ParameterBinding, type ParsedStep } from './parse.ts';
import { loadSuite } from './parameters.ts';
import { loadSeeds, seedContext, testIdFromFile } from './seeds.ts';
import { StepRunner } from './steps.ts';
import { CLICK_LISTENERS, recordClickListeners } from './snapshot.ts';
import {
  apiLogin,
  apiLoginCredentials,
  credentialsOf,
  freshCookiesFor,
  registerSessionCredentials,
  registerSessionFirstPage,
  startFresh,
} from './login.ts';

loadEnv();

// Drafts (`@draft`) are not run unless AT_INCLUDE_DRAFTS=true; the catalog still lists them.
export const suite = withoutDrafts(await loadSuite(appDir(), testsFilter()));
import { sessionFile } from './paths.ts';
export { sessionFile };

// Sessions that are a plain username/password login are logged in by API (see login.ts).
for (const [name, block] of suite.blocks) {
  registerSessionCredentials(name, credentialsOf(block.steps));
  registerSessionFirstPage(name, block.steps);
}

// Seeds live in the app folder, also when AT_TESTS runs only part of it.
const seeds = await loadSeeds(appDir());
for (const tc of suite.files.flatMap((f) => f.cases)) {
  if (tc.seed && !seeds[tc.seed]) {
    throw new ParseError(
      `${tc.file}:${tc.line}: seed "${tc.seed}" is not defined in ${appDir()}/seeds.ts (has: ${Object.keys(seeds).join(', ') || 'none'})`,
    );
  }
}

export type PlanMeta = {
  kind: 'test' | 'session';
  file: string;
  line: number;
  session?: string;
  seed?: string;
  parameters?: ParameterBinding;
};

// AT_NET_LOG=<file>: appends the app's API writes (method, path, body, status) to a file, to learn the API calls
// behind a UI flow (e.g. for a seed). Debugging only: request bodies can contain personal data.
async function logNetwork(page: Page): Promise<void> {
  const { appendFileSync } = await import('node:fs');
  page.on('requestfinished', async (req) => {
    if (
      !req.url().includes('/api/') ||
      (req.method() === 'GET' && !/option|select/i.test(req.url()))
    )
      return;
    const res = await req.response();
    appendFileSync(
      process.env.AT_NET_LOG!,
      `${JSON.stringify({
        method: req.method(),
        url: req.url().replace(/^https?:\/\/[^/]+/, ''),
        status: res?.status(),
        body: req.postData()?.slice(0, 20000),
        response: (await res?.text().catch(() => ''))?.slice(0, 2000),
      })}\n`,
    );
  });
}

export async function runSteps(
  page: Page,
  testInfo: TestInfo,
  steps: ParsedStep[],
  meta: PlanMeta,
  /** The test's browser, for `switch to window`; a session's setup has none. */
  browser?: Browser,
): Promise<void> {
  await testInfo.attach('at-plan', {
    contentType: 'application/json',
    body: JSON.stringify({
      ...meta,
      steps: steps.map((s) => ({
        number: s.number,
        label: s.label,
        file: s.file,
        line: s.line,
        text: s.text,
        kind: s.kind,
      })),
    }),
  });

  if (process.env.AT_NET_LOG) await logNetwork(page);

  // Before the first navigation, so the app's click handlers are recorded as it renders (see recordClickListeners).
  await page.context().addInitScript(recordClickListeners, CLICK_LISTENERS);

  let vars: Record<string, string> = {};
  const windows: BrowserContext[] = [];
  let cleanup: (() => Promise<void>) | undefined;
  const { ctx, dispose } = seedContext(
    (m) => console.log(`  [seed ${meta.seed}] ${m}`),
    testIdFromFile(meta.file),
    meta.parameters?.values,
  );
  let stage: 'seed' | 'setup' | 'unknown' = 'unknown';
  try {
    if (meta.seed) {
      stage = 'seed';
      const t0 = performance.now();
      const result = await test.step(`seed: ${meta.seed}`, () => seeds[meta.seed!].run(ctx), {
        box: true,
      });
      vars = result.vars;
      cleanup = result.cleanup;
      await testInfo.attach('at-seed', {
        contentType: 'application/json',
        body: JSON.stringify({
          name: meta.seed,
          durationMs: Math.round(performance.now() - t0),
          vars,
        }),
      });
    }
    // A fresh session for the test's role, so it doesn't depend on one saved at the start of a long run.
    stage = 'setup';
    const creds = meta.kind === 'test' && meta.session ? apiLoginCredentials(meta.session) : null;
    if (creds)
      await test.step(
        `log in as ${creds.username} (API)`,
        () => apiLogin(page.context(), process.env.BASE_URL!, creds),
        { box: true },
      );
    else if (meta.kind === 'test' && meta.session && freshCookiesFor(meta.session))
      await test.step(`start "${meta.session}" afresh`, () => startFresh(page, meta.session!), {
        box: true,
      });
    stage = 'unknown';
    const runner = new StepRunner(page, testInfo, vars);
    if (browser && meta.kind === 'test' && meta.session) {
      runner.firstWindow = meta.session;
      runner.openWindow = async (session) => {
        const window = await openSessionWindow(browser, session);
        windows.push(window.context());
        return window;
      };
    }
    for (const step of steps) {
      await test.step(`${step.label}. ${step.text}`, () => runner.run(step), { box: true });
    }
  } catch (error) {
    markFailure(error, stage);
    await testInfo
      .attach('at-failure', {
        contentType: 'application/json',
        body: JSON.stringify(failureFor(error, stage)),
      })
      .catch(() => undefined);
    throw error;
  } finally {
    // The other windows go first, so their pages stop calling the app before the seed's data is removed.
    for (const context of windows) await context.close().catch(() => undefined);
    if (cleanup && process.env.AT_KEEP_SEED !== 'true') {
      await test
        .step(`seed cleanup: ${meta.seed}`, cleanup, { box: true })
        .catch((e) => console.warn(`  [seed ${meta.seed}] cleanup failed: ${e}`));
    }
    await dispose();
  }
}

/**
 * A separate window (its own browser context: cookies, storage, websockets) for `switch to window`, set up like a test
 * that starts from the session: its saved state, then a fresh API login for a login block or a fresh visit for a
 * session that isn't one. The test's browser applies the run's context options (base URL, viewport, time zone) and
 * tracing to it, as to the test's own page.
 */
async function openSessionWindow(browser: Browser, session: string): Promise<Page> {
  const context = await browser.newContext({ storageState: sessionFile(session) });
  await context.addInitScript(recordClickListeners, CLICK_LISTENERS);
  const creds = apiLoginCredentials(session);
  if (creds) await apiLogin(context, process.env.BASE_URL!, creds);
  const page = await context.newPage();
  if (process.env.AT_NET_LOG) await logNetwork(page);
  if (!creds && freshCookiesFor(session)) await startFresh(page, session);
  return page;
}
