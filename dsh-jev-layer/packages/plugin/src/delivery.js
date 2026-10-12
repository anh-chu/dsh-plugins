/**
 * Turn boundaries and notice delivery, on the `agent/pre-step` seam.
 *
 * Two jobs share one hook because both need the same fact — "which turn is this
 * step in" — and the harness states it only here (`payload.turn`, `payload.step`).
 *
 * 1. **The turn budget must reset.** `core.budget` is a per-turn ceiling, but the
 *    plugin never told it a turn began. With the default ceiling of 20, the 21st
 *    judgment in the life of the host was refused and every judge-calling module
 *    failed open from then on, silently. Found by calling `tryAcquire` six times
 *    against a ceiling of 3: `true,false,false,false,false,false`.
 *
 * 2. **An accepted notice must reach the model.** Seven modules raise advisory
 *    notices through the core arbiter, which holds one winner per turn and hands it
 *    out through `notice.drain()`. Nothing called `drain()`, so the ledger said
 *    `notice` while the model saw nothing: the real turn's tool result carried no
 *    module text. The winner is appended to this step's admitted messages, labelled
 *    with the plugin's own source kind and `form: 'notice'` (an unlabelled context
 *    renders as a user prompt in derived history).
 *
 * Order matters. A new turn closes the previous one first (`beginTurn`), which
 * records anything still held as `turn-ended` — a notice that arrives too late for
 * its turn is audited, not delivered a turn late. Only then is the current turn's
 * winner drained.
 *
 * Nothing here throws into the harness: a failure leaves the step exactly as the
 * waterfall produced it.
 *
 * @module dsh-jev-layer/delivery
 */
import { randomUUID } from 'node:crypto';

/** The plugin's own declared source kind for anything it puts in front of the model. */
const SOURCE_KIND = 'dsh-jev-layer';
/**
 * The longest a step waits for observer work still in flight, so a stuck judge cannot
 * hold a turn. A judge request is bounded by its own timeout (10 s by default); this
 * sits just above it.
 */
const SETTLE_MS = 12_000;
/** A notice summary is bounded by the message model. */
const SUMMARY_MAX = 120;

/** Clip a summary to the bound, on a character boundary. */
function summarise(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length <= SUMMARY_MAX ? flat : `${flat.slice(0, SUMMARY_MAX - 1)}…`;
}

/** Build the model-facing message for one drained notice. */
function noticeMessage(notice) {
  const content = Object.freeze([Object.freeze({ type: 'text', text: String(notice.text ?? '') })]);
  const label = typeof notice.tag === 'string' && notice.tag !== '' ? notice.tag : 'notice';
  const source = Object.freeze({
    kind: SOURCE_KIND,
    form: 'notice',
    summary: summarise(`${label}: ${notice.text}`),
  });
  return Object.freeze({ role: 'user', id: randomUUID(), content, source });
}

/**
 * Create the pre-step delivery.
 *
 * @param {object} deps injected dependencies.
 * @param {object} deps.core the core: `budget.beginTurn`, `notice.drain`.
 * @param {(message: string) => void} [deps.warn] a logger that must never be the failure.
 * @returns {{ run: (payload: object, next: () => Promise<object>) => Promise<object> }} the step wrapper.
 */
export function createDelivery(deps) {
  const { core, warn = () => {}, settle } = deps;
  const settleMs = Number.isFinite(deps.settleMs) && deps.settleMs > 0 ? deps.settleMs : SETTLE_MS;
  /** The last turn seen per agent, so a boundary is a change and not a guess. */
  const lastTurn = new Map();

  /** Start a new turn when this agent's turn number moved. */
  function boundary(payload) {
    const key = String(payload?.agent?.id ?? payload?.agent?.session?.id ?? '');
    const turn = payload?.turn;
    if (turn === undefined || lastTurn.get(key) === turn) return;
    lastTurn.set(key, turn);
    try {
      core?.budget?.beginTurn?.();
    } catch (error) {
      warn(`[dsh-jev-layer] the turn budget could not be reset: ${String(error?.message ?? error)}`);
    }
  }

  /** Let observer work from the previous step finish, up to a bound. Never throws. */
  async function waitForObservers() {
    if (typeof settle !== 'function') return;
    let timer;
    try {
      const pending = settle();
      if (pending === undefined) return;
      await Promise.race([pending, new Promise((resolve) => { timer = setTimeout(resolve, settleMs); })]);
    } catch (error) {
      warn(`[dsh-jev-layer] observer work could not be awaited: ${String(error?.message ?? error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Run around the harness's own decision.
   *
   * @param {object} payload the `agent/pre-step` payload.
   * @param {() => Promise<object>} next the rest of the waterfall.
   * @returns {Promise<object>} the decision, with any drained notice appended.
   */
  async function run(payload, next) {
    boundary(payload);
    const decision = await next();
    try {
      if (!decision || decision.kind !== 'enter' || !Array.isArray(decision.messages)) return decision;
      await waitForObservers();
      const drained = core?.notice?.drain?.();
      if (!Array.isArray(drained) || drained.length === 0) return decision;
      return { ...decision, messages: [...decision.messages, ...drained.map(noticeMessage)] };
    } catch (error) {
      warn(`[dsh-jev-layer] a notice could not be delivered: ${String(error?.message ?? error)}`);
      return decision;
    }
  }

  return { run };
}
