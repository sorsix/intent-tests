// Named decision-model backends. Pick one with AT_DECIDER or the app config's `decider` (default "jev"); any field can
// be overridden with AT_DECIDER_URL, AT_DECIDER_API_KEY, AT_DECIDER_MODEL, AT_DECIDER_MAX_OPTIONS, AT_DECIDER_USD_PER_M_INPUT.
// API keys and account-specific values only ever come from the environment (`apiKeyEnv`, `${VAR}` in a URL).
// An app adds its own (a self-hosted or experimental model) with the `presets` key of its intent-tests.config.ts.

export type Preset = {
  description: string;
  /** Wire format: System One (default) or OpenAI's Decisions API; 'stub' is the in-process self-test decider. */
  protocol?: 'systemone' | 'openai-decisions' | 'stub';
  /** Endpoint URL; `${VAR}` is filled from the environment. */
  url: string;
  /** Env var holding the API key, if the backend needs one. */
  apiKeyEnv?: string;
  /** Header carrying the API key; default is `Authorization: Bearer <key>`. */
  apiKeyHeader?: string;
  model: string;
  /** Whether `model` goes in the request body (Cloudflare names the model in the URL instead). */
  sendModel: boolean;
  maxOptions: number;
  maxStateTokens?: number;
  usdPerMInput: number;
  /** How the model takes screenshots, so AT_DECIDER_IMAGES=true can send them: 'inline' as data URLs in the request
   *  (a System One `images` list for vllm-sr, `input_image` parts for OpenAI Decisions), 'assets' as TypeSafe's opt-in
   *  `assets` map referenced from the state. */
  images?: 'inline' | 'assets';
  /** Longest screenshot side the model accepts; a larger viewport is captured scaled down to fit. */
  maxImageSide?: number;
  /** AT_DECIDER_IMAGES modes the model is used with; default both. 'always': a screenshot with every element, condition
   *  and `expect` question; 'fallback': only when a text-only element choice is below the threshold. */
  imageModes?: ('always' | 'fallback')[];
  /** Screenshot mode when AT_DECIDER_IMAGES is not set; default none (text only). */
  defaultImageMode?: 'always' | 'fallback';
  /** Fail a call that another model answered (the server may route an alias elsewhere). */
  requireModel?: boolean;
  /** Per-request timeout; default 20 s. */
  timeoutMs?: number;
  /** Default thresholds for this model; the app config, then AT_CHOICE_THRESHOLD / AT_YESNO_THRESHOLD override them. */
  choiceThreshold: number;
  yesNoThreshold: number;
};

const cloudflare = (model: string) =>
  `https://api.cloudflare.com/client/v4/accounts/\${CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/cloudflare/${model}`;

export const presets: Record<string, Preset> = {
  jev: {
    description: 'TypeSafe Jev (api.typesafe.ai)',
    url: 'https://api.typesafe.ai/v1/systemone',
    apiKeyEnv: 'TYPESAFE_API_KEY',
    model: 'jev-latest',
    sendModel: true,
    maxOptions: 255,
    maxStateTokens: 32_000,
    usdPerMInput: 0.042,
    // Jev 1.13+ reads images behind the TypeSafe-Danger-Zone-Images header (docs.typesafe.ai/images, experimental):
    // PNG/JPEG, 280-1568 px a side, so a 1600x1000 viewport is captured at 98%. Fallback only: with a screenshot on
    // every question (a full suite run, 28 Oct 2026) jev-1.14.0 doubted visible, exactly named elements (choices 0.99 → 0.94)
    // and failed 34 tests that pass text-only. Fallback by default: one case's "click the "Submit" button" stayed at
    // 0.50-0.78 text-only once the date field's calendar button was listed, and resolved at 0.92 with the screenshot.
    images: 'assets',
    maxImageSide: 1568,
    imageModes: ['fallback'],
    defaultImageMode: 'fallback',
    choiceThreshold: 0.8,
    yesNoThreshold: 0.8,
  },
  // OpenAI's Decisions API (public beta since 6 Oct 2026): input tokens only, no caching. Its answers come back as
  // exactly 0 or 1 whenever the model is clear, so the thresholds act as a pass/fail switch. Not validated yet.
  openai: {
    description: 'OpenAI Decisions API (gpt-6-luna)',
    protocol: 'openai-decisions',
    url: 'https://api.openai.com/v1/decisions',
    apiKeyEnv: 'OPENAI_API_KEY',
    model: 'gpt-6-luna',
    sendModel: true,
    maxOptions: 255,
    usdPerMInput: 0.1,
    // gpt-6-luna reads images as data URLs (the docs give no size or format limit; the runner sends JPEG). Fallback
    // only, and on by default like jev and d3-ultra; AT_DECIDER_IMAGES=false keeps it text only.
    images: 'inline',
    imageModes: ['fallback'],
    defaultImageMode: 'fallback',
    // OpenAI keeps about a third for "none" when only one or two elements match the step (the right field at 0.65 to
    // 0.67), and rates multi-part checks around 0.6 to 0.7. In the full suite runs of 8 October 2026 every answer it gave
    // between 0.6 and 0.8 matched Jev's on the same step (7 of 7), and false checks stay near 0, so 0.6.
    choiceThreshold: 0.6,
    yesNoThreshold: 0.6,
  },
  // Microsoft-Decision-1 (post-trained Qwen3.5-9B) on Microsoft Foundry: a System One endpoint, $0.042 per million input
  // tokens, output free. Auth is an `api-key` header (MICROSOFT_FOUNDRY_KEY). The request's `model` is the name of the
  // Foundry *deployment* (here "Decision-1"), not the model: set AT_DECIDER_MODEL if yours is called something else.
  // Not validated yet; Microsoft gives no thresholds, so it starts at 0.8 / 0.8.
  microsoft: {
    description:
      'Microsoft-Decision-1 on Microsoft Foundry (MICROSOFT_FOUNDRY_ENDPOINT, e.g. https://<resource>.services.ai.azure.com)',
    url: '${MICROSOFT_FOUNDRY_ENDPOINT}/providers/microsoft/v1/systemone',
    apiKeyEnv: 'MICROSOFT_FOUNDRY_KEY',
    apiKeyHeader: 'api-key',
    model: 'Decision-1',
    sendModel: true,
    maxOptions: 255,
    usdPerMInput: 0.042,
    choiceThreshold: 0.8,
    yesNoThreshold: 0.8,
  },
  // vllm-sr Decision 3.0, the 27B model, on the free hosted API (decision.vllm-sr.ai; keys at /keys). It reads text,
  // images and video. The service logs requests, so use it only with test data. `d3-turbo` and `d3` are aliases the
  // server reroutes over time, so the preset names d3-ultra and fails on an answer from another model.
  // Not validated yet: 0.8 / 0.8 like the other System One models.
  'd3-ultra': {
    description: 'vllm-sr Decision 3.0 d3-ultra (decision.vllm-sr.ai)',
    url: 'https://decision.vllm-sr.ai/v1/systemone',
    apiKeyEnv: 'VLLM_SR_API_KEY',
    model: 'vllm-sr/d3-ultra',
    sendModel: true,
    maxOptions: 255,
    maxStateTokens: 32_000,
    usdPerMInput: 0,
    images: 'inline',
    // Fallback by default: text-only d3-ultra picks some elements below the threshold (the Participant details row icon
    // at ~0.64), and the screenshot rescued 68 of 112 passing tests (full run, 29 Oct 2026). AT_DECIDER_IMAGES=false
    // turns it off.
    defaultImageMode: 'fallback',
    requireModel: true,
    // The server gives up after 35 s.
    timeoutMs: 40_000,
    choiceThreshold: 0.8,
    yesNoThreshold: 0.8,
  },
  'clef-flash': {
    description: 'Cloudflare Workers AI, Clef-flash',
    url: cloudflare('clef-flash'),
    apiKeyEnv: 'CLOUDFLARE_API_TOKEN',
    model: 'clef-flash',
    sendModel: false,
    maxOptions: 255,
    maxStateTokens: 64_000,
    usdPerMInput: 0.09,
    choiceThreshold: 0.8,
    // Its open weights, run locally, need 0.7 for checks (lowest correct check in a full suite run: 0.72).
    yesNoThreshold: 0.7,
  },
  clef: {
    description: 'Cloudflare Workers AI, Clef',
    url: cloudflare('clef'),
    apiKeyEnv: 'CLOUDFLARE_API_TOKEN',
    model: 'clef',
    sendModel: false,
    maxOptions: 255,
    maxStateTokens: 64_000,
    usdPerMInput: 0.24,
    choiceThreshold: 0.8,
    yesNoThreshold: 0.8,
  },
  /** Any model already running on a llama.cpp server; name it with AT_DECIDER_MODEL. */
  llamacpp: {
    description: 'Local llama.cpp server you started yourself',
    url: 'http://localhost:8080/v1/systemone',
    model: 'ggml-org/Kev-4B-GGUF',
    sendModel: true,
    maxOptions: 255,
    usdPerMInput: 0,
    choiceThreshold: 0.8,
    yesNoThreshold: 0.8,
  },
  // The engine's self-tests (npm run test:self): deterministic, offline, free. Not a model; see stub.ts.
  stub: {
    description: 'Deterministic stub for the self-tests (quoted labels, no model)',
    protocol: 'stub',
    url: 'stub://local',
    model: 'stub',
    sendModel: false,
    maxOptions: 255,
    usdPerMInput: 0,
    choiceThreshold: 0.8,
    yesNoThreshold: 0.8,
  },
};
