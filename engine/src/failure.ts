// Failure metadata is observational: keep the original thrown value, message and outcome intact.
import type { Decider } from './decider/types.ts';
export type FailureKind =
  | 'setup'
  | 'seed'
  | 'model-transport'
  | 'target-not-found'
  | 'low-confidence'
  | 'assertion'
  | 'browser'
  | 'unknown';
export type Failure = {
  kind: FailureKind;
  summary: string;
  origin: 'runner' | 'inferred';
  detail?: string;
};
const failures = new WeakMap<object, Failure>();
const summaries: Record<FailureKind, string> = {
  setup: 'Session setup failed',
  seed: 'Test data setup failed',
  'model-transport': 'Decision model request failed',
  'target-not-found': 'Target could not be resolved',
  'low-confidence': 'Model confidence was below the required threshold',
  assertion: 'Expected page assertion was not confirmed',
  browser: 'Browser operation failed',
  unknown: 'Execution failed without a specific diagnosis',
};
export function markFailure(error: unknown, kind: FailureKind, summary = summaries[kind]): void {
  if (kind === 'unknown' && error instanceof Error && error.name === 'TimeoutError') {
    kind = 'browser';
    summary = summaries.browser;
  }
  if (error && typeof error === 'object' && !failures.has(error))
    failures.set(error, {
      kind,
      summary,
      origin: 'runner',
      detail: error instanceof Error ? error.message : String(error),
    });
}
export function failureFor(error: unknown, fallback: FailureKind = 'unknown'): Failure {
  if (error && typeof error === 'object' && failures.has(error)) return failures.get(error)!;
  const kind = error instanceof Error && error.name === 'TimeoutError' ? 'browser' : fallback;
  return {
    kind,
    summary: summaries[kind],
    origin: 'runner',
    detail: error instanceof Error ? error.message : String(error),
  };
}
export function withFailureDiagnosis(inner: Decider): Decider {
  return {
    ...inner,
    async choose(state, instructions, choices, images) {
      try {
        return await inner.choose(state, instructions, choices, images);
      } catch (error) {
        markFailure(error, 'model-transport');
        throw error;
      }
    },
    async yesNo(state, instructions, criteria, images) {
      try {
        return await inner.yesNo(state, instructions, criteria, images);
      } catch (error) {
        markFailure(error, 'model-transport');
        throw error;
      }
    },
  };
}
