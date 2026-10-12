/**
 * guide.shared — deliver a correction to the agents this session already told.
 *
 * The recipient map comes from this session's OWN log. Sending to another agent
 * is the shipped `send_message` tool, which names its recipient in an `agent_id`
 * argument, and every tool call is recorded in the sender's session. So this
 * module does not need a cross-session store: it reads what it sent, to whom, in
 * the same history every other module already reads.
 *
 * It is a broadcast observer. It never rewrites the pre-step decision, because
 * five other modules observe that seam beside it.
 *
 * What it deliberately does not do: guess. A judgement that is missing, below the
 * threshold, or unaffordable delivers nothing, and the ledger says why.
 *
 * @module dsh-jev-layer/modules/guide-shared
 */
import { createHash, randomUUID } from 'node:crypto';

import { SEAMS } from '../seams.js';

/** Stable id: config key, ledger key, shadow key and notice tag. */
const ID = 'guide.shared';

/** The source kind this plugin declares for context it injects. */
const SOURCE_KIND = 'dsh-jev-layer';

/** The tool whose calls carry the recipient map. */
const SEND_TOOL = 'send_message';

/** Defaults. Every one is a declared, editable setting. */
const DEFAULT_MIN_PROBABILITY = 0.8;
const DEFAULT_LOOKBACK_MESSAGES = 40;
const DEFAULT_MAX_PER_SESSION = 3;

/**
 * Per-session state, keyed by session id: what each recipient was last told, and
 * which (recipient, content) pairs have already been corrected. Cleared on stop,
 * because a module that leaks state between sessions would correct the wrong agent.
 */
const state = new Map();

function stateFor(sessionId) {
  let entry = state.get(sessionId);
  if (entry === undefined) {
    entry = { told: new Map(), delivered: new Set() };
    state.set(sessionId, entry);
  }
  return entry;
}

/** Read one of this module's own settings, defensively. */
function setting(api, key, fallback) {
  try {
    const value = api?.config?.get?.(key);
    return value === undefined || value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

function numberSetting(api, key, fallback) {
  const value = Number(setting(api, key, fallback));
  return Number.isFinite(value) ? value : fallback;
}

function modeOf(api) {
  return api?.shadow?.isShadow?.(ID) === true ? 'shadow' : 'enforce';
}

/** One ledger row per decision. The session log stays the source of truth. */
function record(api, entry) {
  try {
    api?.ledger?.append?.({
      featureId: ID,
      callId: entry.callId ?? '',
      question: entry.question ?? null,
      probabilities: entry.probabilities ?? [],
      threshold: entry.threshold ?? null,
      decision: entry.decision,
      wouldBe: entry.wouldBe ?? null,
      mode: entry.mode ?? 'enforce',
      reason: entry.reason ?? '',
      at: Date.now(),
    });
  } catch {
    /* a ledger that cannot be written must not stop the observation */
  }
}

/** Tool-call arguments arrive as an object or as a JSON string. */
function parseArguments(raw) {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || raw === '') return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function textOf(entry) {
  if (typeof entry === 'string') return entry;
  if (entry === null || entry === undefined) return '';
  return typeof entry.message === 'string' ? entry.message : '';
}

/**
 * Every `send_message` call in the trailing window, oldest first.
 *
 * @param {unknown} history derived session messages
 * @param {number} lookback how many trailing messages to examine
 * @returns {Array<{ recipientId: string, text: string }>}
 */
function collectSends(history, lookback) {
  const messages = Array.isArray(history) ? history : [];
  const from = Math.max(0, messages.length - Math.max(1, lookback));
  const sends = [];
  for (let index = from; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role !== 'assistant') continue;
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (block?.type !== 'tool-call') continue;
      if (block.name !== SEND_TOOL) continue;
      const args = parseArguments(block.arguments);
      if (args === undefined) continue;
      const recipientId = String(args.agent_id ?? args.agentId ?? '');
      if (recipientId === '') continue;
      sends.push({ recipientId, text: textOf(args) });
    }
  }
  return sends;
}

/** A stable digest, so one correction per recipient per content. */
function digest(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** The correction this module injects into another agent. */
function buildMessage(change) {
  return Object.freeze({
    role: 'user',
    id: randomUUID(),
    content: [
      {
        type: 'text',
        text:
          'A finding this session shared with you has been superseded. '
          + `The earlier statement was: ${change.previous}\n`
          + `The current statement is: ${change.current}\n`
          + 'Use the current statement. This note is a correction, not a new task.',
      },
    ],
    source: Object.freeze({
      kind: SOURCE_KIND,
      form: 'notice',
      summary: 'a shared finding was corrected',
    }),
  });
}

function readProbability(answer) {
  if (typeof answer === 'number' && Number.isFinite(answer)) return answer;
  if (answer === null || typeof answer !== 'object') return undefined;
  const value = answer.noul ?? answer.probability ?? answer.value;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The question the judge answers for one changed pair. */
function contradictionQuestion() {
  return {
    q: {
      type: 'noul',
      instructions:
        'The state holds two statements this session sent to the same recipient, '
        + '`previous` then `current`. Does `current` contradict `previous`, so that a '
        + 'recipient acting on the earlier one would now be acting on something false?',
      criteria: {
        true: 'the two statements cannot both be true, or current reverses previous',
        false: 'current restates, extends or refines previous without contradicting it',
      },
    },
  };
}

export default {
  id: ID,
  description: 'Delivers a correction to exactly the agents this session already sent a finding to, by reading its own `send_message` history.',
  label: 'Correct agents told something false',
  // Spends the turn budget or raises a notice: needs the turn boundary and the notice drain.
  needsTurn: true,
  seam: SEAMS.AGENT_PRE_STEP,
  seamClass: 'broadcast',
  settings: {
    minProbability: {
      type: 'number',
      default: DEFAULT_MIN_PROBABILITY,
      description: 'Only correct a recipient when the judge is at least this sure that the new statement contradicts the old one.',
    },
    lookbackMessages: {
      type: 'number',
      default: DEFAULT_LOOKBACK_MESSAGES,
      description: 'How many trailing messages to scan for send_message calls.',
    },
    maxPerSession: {
      type: 'number',
      default: DEFAULT_MAX_PER_SESSION,
      description: 'Hard ceiling on corrections delivered in one session, so a chatty session cannot become a broadcast.',
    },
  },

  async handle(event, api) {
    try {
      const session = event?.agent?.session;
      if (session === undefined || session === null) return undefined;
      if (typeof session.deriveMessages !== 'function') return undefined;
      const sessionId = String(session.id ?? '');
      if (sessionId === '') return undefined;

      const mode = modeOf(api);
      const lookback = numberSetting(api, 'lookbackMessages', DEFAULT_LOOKBACK_MESSAGES);
      const sends = collectSends(session.deriveMessages(), lookback);
      if (sends.length === 0) return undefined;

      // The host replays the WHOLE appended history on every step, so read the
      // LATEST text per recipient and compare that against what the recipient was
      // last told. Walking history while updating its own memory reads an old
      // statement as a fresh change and injects a correction that reverses the
      // real one; the independent review found exactly that here.
      const entry = stateFor(sessionId);
      const latest = new Map();
      for (const send of sends) latest.set(send.recipientId, send.text);

      const changed = [];
      for (const [recipientId, text] of latest) {
        const previous = entry.told.get(recipientId);
        if (previous !== undefined && previous !== text) {
          changed.push({ recipientId, previous, current: text });
        }
        entry.told.set(recipientId, text);
      }
      if (changed.length === 0) return undefined;

      const minProbability = numberSetting(api, 'minProbability', DEFAULT_MIN_PROBABILITY);
      const maxPerSession = numberSetting(api, 'maxPerSession', DEFAULT_MAX_PER_SESSION);

      for (const change of changed) {
        const key = `${change.recipientId}:${digest(change.current)}`;
        if (entry.delivered.has(key)) continue;
        if (entry.delivered.size >= maxPerSession) {
          record(api, { decision: 'over-cap', reason: 'session cap reached', mode });
          break;
        }
        if (api?.budget?.tryAcquire?.(ID, 1) === false) {
          record(api, { decision: 'no-budget', reason: 'the shared budget refused', mode });
          break;
        }

        const answers = await api?.judge?.ask?.(
          { previous: change.previous, current: change.current },
          contradictionQuestion(),
          { featureId: ID, failOpen: 'deliver-nothing' },
        );
        const probability = readProbability(answers?.q);
        if (probability === undefined) {
          record(api, { decision: 'undecided', reason: 'no readable answer', mode });
          continue;
        }
        if (probability < minProbability) {
          record(api, {
            decision: 'not-a-contradiction',
            probabilities: [probability],
            threshold: minProbability,
            mode,
          });
          continue;
        }

        // From here the pair is corrected, once, whatever the mode.
        entry.delivered.add(key);

        if (mode === 'shadow') {
          record(api, {
            decision: 'correction-shadow',
            wouldBe: 'inject',
            probabilities: [probability],
            threshold: minProbability,
            mode,
          });
          continue;
        }

        const target = api?.agents?.get?.(change.recipientId);
        const injected = target === undefined ? false : api?.inject?.(target, buildMessage(change)) === true;
        record(api, {
          decision: injected ? 'correction-delivered' : 'correction-undeliverable',
          wouldBe: null,
          probabilities: [probability],
          threshold: minProbability,
          reason: target === undefined ? 'the recipient is not a live agent' : '',
          mode,
        });
      }
    } catch (error) {
      // Observation must never reach the publisher's decision.
      api?.log?.warn?.(`[dsh-jev-layer] guide.shared skipped a step: ${error?.message ?? error}`);
    }
    return undefined;
  },

  stop() {
    state.clear();
  },
};
