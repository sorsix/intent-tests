// The app under test: a folder with its .md tests, seeds.ts, intent-tests.config.ts and .env files, usually
// <repository>/intent-tests/<name>. Chosen per run with AT_APP=<name> (the CLIs' --app <name> sets it) or AT_APP_DIR=<path>.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Committed next to the app folders; names the dashboard product and marks the folder as the apps folder. */
export const WORKSPACE_FILE = 'intent-workspace.json';

/**
 * The folder that holds the app folders: AT_APPS_DIR, else <cwd>/intent-tests (an application workspace), else the
 * nearest folder at or above cwd with intent-workspace.json (a standalone test package run from inside).
 */
export function findAppsDir(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): string {
  if (env.AT_APPS_DIR) return resolve(env.AT_APPS_DIR);
  const nested = resolve(cwd, 'intent-tests');
  if (existsSync(nested) && statSync(nested).isDirectory()) return nested;
  for (let directory = resolve(cwd); ; directory = dirname(directory)) {
    if (existsSync(join(directory, WORKSPACE_FILE))) return directory;
    if (dirname(directory) === directory) return nested;
  }
}

/** Source engine root in development; compiled engine root in an installed package. */
export const ENGINE_DIR = resolve(import.meta.dirname, '..');
/** Consumer-owned app folders. Preserve the absolute root when Playwright changes cwd. */
export const APPS_DIR = findAppsDir();
process.env.AT_APPS_DIR = APPS_DIR;

/** App folders in APPS_DIR (every folder with an intent-tests.config.ts or .md files). */
export function knownApps(): string[] {
  if (!existsSync(APPS_DIR)) return [];
  return readdirSync(APPS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
    .map((d) => d.name)
    .sort();
}

let dir: string | null = null;

/** Absolute path of the app folder. Throws a clear error when no app is chosen or the folder doesn't exist. */
export function appDir(): string {
  if (dir) return dir;
  const explicit = process.env.AT_APP_DIR?.trim();
  const name = process.env.AT_APP?.trim();
  if (!explicit && !name) {
    throw new Error(
      `No app chosen. Set AT_APP=<name> or pass --app <name> (apps in ${APPS_DIR}: ${knownApps().join(', ') || 'none'}), or AT_APP_DIR=<path>.`,
    );
  }
  const candidate = explicit ? resolve(explicit) : resolve(APPS_DIR, name!);
  if (!existsSync(candidate) || !statSync(candidate).isDirectory()) {
    throw new Error(
      explicit
        ? `AT_APP_DIR=${explicit}: ${candidate} is not a folder`
        : `AT_APP=${name}: no folder ${candidate} (apps: ${knownApps().join(', ') || 'none'})`,
    );
  }
  // Child processes (Playwright workers, the second pass of run-suite) resolve the same folder.
  process.env.AT_APP_DIR = candidate;
  return (dir = candidate);
}

/** Where reports go: AT_REPORT_DIR (relative to the current folder) or <app>/reports. */
export function reportDir(): string {
  return process.env.AT_REPORT_DIR
    ? resolve(process.env.AT_REPORT_DIR)
    : resolve(appDir(), 'reports');
}

/** Takes `--app <name>` / `--app=<name>` out of a CLI's arguments and sets AT_APP from it. Returns the other arguments. */
export function takeAppArg(argv: string[]): string[] {
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--app') process.env.AT_APP = argv[++i];
    else if (a.startsWith('--app=')) process.env.AT_APP = a.slice('--app='.length);
    else rest.push(a);
  }
  return rest;
}

/**
 * AT_TESTS (a subfolder or file of the app, e.g. AT_TESTS=booking) runs only part of it; null runs everything.
 * The whole app is still parsed, so shared step blocks and sessions defined elsewhere (e.g. shared/) are found.
 */
export function testsFilter(): string | null {
  return process.env.AT_TESTS ? resolve(appDir(), process.env.AT_TESTS) : null;
}
