// A Decider for any "System One" endpoint: TypeSafe Jev, Cloudflare Clef / Clef-flash, llama.cpp's /v1/systemone.
// Request:  { model?, state, images?, questions: { <id>: { type: "choice" | "noul", instructions, criteria } } }
//           Screenshots only for a model that reads them; every question sees all of them. vllm-sr's d3 takes `images`
//           (data URLs). TypeSafe Jev takes `assets: { <ref>: { type: "image", format, data_base64 } }`, with the ref in
//           the state and the `TypeSafe-Danger-Zone-Images: true` header (docs.typesafe.ai/images).
// Response: { model, answers: { <id>: { choice, confidence, probabilities } | { noul } }, usage: { input_tokens } },
//           possibly wrapped in Cloudflare's { result: …, success } envelope.
// Criteria are left out rather than sent as null: Cloudflare rejects a null yes/no criteria.
import { randomUUID } from 'node:crypto';
import { postJson } from './http.ts';
import type { Decider, DecisionCall } from './types.ts';

export type SystemOneOptions = {
  name: string;
  url: string;
  apiKey?: string;
  /** Header for the key; default `Authorization: Bearer`. */
  apiKeyHeader?: string;
  /** Sent as `model`, unless empty (the URL already names it, e.g. on Cloudflare). */
  model: string;
  /** Whether to put `model` in the request body. */
  sendModel: boolean;
  maxOptions: number;
  maxStateTokens?: number;
  usdPerMInput: number;
  timeoutMs?: number;
  /** Fail when the answer names another model, e.g. when the server routes an alias to a newer model. */
  requireModel?: boolean;
  /** How screenshots are sent: an `images` list (default) or TypeSafe's `assets` map. */
  images?: 'inline' | 'assets';
};

type Answer = {
  choice?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
  noul?: number;
};
type Response = {
  model?: string;
  answers: Record<string, Answer>;
  usage?: { input_tokens?: number };
};

export function systemOne(o: SystemOneOptions): Decider {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (o.apiKey) {
    if (o.apiKeyHeader) headers[o.apiKeyHeader] = o.apiKey;
    else headers.Authorization = `Bearer ${o.apiKey}`;
  }

  const post = ({ body, headers: extra }: { body: unknown; headers?: Record<string, string> }) =>
    postJson(
      { name: o.name, url: o.url, headers: { ...headers, ...extra }, body, timeoutMs: o.timeoutMs },
      (json, text): Response => {
        // Cloudflare wraps the model output: { result: {...}, success: true, errors: [] }.
        const res: Response =
          json && typeof json === 'object' && 'result' in json && !('answers' in json)
            ? json.result
            : json;
        if (!res?.answers) throw new Error(`${o.name}: unexpected response: ${text.slice(0, 300)}`);
        if (o.requireModel && res.model !== o.model)
          throw new Error(
            `${o.name}: asked for ${o.model}, answered by ${res.model ?? 'an unnamed model'}`,
          );
        return res;
      },
    );

  const base = (q: unknown, state: unknown, images?: string[]) => {
    const model = o.sendModel ? { model: o.model } : {};
    if (!images?.length) return { body: { ...model, state, questions: q } };
    if (o.images !== 'assets') return { body: { ...model, state, images, questions: q } };
    // A fresh reference per image: TypeSafe resolves it wherever it appears in the state, instructions or criteria.
    const assets: Record<string, { type: 'image'; format: string; data_base64: string }> = {};
    const refs = images.map((url) => {
      const m = /^data:image\/(png|jpe?g);base64,(.+)$/.exec(url);
      if (!m) throw new Error(`${o.name}: screenshots must be PNG or JPEG data URLs`);
      const ref = randomUUID();
      assets[ref] = { type: 'image', format: m[1], data_base64: m[2] };
      return ref;
    });
    const shots = refs.length === 1 ? { screenshot: refs[0] } : { screenshots: refs };
    const withShots =
      state && typeof state === 'object' && !Array.isArray(state)
        ? { ...state, ...shots }
        : { page: state, ...shots };
    return {
      body: { ...model, state: withShots, assets, questions: q },
      headers: { 'TypeSafe-Danger-Zone-Images': 'true' },
    };
  };

  return {
    name: o.name,
    model: o.model,
    host: new URL(o.url).host,
    limits: { maxOptions: o.maxOptions, maxStateTokens: o.maxStateTokens },
    pricing: { usdPerMInput: o.usdPerMInput },

    async choose(state, instructions, options, images): Promise<DecisionCall> {
      const { res, latencyMs } = await post(
        base({ target: { type: 'choice', instructions, criteria: options } }, state, images),
      );
      const a = res.answers.target ?? {};
      return {
        type: 'choice',
        instructions,
        latencyMs,
        inputTokens: res.usage?.input_tokens ?? 0,
        model: res.model ?? o.model,
        choice: a.choice,
        confidence: a.confidence,
        probabilities: { ...(a.probabilities ?? {}) },
        ...(images?.length ? { images: images.length } : {}),
      };
    },

    async yesNo(state, instructions, criteria, images): Promise<DecisionCall> {
      const { res, latencyMs } = await post(
        base(
          { claim: { type: 'noul', instructions, ...(criteria ? { criteria } : {}) } },
          state,
          images,
        ),
      );
      return {
        type: 'yesno',
        instructions,
        latencyMs,
        inputTokens: res.usage?.input_tokens ?? 0,
        model: res.model ?? o.model,
        yes: res.answers.claim?.noul,
        ...(images?.length ? { images: images.length } : {}),
      };
    },
  };
}
