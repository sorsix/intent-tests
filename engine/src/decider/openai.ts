// A Decider for OpenAI's Decisions API (POST /v1/decisions, public beta).
// Request:  { model, input, questions: [ { type: "choice", name, instructions, choices: [{ value, description }] }
//                                      | { type: "predicate", name, instructions } ] }
// Response: { model, answers: [ { type: "choice", name, choice, confidence, probabilities: [{ value, probability }] }
//                             | { type: "predicate", name, probability } ], usage: { input_tokens } }
// A predicate has no criteria field, so the true/false descriptions go into its instructions.
// Screenshots (AT_DECIDER_IMAGES) turn `input` into one user message: the state as `input_text`, then each screenshot
// as an `input_image` data URL (developers.openai.com/api/docs/guides/decisions).
import { postJson } from './http.ts';
import type { Decider, DecisionCall } from './types.ts';

export type OpenAIDecisionsOptions = {
  name: string;
  url: string;
  apiKey?: string;
  model: string;
  maxOptions: number;
  maxStateTokens?: number;
  usdPerMInput: number;
  timeoutMs?: number;
};

type ChoiceAnswer = {
  type: 'choice';
  name: string;
  choice?: string;
  confidence?: number;
  probabilities?: { value: string; probability: number }[];
};
type PredicateAnswer = { type: 'predicate'; name: string; probability?: number };
type Response = {
  model?: string;
  answers: (ChoiceAnswer | PredicateAnswer)[];
  usage?: { input_tokens?: number };
};

export function openAIDecisions(o: OpenAIDecisionsOptions): Decider {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (o.apiKey) headers.Authorization = `Bearer ${o.apiKey}`;

  const post = (state: unknown, question: object, images?: string[]) => {
    const text = typeof state === 'string' ? state : JSON.stringify(state);
    const input = images?.length
      ? [
          {
            role: 'user',
            content: [
              { type: 'input_text', text },
              ...images.map((url) => ({ type: 'input_image', image_url: url })),
            ],
          },
        ]
      : text;
    return postJson(
      {
        name: o.name,
        url: o.url,
        headers,
        timeoutMs: o.timeoutMs,
        body: { model: o.model, input, questions: [question] },
      },
      (json, text): Response => {
        if (!Array.isArray(json?.answers))
          throw new Error(`${o.name}: unexpected response: ${text.slice(0, 300)}`);
        return json;
      },
    );
  };

  return {
    name: o.name,
    model: o.model,
    host: new URL(o.url).host,
    limits: { maxOptions: o.maxOptions, maxStateTokens: o.maxStateTokens },
    pricing: { usdPerMInput: o.usdPerMInput },

    async choose(state, instructions, options, images): Promise<DecisionCall> {
      const choices = Object.entries(options).map(([value, description]) => ({
        value,
        description,
      }));
      const { res, latencyMs } = await post(
        state,
        { type: 'choice', name: 'target', instructions, choices },
        images,
      );
      const a = res.answers.find((x): x is ChoiceAnswer => x.type === 'choice');
      const probabilities = Object.fromEntries(
        (a?.probabilities ?? []).map((p) => [p.value, p.probability]),
      );
      return {
        type: 'choice',
        instructions,
        latencyMs,
        inputTokens: res.usage?.input_tokens ?? 0,
        model: res.model ?? o.model,
        choice: a?.choice,
        // OpenAI's `confidence` is the margin over the runner-up (0.87 vs 0.13 → 0.74), not the choice's probability as
        // in System One, so the same threshold would be much stricter (a two-option question needed 0.9). The runner's
        // thresholds are probabilities: use the chosen option's probability, and the margin only if it's missing.
        confidence:
          (a?.choice !== undefined ? probabilities[a.choice] : undefined) ?? a?.confidence,
        probabilities,
        ...(images?.length ? { images: images.length } : {}),
      };
    },

    async yesNo(state, instructions, criteria, images): Promise<DecisionCall> {
      const detail = [
        criteria?.true && `True means: ${criteria.true}`,
        criteria?.false && `False means: ${criteria.false}`,
      ]
        .filter(Boolean)
        .join('\n');
      const { res, latencyMs } = await post(
        state,
        {
          type: 'predicate',
          name: 'claim',
          instructions: detail ? `${instructions}\n${detail}` : instructions,
        },
        images,
      );
      const a = res.answers.find((x): x is PredicateAnswer => x.type === 'predicate');
      return {
        type: 'yesno',
        instructions,
        latencyMs,
        inputTokens: res.usage?.input_tokens ?? 0,
        model: res.model ?? o.model,
        yes: a?.probability,
        ...(images?.length ? { images: images.length } : {}),
      };
    },
  };
}
