/**
 * The dsh-jev-layer core.
 *
 * One factory, no host, no network, no filesystem unless it is given a path.
 * Every other package in this repository codes against the interface in
 * docs/CONTRACT.md, and this file is that interface.
 *
 * @module dsh-jev-layer-core
 */
import { createBudget } from './budget.js';
import { createEvents } from './events.js';
import { createJudge, createLimiter } from './judge.js';
import { createLedger, createShadow } from './ledger.js';
import { createNoticeArbiter, createNotifications } from './notice.js';
import { SETTING_KEYS } from './settings.js';

export { SETTING_KEYS, PRIORITY_FEATURES, ANSWER_FEATURE } from './settings.js';
export { createLimiter, parseRetryAfter } from './judge.js';
export { createBudget } from './budget.js';
export { createEvents } from './events.js';
export { createLedger, createShadow, deriveDecision, extractRecord, LEDGER_EVENT_TYPE } from './ledger.js';
export { createNoticeArbiter, createNotifications } from './notice.js';

/** A settings reader that answers nothing, for a caller that has none. */
const EMPTY_SETTINGS = Object.freeze({ get: () => undefined });

/**
 * Build the core.
 *
 * @param {object} [options] injected dependencies and overrides.
 * @param {{ get: (key: string) => unknown }} [options.settings] the settings reader.
 * @param {Function} [options.fetchImpl] the fetch implementation; defaults to `globalThis.fetch`.
 * @param {() => number} [options.now] the clock in milliseconds; defaults to `Date.now`.
 * @param {object} [options.log] optional logger with `warn`/`info`.
 * @param {string} [options.statePath] the JSONL ledger path, if any.
 * @param {(ms: number) => Promise<void>} [options.sleep] injected delay for the limiter.
 * @param {string | (() => string)} [options.apiKey] credential override, for tests.
 * @returns {object} the core.
 */
export function createCore(options = {}) {
  const settings = options.settings ?? EMPTY_SETTINGS;
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const log = options.log ?? null;

  const shadow = createShadow({ settings });
  const ledger = createLedger({ now, shadow, log, statePath: options.statePath });
  const notice = createNoticeArbiter({ settings, now, ledger, shadow, log });
  // One turn boundary resets both the budget and the notice turn, so "one per
  // turn" and "one ceiling per turn" can never drift apart.
  const budget = createBudget({ settings, now, onTurnStart: () => notice.beginTurn() });
  const limiter = createLimiter({ sleep: options.sleep });
  const judge = createJudge({ settings, fetchImpl, now, limiter, log, apiKey: options.apiKey });
  const notifications = createNotifications({ settings, fetchImpl, now, log });
  const events = createEvents({ log });

  /**
   * Record a decision and act on it only when the feature is not in shadow.
   *
   * This is rule 4 of docs/CONTRACT.md in one place: a feature in shadow gets
   * the would-be decision written to the ledger and no action performed.
   *
   * @param {object} request the decision and the action.
   * @param {string} request.featureId the feature id.
   * @param {string} [request.callId] the call id.
   * @param {unknown} [request.question] the question that was judged.
   * @param {Record<string, number>} [request.probabilities] the probabilities.
   * @param {number} [request.threshold] the threshold.
   * @param {string} [request.decision] an explicit decision, else derived.
   * @param {boolean|string} [request.wouldBe] what the action would have been.
   * @param {() => unknown} [request.apply] the action.
   * @returns {Promise<{ acted: boolean, record: object, result?: unknown }>} the outcome.
   */
  async function act(request = {}) {
    const featureId = String(request.featureId ?? '');
    const shadowMode = shadow.isShadow(featureId);
    const record = ledger.append({
      featureId,
      callId: request.callId,
      question: request.question,
      probabilities: request.probabilities,
      threshold: request.threshold,
      decision: request.decision,
      wouldBe: request.wouldBe ?? null,
      mode: shadowMode ? 'shadow' : 'enforce',
    });
    if (shadowMode) return { acted: false, record };
    const result = typeof request.apply === 'function' ? await request.apply(record) : undefined;
    return { acted: true, record, result };
  }

  return { judge, limiter, budget, ledger, shadow, notice, notifications, events, act, settings, now };
}

export default createCore;
