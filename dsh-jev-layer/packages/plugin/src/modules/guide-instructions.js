/**
 * `guide.instructions` — one notice when a session runs with no guidance.
 *
 * An agent that starts without instructions runs on the request alone: no
 * workspace rules, no AGENTS.md context, no project conventions. Nothing fails,
 * and that is the problem — the operator cannot tell "the rules were followed"
 * from "no rules were present". This module looks at what guidance the session
 * actually carries and raises one advisory notice when there is none.
 *
 * ## What counts as present
 *
 * The harness delivers instruction context as a user-role message whose
 * `source.kind` is `agent-instructions`
 * (`@deepseek-ai/dsh-agent-instructions`, `form: 'instructions'`). Injected
 * context is labelled by its producer, and that label is the only honest signal:
 * an unlabelled context would render as a user prompt in derived history, which
 * is exactly why the harness labels its own. A message whose `source.form` is
 * `instructions` counts too — a loaded skill arrives that way — because a skill
 * the model was given really is guidance, and the safe failure for an advisory
 * module is silence, never a notice about rules that are visibly there.
 *
 * ## Why the check waits for a completed step
 *
 * `dsh-agent-instructions` adds its message inside the same `agent/pre-step`
 * waterfall, after its `next()`. A later observer sees the payload, not the
 * decision, so at turn 1 step 1 the rules are in neither the claimed messages
 * nor the committed history even when they exist. Judging absence there would
 * report a gap on every guided session. The module therefore waits until the
 * session has at least one assistant message — one completed step — which is the
 * first moment at which "absent" means something. Then it judges once per
 * session, whatever the answer.
 *
 * ## What it reads
 *
 * Only the event and the api: the claimed messages on the payload and the
 * session's model-visible history, both of which the event exposes. It reads no
 * file, and it cannot tell whether an instruction file exists on disk — that is
 * the harness's business, and a module that re-derived it would guess.
 *
 * ## The seam
 *
 * A `broadcast` observer on `agent/pre-step`, like `select.skill`,
 * `supervise.goal` and `remind.drift`. It returns `undefined` on every path and
 * mutates nothing, so the step decision passes through unchanged; its one
 * channel is the core notice arbiter, and the notice carries this module's tag,
 * `form: 'notice'` on the injected side, and a stable `dedupeKey` per session,
 * so a repeat is suppressed and recorded rather than repeated.
 *
 * @module dsh-jev-layer/modules/guide-instructions
 */
import { SEAMS } from '../seams.js';

/** Stable id: config key, ledger key, shadow key and notice tag. */
const ID = 'guide.instructions';
/** The question this module answers without a judge. */
const QUESTION_ID = 'guidance';
/** Advisory notices carry no ordering pressure; kind already separates them. */
const NOTICE_PRIORITY = 10;
/** The producer label the harness puts on instruction context. */
const DEFAULT_INSTRUCTION_KINDS = ['agent-instructions'];
/** What the module would raise when nothing applies: one notice, once. */
const ABSENT = 'notice';

/**
 * Sessions already judged.
 *
 * A `WeakMap` keyed by the session object: the answer is per session, it must
 * die with the session, and a re-enabled module must start clean, which
 * `stop()` guarantees by replacing the map.
 */
let judged = new WeakMap();

/** Read a string-list setting, falling back when it is absent or not a list. */
function listSetting(api, key, fallback) {
  const value = api?.config?.get?.(key);
  return Array.isArray(value) ? value : fallback;
}

/** Whether one message carries instructions or rules addressed to the model. */
function isInstruction(message, kinds) {
  const source = message?.source;
  if (source === null || typeof source !== 'object') return false;
  if (typeof source.kind === 'string' && kinds.includes(source.kind)) return true;
  return source.form === 'instructions';
}

/** Whether guidance is present in what the step carries. */
function hasInstructions(messages, kinds) {
  for (const message of messages) {
    if (isInstruction(message, kinds)) return true;
  }
  return false;
}

/** Append one ledger row. Bookkeeping never decides and never throws. */
function record(api, fields) {
  try {
    api?.ledger?.append?.({
      featureId: ID,
      callId: fields.sessionId,
      question: QUESTION_ID,
      probabilities: {},
      threshold: null,
      decision: fields.decision,
      wouldBe: fields.wouldBe,
      mode: fields.mode,
      at: Date.now(),
    });
  } catch {
    // A ledger that is down must not change whether the operator is told.
  }
}

export default {
  id: ID,
  description: 'One notice when the applicable rules are missing.',
  label: 'Missing-rules reminder',
  // Spends the turn budget or raises a notice: needs the turn boundary and the notice drain.
  needsTurn: true,
  seam: SEAMS.AGENT_PRE_STEP,
  seamClass: 'broadcast',
  settings: {
    instructionKinds: {
      type: 'stringArray',
      default: [...DEFAULT_INSTRUCTION_KINDS],
      description: 'Message source kinds that count as applicable instructions or rules.',
    },
  },

  /** Released on unload or toggle-off: a judged session is a per-session fact. */
  stop() {
    judged = new WeakMap();
  },

  /**
   * Observe one `agent/pre-step`. Returns `undefined` on every path, so the
   * registry's broadcast dispatch hands the step decision back unchanged.
   */
  handle(event, api) {
    try {
      const session = event?.agent?.session;
      if (session === undefined || session === null) return undefined;
      if (typeof session.deriveMessages !== 'function') return undefined;

      const sessionId = String(session.id ?? '');
      const mode = api?.shadow?.isShadow?.(ID) === true ? 'shadow' : 'enforce';
      const kinds = listSetting(api, 'instructionKinds', DEFAULT_INSTRUCTION_KINDS);
      const history = session.deriveMessages();
      const claimed = Array.isArray(event?.messages) ? event.messages : [];

      // Present: settled for this session, recorded once, and silent.
      if (hasInstructions([...claimed, ...history], kinds)) {
        if (!judged.has(session)) {
          judged.set(session, 'present');
          record(api, { sessionId, decision: 'present', wouldBe: 'silent', mode });
        }
        return undefined;
      }

      // Not enough history to tell "absent" from "not delivered yet".
      if (!history.some((message) => message?.role === 'assistant')) return undefined;
      if (judged.has(session)) return undefined;

      // Shadow records the notice it would have raised and raises nothing.
      if (mode === 'shadow') {
        judged.set(session, ABSENT);
        record(api, { sessionId, decision: 'notice', wouldBe: ABSENT, mode });
        return undefined;
      }

      const outcome = api?.notice?.request?.({
        kind: 'advisory',
        priority: NOTICE_PRIORITY,
        text: 'Guidance check: no applicable rules or instructions are present for this session. '
          + 'None were supplied with the conversation, so only the request itself governs the work. '
          + 'Mention this if workspace guidance was expected.',
        tag: ID,
        dedupeKey: `${ID}:${sessionId}`,
      });
      const accepted = outcome === 'accepted';
      // The check runs once per session whatever the arbiter decided; the
      // suppression, when there is one, is recorded here and by the arbiter.
      judged.set(session, accepted ? ABSENT : 'suppressed');
      record(api, { sessionId, decision: accepted ? 'notice' : 'suppressed', wouldBe: ABSENT, mode });
      return undefined;
    } catch {
      // Advisory by construction: a failure raises no notice, records nothing,
      // and never breaks the step for the modules that do transform it.
      return undefined;
    }
  },
};
