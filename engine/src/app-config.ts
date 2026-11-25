// Loads the app's intent-tests.config.ts once (top-level await) and resolves its hooks. Optional: an app without
// one gets the defaults (sessions log in through their steps in the browser, Jev).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { appDir } from './app.ts';
import type { AppConfig, AuthHook } from './define-config.ts';
import { loadEnv } from './env.ts';

async function load(): Promise<AppConfig> {
  const file = join(appDir(), 'intent-tests.config.ts');
  if (!existsSync(file)) return {};
  const mod = await import(pathToFileURL(file).href);
  if (!mod.default) throw new Error(`${file} must \`export default defineConfig({ … })\``);
  const config = mod.default as AppConfig;
  const auth: unknown = config.auth;
  if (auth === 'pinga')
    throw new Error(
      `${file}: auth: 'pinga' is no longer supported: the engine has no built-in app login. Set auth to the app's own login (an AuthHook, see the README's "Login") or to 'ui'.`,
    );
  if (
    auth !== undefined &&
    auth !== 'ui' &&
    (typeof auth !== 'object' || auth === null || typeof (auth as AuthHook).login !== 'function')
  )
    throw new Error(`${file}: auth must be 'ui' or an AuthHook ({ login, homePath }).`);
  return config;
}

export const appConfig: AppConfig = await load();

// Seeds read TIMEZONE to create times in the zone the browser shows (shell and .env files still win).
loadEnv();
if (appConfig.timezone && !process.env.TIMEZONE) process.env.TIMEZONE = appConfig.timezone;

/**
 * The app's API login, or null when sessions log in through their steps in the browser: auth 'ui', no auth set, or
 * AT_LOGIN=ui.
 */
export function authHook(): AuthHook | null {
  if (process.env.AT_LOGIN === 'ui') return null;
  const auth = appConfig.auth;
  return auth && auth !== 'ui' ? auth : null;
}
