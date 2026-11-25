// Precedence: process env > intent-tests/.env > <app>/.env > <app>/.env.<AT_ENV> (default "dev").
// process.loadEnvFile never overrides a variable that is already set, so loading order = precedence.
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { APPS_DIR, appDir } from './app.ts';

let loaded: string[] | null = null;

/** Shared personal credentials, also used by replay commands that do not select an app. */
export function loadSharedEnv(appsDir = APPS_DIR): string[] {
  const shared = resolve(appsDir, '.env');
  if (!existsSync(shared)) return [];
  process.loadEnvFile(shared);
  return ['../.env'];
}

/** Load files for one app. Separate paths allow isolated fixtures without reading a developer's credentials. */
export function loadAppEnv(dir: string, appsDir = APPS_DIR): string[] {
  // Nx already loads the project's .env; use the same precedence in the plain CLI.
  // External AT_APP_DIR folders (including the self-test fixture) keep their own environment.
  const files = dirname(resolve(dir)) === resolve(appsDir) ? loadSharedEnv(appsDir) : [];
  const local = resolve(dir, '.env');
  if (existsSync(local)) {
    process.loadEnvFile(local);
    files.push('.env');
  }
  const profile = process.env.AT_ENV || 'dev';
  const profileFile = resolve(dir, `.env.${profile}`);
  if (existsSync(profileFile)) {
    process.loadEnvFile(profileFile);
    files.push(`.env.${profile}`);
  } else if (process.env.AT_ENV) {
    throw new Error(`AT_ENV=${profile} but ${profileFile} does not exist`);
  }
  return files;
}

/** Loads the selected app once per process; workers inherit the resolved environment. */
export function loadEnv(): string[] {
  return (loaded ??= loadAppEnv(appDir()));
}
