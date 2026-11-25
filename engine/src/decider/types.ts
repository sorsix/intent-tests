// What the runner needs from a decision model. Any backend (Jev, Clef, a local llama.cpp model, …) plugs in
// by implementing Decider; steps.ts and the reporter only see these normalised types.

/** One model call, as recorded in the report. */
export type DecisionCall = {
  type: 'choice' | 'yesno';
  instructions: string;
  latencyMs: number;
  inputTokens: number;
  /** Model id as reported by the backend (e.g. "jev-1.13.2"). */
  model: string;
  /** Choice: picked label, its probability, and the full distribution. */
  choice?: string;
  /** Probability of the picked option. Set by the runner from `probabilities` (see `withPickProbability`), not taken from
   *  the server: models report "confidence" with different formulas (e.g. 1 - normalised entropy), the probability of the
   *  pick is the one number that means the same for every model. */
  confidence?: number;
  /** The `confidence` the server itself reported, when it differs from the pick's probability. */
  reportedConfidence?: number;
  probabilities?: Record<string, number>;
  /** Yes/no: probability that the answer is yes. */
  yes?: number;
  /** Screenshots sent with the question (AT_DECIDER_IMAGES). */
  images?: number;
};

export type Decider = {
  /** Preset name, e.g. "jev", "clef-flash", "llamacpp". */
  name: string;
  /** Model requested from the backend. */
  model: string;
  /** Endpoint host, for the report. */
  host: string;
  limits: {
    /** Most options a single Choice question accepts. */
    maxOptions: number;
    /** Approximate context size, if known. */
    maxStateTokens?: number;
  };
  pricing: { usdPerMInput: number };
  /** Picks one label from `options` (label → description). `images` are data URLs, sent only with AT_DECIDER_IMAGES. */
  choose(
    state: unknown,
    instructions: string,
    options: Record<string, string>,
    images?: string[],
  ): Promise<DecisionCall>;
  /** Probability that a yes/no question about `state` is true. */
  yesNo(
    state: unknown,
    instructions: string,
    criteria?: { true?: string; false?: string },
    images?: string[],
  ): Promise<DecisionCall>;
};
