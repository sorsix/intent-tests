// Tuning knobs for the runner. Precedence: env var > the app's intent-tests.config.ts > the defaults below.
import { appConfig } from './app-config.ts';
import { deciderSettings } from './decider/index.ts';
import { loadEnv } from './env.ts';

loadEnv();
const num = (name: string, fallback: number) =>
  process.env[name] ? Number(process.env[name]) : fallback;
const decider = deciderSettings();

export const config = {
  /** Minimum Choice confidence to act on an element. Below this, the step fails. Default per decision model. */
  choiceThreshold: decider.choiceThreshold,
  /** Minimum yes probability for an `expect` step to pass. Default per decision model. */
  yesNoThreshold: decider.yesNoThreshold,
  /** Per test, all steps together. Long multi-role flows need more (e.g. 15 min). */
  testTimeoutMs: num('AT_TEST_TIMEOUT_MS', appConfig.testTimeoutMs ?? 90_000),
  /** How long a step keeps re-snapshotting and re-asking before it fails (handles async UI). */
  resolveTimeoutMs: num('AT_RESOLVE_TIMEOUT_MS', appConfig.resolveTimeoutMs ?? 3000),
  /** The same for a required (not optional) step: a slow form or dialog gets this long to show its element. */
  requiredResolveTimeoutMs: num(
    'AT_REQUIRED_RESOLVE_TIMEOUT_MS',
    appConfig.requiredResolveTimeoutMs ?? 10000,
  ),
  /**
   * A step looks at the page at least this many times before it fails, even when resolveTimeoutMs is already over.
   * Slow models (several seconds per decision) would otherwise get a single look, possibly before the page loaded.
   */
  minLooks: num('AT_MIN_LOOKS', 3),
  /** Delay between retries within resolveTimeoutMs. */
  pollIntervalMs: num('AT_POLL_INTERVAL_MS', 500),
  /** Pause after each action so the UI can react before the next snapshot. */
  settleMs: num('AT_SETTLE_MS', appConfig.settleMs ?? 250),
  /** Candidates per Choice question; one option is reserved for "none". */
  maxCandidates: decider.maxOptions - 1,
  // Above this a decision request uses compact page descriptions (Jev rejected a ~129 kB request).
  maxRequestChars: Number(process.env.AT_MAX_REQUEST_CHARS || 80_000),
  /** AT_DECIDER_IMAGES: 'always' (true) sends a viewport screenshot with every element, condition and `expect`
   *  question, besides the text; 'fallback' only re-asks an element choice with one when the text-only answer is unsure. */
  imageMode: decider.imageMode,
  sendImages: decider.sendImages,
  /** Longest screenshot side the decision model accepts (Jev: 1568 px); larger viewports are captured scaled down. */
  maxImageSide: decider.maxImageSide,
  /** Max characters of visible page text sent for `expect` steps. */
  maxPageTextChars: 12000,
};
