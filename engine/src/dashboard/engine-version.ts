// The installed engine release, checked against the dashboard's supported versions before any test starts.
import { createRequire } from 'node:module';

type Environment = Record<string, string | undefined>;
export type EnginePolicy = { latest?: string | null; minimum?: string | null };
export type EngineCheck = { version: string; allowOutdated: boolean; warning?: string };

export const ENGINE_VERSION: string = (
  createRequire(import.meta.url)('@sorsix/intent-engine/package.json') as { version: string }
).version;
const release = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
export const isReleaseVersion = (value: unknown): value is string =>
  typeof value === 'string' && release.test(value);
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number),
    right = b.split('.').map(Number);
  for (let index = 0; index < 3; index++)
    if (left[index] !== right[index]) return left[index] - right[index];
  return 0;
}
export function allowOutdatedFromEnvironment(environment: Environment = process.env): boolean {
  return ['1', 'true', 'yes'].includes(
    environment.INTENT_ALLOW_OUTDATED?.trim().toLowerCase() ?? '',
  );
}

// Below the minimum stops the run unless explicitly allowed; behind the latest only warns.
// An older dashboard without a policy, or a non-release local build, skips the check.
export function checkEngineVersion(
  policy: EnginePolicy | undefined,
  allowOutdated: boolean,
  version = ENGINE_VERSION,
): EngineCheck {
  const result: EngineCheck = { version, allowOutdated };
  if (!isReleaseVersion(version) || !policy) return result;
  const { latest, minimum } = policy;
  const update = `Update @sorsix/intent-engine${isReleaseVersion(latest) ? ` to ${latest}` : ''}.`;
  if (isReleaseVersion(minimum) && compareVersions(version, minimum) < 0) {
    const message = `Intent engine ${version} is below the dashboard's minimum supported version ${minimum}.`;
    if (!allowOutdated)
      throw new Error(
        `${message} ${update} To run anyway, pass --allow-outdated or set INTENT_ALLOW_OUTDATED=1; the run is marked outdated. Tests were not started.`,
      );
    result.warning = `${message} Running anyway because outdated engines are allowed; the run is marked outdated.`;
  } else if (isReleaseVersion(latest) && compareVersions(version, latest) < 0) {
    result.warning = `Intent engine ${version} is older than the latest release ${latest}. ${update}`;
  }
  return result;
}
