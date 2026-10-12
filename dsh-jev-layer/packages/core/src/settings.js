/**
 * Setting names, defaults and defensive reads for the core.
 *
 * docs/CONTRACT.md fixes no setting key names, so this module is where the core
 * publishes the names it reads. The plugin's config schema (owned by the
 * lifecycle ticket) must expose these exact keys; `SETTING_KEYS` is exported so
 * that schema can import them instead of inventing a second spelling.
 *
 * Rule 6 of the contract: a volatile field arrives as an object with `get()`,
 * not as a bare value. The reader injected into `createCore` is supposed to
 * unwrap already, but unwrapping twice is idempotent and cheap, and comparing a
 * marker object against a string fails silently — so every read goes through
 * `unwrap` here as well.
 *
 * @module dsh-jev-layer-core/settings
 */

/** Default System One endpoint. SPEC.md names the full path; it is never appended. */
export const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

/** Default judge model alias. */
export const DEFAULT_MODEL = 'jev-latest';

/** Default per-request timeout, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** Default shared per-turn judgment ceiling. */
export const DEFAULT_TURN_CEILING = 30;

/** Default mode when a feature does not override it. */
export const DEFAULT_MODE = 'enforce';

/** Default per-session cap on delivered notices. */
export const DEFAULT_NOTICE_SESSION_CAP = 6;

/** Default reserved sub-budget for a priority feature. */
export const DEFAULT_PRIORITY_BUDGET = 2;

/** Default minimum interval between notifications, in milliseconds. */
export const DEFAULT_NOTIFY_MIN_INTERVAL_MS = 60_000;

/** Default notification ceiling per rolling hour. */
export const DEFAULT_NOTIFY_MAX_PER_HOUR = 6;

/** The answering feature. It holds a reservation and it defaults to shadow. */
export const ANSWER_FEATURE = 'answer.questions';

/**
 * Explicit priority table.
 *
 * Priority is a declared property of a feature, never an accident of call
 * order: the answering feature outranks pruning, because a blocked question
 * blocks the agent while a missed prune only costs tokens.
 */
export const PRIORITY_FEATURES = Object.freeze({ [ANSWER_FEATURE]: 100 });

/** Logical name to the exact settings key the core reads. */
export const SETTING_KEYS = Object.freeze({
  endpoint: 'endpoint',
  model: 'model',
  timeoutMs: 'timeoutMs',
  apiKey: 'apiKey',
  turnCeiling: 'turnCeiling',
  mode: 'mode',
  noticeSessionCap: 'noticeSessionCap',
  notifyUrl: 'notify.url',
  notifyHeaders: 'notify.headers',
  notifyMinIntervalMs: 'notify.minIntervalMs',
  notifyMaxPerHour: 'notify.maxPerHour',
  /** @param {string} id feature id */
  featureMode: (id) => `${id}.mode`,
  /** @param {string} id feature id */
  featureBudget: (id) => `${id}.budget`,
  /** @param {string} id feature id */
  featurePriority: (id) => `${id}.priority`,
});

/** Whether a value is a plain object (not null, not an array). */
export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Unwrap a volatile marker chain down to the value it denotes.
 *
 * @param {unknown} value a setting value, possibly a marker object.
 * @returns {unknown} the unwrapped value.
 */
export function unwrap(value) {
  let current = value;
  // A marker chain deeper than a few links is broken input, not nesting.
  for (let guard = 0; guard < 5; guard += 1) {
    if (!isRecord(current) || typeof current.get !== 'function') break;
    current = current.get();
  }
  return current;
}

/**
 * Read one setting without ever throwing.
 *
 * @param {{ get: (key: string) => unknown } | undefined} settings the injected reader.
 * @param {string} key the exact settings key.
 * @returns {unknown} the unwrapped value, or `undefined`.
 */
export function readSetting(settings, key) {
  if (settings === undefined || settings === null || typeof settings.get !== 'function') return undefined;
  try {
    return unwrap(settings.get(key));
  } catch {
    return undefined;
  }
}

/**
 * Read a string setting.
 *
 * @param {object} settings the injected reader.
 * @param {string} key the exact settings key.
 * @param {string} fallback the value to use when the setting is absent or blank.
 * @returns {string} the resolved string.
 */
export function readString(settings, key, fallback) {
  const value = readSetting(settings, key);
  return typeof value === 'string' && value !== '' ? value : fallback;
}

/**
 * Read a finite-number setting.
 *
 * @param {object} settings the injected reader.
 * @param {string} key the exact settings key.
 * @param {number} fallback the value to use when the setting is absent or unusable.
 * @returns {number} the resolved number.
 */
export function readNumber(settings, key, fallback) {
  const value = readSetting(settings, key);
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
