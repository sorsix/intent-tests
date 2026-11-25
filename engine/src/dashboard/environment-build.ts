// Discover the build actually serving BASE_URL. Local workspace files can refer to stale/stopped copies.
type Environment = Record<string, string | undefined>;
export type EnvironmentBuild = { id: string; endpoint?: string };
type Options = { fetcher?: typeof fetch; timeoutMs?: number };
const endpointPath = '/.well-known/intent-launch/environment';
const maxBytes = 16 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function environmentBuild(
  environment: Environment = process.env,
  { fetcher = fetch, timeoutMs = 2000 }: Options = {},
): Promise<EnvironmentBuild | undefined> {
  const explicit = environment.AT_ENVIRONMENT_BUILD_ID;
  if (explicit) return { id: explicit };
  if (!environment.BASE_URL?.trim()) return undefined;
  try {
    const target = new URL(environment.BASE_URL.trim());
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password)
      return undefined;
    const endpoint = new URL(endpointPath, target.origin).href;
    const response = await fetcher(endpoint, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    try {
      if (
        response.status !== 200 ||
        !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '') ||
        !response.body
      )
        return undefined;
      if (Number(response.headers.get('content-length')) > maxBytes) return undefined;
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = response.body.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > maxBytes) return undefined;
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      const info = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (
        info?.kind !== 'intent-launch-environment' ||
        info.schemaVersion !== 1 ||
        typeof info.buildId !== 'string' ||
        !uuid.test(info.buildId)
      )
        return undefined;
      // Send only the ID. The dashboard resolves and freezes trusted source/database details itself.
      return { id: info.buildId, endpoint };
    } finally {
      if (response.body && !response.body.locked) await response.body.cancel().catch(() => {});
    }
  } catch {
    return undefined;
  } // Older/non-Launcher apps, network/TLS failures and malformed replies stay unlinked.
}

export function environmentBuildMessage(build: EnvironmentBuild): string | undefined {
  return build.endpoint
    ? `Linked to Launcher build ${build.id} (from ${build.endpoint})`
    : undefined;
}
