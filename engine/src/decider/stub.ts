// A deterministic, in-process Decider for the engine's self-tests (AT_DECIDER=stub): no network, no API key, the same
// answer every time. It is not a decision model and is only good enough for tests written for it:
// - choose: the option whose description contains the most quoted labels of the step ("…"), then the most other words
//   of the step; a tie or no match at all answers "none".
// - yesNo: yes when every quoted text of the statement is on the page; a statement without quotes is taken as true.
import type { Decider, DecisionCall } from './types.ts';

const NONE = 'none';
const STOP = new Set([
  'the',
  'a',
  'an',
  'in',
  'on',
  'of',
  'for',
  'to',
  'with',
  'and',
  'or',
  'is',
  'are',
  'it',
  'its',
  'this',
  'that',
  'button',
  'field',
  'link',
  'checkbox',
  'dropdown',
  'box',
  'action',
  'row',
  'where',
  'click',
  'step',
]);

const quoted = (s: string): string[] =>
  [...s.matchAll(/"([^"]+)"/g)].map((m) => m[1].toLowerCase());
const words = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/"[^"]*"/g, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1 && !STOP.has(w));

/** The step text the runner put in the state (element questions) or the instructions (dropdown options). */
function stepOf(state: unknown, instructions: string): string {
  const s = state as { step?: unknown; wanted?: unknown } | null;
  if (typeof s?.step === 'string') return s.step;
  if (typeof s?.wanted === 'string') return `"${s.wanted}"`;
  return instructions;
}

function call(
  type: DecisionCall['type'],
  instructions: string,
  extra: Partial<DecisionCall>,
): DecisionCall {
  return { type, instructions, latencyMs: 0, inputTokens: 0, model: 'stub', ...extra };
}

export function stubDecider(): Decider {
  return {
    name: 'stub',
    model: 'stub',
    host: 'local',
    limits: { maxOptions: 255 },
    pricing: { usdPerMInput: 0 },

    async choose(state, instructions, options) {
      const step = stepOf(state, instructions);
      const labels = quoted(step);
      const stepWords = words(step);
      const scored = Object.entries(options)
        .filter(([id]) => id !== NONE)
        .map(([id, description]) => {
          const d = description.toLowerCase();
          const labelHits = labels.filter((l) => d.includes(l)).length;
          const wordHits = stepWords.filter((w) => d.includes(w)).length;
          return { id, ok: labelHits > 0 || wordHits > 0, score: labelHits * 100 + wordHits };
        })
        .filter((c) => c.ok)
        .sort((a, b) => b.score - a.score);
      const best = scored[0];
      const unique = best && (scored.length === 1 || scored[1].score < best.score);
      const choice = unique ? best.id : NONE;
      const probabilities: Record<string, number> = Object.fromEntries(
        Object.keys(options).map((id) => [id, 0]),
      );
      probabilities[choice] = 1;
      return call('choice', instructions, { choice, confidence: 1, probabilities });
    },

    async yesNo(state, instructions) {
      const s = state as { assertion?: unknown; page?: unknown } | null;
      const statement = typeof s?.assertion === 'string' ? s.assertion : instructions;
      // The page comes as text, fields and actions (snapshot.ts PageText); searching its JSON covers all of them.
      const page = JSON.stringify(s?.page ?? '').toLowerCase();
      const yes = quoted(statement).every((q) => page.includes(q)) ? 1 : 0;
      return call('yesno', instructions, { yes });
    },
  };
}
