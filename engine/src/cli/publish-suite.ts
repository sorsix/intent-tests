// Publish a captured app suite without opening a browser or constructing a decision model.
import './node-check.ts';
import { authorizeRunner } from '../dashboard/auth.ts';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { appDir, reportDir, takeAppArg } from '../app.ts';
import { loadEnv } from '../env.ts';
import { captureSuite, reportingDashboard, reportingIdentity } from '../dashboard/catalog.ts';
import { atomicJson, Spool } from '../dashboard/spool.ts';
import { DashboardClient } from '../dashboard/client.ts';

const args = takeAppArg(process.argv.slice(2));
if (args.length) throw new Error(`Unknown argument: ${args[0]}`);
loadEnv();
const app = appDir(),
  dashboard = reportingDashboard(app)?.url;
if (!dashboard)
  throw new Error(
    'Publishing a suite needs a dashboard: set AT_DASHBOARD_URL, or "dashboard" in intent-workspace.json.',
  );
const identity = reportingIdentity(process.env.AT_APP || basename(app), app);
await authorizeRunner(dashboard, process.env, fetch, identity.project.key);
const suite = await captureSuite(app, process.env.AT_DASHBOARD_SUITE_REVISION);
const dir = join(reportDir(), 'dashboard', `suite-${randomUUID()}`);
new Spool(dir);
const payload = { ...identity, suite };
atomicJson(join(dir, 'suite.json'), payload);
atomicJson(join(dir, 'suite-publish.json'), { version: 1, url: dashboard });
try {
  await new DashboardClient(dashboard).publishSuite(payload);
  atomicJson(join(dir, 'ack', 'suite.json'), { acknowledgedAt: new Date().toISOString() });
  console.log(
    `Published ${suite.cases.length} cases, ${suite.sources.length} source files; suite ${suite.suiteHash}`,
  );
} catch (error) {
  console.warn(
    `Suite upload pending: ${error instanceof Error ? error.message : String(error)}\nReplay: intent-test replay "${dir}"`,
  );
  process.exitCode = 1;
}
