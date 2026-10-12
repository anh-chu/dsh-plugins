/**
 * The judge client and the one shared limiter.
 *
 * Two rules come from SPEC.md and docs/CONTRACT.md:
 *
 * 1. The call never throws. Every failure returns `null` and leaves a typed,
 *    machine-readable `lastError`, because every call site is fail-open and
 *    "the plugin did nothing" must stay distinguishable from "the judge said no".
 * 2. One limiter serves every module. All of them share one endpoint and one
 *    credential, so serialising through a single lane is the only thing that
 *    keeps a burst of concurrent judgments from tripping the rate limit for
 *    everyone.
 *
 * The retry policy belongs to the limiter, not to the caller: `run(fn)` looks at
 * the response `fn` returned and retries 429 and 529 with backoff, honouring
 * `Retry-After`. Everything else is returned to the caller as-is.
 *
 * @module dsh-jev-layer-core/judge
 */
import {
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  SETTING_KEYS,
  isRecord,
  readNumber,
  readString,
} from './settings.js';

/** Extra retries after the first attempt for a transient status. */
const MAX_RETRIES = 3;

/** Base delay for exponential backoff, in milliseconds. */
const BASE_DELAY_MS = 250;

/** Ceiling for a single backoff delay, in milliseconds. */
const MAX_DELAY_MS = 4_000;

/**
 * Read a `Retry-After` header in the delta-seconds form.
 *
 * The HTTP-date form is rare here, and guessing a date wrong is worse than
 * falling back to backoff.
 *
 * @param {{ get?: (name: string) => string | null } | undefined} headers response headers.
 * @returns {number | undefined} the delay in milliseconds, or `undefined`.
 */
export function parseRetryAfter(headers) {
  if (headers === undefined || headers === null || typeof headers.get !== 'function') return undefined;
  const raw = headers.get('retry-after');
  if (raw === undefined || raw === null) return undefined;
  const seconds = Number(String(raw).trim());
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(seconds * 1_000, MAX_DELAY_MS);
}

/**
 * Create the shared serialized lane.
 *
 * Calls queue in arrival order and finish one at a time. A throwing `fn` rejects
 * that caller only; the lane is released in `finally`, so the next caller still
 * runs.
 *
 * @param {object} [options] limiter options.
 * @param {(ms: number, result?: unknown) => Promise<void>} [options.sleep] injected delay.
 * @returns {{ run: <T>(fn: (attempt: number) => Promise<T> | T) => Promise<T> }} the limiter.
 */
export function createLimiter(options = {}) {
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const maxRetries = options.maxRetries ?? MAX_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? MAX_DELAY_MS;
  let lane = Promise.resolve();

  async function run(fn) {
    const previous = lane;
    let release;
    lane = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      let attempt = 0;
      for (;;) {
        const result = await fn(attempt);
        const status = isRecord(result) ? result.status : undefined;
        const transient = status === 429 || status === 529;
        if (!transient || attempt >= maxRetries) return result;
        const delay =
          parseRetryAfter(result.headers) ?? Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
        await sleep(delay, result);
        attempt += 1;
      }
    } finally {
      release();
    }
  }

  return { run };
}

/**
 * Classify a thrown transport error.
 *
 * @param {unknown} error the thrown value.
 * @returns {'timeout' | 'aborted' | 'network'} the error kind.
 */
function transportKind(error) {
  const name = isRecord(error) || typeof error === 'object' ? error?.name : undefined;
  if (name === 'TimeoutError') return 'timeout';
  if (name === 'AbortError') return 'aborted';
  return 'network';
}

/** Describe a thrown value for a log line and for `lastError.message`. */
function describe(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Create the judge client.
 *
 * @param {object} deps injected dependencies.
 * @param {object} deps.settings the settings reader.
 * @param {Function} deps.fetchImpl the fetch implementation.
 * @param {() => number} deps.now the injected clock.
 * @param {{ run: Function }} deps.limiter the shared limiter.
 * @param {object} [deps.log] optional logger.
 * @param {string | (() => string)} [deps.apiKey] credential override; the plugin's
 *   settings reader resolves the DSH credential store into `apiKey` instead.
 * @returns {object} the judge.
 */
export function createJudge(deps) {
  const { settings, fetchImpl, now, limiter, log } = deps;
  let lastError = null;

  /** The endpoint in force. A default, never a hard-coded request target. */
  function endpoint() {
    return readString(settings, SETTING_KEYS.endpoint, DEFAULT_ENDPOINT);
  }

  /** The credential in force, re-read on every call so a fix needs no restart. */
  function apiKey() {
    const override = deps.apiKey;
    const value = typeof override === 'function' ? override() : override;
    if (typeof value === 'string' && value !== '') return value;
    return readString(settings, SETTING_KEYS.apiKey, '');
  }

  /** Whether a judgment can be attempted at all. */
  function isConfigured() {
    return endpoint() !== '' && apiKey() !== '';
  }

  /**
   * Ask the judge a batch of typed questions.
   *
   * @param {unknown} state the material to judge.
   * @param {Record<string, object>} questions typed questions by id.
   * @param {object} [opts] `{ featureId, callId, timeoutMs, failOpen, signal }`.
   * @returns {Promise<Record<string, object> | null>} the answers map by question id.
   */
  async function ask(state, questions, opts = {}) {
    const featureId = opts?.featureId ?? null;
    const failOpen = opts?.failOpen ?? null;
    const base = { featureId, failOpen, at: now() };
    lastError = null;
    try {
      if (!isConfigured()) {
        lastError = { kind: 'unconfigured', ...base };
        return null;
      }
      const ids = isRecord(questions) ? Object.keys(questions) : [];
      if (ids.length === 0) {
        lastError = { kind: 'invalid-request', message: 'no questions', ...base };
        return null;
      }
      const timeoutMs =
        typeof opts?.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
          ? opts.timeoutMs
          : readNumber(settings, SETTING_KEYS.timeoutMs, DEFAULT_TIMEOUT_MS);
      const url = endpoint();
      const model = readString(settings, SETTING_KEYS.model, DEFAULT_MODEL);
      const init = {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey()}`,
        },
        body: JSON.stringify({ state, model, questions }),
      };

      // A fresh timeout per attempt: one signal shared across retries would
      // already be expired by the second attempt.
      const response = await limiter.run(() => {
        const timeout = AbortSignal.timeout(timeoutMs);
        const signal =
          opts?.signal === undefined ? timeout : AbortSignal.any([opts.signal, timeout]);
        return fetchImpl(url, { ...init, signal });
      });

      const status = isRecord(response) ? response.status : undefined;
      if (status === 429 || status === 529) {
        lastError = { kind: 'rate-limited', status, ...base };
        return null;
      }
      if (status !== undefined && (status < 200 || status >= 300)) {
        lastError = { kind: 'http', status, ...base };
        return null;
      }

      let body;
      try {
        body = await response.json();
      } catch (error) {
        lastError = { kind: 'malformed-response', message: describe(error), ...base };
        return null;
      }
      if (!isRecord(body) || !isRecord(body.answers)) {
        lastError = {
          kind: 'malformed-response',
          message: 'response has no answers object',
          status,
          ...base,
        };
        return null;
      }
      return body.answers;
    } catch (error) {
      lastError = { kind: transportKind(error), message: describe(error), ...base };
      log?.warn?.(`[jev-core] judge ask failed: ${describe(error)}`);
      return null;
    }
  }

  return {
    ask,
    get configured() {
      return isConfigured();
    },
    get lastError() {
      return lastError;
    },
    /** The endpoint in force, for status reporting. */
    get endpoint() {
      return endpoint();
    },
    /** The model in force, for status reporting. */
    get model() {
      return readString(settings, SETTING_KEYS.model, DEFAULT_MODEL);
    },
    /** Test seam: clear `lastError` without asking. */
    reset() {
      lastError = null;
    },
  };
}
