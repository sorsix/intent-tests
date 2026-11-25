// Shared Node-only reporting options. No environment values are serialized or dumped.
import { sanitize } from './sanitize.ts';

type ReportingEnvironment = Record<string, string | undefined>;
export function runName(fallback: string, environment: ReportingEnvironment = process.env): string {
  return environment.AT_RUN_NAME?.trim() || fallback;
}
/** What a run is for. Without a declaration the dashboard decides: automation verifies, a person authors. */
export const RUN_PURPOSES = ['verification', 'authoring'] as const;
export type RunPurpose = (typeof RUN_PURPOSES)[number];
export function isRunPurpose(value: unknown): value is RunPurpose {
  return RUN_PURPOSES.includes(value as RunPurpose);
}
/** The declared purpose: `--purpose` (it sets AT_RUN_PURPOSE), then the app config's `purpose`; an invalid value stops the run. */
export function runPurpose(
  environment: ReportingEnvironment = process.env,
  configured?: string,
): RunPurpose | undefined {
  const value = environment.AT_RUN_PURPOSE?.trim().toLowerCase() || configured;
  if (!value) return undefined;
  if (!isRunPurpose(value))
    throw new Error(`The run purpose must be ${RUN_PURPOSES.join(' or ')}, not "${value}"`);
  return value;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * The Intent Launcher installation that started the engine (a UUID in AT_LAUNCHER_INSTALLATION_ID, set by the
 * Launcher desktop shell). Anything else is ignored; the dashboard only trusts it from a desktop session.
 */
export function launcherInstallationId(environment: ReportingEnvironment = process.env) {
  const value = environment.AT_LAUNCHER_INSTALLATION_ID?.trim();
  return value && UUID.test(value) ? value.toLowerCase() : undefined;
}

/** A registered run on the dashboard at `dashboard` (its base URL). */
type RunLink = { dashboard: string; runId: string; runNumber?: number | null };
const runUrl = (input: RunLink) => `${input.dashboard}/runs/${input.runId}`;
const knownRunNumber = (value: number | null | undefined) =>
  Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;

export function runBanner(input: RunLink & { name: string }): string {
  // Keep a custom name on one terminal line; the captured run name itself is preserved.
  const name = sanitize(input.name)
    .replace(/[\r\n\t]/g, ' ')
    // eslint-disable-next-line no-control-regex -- terminal control characters must not come from a custom display name
    .replace(/[\x00-\x1f\x7f]/g, '');
  const number = knownRunNumber(input.runNumber);
  return `Dashboard run${number ? ` #${number}` : ''}: ${name}\n${runUrl(input)}`;
}

/** The prefix of the machine-readable run line on stdout (Launcher integration). */
export const RUN_ANNOUNCEMENT_PREFIX = '@intent-run ';
/** One stdout line for tools that start the engine: `@intent-run {"runId":…,"runNumber":…,"url":…}`. */
export function runAnnouncement(input: RunLink): string {
  return `${RUN_ANNOUNCEMENT_PREFIX}${JSON.stringify({
    runId: input.runId,
    runNumber: knownRunNumber(input.runNumber),
    url: runUrl(input),
  })}`;
}
