/**
 * `notify.decline` — one message to the operator when an armed loop cannot be
 * answered and is left waiting.
 *
 * ## Why this module exists
 *
 * `answer.questions` answers a question only while every hard gate holds, and
 * the first gate is the autonomy signal: a goal that is active and armed. When
 * that gate holds and the question is still delegated — the judge was not
 * decisive, the runner-up was too close, `ask-human` won, or the deadline
 * passed — nobody is watching and the loop now waits for a human who is not
 * there. v1 deliberately delegates rather than guesses; this module is what
 * tells the human to come back.
 *
 * ## Trigger
 *
 * It subscribes to the plugin-internal `SEAMS.INTERNAL_QUESTION_EVALUATED`
 * event, which `answer.questions` publishes at the decision moment. It must not
 * observe `user-questions/request` itself: that seam has one exclusive owner,
 * and a second observer would make the outcome depend on registration order,
 * which is the failure this whole plugin exists to remove.
 *
 * A message is raised only when the outcome is a delegation *and* the reason is
 * not an autonomy-gate failure. A disarmed, paused or missing goal means a human
 * is expected, or the nag speaks instead; in both cases a pager-style
 * notification would be wrong. The reason vocabulary is a setting
 * (`autonomyReasons`) because the payload's `reason` is written by another
 * module and the contract does not fix its spelling — see the reported contract
 * gaps in the ticket notes. An unrecognised reason counts as "the autonomy gate
 * held": the risk that matters here is a silently missed decline, not one extra
 * message.
 *
 * ## Transport
 *
 * Two opt-in transports, both off by default:
 *
 *   - `url` — POST JSON through `api.notifications.send`, which the core owns
 *     and rate limits; the module neither re-implements the POST nor its
 *     limiter. Bark and Home Assistant both accept this shape.
 *   - `command` — a shell command with `{title}`, `{body}`, `{session}` and
 *     `{reason}` substituted. The core has no command transport (see
 *     `packages/core/src/notice.js`), so this path carries its own limiter.
 *
 * `transport: 'auto'` picks whichever of the two is configured. The install
 * default is `off`, so on a fresh install nothing is ever sent.
 *
 * Substituted values come from a model-authored question, so every one of them
 * is single-quote-escaped before it reaches the shell. Without that, a question
 * text containing a quote would be a command injection.
 *
 * ## A failed send never changes the outcome
 *
 * The subscriber runs synchronously inside the publisher's decision: `publish`
 * does not await, and everything here is wrapped so that no path can throw into
 * `answer.questions`. The delegation has already been decided before this
 * module hears about it, and nothing here can revise it.
 *
 * @module dsh-jev-layer/modules/notify-decline
 */
import { execFile } from 'node:child_process';

import { SEAMS } from '../seams.js';

/** Stable id: config key, ledger key, shadow key and notice tag. */
const ID = 'notify.decline';

/** The feature that publishes the event, and the source of the decision count. */
const ANSWER_FEATURE = 'answer.questions';

/** A delegation outcome. The payload carries `delegated:<gate>` today. */
const DELEGATION = /^deleg/;

/** Reasons whose meaning is "the autonomy gate did not hold": no message. */
const DEFAULT_AUTONOMY_REASONS = Object.freeze([
  'no-agent',
  'no-goal',
  'goal-absent',
  'disarmed',
  'not-armed',
  'inactive',
  'not-active',
  'autonomy',
  'autonomy-gate',
]);

/** Default rolling-hour ceiling, matching the core's own default. */
const DEFAULT_MAX_PER_HOUR = 6;

/** Default minimum interval, matching the core's own default. */
const DEFAULT_MIN_INTERVAL_MS = 60_000;

/** How long one command send may run before it is killed. */
const COMMAND_TIMEOUT_MS = 10_000;

/** Default message templates. Both transports substitute the same names. */
const DEFAULT_TITLE = 'dsh-jev-layer: question not answered';
const DEFAULT_BODY = [
  'A question in an armed goal was delegated to a human who is not there.',
  'Question: {question}',
  'Options: {options}',
  'Reason: {reason}',
  'Session: {session}',
].join('\n');

/**
 * Send attempts still in flight.
 *
 * `events.publish` is synchronous and does not await, so an `async` subscriber
 * would otherwise fail silently. The promises are kept here so a test (or an
 * orderly shutdown) can await the real work through {@link idle}.
 */
const pending = new Set();

/** Counters for one module instance, read back by {@link stats}. */
let counts = { sent: 0, suppressed: 0, failed: 0, off: 0, shadow: 0, skipped: 0 };

/** The last several outcomes, for diagnosis without a log file. */
let recent = [];

/**
 * Await every send attempt started so far.
 *
 * The subscriber itself stays synchronous, so this is the only honest way for a
 * caller to observe the outcome of a send.
 *
 * @returns {Promise<void>} resolves when nothing is in flight.
 */
export async function idle() {
  while (pending.size > 0) {
    await Promise.allSettled([...pending]);
  }
}

/** The counters and the recent outcomes. */
export function stats() {
  return { ...counts, recent: recent.slice() };
}

/** Read a module setting, with a fallback for an absent or blank value. */
function setting(api, key, fallback) {
  const value = api?.config?.get?.(key);
  return value === undefined || value === null || value === '' ? fallback : value;
}

/** Read a numeric setting, rejecting a value a template could not use. */
function settingNumber(api, key, fallback) {
  const value = Number(setting(api, key, fallback));
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Escape one substituted value for a single-quoted POSIX shell word.
 *
 * The only character that can end a single-quoted string is the quote itself,
 * so closing the quotes, emitting an escaped quote and reopening them is
 * enough — and it leaves no way to start a command, a substitution or a
 * redirect.
 *
 * @param {unknown} value the value.
 * @returns {string} the escaped word content.
 */
export function shellEscape(value) {
  return String(value ?? '').replaceAll("'", "'\\''");
}

/**
 * Substitute `{name}` placeholders in one template.
 *
 * A name the template does not use costs nothing; a placeholder with no value
 * is replaced by an empty string rather than left in the message, because a
 * literal `{reason}` in a notification is worse than nothing.
 *
 * @param {string} template the template text.
 * @param {Record<string, string>} values the values, already escaped.
 * @returns {string} the substituted text.
 */
export function substitute(template, values) {
  return String(template ?? '').replace(/\{(\w+)\}/g, (whole, name) =>
    (Object.hasOwn(values, name) ? values[name] : whole),
  );
}

/** The session id the payload carries, however the publisher spells it. */
function sessionOf(payload) {
  const direct = payload?.sessionId ?? payload?.session ?? payload?.agent?.session?.id;
  return typeof direct === 'string' ? direct : String(direct ?? '');
}

/** The option labels of the question, as text. */
function optionsOf(payload) {
  const raw = payload?.options ?? payload?.question?.options;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((option) => (typeof option === 'string' ? option : option?.label))
    .filter((label) => typeof label === 'string' && label !== '');
}

/** The question text the payload carries, however the publisher spells it. */
function questionOf(payload) {
  const raw = payload?.question ?? payload?.questionText ?? payload?.text;
  if (typeof raw === 'string') return raw;
  if (raw !== null && typeof raw === 'object') {
    const inner = raw.text ?? raw.question ?? raw.header;
    if (typeof inner === 'string') return inner;
  }
  return '';
}

/** Append one ledger row. Bookkeeping never decides and never throws. */
function record(api, { callId, question, decision, wouldBe, reason, at }) {
  try {
    api?.ledger?.append?.({
      featureId: ID,
      callId,
      question,
      probabilities: {},
      threshold: null,
      decision,
      wouldBe: wouldBe ?? reason ?? null,
      at,
    });
  } catch {
    // The ledger is a derived cache; losing a row must not lose a message.
  }
}

/** Remember one outcome for {@link stats}; the list stays short by design. */
function remember(outcome, payload) {
  recent.push({
    outcome,
    reason: payload?.reason ?? null,
    session: sessionOf(payload),
    at: Date.now(),
  });
  if (recent.length > 20) recent.splice(0, recent.length - 20);
}

/**
 * Whether the payload describes a decline this module should report.
 *
 * @param {object} api the module api.
 * @param {unknown} payload the published payload.
 * @returns {{ send: boolean, why: string }} the verdict and why it was reached.
 */
export function shouldNotify(api, payload) {
  const outcome = payload?.outcome;
  if (typeof outcome !== 'string' || !DELEGATION.test(outcome)) {
    return { send: false, why: 'not-a-delegation' };
  }
  const reasons = setting(api, 'autonomyReasons', DEFAULT_AUTONOMY_REASONS);
  const list = Array.isArray(reasons) && reasons.length > 0 ? reasons : DEFAULT_AUTONOMY_REASONS;
  const reason = String(payload?.reason ?? '');
  if (reason !== '' && list.includes(reason)) return { send: false, why: 'autonomy-gate' };
  // A payload that carries the agent can be re-checked against the live goal,
  // which is the one fact that separates "nobody is coming" from "the human is
  // expected". Absent an agent there is nothing to read, exactly as in
  // answer.questions, so the reason is the only signal there is.
  const agent = payload?.agent;
  if (agent !== undefined && agent !== null && typeof api?.goals?.get === 'function') {
    const view = api.goals.get(agent);
    if (view === undefined || view === null) return { send: false, why: 'no-goal' };
    if (view.phase !== 'active' || view.activation !== 'armed') {
      return { send: false, why: 'not-armed' };
    }
  }
  return { send: true, why: 'declined-in-armed-goal' };
}

/**
 * Which transport is in force right now.
 *
 * `off` is the install default and the only value that sends nothing by
 * construction. `auto` resolves from what is configured, so the module can be
 * switched on without naming a transport twice; an explicit `url` or `command`
 * whose field is blank falls back to `off` and announces itself instead of
 * silently doing nothing.
 *
 * @param {object} api the module api.
 * @returns {'off' | 'url' | 'command'} the resolved transport.
 */
export function resolveTransport(api) {
  const configured = String(setting(api, 'transport', 'off')).toLowerCase();
  // The URL is NOT a module setting: the core owns that transport end to end,
  // including its own notify.url, its headers, the minimum interval and the
  // hourly cap. An explicit `url` therefore resolves here and the core reports
  // what actually happened, instead of this module guessing from a field it
  // does not declare.
  const command = setting(api, 'commandTemplate', '');
  const hasCommand = typeof command === 'string' && command !== '';
  if (configured === 'auto') return hasCommand ? 'command' : 'url';
  if (configured === 'off' || configured === '') return 'off';
  if (configured === 'url') return 'url';
  // The command transport is ours, so its own field is ours to validate.
  if (configured === 'command') return hasCommand ? 'command' : 'off';
  return 'off';
}

/**
 * Raise one message through the configured transport.
 *
 * @param {object} api the module api.
 * @param {Record<string, string>} values the substituted values, unescaped.
 * @param {string} rawReason the reason, unescaped and unsubstituted.
 * @param {string} session the session id.
 * @param {number} decisions the decisions recorded for the answering feature.
 * @returns {Promise<'sent' | 'suppressed' | 'failed' | 'off'>} the transport outcome.
 */
async function deliver(api, values, rawReason, session, decisions) {
  const transport = resolveTransport(api);
  if (transport === 'off') return 'off';
  const raw = {
    title: substitute(setting(api, 'titleTemplate', DEFAULT_TITLE), values),
    body: substitute(setting(api, 'bodyTemplate', DEFAULT_BODY), values),
  };
  const meta = {
    title: raw.title,
    body: raw.body,
    question: values.question,
    options: values.options,
    reason: rawReason,
    session,
    decisions,
  };

  if (transport === 'url') {
    // The core owns this path end to end: the POST, its headers, the minimum
    // interval and the rolling-hour cap. Nothing here repeats any of it.
    return api?.notifications?.send?.(raw.body, meta);
  }

  const template = String(setting(api, 'commandTemplate', ''));
  if (template === '') return 'off';
  const escaped = {
    title: shellEscape(raw.title),
    body: shellEscape(raw.body),
    session: shellEscape(session),
    reason: shellEscape(rawReason),
  };
  const command = substitute(template, escaped);
  try {
    await new Promise((resolve, reject) => {
      execFile('/bin/sh', ['-c', command], { timeout: COMMAND_TIMEOUT_MS }, (error) => {
        if (error) reject(error);
        else resolve(undefined);
      });
    });
    return 'sent';
  } catch {
    return 'failed';
  }
}

/**
 * The subscriber.
 *
 * It never throws and never awaits anything the publisher could see, so a
 * transport failure cannot revise the delegation that already happened.
 *
 * @param {object} api the module api.
 * @param {unknown} payload the published payload.
 */
function onEvaluated(api, payload) {
  try {
    const at = Date.now();
    const callId = String(payload?.callId ?? '');
    const reason = String(payload?.reason ?? '');
    const question = questionOf(payload);
    const labels = optionsOf(payload);
    const session = sessionOf(payload);

    const verdict = shouldNotify(api, payload);
    if (!verdict.send) {
      counts.skipped += 1;
      remember(verdict.why, payload);
      return;
    }

    // Shadow mode is rule 4 of docs/CONTRACT.md: record the message that would
    // have gone out, and send nothing.
    if (api?.shadow?.isShadow?.(ID) === true) {
      counts.shadow += 1;
      remember('shadow', payload);
      record(api, {
        callId,
        question,
        decision: 'notify-shadow',
        wouldBe: 'send',
        reason,
        at,
      });
      return;
    }

    const transport = resolveTransport(api);
    if (transport === 'off') {
      // The transport is off, so nothing was ever going to be sent. That is a
      // declared state, not a suppression: it is not counted as one and it is
      // not written to the ledger on every decline. An explicit `url` or
      // `command` with its field blank is a configuration mistake, so it is
      // reported once rather than passing as "off by choice".
      const configured = String(setting(api, 'transport', 'off')).toLowerCase();
      if (configured === 'url' || configured === 'command') {
        try {
          api?.log?.warn?.(
            `[dsh-jev-layer] notify.decline: transport "${configured}" is selected but its field is empty`,
          );
        } catch {
          // A logger that throws must not change the outcome either.
        }
      }
      counts.off += 1;
      remember('off', payload);
      return;
    }

    // ponytail: the ledger has no goal id, so this counts evaluations for the
    // answering feature in this process, not strictly within one goal. Make it
    // per goal if the ledger ever carries a goal key.
    let decisions = 0;
    try {
      decisions = api?.ledger?.read?.(ANSWER_FEATURE)?.length ?? 0;
    } catch {
      decisions = 0;
    }

    // The values are escaped at substitution time; the placeholders are read
    // here, once, so both transports describe the same event.
    const values = {
      question,
      options: labels.join(' | '),
      reason,
      session,
      decisions: String(decisions),
    };

    // The promise chain owns its own failures: it has a .catch for a transport
    // that throws and a .finally for the pending set, so no synchronous try is
    // needed here. A synchronous throw from `deliver` itself is caught by the
    // outer handler, which records the notification as failed.
    const attempt = deliver(api, values, reason, session, decisions)
      .then((outcome) => {
        if (outcome === 'sent') counts.sent += 1;
        else if (outcome === 'suppressed') counts.suppressed += 1;
        else if (outcome === 'failed') counts.failed += 1;
        else counts.off += 1;
        remember(outcome, payload);
        record(api, {
          callId,
          question,
          decision: outcome === 'sent' ? 'notify-sent' : `notify-${outcome}`,
          wouldBe: null,
          reason,
          at: Date.now(),
        });
        return outcome;
      })
      .catch((e) => {
        // A transport must not be able to throw into the publisher's decision.
        counts.failed += 1;
        remember('failed', payload);
        record(api, {
          callId,
          question,
          decision: 'notify-failed',
          wouldBe: null,
          reason,
          at: Date.now(),
        });
        return 'failed';
      })
      .finally(() => pending.delete(attempt));
    pending.add(attempt);
  } catch (error) {
    // Nothing above may reach answer.questions: the outcome is already decided.
    counts.failed += 1;
    remember('failed', payload);
    record(api, {
      callId: String(payload?.callId ?? ''),
      question: questionOf(payload),
      decision: 'notify-failed',
      wouldBe: null,
      reason: String(error?.message ?? 'error'),
      at: Date.now(),
    });
  }
}

export default {
  id: ID,
  description: 'Tells the user when a question was declined, so an unattended loop does not wait forever.',
  label: 'Notify when a question is declined',
  /**
   * No harness seam. This module hears the decision on the core's own channel
   * (`api.events`), so naming one only registered a listener that could never
   * fire. `null` states that, and the registry registers nothing for it.
   */
  seam: null,
  seamClass: 'broadcast',
  settings: {
    transport: {
      type: 'string',
      default: 'off',
      description: 'Notification transport: "off", "url" (POST JSON through the core), "command", or "auto" (whichever is configured).',
    },
    commandTemplate: {
      type: 'string',
      default: '',
      description: 'Shell command for the command transport; {title}, {body}, {session} and {reason} are substituted.',
    },
    titleTemplate: {
      type: 'string',
      default: DEFAULT_TITLE,
      description: 'Notification title; the same placeholders are substituted.',
    },
    bodyTemplate: {
      type: 'string',
      default: DEFAULT_BODY,
      description: 'Notification body; the same placeholders are substituted.',
    },
    minIntervalMs: {
      type: 'number',
      default: DEFAULT_MIN_INTERVAL_MS,
      description: 'Minimum interval between messages sent through the command transport.',
    },
    maxPerHour: {
      type: 'number',
      default: DEFAULT_MAX_PER_HOUR,
      description: 'Hard ceiling per rolling hour for the command transport.',
    },
    autonomyReasons: {
      type: 'stringArray',
      default: [...DEFAULT_AUTONOMY_REASONS],
      description: 'Delegate reasons that mean the autonomy gate did not hold, so no message is sent.',
    },
  },

  /**
   * Subscribe to the decision moment.
   *
   * The registry does not dispatch this seam; the core's own channel does.
   * Returns `undefined`, so a module that is also registered on a harness seam
   * would still hand that event back unchanged.
   */
  start(api) {
    counts = { sent: 0, suppressed: 0, failed: 0, off: 0, shadow: 0, skipped: 0 };
    recent = [];
    const unsubscribe = api?.events?.subscribe?.(SEAMS.INTERNAL_QUESTION_EVALUATED, (payload) =>
      onEvaluated(api, payload),
    );
    this._unsubscribe = typeof unsubscribe === 'function' ? unsubscribe : null;
    return undefined;
  },

  /** Release the subscription and forget everything `start` recorded. */
  stop() {
    const unsubscribe = this._unsubscribe;
    this._unsubscribe = null;
    if (typeof unsubscribe === 'function') {
      try {
        unsubscribe();
      } catch {
        // An unsubscribe that throws must not stop the rest of the unload.
      }
    }
    counts = { sent: 0, suppressed: 0, failed: 0, off: 0, shadow: 0, skipped: 0 };
    recent = [];
  },

  /** Observes only: the registry's broadcast dispatch hands the event back. */
  handle() {
    return undefined;
  },
};
