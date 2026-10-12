/**
 * The judgment ledger and the shadow mode that guards every acting module.
 *
 * The ledger is a derived cache, never the source of truth (SPEC.md, principle
 * 3): the session log is. So it records exactly the shape docs/CONTRACT.md
 * fixes, it can be thrown away and rebuilt from a list of events, and a hidden
 * file appears only when `options.statePath` is given.
 *
 * Shadow mode is a property of a feature, not of a call site. A feature in
 * shadow still has its measurement recorded — with the decision it *would* have
 * taken — and performs no action. `createCore` exposes `act()` so that rule
 * lives in one place instead of being re-derived by every module.
 *
 * @module dsh-jev-layer-core/ledger
 */
import { appendFileSync } from 'node:fs';
import { SETTING_KEYS, isRecord, readString } from './settings.js';

/** The default mode for a feature that declares no mode of its own. */
const DEFAULT_MODE = 'enforce';

/** The answering feature defaults to shadow: record the answer, act on nothing. */
const DEFAULT_SHADOW_FEATURE = 'answer.questions';

/** The event type `ledger.events()` produces, and `rebuild()` accepts back. */
export const LEDGER_EVENT_TYPE = 'jev-layer/ledger';

/** The keys of a record, in the order docs/CONTRACT.md lists them. */
const RECORD_KEYS = Object.freeze([
  'featureId',
  'callId',
  'question',
  'probabilities',
  'threshold',
  'decision',
  'wouldBe',
  'reason',
  'mode',
  'at',
]);

/**
 * Derive the binary decision when a caller records only measurements.
 *
 * A record carrying several probabilities is one question with several labels
 * (a `choice`), so the strongest label is the decision. A record carrying no
 * usable probability has no derivable decision and stores `null` rather than
 * inventing one.
 *
 * @param {Record<string, number>} probabilities probabilities by label.
 * @param {number | null} threshold the decision threshold.
 * @returns {string | null} `'accept'`, `'reject'`, or `null`.
 */
export function deriveDecision(probabilities, threshold) {
  const values = Object.values(probabilities ?? {}).filter(
    (value) => typeof value === 'number' && Number.isFinite(value),
  );
  if (values.length === 0) return null;
  return Math.max(...values) >= (threshold ?? 0.5) ? 'accept' : 'reject';
}

/**
 * Create shadow-mode resolution.
 *
 * @param {object} deps injected dependencies.
 * @param {object} deps.settings the settings reader.
 * @returns {{ isShadow: (id: string) => boolean, modeOf: (id: string) => string }} the resolver.
 */
export function createShadow(deps) {
  const { settings } = deps;

  /**
   * The mode in force for a feature.
   *
   * Precedence: the feature's own `<id>.mode`, then the answering feature's
   * shadow default, then the global `mode`.
   *
   * @param {string} featureId the feature id.
   * @returns {'shadow' | 'enforce'} the mode.
   */
  function modeOf(featureId) {
    const own = readString(settings, SETTING_KEYS.featureMode(featureId), '');
    if (own === 'shadow' || own === 'enforce') return own;
    if (featureId === DEFAULT_SHADOW_FEATURE) return 'shadow';
    return readString(settings, SETTING_KEYS.mode, DEFAULT_MODE) === 'shadow' ? 'shadow' : DEFAULT_MODE;
  }

  return {
    modeOf,
    isShadow: (featureId) => modeOf(featureId) === 'shadow',
  };
}

/**
 * Extract a ledger record from one session-log event.
 *
 * Accepts a bare record, or an envelope carrying it under `record`, `data` or
 * `payload`. Anything else is not a ledger event and is skipped, because the
 * session log holds every other event type too.
 *
 * @param {unknown} event one event from the log.
 * @returns {object | null} the record, or `null`.
 */
export function extractRecord(event) {
  if (!isRecord(event)) return null;
  if (typeof event.featureId === 'string') return event;
  for (const key of ['record', 'data', 'payload']) {
    const candidate = event[key];
    if (!isRecord(candidate)) continue;
    if (typeof candidate.featureId === 'string') return candidate;
    if (isRecord(candidate.record) && typeof candidate.record.featureId === 'string') {
      return candidate.record;
    }
  }
  return null;
}

/**
 * Create the ledger.
 *
 * @param {object} deps injected dependencies.
 * @param {object} deps.settings the settings reader.
 * @param {() => number} deps.now the injected clock.
 * @param {{ isShadow: (id: string) => boolean }} deps.shadow the shadow resolver.
 * @param {string} [deps.statePath] where to append JSONL, if anywhere.
 * @param {object} [deps.log] optional logger.
 * @returns {object} the ledger.
 */
export function createLedger(deps) {
  const { now, shadow, log } = deps;
  const statePath = deps.statePath;
  const records = [];

  /** Coerce one input into exactly the recorded shape. */
  function normalize(input) {
    const source = isRecord(input) ? input : {};
    // A module may hand over a keyed object or a plain array of scores (one per
    // segment, in order). The array form used to be coerced to `{}`, which threw
    // away every score `admit.output`, `admit.terminal` and `guide.shared` recorded
    // — found by reading real ledger rows from a live turn, not by any gate.
    const probabilities = Array.isArray(source.probabilities)
      ? Object.fromEntries(
        source.probabilities.flatMap((value, index) => (
          typeof value === 'number' && Number.isFinite(value) ? [[`s${index}`, value]] : []
        )),
      )
      : (isRecord(source.probabilities) ? { ...source.probabilities } : {});
    const threshold =
      typeof source.threshold === 'number' && Number.isFinite(source.threshold)
        ? source.threshold
        : null;
    const mode =
      source.mode === 'shadow' || source.mode === 'enforce'
        ? source.mode
        : shadow.isShadow(String(source.featureId ?? ''))
          ? 'shadow'
          : 'enforce';
    const record = {
      featureId: String(source.featureId ?? ''),
      callId: source.callId ?? null,
      question: source.question ?? null,
      probabilities,
      threshold,
      decision:
        typeof source.decision === 'string' && source.decision !== ''
          ? source.decision
          : deriveDecision(probabilities, threshold),
      wouldBe: source.wouldBe ?? null,
      reason:
        typeof source.reason === 'string' && source.reason !== '' ? source.reason : null,
      mode,
      at: typeof source.at === 'number' && Number.isFinite(source.at) ? source.at : now(),
    };
    // Exactly the contract's keys: extra fields do not travel into the record.
    return Object.fromEntries(RECORD_KEYS.map((key) => [key, record[key]]));
  }

  /** Append one line of JSONL, and never let bookkeeping fail a judgment. */
  function persist(record) {
    if (typeof statePath !== 'string' || statePath === '') return;
    try {
      // ponytail: synchronous append, one small line per judgment. Make it an
      // append stream if the ledger ever becomes hot enough to block a turn.
      appendFileSync(statePath, `${JSON.stringify(record)}\n`, 'utf8');
    } catch (error) {
      log?.warn?.(`[jev-core] ledger persist failed: ${String(error)}`);
    }
  }

  /**
   * Append a record.
   *
   * @param {object} input the record, or the measurements to record.
   * @returns {object} the stored record.
   */
  function append(input) {
    const record = normalize(input);
    records.push(record);
    persist(record);
    return record;
  }

  /**
   * Read records by feature, optionally narrowed to one call.
   *
   * @param {string} [featureId] the feature id; omit for every record.
   * @param {string} [callId] the call id; omit for every call of that feature.
   * @returns {object[]} the matching records.
   */
  function read(featureId, callId) {
    return records.filter(
      (record) =>
        (featureId === undefined || featureId === null || record.featureId === featureId) &&
        (callId === undefined || callId === null || record.callId === callId),
    );
  }

  /**
   * Replace the store with the records found in a session-log event list.
   *
   * @param {unknown[]} events the events.
   * @returns {object[]} the rebuilt records.
   */
  function rebuild(events) {
    records.length = 0;
    for (const event of Array.isArray(events) ? events : []) {
      const raw = extractRecord(event);
      if (raw !== null) records.push(normalize(raw));
    }
    return records.slice();
  }

  /** Render the records as events, so the log and the ledger use one shape. */
  function events() {
    return records.map((record) => ({ type: LEDGER_EVENT_TYPE, record: { ...record } }));
  }

  return { append, read, rebuild, events, size: () => records.length };
}
