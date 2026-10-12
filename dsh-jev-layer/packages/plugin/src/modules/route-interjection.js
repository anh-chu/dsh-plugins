/**
 * `route.interjection` — route a correction the user sent mid-run to the next step.
 *
 * ## The gap this module fills
 *
 * A message the user submits while a turn is already running arrives in the
 * default delivery mode as a queued follow-up, not as steering
 * (`@deepseek-ai/dsh-api-session-controller`, `lib/index.js:883`: `steer` only in
 * the explicit mode, `followup` otherwise). The loop claims pending input at each
 * step boundary, and that claim takes *all* of the next-step list but only **one**
 * next-turn message per turn (`@deepseek-ai/dsh-agent-loop`, `lib/index.js:103-111`).
 * So a correction typed while the agent works is invisible to the running turn and
 * waits for a turn of its own — which, in a long autonomous run, may be the whole
 * task later.
 *
 * ## What it does
 *
 * On every `agent/pre-step` it reads the agent's own pending turn queue,
 * `event.agent.inbox.nextTurn` (`Agent.inbox`, "Agent-owned access to pending
 * work"), and routes the user-authored messages in it to the nearest later step
 * through `api.inject`. The route is queue-only: `Agent.inject` is
 * `send(message, 'next-step', false)` — it queues context for the next pre-step
 * and does not wake the driver (`lib/index.js:812`). The decision under judgment
 * is not touched.
 *
 * ## The seam
 *
 * `agent/pre-step` is `broadcast`: `select.skill`, `supervise.goal`,
 * `remind.drift` and `guide.instructions` all observe it, so no owner may rewrite
 * the decision. This module returns `undefined` on every path and mutates nothing
 * — not the payload, not `messages`, and not the inbox. The decision the harness
 * would have produced is the decision the registry hands back.
 *
 * ## Why a judge gates it
 *
 * Not every queued message is a correction: a queued follow-up may be an unrelated
 * next task that its own turn will carry correctly. One `noul` question per
 * candidate decides, `failOpen: 'queue'` names what "do nothing" means here, and
 * every outcome — routed, declined, no judge, no budget — is recorded in the
 * ledger, so a considered refusal and a module that never fired do not look alike.
 * At most one candidate is judged per pre-step, so the answer a step waits for is
 * bounded at one request.
 *
 * ## The source label is load-bearing
 *
 * The delivered message is a fresh user-role message carrying this module's own
 * source kind and `form: 'notice'`, because an unlabelled context renders as a
 * user prompt in derived history. `@deepseek-ai/dsh-tool-jobs` builds the same
 * shape (`lib/index.js:275-280`) and calls `owner.inject(message)` with it.
 *
 * ponytail: delivery is additive, never a move. The original message stays in
 * `nextTurn` and still opens its own turn, so the model can see the correction
 * twice. Removing or moving pending user input would rewrite the message list at
 * a seam this module may not transform; that needs an exclusive seam and is not
 * this module's decision to take. Reported unresolved with this ticket.
 *
 * @module dsh-jev-layer/modules/route-interjection
 */
import { createHash, randomUUID } from 'node:crypto';
import { SEAMS } from '../seams.js';

/** Stable id: config key, ledger key, shadow key and notice tag. */
const ID = 'route.interjection';
/** The producer label on the injected message; an unknown kind falls through. */
const SOURCE_KIND = ID;
/** The question the judge answers without the model seeing it. */
const QUESTION_ID = 'correction';
/** Below this probability the message keeps its queued turn and nothing is routed. */
const DEFAULT_THRESHOLD = 0.5;
/** The step is waiting for this answer, so the request is bounded. */
const DEFAULT_TIMEOUT_MS = 4000;
/** Caller text has no length of its own; one notice cannot ride in unbounded. */
const MAX_TEXT_CHARS = 2000;
/** One judgment per pre-step, so the added latency stays bounded. */
const MAX_PER_STEP = 1;
/** One-line account carried by a `notice`-form source (bound: 120 chars). */
const SUMMARY = 'user correction routed to the next step';

/**
 * The correction test, as one `noul` question.
 *
 * English on purpose: the judge reads it, not the operator.
 */
const CORRECTION_QUESTION = Object.freeze({
  type: 'noul',
  instructions: '`message` was written by the user while the agent was already working on this turn. '
    + 'Does it correct, redirect or constrain that work in progress, so the running step should see '
    + 'it now — rather than an unrelated request or an acknowledgement that its own turn can carry?',
  criteria: {
    true: 'a correction, redirection or constraint on the work in progress',
    false: 'a new unrelated task, an acknowledgement, or anything that can wait for its own turn',
  },
});

/**
 * Messages already judged, per agent.
 *
 * Keyed the way the registry keys an agent, and released through
 * `api.registerAgent`'s teardown, so no state survives an agent and none is
 * shared between agents. `stop()` clears the rest.
 */
const seen = new Map();

/** Read a numeric setting, falling back when it is absent or not finite. */
function numberSetting(api, key, fallback) {
  const value = api?.config?.get?.(key);
  return Number.isFinite(value) ? value : fallback;
}

/** The readable text of one message, from its `text` content blocks. */
function textOf(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

/**
 * Whether one message is something the user wrote.
 *
 * A genuine prompt carries `source.kind === 'user'`
 * (`dsh-api-session-controller`, `lib/index.js:852`); the shipped
 * `repeat-tool-reminder` reads the same field to recognise user input
 * (`lib/index.js:1583`). A missing source counts as user text, the conservative
 * reading this package uses elsewhere: skipping it would silently drop a
 * correction.
 */
function isUserAuthored(message) {
  const source = message?.source;
  return source === undefined || source === null || source.kind === 'user';
}

/** A short stable digest; the fallback key stays readable and collisions do not matter. */
function digest(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/**
 * The identity of one candidate.
 *
 * The harness gives every message an id, and the inbox projection refuses two
 * pending messages that share one, so the id is both available and the honest
 * key. A message without one falls back to its text, which is all that can
 * distinguish it.
 */
function keyOf(message) {
  if (typeof message?.id === 'string' && message.id !== '') return message.id;
  const text = textOf(message).trim();
  return text === '' ? undefined : `text:${digest(text)}`;
}

/** The set of candidates already judged for one agent, registered on first use. */
function seenFor(agent, api) {
  const key = agent?.id ?? agent;
  const existing = seen.get(key);
  if (existing !== undefined) return existing;

  const set = new Set();
  seen.set(key, set);
  try {
    api?.registerAgent?.(agent, () => () => {
      if (seen.get(key) === set) seen.delete(key);
    });
  } catch {
    // A host that refuses the registration still gets correct routing for this
    // process; `stop()` is the other release path.
  }
  return set;
}

/** Append one ledger record in the frozen shape. Bookkeeping never decides. */
function record(api, fields) {
  try {
    api?.ledger?.append?.({
      featureId: ID,
      callId: fields.callId ?? '',
      question: QUESTION_ID,
      probabilities: fields.probabilities ?? {},
      threshold: fields.threshold ?? null,
      decision: fields.decision,
      wouldBe: fields.wouldBe ?? 'queue',
      mode: fields.mode ?? (api?.shadow?.isShadow?.(ID) === true ? 'shadow' : 'enforce'),
      at: Date.now(),
    });
  } catch {
    // The ledger is a derived cache; a failure to record must not cascade.
  }
}

/**
 * The probability under {@link QUESTION_ID}, or `undefined` when the answer
 * cannot be read. An absent or wrong-typed answer is a communication failure, so
 * it is neither a correction nor a refusal.
 */
function readProbability(answers) {
  if (answers === null || answers === undefined) return undefined;
  const answer = answers[QUESTION_ID];
  const raw = answer && typeof answer === 'object' ? answer.noul ?? answer.probability : answer;
  return Number.isFinite(raw) ? raw : undefined;
}

/**
 * Build the identified user-role message the way the harness's own producers do:
 * a text block, plus this module's source kind and `form: 'notice'` with the
 * one-line summary that form requires. `@deepseek-ai/dsh-llm` is not a runtime
 * dependency of this package, so the equivalent is built here and frozen.
 */
function messageFor(text) {
  const content = Object.freeze([Object.freeze({ type: 'text', text })]);
  const source = Object.freeze({ kind: SOURCE_KIND, form: 'notice', summary: SUMMARY });
  return Object.freeze({ role: 'user', id: randomUUID(), content, source });
}

/** The model-facing text: what this is, and that it belongs to the current work. */
function textFor(text) {
  return 'The user sent this correction while this turn was already running:\n\n'
    + text
    + '\n\nApply it to the work in progress now; do not wait for a new turn.';
}

/**
 * Judge one candidate and route it when it is a correction.
 *
 * Never throws: a judge that is absent, unconfigured, out of budget, slow or
 * wrong delivers nothing and leaves the message in its queue, which is the same
 * place it already was. Each of those outcomes is recorded.
 */
async function routeOne(agent, message, api) {
  const callId = typeof message?.id === 'string' ? message.id : '';
  const text = textOf(message).trim();
  if (text === '') {
    record(api, { callId, decision: 'skipped', wouldBe: 'queue' });
    return;
  }

  const threshold = numberSetting(api, 'threshold', DEFAULT_THRESHOLD);
  if (api?.judge?.configured === false) {
    record(api, { callId, threshold, decision: 'no-judge', wouldBe: 'queue' });
    return;
  }
  if (typeof api?.budget?.tryAcquire === 'function' && api.budget.tryAcquire(ID, 1) === false) {
    record(api, { callId, threshold, decision: 'no-budget', wouldBe: 'queue' });
    return;
  }

  let answers;
  try {
    answers = await api.judge.ask(
      { message: text.slice(0, MAX_TEXT_CHARS) },
      { [QUESTION_ID]: CORRECTION_QUESTION },
      { featureId: ID, failOpen: 'queue', timeoutMs: numberSetting(api, 'timeoutMs', DEFAULT_TIMEOUT_MS) },
    );
  } catch {
    // A judge that throws is not a verdict; the message keeps its queued turn.
    answers = null;
  }

  const probability = readProbability(answers);
  if (probability === undefined) {
    record(api, { callId, threshold, decision: 'skipped', wouldBe: 'queue' });
    return;
  }

  const probabilities = { [QUESTION_ID]: probability };
  if (probability < threshold) {
    record(api, { callId, probabilities, threshold, decision: 'queued', wouldBe: 'queue' });
    return;
  }

  // Shadow records the route it would have taken and delivers nothing.
  if (api?.shadow?.isShadow?.(ID) === true) {
    record(api, { callId, probabilities, threshold, decision: 'route', wouldBe: 'inject', mode: 'shadow' });
    return;
  }

  let delivered = false;
  try {
    delivered = typeof api?.inject === 'function'
      && api.inject(agent, messageFor(textFor(text.slice(0, MAX_TEXT_CHARS)))) === true;
  } catch {
    // A delivery that threw is a failed delivery, not a broken step.
    delivered = false;
  }
  record(api, {
    callId,
    probabilities,
    threshold,
    decision: delivered ? 'route' : 'failed',
    wouldBe: 'inject',
  });
}

export default {
  id: ID,
  description: 'Queues a running correction for the next step.',
  label: 'Route mid-task corrections',
  // Spends the turn budget or raises a notice: needs the turn boundary and the notice drain.
  needsTurn: true,
  seam: SEAMS.AGENT_PRE_STEP,
  seamClass: 'broadcast',
  settings: {
    threshold: {
      type: 'number',
      default: DEFAULT_THRESHOLD,
      description: 'Probability at or above which a queued user message is treated as a correction and routed to the next step.',
    },
    timeoutMs: {
      type: 'number',
      default: DEFAULT_TIMEOUT_MS,
      description: 'Bound on the judge request for one candidate; the step being decided waits for this answer.',
    },
  },

  /** Release every per-agent record this module kept. */
  stop() {
    seen.clear();
  },

  /**
   * Observe one `agent/pre-step` and route any pending user correction.
   *
   * A broadcast observer may never rewrite the decision — `select.skill` and
   * three other modules share this seam — so the return value is `undefined` on
   * every path, including after a failure inside this module. The routing itself
   * is a side effect on the agent's next-step queue, which is a different step
   * from the one being decided.
   */
  async handle(event, api) {
    try {
      const agent = event?.agent;
      const pending = agent?.inbox?.nextTurn;
      if (!Array.isArray(pending) || pending.length === 0) return undefined;

      const judged = seenFor(agent, api);
      let routed = 0;
      for (const message of pending) {
        if (routed >= MAX_PER_STEP) break;
        if (!isUserAuthored(message)) continue;
        const key = keyOf(message);
        if (key === undefined || judged.has(key)) continue;
        // Marked before the judgment: a slow or failed judge must not turn one
        // correction into one delivery per step.
        judged.add(key);
        routed += 1;
        await routeOne(agent, message, api);
      }
    } catch (error) {
      // Advisory by construction: a routing failure never breaks the step for
      // the harness or for the modules that do transform it.
      try {
        api?.log?.warn?.('[route.interjection] a correction was not routed', error);
      } catch {
        // Logging must not become the failure.
      }
    }
    return undefined;
  },
};
