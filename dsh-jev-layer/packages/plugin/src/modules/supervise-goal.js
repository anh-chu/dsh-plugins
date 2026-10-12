/**
 * `supervise.goal` — one advisory notice when a run of rounds stops moving.
 *
 * ## The seam
 *
 * `agent/pre-step` is a waterfall shared with `select.skill`, so this module is
 * a broadcast observer: it returns the event it was given and can never rewrite
 * the step decision. Everything it does — a notice request, a ledger row — is a
 * side effect, and a failure here leaves the step exactly as it arrived.
 *
 * ## What a round is
 *
 * One turn. `agent/pre-step` fires once per step, and the step number restarts
 * at 1 for each turn, so a change in `event.turn` closes the round before it and
 * opens the next one. The module therefore reads `turn` to find boundaries and
 * `step` to see how far a round got.
 *
 * ## What progress is
 *
 * Two signals, both read from the event alone. The module never asks whether a
 * goal exists, so it works whether or not the goal tool is enabled.
 *
 *   1. **Tool work.** A turn that calls a tool which does not conclude it is
 *      proposed again with `step >= 2`: in `dsh-agent-loop`, `step()` returns
 *      `{ kind: 'completed' }` for a reply with no tool call, which ends the
 *      turn after step 1, and returns `null` after tool calls that continue.
 *      Any pre-step beyond the first therefore proves the round reached the tool
 *      loop and did something.
 *   2. **New user input.** A round carrying a user-authored message the previous
 *      round did not carry is driven by a human. Injected context — a goal round
 *      prompt, a reminder, a catalog — carries a `source.kind` and is not user
 *      input, and a round prompt that only renumbers itself is not progress.
 *
 * A round that shows neither is a round without progress. The count is evaluated
 * at a round boundary: a run of `stalledRounds` rounds is complete when the next
 * one begins, and the notice is delivered to that next round. The notice is
 * advisory and names no objective.
 *
 * ## Once per agent
 *
 * The first boundary at or past the threshold takes the decision, and the module
 * never takes a second one for that agent. In shadow mode it records the notice
 * it would have raised and raises nothing.
 *
 * ponytail: both signals are proxies with a known ceiling. An agent that keeps
 * calling tools without advancing counts as progressing, and a steer queued
 * after a completed step forces a step 2 and does the same. The upgrade path is
 * a judgment over session evidence once a non-deprecated reader exists —
 * `Session.snapshotEvents()` and `ownEvents()` are marked "new calls are
 * prohibited". The once-per-agent latch bounds the cost of a false positive.
 *
 * @module dsh-jev-layer/modules/supervise-goal
 */
import { SEAMS } from '../seams.js';

/** Stable id: config key, ledger key, shadow key and notice tag. */
const ID = 'supervise.goal';
/** Rounds without progress tolerated before the one notice. */
const DEFAULT_STALLED_ROUNDS = 4;
/** Advisory notices carry no ordering pressure; `kind` already separates them. */
const NOTICE_PRIORITY = 10;
/** How many messages of one round the user-input comparison reads. */
const MAX_USER_CHARS = 4000;

/**
 * Per-agent supervision state, keyed the way the registry keys an agent.
 *
 * An agent is registered through `api.registerAgent` the first time it appears,
 * and the teardown of that registration removes its entry, so no state survives
 * an agent and none is shared between agents. `stop()` clears the rest.
 */
const states = new Map();

/** The configured round budget, or the default when it is absent or unusable. */
function stalledRounds(api) {
  const value = api?.config?.get?.('stalledRounds');
  if (!Number.isFinite(value)) return DEFAULT_STALLED_ROUNDS;
  return Math.max(1, Math.floor(value));
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
 * A missing source counts as user text, the conservative reading: skipping it
 * would let a human-driven round look like a loop repeating itself.
 */
function isUserAuthored(message) {
  const source = message?.source;
  return source === undefined || source === null || source.kind === 'user';
}

/** The user-authored text of one round, trimmed to {@link MAX_USER_CHARS}. */
function userText(messages) {
  if (!Array.isArray(messages)) return '';
  const parts = [];
  for (const message of messages) {
    if (!isUserAuthored(message)) continue;
    parts.push(textOf(message));
  }
  return parts.join('\n').trim().slice(0, MAX_USER_CHARS);
}

/** The state for one agent, registering it once through the agent's own scope. */
function stateFor(agent, api) {
  const key = agent?.id ?? agent;
  const existing = states.get(key);
  if (existing !== undefined) return existing;

  const id = typeof agent?.id === 'string' && agent.id !== '' ? agent.id : 'agent';
  const state = {
    key,
    /** Dedupe key suffix: one notice per agent per session. */
    keyText: id,
    turn: undefined,
    step: 1,
    /** The round being tracked reached a step beyond its first. */
    worked: false,
    /** The user-authored text the current round arrived with. */
    userText: '',
    stalled: 0,
    decided: false,
  };
  states.set(key, state);
  try {
    api?.registerAgent?.(agent, () => () => {
      if (states.get(key) === state) states.delete(key);
    });
  } catch {
    // A host that refuses the registration still gets correct supervision for
    // this process; `stop()` is the other release path.
  }
  return state;
}

/** Append one ledger record in the frozen shape. Bookkeeping never decides. */
function record(api, { threshold, mode }) {
  try {
    api?.ledger?.append?.({
      featureId: ID,
      callId: '',
      question: null,
      probabilities: {},
      threshold,
      decision: 'stall',
      wouldBe: 'notice',
      mode,
      at: Date.now(),
    });
  } catch {
    // The ledger is a derived cache; a failure to record must not cascade.
  }
}

/**
 * Take the one decision: record it always, raise the notice unless shadow.
 *
 * The latch is set first, so a throwing arbiter cannot turn one stall into a
 * notice per round.
 */
function decide(state, api, threshold) {
  state.decided = true;
  const shadow = api?.shadow?.isShadow?.(ID) === true;
  record(api, { threshold, mode: shadow ? 'shadow' : 'enforce' });
  if (shadow) return;
  try {
    api?.notice?.request?.({
      kind: 'advisory',
      priority: NOTICE_PRIORITY,
      text: `No progress for ${state.stalled} rounds: each round ended without tool work and without new user input. `
        + 'Change approach, or state what is blocking the work; if a goal is active, check whether it is stuck.',
      tag: ID,
      dedupeKey: `${ID}:${state.keyText}`,
    });
  } catch (error) {
    try {
      api?.log?.warn?.('[supervise.goal] the notice was refused', error);
    } catch {
      // Logging must not become the failure.
    }
  }
}

/**
 * Fold one pre-step event into the agent's state, and decide if the moment came.
 *
 * Pure bookkeeping apart from {@link decide}, so the counting rule is readable
 * in one place: a turn change closes the previous round, and the round is judged
 * on the two progress signals before the new round replaces them.
 */
function observe(state, event, threshold, api) {
  const turn = event?.turn;
  // A round is a turn; an event without a turn number cannot be placed.
  if (!Number.isFinite(turn)) return;
  const step = Number.isFinite(event?.step) ? event.step : 1;
  const text = userText(event?.messages);

  if (state.turn === undefined) {
    state.turn = turn;
    state.step = step;
    state.worked = step >= 2;
    state.userText = text;
    return;
  }

  if (turn === state.turn) {
    if (step > state.step) {
      state.step = step;
      state.worked = true;
    }
    return;
  }

  // A new round begins: judge the one that just ended, then track the new one.
  const freshInput = text !== '' && text !== state.userText;
  state.stalled = state.worked || freshInput ? 0 : state.stalled + 1;
  state.turn = turn;
  state.step = step;
  state.worked = step >= 2;
  state.userText = text;

  if (state.stalled >= threshold && !state.decided) decide(state, api, threshold);
}

export default {
  id: ID,
  description: 'One notice after a run of rounds without progress.',
  label: 'Stalled-goal alert',
  // Spends the turn budget or raises a notice: needs the turn boundary and the notice drain.
  needsTurn: true,
  seam: SEAMS.AGENT_PRE_STEP,
  seamClass: 'broadcast',
  settings: {
    stalledRounds: {
      type: 'number',
      default: DEFAULT_STALLED_ROUNDS,
      description: 'Rounds without progress, judged at round boundaries, before one advisory notice is raised.',
    },
  },

  /** Release every per-agent record this module kept. */
  stop() {
    states.clear();
  },

  /**
   * Observe one `agent/pre-step` and hand the event back unchanged.
   *
   * A broadcast observer may never rewrite the pre-step decision — `select.skill`
   * shares this seam — so the return value is the event, always, including after
   * a failure inside this module.
   */
  async handle(event, api) {
    try {
      const agent = event?.agent;
      if (agent !== undefined && agent !== null) {
        observe(stateFor(agent, api), event, stalledRounds(api), api);
      }
    } catch (error) {
      // Advisory by construction: a supervision failure never breaks the step
      // for the harness or for the modules that do transform it.
      try {
        api?.log?.warn?.('[supervise.goal] a round was not judged', error);
      } catch {
        // Logging must not become the failure.
      }
    }
    return event;
  },
};
