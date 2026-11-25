// AT_LOG_DECISIONS=true writes model calls with complete input to <reports>/decisions/<pid>.jsonl.
// Dashboard linkage adds immutable call ids and attempt/step context; existing request/answer fields are preserved.
// Playwright runs one test per worker process. Capture context before awaiting a call, so late completions keep it.
import { failureFor } from '../failure.ts';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { reportDir } from '../app.ts';
import type { Decider, DecisionCall } from './types.ts';

export type DecisionContext = {
  test: string;
  file: string;
  line: number;
  step: number;
  stepText: string;
  clientTestId?: string;
  attempt?: number;
  clientStepId?: string;
  pass?: string;
};

let context: DecisionContext | null = null;
let looks = 0;
let captureWarnings = 0;
export const decisionCaptureWarnings = () => captureWarnings;

/** Called before a numbered step. Existing callers can continue to supply the original context shape. */
export function setDecisionContext(ctx: DecisionContext | null): void {
  context = ctx;
  looks = 0;
}

export const loggingEnabled = (): boolean => process.env.AT_LOG_DECISIONS === 'true';

type LoggingOptions = { directory?: string };

/** Screenshots are logged by size only: the report already keeps one per step. */
const imageSizes = (images?: string[]) =>
  images?.length ? { images: images.map((i) => `${Math.round(i.length / 1000)} kB`) } : {};

/** Local recording is best effort: storage errors never change the model's return value or thrown error. */
export function withLogging(inner: Decider, options: LoggingOptions = {}): Decider {
  let file: string | null = null;
  let warned = false;
  const warn = () => {
    if (warned) return;
    warned = true;
    captureWarnings++;
    console.warn(
      '[intent-tests] Decision logging is unavailable; test execution continues without these records.',
    );
  };
  try {
    const dir = options.directory ?? resolve(reportDir(), 'decisions');
    mkdirSync(dir, { recursive: true });
    file = resolve(dir, `${process.pid}.jsonl`);
  } catch {
    warn();
  }

  const captureContext = () => context && { ...context, look: ++looks };
  const write = (
    request: object,
    ctx: ReturnType<typeof captureContext>,
    type: 'choice' | 'yesno',
    call?: DecisionCall,
    error?: unknown,
  ) => {
    if (!file) return;
    try {
      const answer = call
        ? Object.fromEntries(Object.entries(call).filter(([key]) => key !== 'instructions'))
        : undefined;
      appendFileSync(
        file,
        JSON.stringify({
          clientDecisionId: randomUUID(),
          ts: new Date().toISOString(),
          ctx,
          decider: inner.name,
          model: call?.model ?? inner.model,
          type,
          request,
          ...(answer
            ? { answer }
            : {
                failure: failureFor(error, 'model-transport'),
                error:
                  error instanceof Error
                    ? { name: error.name, message: error.message }
                    : { message: String(error) },
              }),
        }) + '\n',
      );
    } catch {
      warn();
    }
  };

  return {
    ...inner,
    async choose(state, instructions, choices, images) {
      const ctx = captureContext();
      const request = { state, instructions, options: choices, ...imageSizes(images) };
      let call: DecisionCall;
      try {
        call = await inner.choose(state, instructions, choices, images);
      } catch (error) {
        write(request, ctx, 'choice', undefined, error);
        throw error;
      }
      write(request, ctx, 'choice', call);
      return call;
    },
    async yesNo(state, instructions, criteria, images) {
      const ctx = captureContext();
      const request = { state, instructions, criteria, ...imageSizes(images) };
      let call: DecisionCall;
      try {
        call = await inner.yesNo(state, instructions, criteria, images);
      } catch (error) {
        write(request, ctx, 'yesno', undefined, error);
        throw error;
      }
      write(request, ctx, 'yesno', call);
      return call;
    },
  };
}
