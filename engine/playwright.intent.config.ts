import { defineConfig, devices } from '@playwright/test';
import { appConfig } from './src/app-config.ts';
import { reportDir } from './src/app.ts';
import { config } from './src/config.ts';
import { deciderSettings } from './src/decider/index.ts';
import { loadEnv } from './src/env.ts';
import { requiredReportingToken } from './src/dashboard/auth.ts';
import { fileURLToPath } from 'node:url';

const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
const reporterPath = (path: string) =>
  fileURLToPath(new URL(`${path}.${extension}`, import.meta.url));

// The app comes from AT_APP / AT_APP_DIR. Process env > shared .env > app .env > app profile (default "dev").
// Must run before anything reads process.env.
loadEnv();
if (!process.argv.includes('--list') && !process.env.AT_DASHBOARD_SPOOL_DIR)
  throw new Error(
    'Run intent tests through intent-test run (src/cli/run-suite.ts) so personal/automation token validation and dashboard reporting are required.',
  );
if (!process.argv.includes('--list')) requiredReportingToken();
// Fails fast on an unknown AT_DECIDER or a missing API key / account id.
const decider = deciderSettings();
if (!process.env.TEST_WORKER_INDEX)
  console.log(`Decision model: ${decider.name} (${decider.model}, ${new URL(decider.url).host})`);

// <app>/reports, or AT_REPORT_DIR to keep runs apart (e.g. one folder per decision model).
const REPORTS = reportDir();
// When BASE_URL is set, tests run against it; otherwise the app config's webServer is started (the self-test site).
const BASE_URL = process.env.BASE_URL?.trim() || '';
if (!BASE_URL && !appConfig.webServer)
  throw new Error(
    'BASE_URL is not set (environment or app profile) and the app config has no webServer',
  );
// A bigger viewport (VIEWPORT=1600x1000 or the app config's) for apps whose dialogs don't fit in the default 1280x720.
const vp = process.env.VIEWPORT?.match(/^(\d+)x(\d+)$/);
const viewport = vp ? { width: Number(vp[1]), height: Number(vp[2]) } : appConfig.viewport;
// The browser shows times as the app's users see them (seeds use the same zone, see src/app-config.ts).
const timezone = process.env.TIMEZONE || appConfig.timezone;
const browser = {
  ...devices['Desktop Chrome'],
  ...(viewport ? { viewport } : {}),
  ...(timezone ? { timezoneId: timezone } : {}),
};

export default defineConfig({
  testDir: 'src/specs',
  // Per test, all steps together: AT_TEST_TIMEOUT_MS > app config > 90 s.
  timeout: config.testTimeoutMs,
  fullyParallel: true,
  // AT_WORKERS > app config > 2 (local and CI); `--workers=N` overrides all.
  workers: Number(process.env.AT_WORKERS) || appConfig.workers || 2,
  retries: 0,
  outputDir: `${REPORTS}/test-results`,
  reporter: [
    ['list'],
    ['html', { outputFolder: `${REPORTS}/playwright`, open: 'never' }],
    [reporterPath('./src/reporter'), { outputDir: REPORTS }],
    ...(process.env.AT_DASHBOARD_SPOOL_DIR || process.env.AT_DASHBOARD_DISCOVERY_DIR
      ? [[reporterPath('./src/dashboard/reporter'), { outputDir: REPORTS }] as const]
      : []),
  ],
  use: {
    baseURL: BASE_URL || appConfig.webServer!.url,
    ignoreHTTPSErrors: process.env.IGNORE_HTTPS_ERRORS === 'true',
    trace: 'retain-on-failure',
    // PW_VIDEO=on records a video of every test (reports/test-results/…/video.webm).
    video: process.env.PW_VIDEO === 'on' ? 'on' : 'off',
    actionTimeout: 5_000,
  },
  webServer:
    BASE_URL || !appConfig.webServer
      ? undefined
      : { ...appConfig.webServer, reuseExistingServer: true },
  projects: [
    // Logs in once per `session:` name and saves the browser state.
    { name: 'sessions', testMatch: /sessions\.setup\.[jt]s$/, use: browser },
    // Everything that can share the app with other tests.
    {
      name: 'parallel',
      testMatch: /tests\.spec\.[jt]s$/,
      grepInvert: /@exclusive/,
      dependencies: ['sessions'],
      use: browser,
    },
    // Tests tagged @exclusive change something global (bulk invitations, auto-booking, shared configuration): one at a
    // time and with nothing else running. src/cli/run-suite.ts runs this project after `parallel`, in
    // a second pass with one worker; running both projects in one `playwright test` would let them overlap.
    {
      name: 'exclusive',
      testMatch: /tests\.spec\.[jt]s$/,
      grep: /@exclusive/,
      fullyParallel: false,
      dependencies: ['sessions'],
      use: browser,
    },
  ],
});
