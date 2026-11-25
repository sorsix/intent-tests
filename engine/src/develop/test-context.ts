// What StepRunner (src/steps.ts) reads from Playwright's TestInfo, as a structural type, and the develop session's own
// implementation of it. A run passes Playwright's TestInfo; `intent-test develop` passes a DevelopTestContext, which
// keeps the `at-step-*` JSON StepRunner attaches in memory instead of in a report; `developRecord` turns those records
// into the protocol's DevelopStepRecord.
import { failureFor } from '../failure.ts';
import type { StepRecord } from '../steps.ts';
import type { DevelopStepRecord, PageActivity } from './protocol.ts';

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The part of Playwright's `TestInfo` StepRunner uses. Playwright's own `TestInfo` satisfies it. */
export type StepTestInfo = {
  title: string;
  annotations: { type: string; description?: string }[];
  testId: string;
  retry: number;
  project: { name: string };
  attach(
    name: string,
    options?: { body?: string | Buffer; contentType?: string; path?: string },
  ): Promise<void>;
};

/** A develop session's stand-in for `TestInfo`: one per loaded case. */
export class DevelopTestContext implements StepTestInfo {
  title: string;
  annotations: { type: string; description?: string }[];
  testId: string;
  retry = 0;
  project = { name: 'develop' };
  /** The attachments StepRunner made, newest last (`at-step-<n>` holds a StepRecord as JSON). */
  attachments: { name: string; contentType?: string; body: string }[] = [];

  constructor(title: string, clientTestId: string) {
    this.title = title;
    this.testId = clientTestId;
    this.annotations = [{ type: 'at-client-test-id', description: clientTestId }];
  }

  async attach(
    name: string,
    options: { body?: string | Buffer; contentType?: string; path?: string } = {},
  ): Promise<void> {
    const body = typeof options.body === 'string' ? options.body : (options.body?.toString() ?? '');
    this.attachments.push({ name, contentType: options.contentType, body });
    // Only the latest few matter (the step that just ran); keep memory flat over a long session.
    if (this.attachments.length > 50) this.attachments.splice(0, this.attachments.length - 50);
  }

  /** Drops what was attached so far. */
  clear(): void {
    this.attachments = [];
  }
}

/** One own step's result from the records of the steps it ran (one, or a `use` block's). */
export function developRecord(
  position: number,
  records: StepRecord[],
  offered: { id: string; description: string }[],
  thrown?: unknown,
  /** The screenshot after the step and what the page reported during it (`page-activity.ts`). */
  extra: { after?: string; page?: PageActivity } = {},
): DevelopStepRecord {
  const failed = records.find((r) => r.status === 'failed');
  const pick = failed ?? records.at(-1);
  const failure = pick?.failure ?? (thrown ? failureFor(thrown) : undefined);
  const outcome = records
    .map((r) => r.outcome)
    .filter(Boolean)
    .join('; ');
  const error = pick?.error ?? (thrown ? message(thrown) : undefined);
  return {
    index: position,
    status: failed || thrown ? 'failed' : 'passed',
    durationMs: records.reduce((n, r) => n + r.durationMs, 0),
    modelMs: records.reduce((n, r) => n + r.modelMs, 0),
    ...(pick?.chosen ? { chosen: pick.chosen } : {}),
    ...(pick?.top ? { top: pick.top } : {}),
    ...(offered.length ? { candidates: offered } : {}),
    ...(outcome ? { outcome } : {}),
    ...(error ? { error } : {}),
    ...(failure
      ? {
          failure: {
            kind: failure.kind,
            summary: failure.summary,
            ...(failure.detail ? { detail: failure.detail } : {}),
          },
        }
      : {}),
    ...(pick?.screenshot ? { screenshot: pick.screenshot } : {}),
    ...(pick?.screenshotFallback ? { screenshotFallback: true } : {}),
    ...(pick?.condition ? { condition: pick.condition } : {}),
    ...(extra.after ? { after: extra.after } : {}),
    ...(extra.page ? { page: extra.page } : {}),
  };
}
