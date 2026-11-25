// The shape of an app's intent-tests.config.ts. A leaf module (type imports only): app configs import it, and
// app-config.ts imports the app configs, so anything heavier here would make an import cycle.
import type { APIRequestContext } from '@playwright/test';
import type { Preset } from './decider/presets.ts';

export type Credentials = { username: string; password: string };

/**
 * How a session block that is a plain username/password login is logged in, without the login form.
 * The runner calls it before each test and on every `switch to session` (so a long run never works with an expired
 * session), and seeds call it through `ctx.login`.
 */
export type AuthHook = {
  /** Logs `request` (the browser context's or a seed's API context) in. Throws when the login fails. */
  login(request: APIRequestContext, creds: Credentials, baseURL: string): Promise<void>;
  /** Page the session setup opens once after the API login, so the app sets up its local storage. */
  homePath: string;
};

export type AppConfig = {
  /**
   * Login: the app's own AuthHook (an API login; seeds can use ctx.login), or 'ui' (the default) to run the session
   * block's steps in the browser (no API login; seeds can't use ctx.login). AT_LOGIN=ui forces 'ui'.
   */
  auth?: 'ui' | AuthHook;
  /** Decision model preset (see decider/presets.ts, or `presets` below); AT_DECIDER overrides. Default "jev". */
  decider?: string;
  /**
   * The app's own decision model presets, added to the built-in ones (same name: the app's wins), e.g. a self-hosted
   * model. Keys and account values still come from the environment (`apiKeyEnv`, `${VAR}` in `url`).
   */
  presets?: Record<string, Preset>;
  /** Minimum confidence to act on an element (AT_CHOICE_THRESHOLD overrides). Default: the preset's. */
  choiceThreshold?: number;
  /** Minimum yes probability for an `expect` step to pass (AT_YESNO_THRESHOLD overrides). Default: the preset's. */
  yesNoThreshold?: number;
  /** Browser size (VIEWPORT=WIDTHxHEIGHT overrides). Default 1280x720. */
  viewport?: { width: number; height: number };
  /** Browser time zone, e.g. 'Europe/Berlin', so times show as the app's users see them (TIMEZONE overrides). */
  timezone?: string;
  /** Per test, all steps together (AT_TEST_TIMEOUT_MS overrides). Default 90 s. */
  testTimeoutMs?: number;
  /** What this app's runs are for: 'verification' or 'authoring' (AT_RUN_PURPOSE and --purpose override). Default: the dashboard decides from the reporter (automation verifies, a person authors). */
  purpose?: 'verification' | 'authoring';
  /** Parallel tests (AT_WORKERS and --workers=N override). Default 2, locally and on CI. */
  workers?: number;
  /** How long a step keeps looking before it fails (AT_RESOLVE_TIMEOUT_MS overrides). Default 3 s. */
  resolveTimeoutMs?: number;
  /** The same for a required (not optional) step (AT_REQUIRED_RESOLVE_TIMEOUT_MS overrides). Default 10 s. */
  requiredResolveTimeoutMs?: number;
  /** Pause after each action so the UI can react (AT_SETTLE_MS overrides). Default 250 ms. */
  settleMs?: number;
  /** A server to start when BASE_URL is empty (e.g. a static demo site), as in Playwright's webServer. */
  webServer?: { command: string; url: string; env?: Record<string, string> };
};

/** Typed identity function for intent-tests.config.ts: `export default defineConfig({ … })`. */
export const defineConfig = (config: AppConfig): AppConfig => config;
