/**
 * `nag.nogoal` — one model-facing notice when a delegated question has no goal.
 *
 * The autonomy gate reads a goal. With no goal at all there is nothing to read,
 * so `answer.questions` delegates, and the session keeps delegating forever. The
 * nag surfaces that fact once, to whichever actor can act on it: the missing goal
 * is the one thing that makes unattended answering impossible.
 *
 * ## The trigger
 *
 * Not the harness seam. `user-questions/request` is owned exclusively by
 * `answer.questions` (docs/CONTRACT.md, seam classes), so observing it here would
 * make this module a second owner of it. Not `tools/result` either: it would fire
 * only after the question settles, which in the case the nag exists to report — an
 * armed loop with nobody there to answer — may be never.
 *
 * The trigger is the plugin-internal channel `SEAMS.INTERNAL_QUESTION_EVALUATED`,
 * published by `answer.questions` at the decision moment and subscribed in
 * `start()`, released in `stop()`. A publisher that is disabled simply never
 * fires: that is the declared soft dependency, and this module must not fail
 * startup because of it.
 *
 * ## The goal test
 *
 * `api.goals.get(agent) === undefined` means there is no goal at all. A goal that
 * exists but is `paused`, `blocked`, `complete` or `disarmed` is a deliberate
 * state, so any returned value — whatever its phase — does not nag.
 *
 * ## Delivery, and the two targets
 *
 * The notice is model-facing context, not a chat message: `api.inject(agent,
 * message)` queues it for the next step without waking the driver
 * (`dsh-agent-loop/lib/index.js:812`, `inject` is `send(…, 'next-step', false)`).
 *
 * `nagTarget` selects the recipient. `auto` probes whether the goal tool
 * `create_goal` is registered for the agent (`@deepseek-ai/dsh-tool-goal`
 * registers it at `lib/index.js:275`, the toolbox resolves it through
 * `ToolRuntime.get`, `dsh-tools/lib/types/index.d.ts:690`): with the tool the
 * agent can act on the nag, without it only the operator can, so `auto` sends the
 * user notification instead. **Corrected 2026-10-07: on this host the tool is
 * present and `auto` resolves to the agent.** The web bundle disables the
 * `tool-goal` row on purpose — its own comment is "Presets own the human command
 * and model-facing tool" — and the active preset
 * (`~/.dsh/.agent-presets/standard-jev/agent.cordis.yml:95-99`) declares it, so
 * `api.tools.get('create_goal', agent)` finds it. The note that stood here read
 * the profile bundle alone and concluded the host lacked the capability; entries
 * come from three planes (bundle, profile patch, preset), and only this probe
 * answers the question.
 *
 * ## The source label is load-bearing
 *
 * Every injected notice carries this plugin's own source kind and `form:
 * 'notice'`, because an unlabelled context renders as a user prompt in derived
 * history. The shipped `repeat-tool-reminder` states exactly that at
 * `lib/index.js:1458-1462` and stamps `{kind, form: 'notice', summary}` at
 * `lib/index.js:1565-1575`; `createUserMessage` adds the role and a fresh id and
 * freezes the message (`lib/index.js:257-273`). That package declares its kind in
 * `MessageSourceMap` (`lib/types/index.d.ts:11-17`) — a type-only augmentation,
 * so plain JavaScript has nothing to register at runtime, but the value is what
 * consumers switch on.
 *
 * ## Two deliberate deviations, both reported
 *
 * 1. The frozen `question/evaluated` payload (docs/CONTRACT.md) carries
 *    `{ callId, outcome, reason, question, options, at }` — no agent, yet
 *    `goals.get(agent)` and `inject(agent, message)` both need one. This module
 *    reads `payload.agent` and records `no-agent` when it is absent, rather than
 *    guessing. The publisher must add it.
 * 2. SPEC.md routes every notice through the core's arbiter. The arbiter has no
 *    path into an agent (nothing drains it into a session), so this module injects
 *    directly, as the ticket requires.
 *
 * @module dsh-jev-layer/modules/nag-nogoal
 */
import { randomUUID } from 'node:crypto';
import { SEAMS } from '../seams.js';

/** Stable id: config key, ledger key, shadow key and notice tag. */
const ID = 'nag.nogoal';
/** The plugin's own declared source kind; see the header. */
const SOURCE_KIND = 'dsh-jev-layer';
/** One-line account carried by a `notice`-form source (bound: 120 chars). */
const NAG_SUMMARY = 'no goal set';
/** The tool that lets the agent act on the nag; its absence sends it to the user. */
const GOAL_TOOL = 'create_goal';
/** Caller text has no length of its own, so the question is quoted bounded. */
const QUESTION_PREVIEW_CHARS = 200;

/** The agent delivers the notice itself. */
const DELIVER_AGENT = 'agent';
/** The operator gets the notification transport instead. */
const DELIVER_USER = 'user';

const NOOP = () => {};

/** The model-facing text: what happened, why, and what would change it. */
const AGENT_TEXT = 'A question in this session could not be decided automatically because the '
  + 'session has no goal, so it was delegated to the user. Unattended answering needs an active '
  + 'goal: call create_goal with the objective you are working to, and a later question in this '
  + 'goal can be answered without a human.';

/** The same fact for the operator, whose lever is the goal UI, not a model tool. */
const USER_TEXT = 'A question in this session could not be decided automatically because the '
  + 'session has no goal, so it is waiting for you. Set a goal for the session to let the loop '
  + 'continue unattended.';

/**
 * The unsubscribe for the internal channel, held between `start()` and `stop()`.
 * `null` means "not subscribed", which is the state a host with no channel leaves.
 */
let delivery = null;

/**
 * Sessions already nagged.
 *
 * A `WeakSet` keyed by the session (or the agent when it has none), so an entry
 * cannot outlive the session and no per-agent disposer is needed to avoid a leak.
 * `stop()` replaces it, so a re-enabled module starts each session clean.
 */
let latched = new WeakSet();

/** Whether a value is a plain object (not null, not an array). */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Read a string setting, falling back when it is absent or not a string. */
function stringSetting(api, key, fallback) {
  const value = api?.config?.get?.(key);
  return typeof value === 'string' && value !== '' ? value : fallback;
}

/** Read a boolean setting, falling back when it is absent or not a boolean. */
function booleanSetting(api, key, fallback) {
  const value = api?.config?.get?.(key);
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * The text of the delegated question, as far as the payload fixes it.
 *
 * The frozen payload names `question` and `options` without fixing the inner
 * shape, so a bare string, a harness question object and a header are all read;
 * anything else contributes nothing rather than a wrong name.
 */
function questionTextOf(event) {
  const question = event.question;
  if (typeof question === 'string') return question;
  if (!isRecord(question)) return '';
  if (typeof question.question === 'string') return question.question;
  return typeof question.header === 'string' ? question.header : '';
}

/** Head-truncate the question so one notice cannot ride in unbounded. */
function preview(text) {
  if (text.length <= QUESTION_PREVIEW_CHARS) return text;
  return `${text.slice(0, QUESTION_PREVIEW_CHARS)}…`;
}

/** Append the quoted question to a text, when the payload carried one. */
function withQuestion(text, question) {
  return question === '' ? text : `${text} Question: ${question}`;
}

/**
 * Build the identified user-role message the way `repeat-tool-reminder` does:
 * a text block, plus the producer's own source kind and `form: 'notice'` with the
 * one-line summary that form requires. `@deepseek-ai/dsh-llm` is not a runtime
 * dependency of this package, so the equivalent is built here and frozen.
 */
function messageFor(text) {
  const content = Object.freeze([Object.freeze({ type: 'text', text })]);
  const source = Object.freeze({ kind: SOURCE_KIND, form: 'notice', summary: NAG_SUMMARY });
  return Object.freeze({ role: 'user', id: randomUUID(), content, source });
}

/** Append one ledger row. Bookkeeping never decides and never throws. */
function record(api, fields) {
  try {
    const shadowed = api?.shadow?.isShadow?.(ID) === true;
    api?.ledger?.append?.({
      featureId: ID,
      callId: fields.callId ?? null,
      question: fields.question ?? null,
      probabilities: {},
      threshold: null,
      decision: fields.decision,
      wouldBe: fields.wouldBe ?? null,
      mode: fields.mode ?? (shadowed ? 'shadow' : 'enforce'),
      at: Date.now(),
    });
  } catch {
    // A ledger that is down must not change whether the nag is delivered.
  }
}

/**
 * Who receives the nag: `agent`, `user`, or `off`.
 *
 * `auto` needs the agent to be able to act on the notice, which means a
 * registered goal tool for this agent. The deferred tools bridge exposes only
 * `register`, so a host whose toolbox is not reachable resolves to `user`: the
 * safe direction, because a nag the agent cannot obey is noise.
 */
function targetFor(api, agent) {
  const configured = stringSetting(api, 'nagTarget', 'auto');
  if (configured === DELIVER_AGENT || configured === DELIVER_USER || configured === 'off') return configured;
  const tools = api?.tools;
  if (!tools || typeof tools.get !== 'function') return DELIVER_USER;
  try {
    return tools.get(GOAL_TOOL, agent) === undefined ? DELIVER_USER : DELIVER_AGENT;
  } catch {
    return DELIVER_USER;
  }
}

/** Deliver the notice to the agent. `false` means it was not delivered. */
function injectNotice(api, agent, text) {
  if (typeof api?.inject !== 'function') return false;
  return api.inject(agent, messageFor(text)) === true;
}

/**
 * Send the nag through the operator's notification transport.
 *
 * The send is fire-and-forget: the decision is delivered or not, and a transport
 * that fails never changes an outcome. The transport's own rate limiting and
 * suppression counting stay in the core, which owns them.
 */
function notifyUser(api, agent, event, text) {
  const send = api?.notifications?.send;
  if (typeof send !== 'function') return false;
  try {
    const result = send(text, {
      reason: 'no-goal',
      callId: event.callId ?? null,
      session: agent?.session?.id ?? null,
    });
    if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
      result.then(NOOP, NOOP);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * One `question/evaluated` event: decide, deliver once, record.
 *
 * Never throws. The publisher is `answer.questions` in the middle of its own
 * decision, and a broken nag must not fail that decision — the core channel
 * already logs a throwing subscriber, and this keeps the promise out of it.
 */
function onEvaluated(api, payload) {
  try {
    const event = isRecord(payload) ? payload : {};
    // The channel fires at the moment of a delegation. The guard covers a future
    // publisher that also reports answers, which never need a nag.
    if (event.outcome === 'answered') return;

    const callId = event.callId ?? null;
    const agent = event.agent;
    if (agent === undefined || agent === null) {
      // The frozen payload carries no agent. Recording it is the honest outcome;
      // guessing a recipient is not.
      record(api, { callId, decision: 'no-agent', wouldBe: 'skip' });
      return;
    }

    // Any goal at all — active, paused, blocked, complete, disarmed — is a
    // deliberate state, and only the absence of one needs reporting.
    if (api?.goals?.get?.(agent) !== undefined) return;

    const once = booleanSetting(api, 'nagOncePerSession', true);
    const key = agent.session ?? agent;
    if (once && latched.has(key)) {
      record(api, { callId, decision: 'suppressed', wouldBe: 'once-per-session' });
      return;
    }

    const target = targetFor(api, agent);
    if (target === 'off') {
      record(api, { callId, decision: 'off', wouldBe: 'off' });
      return;
    }

    const question = preview(questionTextOf(event));
    // Shadow records the would-be lever and nothing else: no injection, no
    // notification, and no latch, so the measurement does not silence a later
    // enforced run.
    if (api?.shadow?.isShadow?.(ID) === true) {
      record(api, { callId, question, decision: 'nag', wouldBe: target, mode: 'shadow' });
      return;
    }

    const delivered = target === DELIVER_AGENT
      ? injectNotice(api, agent, withQuestion(AGENT_TEXT, question))
      : notifyUser(api, agent, event, withQuestion(USER_TEXT, question));

    // Only a delivery that was issued closes the latch: a failed one leaves the
    // session its one nag.
    if (delivered && once) latched.add(key);
    record(api, { callId, question, decision: delivered ? 'nag' : 'failed', wouldBe: target });
  } catch {
    // Advisory by construction: a failure here changes nothing downstream.
  }
}

export default {
  id: ID,
  description: 'Tells whoever can act that the session has no goal.',
  label: 'No-goal reminder',
  /**
   * No harness seam at all. This module hears the decision through the core's own
   * channel (`api.events`) and delivers through `api.inject`, so naming a seam it
   * never listens on only bought a listener that could never fire. `null` says
   * what is true, and the registry registers nothing for it.
   */
  seam: null,
  seamClass: 'broadcast',
  settings: {
    nagTarget: {
      type: 'string',
      default: 'auto',
      description: 'Who receives the no-goal nag: auto (the agent when the goal tool is registered, otherwise the operator), agent, user, or off.',
    },
    nagOncePerSession: {
      type: 'boolean',
      default: true,
      description: 'Deliver at most one no-goal nag per session. A later question in the same session is recorded as suppressed.',
    },
  },

  /**
   * Subscribe to the plugin-internal decision channel.
   *
   * A host with no channel leaves the module subscribed to nothing and started:
   * the declared soft dependency is inert, not a startup failure. A previous
   * subscription is released first, so a re-entered start cannot double-fire.
   */
  start(api) {
    if (typeof delivery === 'function') {
      try {
        delivery();
      } catch {
        // Releasing a subscription that is already gone is not a failure.
      }
    }
    delivery = null;
    const subscribe = api?.events?.subscribe;
    if (typeof subscribe !== 'function') return;
    delivery = subscribe(SEAMS.INTERNAL_QUESTION_EVALUATED, (payload) => onEvaluated(api, payload));
  },

  /** Release the subscription and the latch: nothing survives a toggle-off. */
  stop() {
    if (typeof delivery === 'function') {
      try {
        delivery();
      } catch {
        // A disposer that throws must not stop the rest of the teardown.
      }
    }
    delivery = null;
    latched = new WeakSet();
  },

  /**
   * The registry requires a handler of every module and dispatches this seam's
   * events to it. Nothing emits `agent/inject` on this harness, so this never
   * runs; the nag's trigger is the channel subscribed in `start()`.
   *
   * @returns {undefined} the unchanged event, as a broadcast observer must.
   */
  handle() {
    return undefined;
  },
};
