/**
 * The notice arbiter and the notification transports.
 *
 * Several modules want to say something to the agent, and only one of them may
 * win: an unlabelled or duplicated notice is noise, and noise is what makes an
 * agent stop reading notices. So every request goes through one arbiter, which
 * enforces one notice per turn, a per-session cap, content-hash dedupe, a
 * summary that never repeats, and blocked-state notices outranking advisory
 * ones. A suppressed request is recorded rather than dropped — a silence you
 * cannot audit is indistinguishable from a bug.
 *
 * Every suppression is also appended to the core ledger, keyed by the module's
 * own notice tag, so the session log explains the silence.
 *
 * @module dsh-jev-layer-core/notice
 */
import { createHash } from 'node:crypto';
import {
  DEFAULT_NOTICE_SESSION_CAP,
  DEFAULT_NOTIFY_MAX_PER_HOUR,
  DEFAULT_NOTIFY_MIN_INTERVAL_MS,
  SETTING_KEYS,
  isRecord,
  readNumber,
  readSetting,
} from './settings.js';

/** A blocked-state notice outranks every advisory one, whatever its priority. */
const BLOCKED_RANK = 1_000;

/** Hash content for dedupe. Collision resistance is not the point; identity is. */
function contentHash(text) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, 24);
}

/**
 * Create the notice arbiter.
 *
 * @param {object} deps injected dependencies.
 * @param {object} deps.settings the settings reader.
 * @param {() => number} deps.now the injected clock.
 * @param {{ append: Function }} deps.ledger the ledger, for suppression records.
 * @param {{ isShadow: (id: string) => boolean }} deps.shadow the shadow resolver.
 * @param {object} [deps.log] optional logger.
 * @returns {object} the arbiter.
 */
export function createNoticeArbiter(deps) {
  const { settings, now, ledger, shadow } = deps;
  const seen = new Set();
  const delivered = [];
  const suppressed = [];
  let winner = null;
  let summarySeen = false;
  let callSeq = 0;

  /** The per-session cap on delivered notices. */
  function cap() {
    return Math.max(0, readNumber(settings, SETTING_KEYS.noticeSessionCap, DEFAULT_NOTICE_SESSION_CAP));
  }

  /** Record a suppression, in the arbiter and in the ledger. */
  function recordSuppression(entry, reason) {
    const record = {
      kind: entry.kind,
      text: entry.text,
      tag: entry.tag,
      reason,
      priority: entry.priority,
      at: now(),
    };
    suppressed.push(record);
    callSeq += 1;
    try {
      ledger.append({
        featureId: entry.tag ?? 'notice',
        callId: `notice-${callSeq}`,
        question: null,
        probabilities: {},
        threshold: null,
        decision: 'notice-suppressed',
        wouldBe: reason,
        mode: shadow.isShadow(entry.tag ?? 'notice') ? 'shadow' : 'enforce',
        at: record.at,
      });
    } catch {
      // The ledger is bookkeeping; losing a line must not lose the suppression.
    }
    return 'suppressed';
  }

  /**
   * Request one notice for this turn.
   *
   * @param {object} req `{ kind, priority, text, tag, dedupeKey, summary }`.
   * @returns {'accepted' | 'suppressed'} the outcome.
   */
  function request(req = {}) {
    try {
      const kind = req.kind === 'blocked' ? 'blocked' : 'advisory';
      const text = String(req.text ?? '');
      const priority = typeof req.priority === 'number' && Number.isFinite(req.priority) ? req.priority : 0;
      const hash = contentHash(text);
      const entry = {
        kind,
        priority,
        rank: (kind === 'blocked' ? BLOCKED_RANK : 0) + priority,
        text,
        tag: typeof req.tag === 'string' && req.tag !== '' ? req.tag : null,
        key: req.dedupeKey ?? hash,
        hash,
        summary: req.summary === true,
        at: now(),
      };
      if (seen.has(entry.key) || seen.has(entry.hash)) return recordSuppression(entry, 'duplicate');
      if (delivered.length >= cap()) return recordSuppression(entry, 'cap');
      if (entry.summary && summarySeen) return recordSuppression(entry, 'summary-repeat');
      if (winner !== null) {
        if (entry.rank > winner.rank) {
          const loser = winner;
          winner = entry;
          recordSuppression(loser, 'outranked');
          return 'accepted';
        }
        return recordSuppression(entry, 'one-per-turn');
      }
      winner = entry;
      return 'accepted';
    } catch {
      // An arbiter that throws would take a module's turn down with it.
      return 'suppressed';
    }
  }

  /**
   * Take the notices accepted for this turn and close it.
   *
   * @returns {object[]} zero or one notice.
   */
  function drain() {
    const out = [];
    if (winner !== null) {
      const taken = winner;
      winner = null;
      delivered.push(taken);
      seen.add(taken.key);
      seen.add(taken.hash);
      if (taken.summary) summarySeen = true;
      out.push(taken);
    }
    return out;
  }

  /** The notice held for this turn, if any, without closing the turn. */
  function pending() {
    return winner === null ? [] : [winner];
  }

  /** Close the turn without a drain, recording anything still held. */
  function beginTurn() {
    if (winner !== null) {
      const dropped = winner;
      winner = null;
      recordSuppression(dropped, 'turn-ended');
    }
  }

  return {
    request,
    drain,
    beginTurn,
    pending,
    cap,
    /** Read back what was suppressed, so a silence stays auditable. */
    suppressed: () => suppressed.slice(),
    /** Read back what was delivered. */
    delivered: () => delivered.slice(),
  };
}

/**
 * Create the notification transports.
 *
 * SPEC.md allows an HTTPS POST or a shell command. This core ticket implements
 * the POST only and rate limits it; the shell transport belongs to the
 * `notify.decline` ticket, which owns notification policy.
 *
 * @param {object} deps injected dependencies.
 * @param {object} deps.settings the settings reader.
 * @param {Function} deps.fetchImpl the fetch implementation.
 * @param {() => number} deps.now the injected clock.
 * @returns {object} the notifier.
 */
export function createNotifications(deps) {
  const { settings, fetchImpl, now } = deps;
  const history = [];
  let sent = 0;
  let suppressedCount = 0;
  let failed = 0;

  /** Whether the rolling-hour ceiling is reached. */
  function overHourlyCap() {
    const max = Math.max(0, readNumber(settings, SETTING_KEYS.notifyMaxPerHour, DEFAULT_NOTIFY_MAX_PER_HOUR));
    const cutoff = now() - 3_600_000;
    for (let index = history.length - 1; index >= 0; index -= 1) {
      if (history[index] < cutoff) history.splice(index, 1);
    }
    return history.length >= max;
  }

  /**
   * Send one message.
   *
   * @param {string} text the message.
   * @param {object} [meta] extra fields for the body and headers.
   * @returns {Promise<'sent' | 'suppressed' | 'failed'>} the outcome.
   */
  async function send(text, meta = {}) {
    try {
      const url = readSetting(settings, SETTING_KEYS.notifyUrl);
      if (typeof url !== 'string' || url === '') return 'suppressed';
      const minInterval = Math.max(
        0,
        readNumber(settings, SETTING_KEYS.notifyMinIntervalMs, DEFAULT_NOTIFY_MIN_INTERVAL_MS),
      );
      if (history.length > 0 && now() - history[history.length - 1] < minInterval) {
        suppressedCount += 1;
        return 'suppressed';
      }
      if (overHourlyCap()) {
        suppressedCount += 1;
        return 'suppressed';
      }
      const configured = readSetting(settings, SETTING_KEYS.notifyHeaders);
      const headers = {
        'content-type': 'application/json',
        ...(isRecord(configured) ? configured : {}),
        ...(isRecord(meta.headers) ? meta.headers : {}),
      };
      const response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ text, ...meta, headers: undefined }),
      });
      if (isRecord(response) && response.status >= 200 && response.status < 300) {
        sent += 1;
        history.push(now());
        return 'sent';
      }
      failed += 1;
      return 'failed';
    } catch {
      failed += 1;
      return 'failed';
    }
  }

  return {
    send,
    stats: () => ({ sent, suppressed: suppressedCount, failed }),
  };
}
