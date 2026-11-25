// Logs a browser context in through the app's login API (the `auth` hook, see app-config.ts) instead of the login
// form, for session blocks that are a plain username/password login. Faster than the form (no model calls), and cheap
// enough to repeat before each test and on every `switch to session`, so a long run never works with a session that
// has expired.
import type { BrowserContext, Page } from '@playwright/test';
import { authHook } from './app-config.ts';
import type { Credentials } from './define-config.ts';
import type { ParsedStep } from './parse.ts';

export type { Credentials } from './define-config.ts';

/**
 * The username and password a session block fills in, if the block is a login (a "fill … user…" and a
 * "fill … password …" step); null for other blocks, e.g. "participant (not logged in)".
 */
export function credentialsOf(steps: ParsedStep[]): Credentials | null {
  const fill = (re: RegExp) => steps.find((s) => s.kind === 'fill' && re.test(s.target));
  const user = fill(/user\s*name|username/i);
  const password = fill(/password/i);
  if (!user || !password || user.kind !== 'fill' || password.kind !== 'fill') return null;
  return { username: user.value, password: password.value };
}

/** Replaces the context's session with a fresh one for these credentials, through the app's `auth` hook. */
export async function apiLogin(
  context: BrowserContext,
  baseURL: string,
  creds: Credentials,
): Promise<void> {
  const auth = authHook();
  if (!auth)
    throw new Error(
      `No API login for this app (no auth hook in intent-tests.config.ts, auth: 'ui' or AT_LOGIN=ui), so ${creds.username} can't be logged in by API`,
    );
  await context.clearCookies();
  // A connection the app drops under load ("socket hang up", seen in SP-2 with 3 workers) is tried once more.
  await auth.login(context.request, creds, baseURL).catch(async (e) => {
    if (!/socket hang up|ECONNRESET|ECONNREFUSED/.test(String(e?.message))) throw e;
    await new Promise((r) => setTimeout(r, 2000));
    await context.clearCookies();
    await auth.login(context.request, creds, baseURL);
  });
}

/** Credentials per session name, registered by suite.ts once the tests are parsed (null: not a login block). */
const registry = new Map<string, Credentials | null>();
export const registerSessionCredentials = (name: string, creds: Credentials | null) =>
  void registry.set(name, creds);

/**
 * A session that isn't a login (e.g. "participant (not logged in)") starts without server cookies in every test and
 * on every `switch to session`, like a visitor opening a link: the cookies saved at setup would make all those tests
 * share one server session, and server-side state in it (a "verified" flag, a cart, …) leaks between tests and
 * parallel workers. Only cookies are dropped; local storage (e.g. the chosen language) is kept.
 * AT_ANONYMOUS_FRESH_COOKIES=false keeps the saved cookies instead.
 */
export const freshCookiesFor = (session: string) =>
  process.env.AT_ANONYMOUS_FRESH_COOKIES !== 'false' &&
  registry.has(session) &&
  registry.get(session) === null;

/** The page a non-login session block opens first (its first `open` step), registered by suite.ts. */
const firstPages = new Map<string, string>();
export const registerSessionFirstPage = (name: string, steps: ParsedStep[]) => {
  const open = steps.find((s) => s.kind === 'open');
  if (open?.kind === 'open') firstPages.set(name, open.path);
};

/**
 * Starts a non-login session afresh: no server cookies, then one visit to the page its block opens first, like a
 * visitor arriving at the site. The visit gives the browser one settled server session before the test opens its
 * own page. Without it, the first requests of a cookie-less browser each start their own server session, and state
 * the app keeps there can land in a session the browser doesn't keep (e.g. the chosen language, then HTTP 500
 * on a later page). Waits up to 1.5 s for the page's requests to finish.
 */
export async function startFresh(page: Page, session: string): Promise<void> {
  await page.context().clearCookies();
  const path = firstPages.get(session);
  if (!path) return;
  await page.goto(path);
  // The page's startup calls (e.g. storing the language) go out right after it loads; pages that keep polling
  // are never "network idle", so this waits at most 1.5 s.
  await page.waitForLoadState('networkidle', { timeout: 1500 }).catch(() => undefined);
}

/** The credentials to log a session in by API, or null to run its steps (not a login block, or no API login). */
export function apiLoginCredentials(session: string): Credentials | null {
  if (!authHook()) return null;
  return registry.get(session) ?? null;
}
