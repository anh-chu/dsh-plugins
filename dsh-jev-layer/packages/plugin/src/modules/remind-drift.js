/**
 * `remind.drift` — one reminder per drift pattern, per session.
 *
 * A loop that keeps making the same call looks productive from inside it: every
 * step produces a result, and the result itself says nothing about the
 * repetition. So this module reads the tool activity of the step from the only
 * source the event exposes — the model-visible history of the live session —
 * looks for one of two unproductive shapes at the tail of it, and raises one
 * advisory notice through the core notice arbiter.
 *
 * The two shapes:
 *
 *   - the same tool call repeated with identical arguments
 *     (`repeat:<tool>:<hash>`). The results differ in nothing that matters, so
 *     the model cannot see that it is standing still;
 *   - the same tool failing again and again (`failure:<tool>`), which is where a
 *     retry loop with no new information lives.
 *
 * Only the tail matters: the run must end at the newest call, because a call
 * that was repeated twice in the middle of the session and not since is not
 * drift. Detection is deterministic and costs no judge request and no budget:
 * it is arithmetic over records the harness already keeps.
 *
 * ## The seam
 *
 * A `broadcast` observer on `agent/pre-step`, the waterfall the loop runs before
 * every model call. `docs/CONTRACT.md` records that this seam already has
 * several observers — `select.skill`, `supervise.goal`, `guide.instructions` —
 * and none of them may rewrite the decision. So the handler returns `undefined`
 * for every path and mutates nothing: the registry hands the downstream
 * decision back untouched, and the notice is the only channel this module has.
 *
 * ## One notice per session, per pattern
 *
 * The pattern key is stable across the whole loop: `repeat:read:<hash of the
 * canonical arguments>` or `failure:bash`. It travels in the notice's
 * `dedupeKey`, together with the session id, so the arbiter can suppress a
 * repeat even if the module's own latch is lost, and so two sessions in one
 * process do not silence each other. A delivered pattern is also latched for
 * that session, so a runaway loop cannot refill the arbiter on every step; a
 * request the arbiter suppressed is recorded and NOT latched, because losing
 * one turn is the arbiter's decision and not a reason to stay silent for the
 * rest of the session.
 *
 * ## What it deliberately does not do
 *
 * It never asks the judge. "The same call, again" is a fact of the log, not a
 * judgment; paying a model for it would add a failure mode and a budget line to
 * arithmetic. It reads no file and no other module's state; and it keeps no
 * cross-session memory — the latch is a `WeakMap` keyed by the session object,
 * so it dies with the session and cannot leak between agents.
 *
 * @module dsh-jev-layer/modules/remind-drift
 */
import { createHash } from 'node:crypto';
import { SEAMS } from '../seams.js';

/** Stable id: config key, ledger key, shadow key and notice tag. */
const ID = 'remind.drift';
/** The question this module answers without a judge. */
const QUESTION_ID = 'drift';
/** Advisory notices carry no ordering pressure; kind already separates them. */
const NOTICE_PRIORITY = 10;
/** The same call this many times in a row is a loop. */
const DEFAULT_REPEAT_THRESHOLD = 3;
/** The same tool failing this many times in a row is a failure loop. */
const DEFAULT_FAILURE_THRESHOLD = 3;
/** How many trailing history messages are examined. A bound, not a policy. */
const DEFAULT_LOOKBACK_MESSAGES = 200;

/**
 * Pattern keys already noticed, by session object.
 *
 * A `WeakMap` and not a `Map`: an entry must not outlive its session, and the
 * module must not need a disposer per agent to avoid a leak. `stop()` replaces
 * it, so a re-enabled module starts each session with a clean latch.
 */
let noticed = new WeakMap();

/** Read a numeric setting, falling back when it is absent or not finite. */
function numberSetting(api, key, fallback) {
  const value = api?.config?.get?.(key);
  return Number.isFinite(value) ? value : fallback;
}

/** Deep key-sort, so two argument objects that differ only in key order are one call. */
function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortJson(value[key]);
    return sorted;
  }
  return value;
}

/**
 * Canonical form of a call's arguments.
 *
 * The model writes the raw JSON string, so two spellings of one argument set
 * (key order, whitespace) must not look like two different calls. Unparseable
 * arguments — the loop keeps a raw-string fallback — are compared as written.
 */
function canonicalArguments(raw) {
  if (typeof raw !== 'string' || raw === '') return '';
  try {
    return JSON.stringify(sortJson(JSON.parse(raw)));
  } catch {
    return raw;
  }
}

/** A short stable digest; the key stays readable and collisions do not matter. */
function digest(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/**
 * The tool activity of the trailing history, in call order.
 *
 * `deriveMessages()` is the session's model-visible history: assistant messages
 * carry `tool-call` blocks and the answers arrive as `role: 'tool'` messages
 * with `isError`. Both are the harness's own record, so the module reads what
 * the model saw rather than a private copy of it.
 *
 * @param {unknown} history the derived messages.
 * @param {number} lookback how many trailing messages to examine.
 * @returns {{ calls: Array<{ id: string, name: string, signature: string }>, failed: Set<string> }}
 */
function activityOf(history, lookback) {
  const messages = Array.isArray(history) ? history : [];
  const from = Math.max(0, messages.length - Math.max(1, lookback));
  const calls = [];
  const failed = new Set();
  for (let index = from; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role === 'assistant') {
      const content = Array.isArray(message.content) ? message.content : [];
      for (const block of content) {
        if (block?.type !== 'tool-call') continue;
        calls.push({
          id: String(block.id ?? ''),
          name: typeof block.name === 'string' ? block.name : '',
          signature: canonicalArguments(block.arguments),
        });
      }
      continue;
    }
    if (message?.role === 'tool' && message.isError === true) {
      failed.add(String(message.toolCallId ?? ''));
    }
  }
  return { calls, failed };
}

/**
 * The drift pattern at the tail of the activity, or `null`.
 *
 * Both runs start at the newest call, so an old repetition is not drift. The
 * repeat test runs first: an identical failing call is both a repeat and a
 * failure, and the repeat names the arguments the model must change.
 *
 * @param {{ calls: Array, failed: Set<string> }} activity
 * @param {{ repeatThreshold: number, failureThreshold: number }} limits
 * @returns {{ key: string, kind: string, name: string, count: number } | null}
 */
function detectDrift(activity, limits) {
  const calls = activity.calls;
  const last = calls[calls.length - 1];
  if (last === undefined || last.name === '') return null;

  let repeats = 0;
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    if (calls[index].name !== last.name || calls[index].signature !== last.signature) break;
    repeats += 1;
  }
  if (repeats >= limits.repeatThreshold) {
    return {
      key: `repeat:${last.name}:${digest(`${last.name}\u0000${last.signature}`)}`,
      kind: 'repeat',
      name: last.name,
      count: repeats,
    };
  }

  let failures = 0;
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index];
    if (call.name !== last.name || !activity.failed.has(call.id)) break;
    failures += 1;
  }
  if (failures >= limits.failureThreshold) {
    return { key: `failure:${last.name}`, kind: 'failure', name: last.name, count: failures };
  }
  return null;
}

/** The model-facing reminder for one pattern. English: it is read by the model. */
function textFor(pattern) {
  if (pattern.kind === 'failure') {
    return `Drift reminder: ${pattern.name} has failed ${pattern.count} consecutive times. `
      + 'This looks like a failure loop. Change the approach, gather different evidence, '
      + 'or report the blocker, instead of retrying the same call.';
  }
  return `Drift reminder: ${pattern.name} has been called ${pattern.count} consecutive times `
    + 'with identical arguments. The repetition is not making progress. Inspect the latest '
    + 'result, then change the arguments or the approach.';
}

/** The latch for one session, created on first use. */
function latchFor(session) {
  let keys = noticed.get(session);
  if (keys === undefined) {
    keys = new Set();
    noticed.set(session, keys);
  }
  return keys;
}

/** Append one ledger row. Bookkeeping never decides and never throws. */
function record(api, fields) {
  try {
    api?.ledger?.append?.({
      featureId: ID,
      callId: fields.sessionId,
      question: QUESTION_ID,
      probabilities: {},
      threshold: fields.threshold,
      decision: fields.decision,
      wouldBe: fields.wouldBe,
      mode: fields.mode,
      at: Date.now(),
    });
  } catch {
    // A ledger that is down must not change whether the agent is reminded.
  }
}

export default {
  id: ID,
  description: 'One notice per repeated unproductive pattern.',
  label: 'Repeated-pattern reminder',
  // Spends the turn budget or raises a notice: needs the turn boundary and the notice drain.
  needsTurn: true,
  seam: SEAMS.AGENT_PRE_STEP,
  seamClass: 'broadcast',
  settings: {
    repeatThreshold: {
      type: 'number',
      default: DEFAULT_REPEAT_THRESHOLD,
      description: 'Consecutive identical tool calls that count as drift. Below 2 nothing can repeat.',
    },
    failureThreshold: {
      type: 'number',
      default: DEFAULT_FAILURE_THRESHOLD,
      description: 'Consecutive failures of one tool that count as a failure loop.',
    },
    lookbackMessages: {
      type: 'number',
      default: DEFAULT_LOOKBACK_MESSAGES,
      description: 'How many trailing session messages are examined for tool calls and failures.',
    },
  },

  /** Released on unload or toggle-off: the latch must not survive a restart. */
  stop() {
    noticed = new WeakMap();
  },

  /**
   * Observe one `agent/pre-step`. Returns `undefined` on every path, so the
   * registry's broadcast dispatch hands the step decision back unchanged.
   */
  handle(event, api) {
    try {
      // The history is the only place tool calls and their outcomes appear:
      // the pre-step payload carries claimed inbox messages, not tool traffic.
      const session = event?.agent?.session;
      if (session === undefined || session === null) return undefined;
      if (typeof session.deriveMessages !== 'function') return undefined;

      const lookback = numberSetting(api, 'lookbackMessages', DEFAULT_LOOKBACK_MESSAGES);
      const pattern = detectDrift(activityOf(session.deriveMessages(), lookback), {
        repeatThreshold: numberSetting(api, 'repeatThreshold', DEFAULT_REPEAT_THRESHOLD),
        failureThreshold: numberSetting(api, 'failureThreshold', DEFAULT_FAILURE_THRESHOLD),
      });
      if (pattern === null) return undefined;

      const sessionId = String(session.id ?? '');
      const mode = api?.shadow?.isShadow?.(ID) === true ? 'shadow' : 'enforce';
      const threshold = pattern.kind === 'failure'
        ? numberSetting(api, 'failureThreshold', DEFAULT_FAILURE_THRESHOLD)
        : numberSetting(api, 'repeatThreshold', DEFAULT_REPEAT_THRESHOLD);

      // Shadow records the decision it would have taken and raises nothing.
      if (mode === 'shadow') {
        record(api, { sessionId, threshold, decision: 'notice', wouldBe: pattern.key, mode });
        return undefined;
      }

      // Already delivered in this session: record the silence, spend nothing.
      const keys = latchFor(session);
      if (keys.has(pattern.key)) {
        record(api, { sessionId, threshold, decision: 'suppressed', wouldBe: pattern.key, mode });
        return undefined;
      }

      const outcome = api?.notice?.request?.({
        kind: 'advisory',
        priority: NOTICE_PRIORITY,
        text: textFor(pattern),
        tag: ID,
        dedupeKey: `${ID}:${sessionId}:${pattern.key}`,
      });
      const accepted = outcome === 'accepted';
      // Only a delivered notice latches: an arbiter suppression is this turn's
      // business and a later step may still deliver the reminder.
      if (accepted) keys.add(pattern.key);
      record(api, { sessionId, threshold, decision: accepted ? 'notice' : 'suppressed', wouldBe: pattern.key, mode });
      return undefined;
    } catch {
      // Advisory by construction: a failure raises no notice, records nothing,
      // and never breaks the step for the modules that do transform it.
      return undefined;
    }
  },
};
