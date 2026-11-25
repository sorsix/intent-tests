import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SuitePayload } from './catalog.ts';
import type { ArtifactJob, Envelope, Event } from './spool.ts';
import { DashboardAuth } from './auth.ts';

/** A non-2xx dashboard answer. The message format is unchanged; status and the parsed JSON body are attached. */
export class DashboardHttpError extends Error {
  status: number;
  body?: Record<string, unknown>;
  constructor(status: number, text: string) {
    super(`Dashboard HTTP ${status}: ${text.slice(0, 300)}`);
    this.name = 'DashboardHttpError';
    this.status = status;
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        this.body = parsed as Record<string, unknown>;
    } catch {
      // Not JSON (a proxy page): only the message describes it.
    }
  }
  /** A client error the same request will keep getting (not 408 Request Timeout or 429 Too Many Requests). */
  get permanent(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 429;
  }
}

export class DashboardClient {
  url: string;
  timeoutMs: number;
  private auth = new DashboardAuth();
  constructor(url: string, timeoutMs = 2500) {
    this.url = url.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
  }
  async request(
    path: string,
    body: string | FormData,
    timeoutMs = this.timeoutMs,
  ): Promise<Record<string, unknown>> {
    const token = await this.auth.token();
    const origin = new URL(this.url);
    if (
      token &&
      origin.protocol !== 'https:' &&
      !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
    )
      throw new Error('Dashboard authentication requires HTTPS or loopback');
    const response = await fetch(`${this.url}${path}`, {
      method: 'POST',
      body,
      redirect: 'error',
      headers: {
        ...(typeof body === 'string' ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) throw new DashboardHttpError(response.status, text);
    return JSON.parse(text) as Record<string, unknown>;
  }
  ingest(envelope: Envelope, events: Event[]) {
    // Serialize once; retries are performed by the persistent spool without changing event ids or timestamps.
    return this.request('/api/ingest/events', JSON.stringify({ ...envelope, events }));
  }
  // A whole app's suite is about 1 MB (115 cases) but large apps reach 20 MB (portal limit 64 MiB); the portal
  // stores it in one transaction, so the timeout grows with the body. Runs wait for it before starting.
  publishSuite(payload: SuitePayload) {
    const body = JSON.stringify(payload);
    const perMiB = 5_000;
    return this.request(
      '/api/ingest/suite',
      body,
      Math.max(
        this.timeoutMs,
        30_000 + Math.ceil(Buffer.byteLength(body) / (1024 * 1024)) * perMiB,
      ),
    );
  }
  upload(dir: string, runId: string, job: ArtifactJob) {
    const query = new URLSearchParams({
      runId,
      clientArtifactId: job.clientArtifactId,
      kind: job.kind,
    });
    if (job.clientTestId) {
      query.set('clientTestId', job.clientTestId);
      query.set('attempt', String(job.attempt ?? 1));
    }
    if (job.clientStepId) query.set('clientStepId', job.clientStepId);
    const form = new FormData();
    form.append(
      'file',
      new Blob([readFileSync(join(dir, job.path))], { type: job.contentType }),
      job.filename,
    );
    // Traces of long tests reach 10+ MB, which take longer than the event timeout to send.
    return this.request(`/api/ingest/artifacts?${query}`, form, Math.max(this.timeoutMs, 60_000));
  }
}
export function batches(envelope: Envelope, events: Event[]): Event[][] {
  const batches: Event[][] = [];
  let batch: Event[] = [],
    bytes = Buffer.byteLength(JSON.stringify(envelope)) + 30;
  for (const event of events) {
    const size = Buffer.byteLength(JSON.stringify(event)) + 1;
    if (size > 6 * 1024 * 1024) throw new Error('A dashboard event exceeds 6 MiB');
    if (batch.length && (batch.length === 200 || bytes + size > 6 * 1024 * 1024)) {
      batches.push(batch);
      batch = [];
      bytes = Buffer.byteLength(JSON.stringify(envelope)) + 30;
    }
    batch.push(event);
    bytes += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}
