// One JSON POST for the HTTP deciders, retried on network errors, timeouts, 408, 429 and 5xx.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { reportDir } from '../app.ts';
const RETRY_STATUSES = new Set([408, 429, 529]);
const MAX_RETRIES = 3;

export type PostOptions = {
  /** Decider name, for error messages. */
  name: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs?: number;
  /** First retry delay, doubled per attempt up to ten times it; 500 ms unless given. */
  retryBaseMs?: number;
};

/** `parse` turns the JSON of a 2xx response into the result; throwing there is a malformed response and is not retried. */
export async function postJson<T>(
  o: PostOptions,
  parse: (json: any, text: string) => T,
): Promise<{ res: T; latencyMs: number }> {
  const payload = JSON.stringify(o.body);
  for (let attempt = 0; ; attempt++) {
    const t0 = performance.now();
    let status: number;
    let text: string;
    try {
      const r = await fetch(o.url, {
        method: 'POST',
        headers: o.headers,
        body: payload,
        signal: AbortSignal.timeout(o.timeoutMs ?? 20_000),
      });
      status = r.status;
      // Inside the try: the connection can drop while the body is still arriving, after a 200 ("TypeError: terminated").
      text = await r.text();
    } catch (e) {
      // Network errors, timeouts and bodies cut off mid-way are retried.
      if (attempt >= MAX_RETRIES)
        throw new Error(`${o.name}: request to ${new URL(o.url).host} failed: ${e}`);
      await sleep(backoff(attempt, o.retryBaseMs));
      continue;
    }
    if (status >= 200 && status < 300) {
      const latencyMs = Math.round(performance.now() - t0);
      // A complete 2xx response that isn't the expected JSON would come back the same, so it is not retried.
      try {
        return { res: parse(JSON.parse(text), text), latencyMs };
      } catch (e) {
        // The protocol parsers already name the decider ("jev: unexpected response: …"); a JSON error doesn't.
        if (e instanceof Error && e.message.startsWith(`${o.name}:`)) throw e;
        throw new Error(
          `${o.name}: unexpected response from ${new URL(o.url).host}: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
    const retryable = RETRY_STATUSES.has(status) || status >= 500;
    if (!retryable || attempt >= MAX_RETRIES) {
      const saved = saveFailedRequest(o, payload, status, text);
      throw new Error(
        `${o.name}: HTTP ${status} from ${new URL(o.url).host} (request ${Math.round(payload.length / 1000)} kB): ${text.slice(0, 500)}${saved ? `\nRequest saved for a replay: ${saved}` : ''}`,
      );
    }
    await sleep(backoff(attempt, o.retryBaseMs));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const backoff = (attempt: number, baseMs = 500) =>
  Math.min(baseMs * 2 ** attempt, baseMs * 10) * (0.75 + Math.random() * 0.5);

/**
 * A request the decider's server rejected (HTTP 4xx/5xx after the retries) is saved next to the report, in
 * <report dir>/decider-errors/, with a curl script that sends it again: the server's maintainers can replay it as
 * is. The API key is never written; the script reads it from $DECIDER_API_KEY when the decider uses one.
 */
function saveFailedRequest(
  o: PostOptions,
  payload: string,
  status: number,
  response: string,
): string | null {
  try {
    const dir = resolve(reportDir(), 'decider-errors');
    mkdirSync(dir, { recursive: true });
    const base = `${new Date().toISOString().replace(/[:.]/g, '-')}-${o.name}-http${status}`;
    writeFileSync(join(dir, `${base}.json`), payload);
    const keyed = Object.keys(o.headers).some((h) => h.toLowerCase() === 'authorization');
    writeFileSync(
      join(dir, `${base}.sh`),
      [
        '#!/bin/sh',
        `# Replays a decision request that ${o.name} answered with HTTP ${status}:`,
        `# ${response.slice(0, 300).replace(/\s+/g, ' ')}`,
        `cd "$(dirname "$0")"`,
        `curl -sS -w '\\nHTTP %{http_code}\\n' -X POST '${o.url}' -H 'Content-Type: application/json'${keyed ? ` -H "Authorization: Bearer $DECIDER_API_KEY"` : ''} --data @'${base}.json'`,
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    return join(dir, `${base}.sh`);
  } catch {
    return null;
  }
}
