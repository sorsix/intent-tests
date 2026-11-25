// Seeds create test data through the app's API before a test runs. An app's tests folder may contain a
// `seeds.ts` exporting `seeds: Record<string, Seed>`; a test picks one with a `seed: <name>` line and reads
// the values it returns as `{{seed.<key>}}`.
// Playwright is imported only when a seed runs, so `parse` works without node_modules (e.g. in a bare CI job).
import type { APIRequestContext } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { authHook } from './app-config.ts';

export type SeedContext = {
  /** The app's base URL (BASE_URL). */
  baseURL: string;
  /**
   * Short id of the test being seeded, from its file name: "sp-1-routine-round.md" → "SP1"
   * (the leading letters + digits, a hyphen between them allowed: "sp-1-…" → "SP1"), otherwise "AT".
   */
  testId: string;
  /** The test's parameter row (`parameters:`), the values `{{param.<key>}}` is filled with; empty for other tests. */
  params: Readonly<Record<string, string>>;
  /** A new API context (cookie jar) per call; log in with `ctx.login` to get an authenticated one. */
  newRequest(): Promise<APIRequestContext>;
  /** Logs in through the app's `auth` hook (its API login) and returns an authenticated API context. */
  login(username: string, password: string): Promise<APIRequestContext>;
  /** Shown in the run output, e.g. what was created. */
  log(message: string): void;
};

export type SeedResult = {
  /** Available to the test as `{{seed.<key>}}`. */
  vars: Record<string, string>;
  /** Removes what the seed created. Runs after the test unless AT_KEEP_SEED=true. */
  cleanup?: () => Promise<void>;
};

export type Seed = { description?: string; run(ctx: SeedContext): Promise<SeedResult> };

export async function loadSeeds(testsRoot: string): Promise<Record<string, Seed>> {
  const file = join(testsRoot, 'seeds.ts');
  if (!existsSync(file)) return {};
  const mod = await import(pathToFileURL(file).href);
  return mod.seeds ?? {};
}

/** "spines/sp-1-routine-round.md" → "SP1", "booking/bk-08-session-cancelled.md" → "BK08"; "AT" otherwise. */
export function testIdFromFile(file: string): string {
  const base = file.split('/').pop() ?? '';
  const m = base.match(/^([a-z]+)-?(\d+)/i);
  return m ? `${m[1]}${m[2]}`.toUpperCase() : 'AT';
}

/** A seed context plus `dispose()`, which closes every API context it opened. */
export function seedContext(
  log: (m: string) => void,
  testId = 'AT',
  params: Record<string, string> = {},
): { ctx: SeedContext; dispose: () => Promise<void> } {
  const baseURL = (process.env.BASE_URL || '').replace(/\/$/, '');
  const ignoreHTTPSErrors = process.env.IGNORE_HTTPS_ERRORS === 'true';
  const contexts: APIRequestContext[] = [];
  const newRequest = async () => {
    // Empty storage on purpose: inside a test, request.newContext() inherits the test's storageState. Logging in
    // on top of the browser's session cookie makes the server rotate that session and logs the browser out.
    // 30 s per call: setup calls (registration with a patient lookup, booking) are slower than the 5 s UI action timeout.
    const { request } = await import('@playwright/test');
    const ctx = await request.newContext({
      baseURL,
      ignoreHTTPSErrors,
      storageState: { cookies: [], origins: [] },
      timeout: 30_000,
    });
    contexts.push(ctx);
    return ctx;
  };
  const ctx: SeedContext = {
    baseURL,
    testId,
    params: Object.freeze({ ...params }),
    newRequest,
    async login(username, password) {
      const auth = authHook();
      if (!auth)
        throw new Error(
          `Seed login as ${username}: this app has no API login (no auth hook in intent-tests.config.ts, auth: 'ui' or AT_LOGIN=ui)`,
        );
      const ctx = await newRequest();
      await auth.login(ctx, { username, password }, baseURL).catch((e) => {
        throw new Error(`Seed ${String(e?.message ?? e)}`);
      });
      return ctx;
    },
    log,
  };
  return {
    ctx,
    dispose: async () => {
      await Promise.all(contexts.map((c) => c.dispose()));
    },
  };
}

/** Replaces `{{seed.<key>}}` in a string; unknown keys are an error. */
export function bindSeedVars(s: string, vars: Record<string, string>, where: string): string {
  return s.replace(/\{\{\s*seed\.([A-Za-z0-9_]+)\s*\}\}/g, (_, key) => {
    if (!(key in vars))
      throw new Error(
        `${where}: {{seed.${key}}} is not provided by the seed (has: ${Object.keys(vars).join(', ') || 'nothing'})`,
      );
    return vars[key];
  });
}
