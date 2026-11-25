// `catalog [--app <name>]`: prints the app's suite catalog as JSON, exactly as `publish-suite` would capture it, for
// local tools such as the Launcher. Read-only: no browser, decision model, dashboard token or network.
// Without --app it lists the app folders instead.
import './node-check.ts';
import { existsSync, readdirSync } from 'node:fs';
import { basename } from 'node:path';

const { APPS_DIR, appDir, knownApps, takeAppArg } = await import('../app.ts');
const { ENGINE_VERSION: engine } = await import('../dashboard/engine-version.ts');
const header = { kind: 'intent-catalog', schema: 1, engine };
const args = takeAppArg(process.argv.slice(2));
if (args.length) {
  console.error(`Unknown argument: ${args[0]}. Usage: intent-test catalog [--app <name>]`);
  process.exit(1);
}
if (!process.env.AT_APP && !process.env.AT_APP_DIR) {
  console.log(JSON.stringify({ ...header, appsDir: APPS_DIR, apps: knownApps() }));
} else {
  try {
    const dir = appDir();
    const { loadEnv } = await import('../env.ts');
    const envFiles = loadEnv();
    const { captureSuite, reportingDashboard, reportingIdentity, reportingProduct } =
      await import('../dashboard/catalog.ts');
    const suite = await captureSuite(dir, process.env.AT_DASHBOARD_SUITE_REVISION);
    const { deciderChoices } = await import('../decider/index.ts');
    const profiles = existsSync(dir)
      ? readdirSync(dir)
          .map((name) => /^\.env\.([A-Za-z0-9_-]+)$/.exec(name)?.[1])
          .filter((name) => name && name !== 'example')
          .sort()
      : [];
    const key = process.env.AT_APP || basename(dir);
    console.log(
      JSON.stringify({
        ...header,
        appDir: dir,
        profile: process.env.AT_ENV || 'dev',
        profiles,
        envFiles,
        // Presence only: the values stay in the environment files.
        dashboardToken: !!process.env.AT_DASHBOARD_TOKEN?.trim(),
        baseUrl: process.env.BASE_URL || '',
        ...reportingIdentity(key, dir),
        productSource: reportingProduct(dir).source,
        // The dashboard runs report to, or null for local-only runs.
        dashboard: reportingDashboard(dir)?.url ?? null,
        deciders: deciderChoices(),
        suite,
      }),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
