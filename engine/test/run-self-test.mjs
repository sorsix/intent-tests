// The fixed fixture exercises the real browser/engine with an in-memory reporting boundary.
// A run with a dashboard validates its credentials before any test starts; this one injects that check.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DashboardClient } from '../src/dashboard/client.ts';
import { DashboardSession } from '../src/dashboard/session.ts';
import { requiredReportingToken } from '../src/dashboard/auth.ts';
import { runSuite } from '../src/cli/run-suite.ts';
const temporary = mkdtempSync(join(tmpdir(), 'intent-engine-self-test-'));
Object.assign(process.env, {
  AT_APP_DIR: fileURLToPath(new URL('fixture', import.meta.url)),
  AT_APP: 'fixture',
  AT_TESTS: 'self-test',
  AT_DECIDER: 'stub',
  AT_REPORT_DIR: temporary,
  AT_DASHBOARD_URL: 'https://dashboard.example.test',
  AT_DASHBOARD_TOKEN: 'pit_pat_' + '1'.repeat(32) + '_' + 'a'.repeat(43),
  CI: '',
});
delete process.env.BASE_URL;
class FixtureClient extends DashboardClient {
  async request() {
    return { runId: '11111111-1111-1111-1111-111111111111', runNumber: 1 };
  }
}
try {
  process.exitCode = await runSuite([], {
    authorize: async () => {
      requiredReportingToken();
    },
    createSession: (dir, manifest) =>
      new DashboardSession(dir, manifest, {
        client: new FixtureClient(process.env.AT_DASHBOARD_URL),
      }),
  });
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
