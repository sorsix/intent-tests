// Builds the configured decision model: AT_DECIDER, else the app config's `decider`, else "jev"; then overrides. See presets.ts.
import { withFailureDiagnosis } from '../failure.ts';
import { appConfig } from '../app-config.ts';
import { loadEnv } from '../env.ts';
import { presets as builtIn, type Preset } from './presets.ts';
import { loggingEnabled, withLogging } from './log.ts';
import { openAIDecisions } from './openai.ts';
import { stubDecider } from './stub.ts';
import { systemOne } from './systemone.ts';
import type { Decider, DecisionCall } from './types.ts';

/** The built-in presets plus the app config's own `presets` (an app's preset of the same name wins). */
const presets = (): Record<string, Preset> => ({ ...builtIn, ...appConfig.presets });

export type { Decider, DecisionCall } from './types.ts';

export type ImageMode = 'off' | 'always' | 'fallback';
export type DeciderSettings = Preset & {
  name: string;
  apiKey?: string;
  imageMode: ImageMode;
  sendImages: boolean;
};

const num = (name: string): number | undefined =>
  process.env[name] ? Number(process.env[name]) : undefined;

/**
 * The models a person can choose (every preset but the self-test stub), the one a run uses by default, and the
 * variables each still needs, for local tools such as the Launcher. Names of variables only, never their values.
 */
export function deciderChoices() {
  loadEnv();
  const needs = (preset: Preset) => [
    ...[...preset.url.matchAll(/\$\{(\w+)\}/g)].map((match) => match[1]),
    ...(preset.apiKeyEnv && !process.env.AT_DECIDER_API_KEY ? [preset.apiKeyEnv] : []),
  ];
  return {
    default: process.env.AT_DECIDER || appConfig.decider || 'jev',
    options: Object.entries(presets())
      .filter(([, preset]) => preset.protocol !== 'stub')
      .map(([name, preset]) => ({
        name,
        description: preset.description,
        missing: needs(preset).filter((name) => !process.env[name]),
      })),
  };
}

/** Resolves the preset and overrides. Throws a clear error for an unknown preset or a missing variable. */
export function deciderSettings(): DeciderSettings {
  loadEnv();
  const name = process.env.AT_DECIDER || appConfig.decider || 'jev';
  const all = presets();
  const preset = all[name];
  if (!preset)
    throw new Error(
      `Decision model "${name}" (AT_DECIDER or the app config's decider) is not known. Use one of: ${Object.keys(all).join(', ')}`,
    );

  const url = (process.env.AT_DECIDER_URL || preset.url).replace(/\$\{(\w+)\}/g, (_, v) => {
    if (!process.env[v])
      throw new Error(`AT_DECIDER=${name} needs ${v}. Set it in intent-tests/.env or your shell.`);
    return process.env[v]!;
  });
  const apiKey =
    process.env.AT_DECIDER_API_KEY ||
    (preset.apiKeyEnv ? process.env[preset.apiKeyEnv] : undefined);
  if (preset.apiKeyEnv && !apiKey) {
    throw new Error(
      `AT_DECIDER=${name} needs ${preset.apiKeyEnv} (or AT_DECIDER_API_KEY). Set it in the ignored intent-tests/.env or your shell, never in a committed file.`,
    );
  }
  const raw = process.env.AT_DECIDER_IMAGES?.trim() || preset.defaultImageMode || 'false';
  const imageMode: ImageMode =
    raw === 'true' || raw === 'always'
      ? 'always'
      : raw === 'fallback'
        ? 'fallback'
        : raw === 'false'
          ? 'off'
          : (() => {
              throw new Error(
                `AT_DECIDER_IMAGES=${raw} is not known. Use true (always), fallback or false.`,
              );
            })();
  if (imageMode !== 'off') {
    const modes = (p: Preset) => (p.images ? (p.imageModes ?? ['always', 'fallback']) : []);
    if (!modes(preset).includes(imageMode)) {
      const fit = Object.keys(all).filter((p) => modes(all[p]).includes(imageMode));
      throw new Error(
        `AT_DECIDER_IMAGES=${raw} needs a decision model that reads screenshots${imageMode === 'always' ? ' on every question' : ''}; ${name} does not${preset.images ? ` (it supports ${modes(preset).join(', ')})` : ''}. Use one of: ${fit.join(', ')}`,
      );
    }
  }
  const sendImages = imageMode !== 'off';
  return {
    ...preset,
    name,
    url,
    apiKey,
    imageMode,
    sendImages,
    model: process.env.AT_DECIDER_MODEL || preset.model,
    maxOptions: num('AT_DECIDER_MAX_OPTIONS') ?? preset.maxOptions,
    usdPerMInput: num('AT_DECIDER_USD_PER_M_INPUT') ?? preset.usdPerMInput,
    choiceThreshold:
      num('AT_CHOICE_THRESHOLD') ?? appConfig.choiceThreshold ?? preset.choiceThreshold,
    yesNoThreshold: num('AT_YESNO_THRESHOLD') ?? appConfig.yesNoThreshold ?? preset.yesNoThreshold,
  };
}

/**
 * A choice's confidence is the probability of the option it picked, whatever the server calls "confidence": models compute
 * it differently (Clef and d1: the pick's probability; Jev, Perplexity and Microsoft: sometimes lower; an entropy-based model
 * would report 0.53 for a 90% pick), and the 0.8 threshold only means the same thing for every model on that number.
 * The server's own value is kept in `reportedConfidence`.
 */
export function pickProbability(call: DecisionCall): DecisionCall {
  const p = call.choice !== undefined ? call.probabilities?.[call.choice] : undefined;
  if (p === undefined || p === call.confidence) return call;
  return { ...call, confidence: p, reportedConfidence: call.confidence };
}

export function withPickProbability(inner: Decider): Decider {
  return {
    ...inner,
    async choose(state, instructions, options, images) {
      return pickProbability(await inner.choose(state, instructions, options, images));
    },
  };
}

let decider: Decider | null = null;

export function getDecider(): Decider {
  if (decider) return decider;
  const s = deciderSettings();
  decider =
    s.protocol === 'stub'
      ? stubDecider()
      : s.protocol === 'openai-decisions'
        ? openAIDecisions({
            name: s.name,
            url: s.url,
            apiKey: s.apiKey,
            model: s.model,
            maxOptions: s.maxOptions,
            maxStateTokens: s.maxStateTokens,
            usdPerMInput: s.usdPerMInput,
          })
        : systemOne({
            name: s.name,
            url: s.url,
            apiKey: s.apiKey,
            apiKeyHeader: s.apiKeyHeader,
            model: s.model,
            // An explicit AT_DECIDER_MODEL is always sent, so a custom endpoint can route on it.
            sendModel: s.sendModel || !!process.env.AT_DECIDER_MODEL,
            maxOptions: s.maxOptions,
            maxStateTokens: s.maxStateTokens,
            usdPerMInput: s.usdPerMInput,
            requireModel: s.requireModel,
            timeoutMs: s.timeoutMs,
            images: s.images,
          });
  decider = withFailureDiagnosis(withPickProbability(decider));
  if (loggingEnabled()) decider = withLogging(decider);
  return decider;
}
