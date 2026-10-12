/**
 * `answer.questions` — answer a user-question batch, or hand the whole batch to
 * the human.
 *
 * ## The seam
 *
 * `user-questions/request` is a waterfall owned exclusively by this module. The
 * registry registers the one listener and dispatches to `handle(request, api,
 * next)`; this module never calls `ctx.on` itself. It either returns the answer
 * batch, which claims the request, or calls the continuation, which is the
 * human's path.
 *
 * ## The five hard gates
 *
 * All five must hold before a batch is answered, and they are checked in order:
 *
 *   1. Autonomy. `api.goals.get(agent)` returns `undefined` (`no-goal`), or a
 *      view whose `phase` is not `active` (`goal-inactive`), or whose
 *      `activation` is not `armed` (`disarmed`). An absent `agent` is `no-agent`.
 *   2. The whole batch is answerable. Every question has at least two options
 *      with a usable label (`free-text` when it does not), is not `multiSelect`
 *      (`multi-select`), and names a distinct id (`batch`).
 *   3. Labels are unambiguous. Two options in one question may not share a label
 *      and no real label may equal the injected decline label (`labels`).
 *   4. Jev is decisive. One `choice` judgment per question returns a top option
 *      at or above `minProbability` (default 0.90) with a margin over the
 *      runner-up at or above `minMargin` (default 0.35). A missing or unusable
 *      answer is `judge`; a top below the floor is `probability`; a thin margin
 *      is `margin`.
 *   5. The verdict is not the decline option (`ask-human`).
 *
 * A batch is answered in full or delegated in full. A partial batch is never
 * sent, because the answer must name each question of the call exactly once.
 *
 * ## Deadlines and failure
 *
 * The judgment runs under one `deadlineMs` (default 2500) and the module never
 * blocks the agent past it: past the deadline the reason is `deadline`, a judge
 * that cannot be reached or gives an unreadable answer is `judge`, a refused
 * shared budget is `budget`, and an unexpected failure is `error`.
 *
 * ## Shadow and recording
 *
 * The default mode for this feature is `shadow`: the would-be answer is recorded
 * and the batch is delegated anyway. In shadow the judgment also runs when the
 * autonomy gate failed, because the shadow ledger exists to measure agreement
 * with the human on real questions — including the ordinary case where no goal
 * is armed.
 *
 * Every decision reaches the ledger as one row per question, with the reason
 * encoded in `decision` (`answered` or `delegated:<reason>`) and the chosen
 * label in `wouldBe`, and every delegated question publishes exactly one
 * `SEAMS.INTERNAL_QUESTION_EVALUATED` event carrying that reason. The nag reads
 * the ledger and that event, so exactly one event per delegated question matters.
 *
 * The event carries one key beyond the frozen payload list: `agent`. Both
 * consumers need it and neither can recover it — `nag.nogoal` has no recipient
 * without it and `notify.decline` cannot re-check the live goal. Reported to the
 * integrator as a contract addition; removing it would silently disable the nag.
 *
 * Reason vocabulary, in gate order: `no-agent`, `no-goal`, `goal-inactive`,
 * `disarmed`, `batch`, `free-text`, `multi-select`, `labels`, `judge`, `budget`,
 * `deadline`, `probability`, `margin`, `ask-human`, and `shadow` when every gate
 * held and only the mode stopped the answer.
 *
 * @module dsh-jev-layer/modules/answer-questions
 */
import { SEAMS } from '../seams.js';

/** Stable id: config key, ledger key, shadow key and notice tag. */
const ID = 'answer.questions';

/**
 * The decline option injected into every judgment. A real option labelled this
 * way collides with it (gate 3) and the judge selecting it delegates (gate 5).
 */
const DECLINE_LABEL = 'ask-human';

/** A top option below this probability is not decisive. */
const DEFAULT_MIN_PROBABILITY = 0.9;

/** The top option must beat the runner-up by at least this. */
const DEFAULT_MIN_MARGIN = 0.35;

/** Recall and the judgment share this budget. */
const DEFAULT_DEADLINE_MS = 2500;

/**
 * A `choice` judgment caps at 255 options and the decline option takes one, so a
 * question offering more than this many real options cannot be judged.
 */
const MAX_OPTIONS = 254;

/** The sentinel the deadline timer resolves with. */
const EXPIRED = Symbol('deadline');

/** Whether a value is a plain object (not null, not an array). */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Read a numeric setting, falling back when it is absent or unusable. */
function numberSetting(api, key, fallback) {
  const value = api?.config?.get?.(key);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * The mode in force. The answering feature defaults to shadow, so a host that
 * hands out no shadow resolver records the decision and acts on nothing.
 */
function modeOf(api) {
  return api?.shadow?.isShadow?.(ID) === false ? 'enforce' : 'shadow';
}

/** The display text of one question. */
function textOf(question) {
  return isRecord(question) && typeof question.question === 'string' ? question.question : '';
}

/**
 * The option labels of one question, or `null` when it cannot be answered from
 * a list: no options, fewer than two, more than the judgment accepts, or a
 * label that is not a usable string.
 */
function labelsOf(question) {
  if (!isRecord(question) || !Array.isArray(question.options)) return null;
  if (question.options.length < 2 || question.options.length > MAX_OPTIONS) return null;
  const labels = [];
  for (const option of question.options) {
    if (!isRecord(option) || typeof option.label !== 'string' || option.label === '') return null;
    labels.push(option.label);
  }
  return labels;
}

/**
 * The first structural problem of one question — gate 2 then gate 3 — or `null`.
 * `seenIds` carries the ids already claimed by the batch.
 */
function structureProblem(question, seenIds) {
  if (!isRecord(question)) return 'batch';
  if (typeof question.id !== 'string' || question.id === '') return 'batch';
  if (seenIds.has(question.id)) return 'batch';
  seenIds.add(question.id);
  if (question.multiSelect === true) return 'multi-select';
  // More options than one judgment accepts is a structural refusal, not a
  // free-text question.
  if (Array.isArray(question.options) && question.options.length > MAX_OPTIONS) return 'batch';
  const labels = labelsOf(question);
  if (labels === null) return 'free-text';
  const seen = new Set();
  for (const label of labels) {
    if (seen.has(label) || label === DECLINE_LABEL) return 'labels';
    seen.add(label);
  }
  return null;
}

/** The autonomy gate, or `null` when it holds. */
function goalProblem(agent, api) {
  if (agent === undefined || agent === null) return 'no-agent';
  let view;
  try {
    view = api?.goals?.get?.(agent);
  } catch {
    view = undefined;
  }
  if (view === undefined || view === null) return 'no-goal';
  if (view.phase !== 'active') return 'goal-inactive';
  if (view.activation !== 'armed') return 'disarmed';
  return null;
}

/** The judge's `choice` question for one user question. */
function choiceQuestion(question) {
  const criteria = {};
  for (const option of question.options) {
    criteria[option.label] =
      typeof option.description === 'string' && option.description !== ''
        ? option.description
        : option.label;
  }
  criteria[DECLINE_LABEL] = 'the human must decide this question';
  return {
    type: 'choice',
    // English on purpose: this text goes to the model, not to the reader.
    instructions:
      'Select the single option that best answers this question for the operator. '
      + `Choose ${DECLINE_LABEL} when the decision needs the human.`,
    criteria,
  };
}

/**
 * The material the judge sees.
 *
 * ponytail: recalled memory would join here (the autopilot SPEC's `recallK`).
 * The v1 recall path shells out to the `mnemosyne` CLI, measured at 2.3 s on
 * this host against a 2500 ms deadline, so it would starve the judgment. The
 * upgrade path is the memory database's FTS5 tables, then the MCP server, then a
 * `Promise.all` beside the judgment call here.
 */
function judgeState(questions) {
  return {
    questions: questions.map((question) => ({
      id: question.id,
      question: textOf(question),
      header: question.header,
      detail: question.detail,
      options: question.options.map((option) => ({
        label: option.label,
        description: typeof option.description === 'string' ? option.description : undefined,
      })),
    })),
  };
}

/**
 * Read one judgment into a verdict.
 *
 * An unreadable answer is a communication failure, not a vote: the chosen label
 * must be one of the candidates and the distribution must carry at least two of
 * them, because a margin needs a runner-up to be measured against. The returned
 * `reason` is `null` when the verdict is decisive and is not the decline option.
 */
function readVerdict(answer, labels, minProbability, minMargin) {
  const candidates = [...labels, DECLINE_LABEL];
  if (!isRecord(answer) || typeof answer.choice !== 'string') return { reason: 'judge', probabilities: {}, chosen: null };
  const chosen = answer.choice;
  if (!candidates.includes(chosen)) return { reason: 'judge', probabilities: {}, chosen: null };
  if (!isRecord(answer.probabilities)) return { reason: 'judge', probabilities: {}, chosen };
  const probabilities = {};
  for (const label of candidates) {
    const value = answer.probabilities[label];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) {
      probabilities[label] = value;
    }
  }
  if (Object.keys(probabilities).length < 2) return { reason: 'judge', probabilities, chosen };
  const top = probabilities[chosen];
  if (!Number.isFinite(top)) return { reason: 'judge', probabilities, chosen };
  let runnerUp = 0;
  for (const [label, value] of Object.entries(probabilities)) {
    if (label !== chosen && value > runnerUp) runnerUp = value;
  }
  if (top < minProbability) return { reason: 'probability', probabilities, chosen };
  if (top - runnerUp < minMargin) return { reason: 'margin', probabilities, chosen };
  if (chosen === DECLINE_LABEL) return { reason: 'ask-human', probabilities, chosen };
  return { reason: null, probabilities, chosen };
}

/**
 * Ask the judge for the whole batch under one deadline.
 *
 * The call is bounded twice: `timeoutMs` so the request itself gives up at the
 * deadline, and the race so a judge that ignores its timeout still cannot hold
 * the question past it. `api.judge.ask` never throws by contract; the inner
 * catch covers a host that hands out something else.
 *
 * @returns `{ answers, expired }`; `expired` means the deadline won.
 */
async function runJudge(request, api, questions, deadlineAt) {
  const payload = {};
  for (const question of questions) payload[question.id] = choiceQuestion(question);
  const state = judgeState(questions);
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve(EXPIRED), Math.max(0, deadlineAt - Date.now()));
  });
  try {
    const call = (async () => {
      try {
        return await api?.judge?.ask?.(state, payload, {
          featureId: ID,
          failOpen: 'delegate',
          timeoutMs: Math.max(1, deadlineAt - Date.now()),
          signal: request?.signal,
        });
      } catch {
        return null;
      }
    })();
    const outcome = await Promise.race([call, expired]);
    if (outcome === EXPIRED) return { answers: null, expired: true };
    return { answers: outcome ?? null, expired: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Evaluate the request into a plan. Pure apart from the judge call: it writes
 * nothing to the ledger and publishes nothing.
 *
 * @returns `{ callId, mode, minProbability, answered, items }`, where each item
 *   carries its own reason (`null` when that question would be answered).
 */
async function evaluate(request, api) {
  const questions = Array.isArray(request?.questions) ? request.questions : [];
  const mode = modeOf(api);
  const minProbability = numberSetting(api, 'minProbability', DEFAULT_MIN_PROBABILITY);
  const minMargin = numberSetting(api, 'minMargin', DEFAULT_MIN_MARGIN);
  const deadlineMs = Math.max(1, numberSetting(api, 'deadlineMs', DEFAULT_DEADLINE_MS));
  const callId = request?.wait?.callId ?? '';
  const plan = { callId, agent: request?.agent ?? null, mode, minProbability, answered: false, items: [] };
  if (questions.length === 0) return plan;

  // Gate 1 is a fact about the session, so it labels every question alike.
  const goal = goalProblem(request?.agent, api);

  // Gates 2 and 3 are facts about one question; a sibling that passed is
  // delegated because of the batch.
  const seenIds = new Set();
  const structural = questions.map((question) => structureProblem(question, seenIds));
  const batchFailed = structural.some((reason) => reason !== null);

  plan.items = questions.map((question, index) => ({
    id: isRecord(question) ? question.id : undefined,
    text: textOf(question),
    labels: labelsOf(question) ?? [],
    reason: goal ?? structural[index] ?? (batchFailed ? 'batch' : null),
    probabilities: {},
    chosen: null,
  }));

  // The judgment is skipped only where it cannot change the outcome: in enforce
  // when the autonomy gate already refuses, and for any batch whose structure
  // makes it unanswerable. Shadow measures even the disarmed case.
  const needsJudge = mode === 'shadow' ? !batchFailed : goal === null && !batchFailed;
  if (!needsJudge) return plan;

  let answers = null;
  let failure = null;
  if (api?.judge?.configured === false) {
    failure = 'judge';
  } else if (
    typeof api?.budget?.tryAcquire === 'function'
    && api.budget.tryAcquire(ID, 1) === false
  ) {
    failure = 'budget';
  } else {
    const outcome = await runJudge(request, api, questions, Date.now() + deadlineMs);
    if (outcome.expired) failure = 'deadline';
    else if (outcome.answers === null) failure = 'judge';
    else answers = outcome.answers;
  }

  for (const item of plan.items) {
    if (failure !== null) {
      if (item.reason === null) item.reason = failure;
      continue;
    }
    const verdict = readVerdict(answers?.[item.id], item.labels, minProbability, minMargin);
    item.probabilities = verdict.probabilities;
    item.chosen = verdict.chosen;
    // A question already refused by an earlier gate keeps that reason; the
    // verdict is still recorded, because the ledger is the measurement.
    if (item.reason === null) item.reason = verdict.reason;
  }

  const allClear = plan.items.every((item) => item.reason === null);
  if (allClear && mode === 'shadow') {
    for (const item of plan.items) item.reason = 'shadow';
  }
  plan.answered = allClear && mode === 'enforce';
  return plan;
}

/** The plan for a failure that escaped `evaluate`: every question is delegated. */
function errorPlan(request, api) {
  const questions = Array.isArray(request?.questions) ? request.questions : [];
  return {
    callId: request?.wait?.callId ?? '',
    agent: request?.agent ?? null,
    mode: modeOf(api),
    minProbability: numberSetting(api, 'minProbability', DEFAULT_MIN_PROBABILITY),
    answered: false,
    items: questions.map((question) => ({
      id: isRecord(question) ? question.id : undefined,
      text: textOf(question),
      labels: labelsOf(question) ?? [],
      reason: 'error',
      probabilities: {},
      chosen: null,
    })),
  };
}

/** One ledger row per question. Bookkeeping never decides, so it never throws. */
function record(api, plan) {
  for (const item of plan.items) {
    try {
      api?.ledger?.append?.({
        featureId: ID,
        callId: plan.callId,
        question: { id: item.id, text: item.text, options: item.labels },
        probabilities: item.probabilities,
        threshold: plan.minProbability,
        decision: item.reason === null ? 'answered' : `delegated:${item.reason}`,
        wouldBe: item.chosen ?? null,
        mode: plan.mode,
        at: Date.now(),
      });
    } catch {
      // The ledger is a derived cache; a failure to record must not change the
      // decision or stop the question reaching the human.
    }
  }
}

/**
 * Exactly one event per delegated question, published before the continuation
 * runs. The nag consumes it and must not observe the harness seam.
 */
function publish(api, plan) {
  const events = api?.events;
  if (typeof events?.publish !== 'function') return;
  for (const item of plan.items) {
    if (item.reason === null) continue;
    try {
      events.publish(SEAMS.INTERNAL_QUESTION_EVALUATED, {
        callId: plan.callId,
        outcome: 'delegated',
        reason: item.reason,
        question: item.text,
        options: item.labels,
        // Beyond the frozen key list on purpose: the nag needs a recipient and
        // the notifier re-checks the live goal. See the module header.
        agent: plan.agent,
        at: Date.now(),
      });
    } catch {
      // A broken subscriber must not turn a delegation into a failure.
    }
  }
}

export default {
  id: ID,
  description: 'Answers the agent\'s own questions when nobody is coming, or delegates.',
  label: "Answer the agent's own questions",
  // Spends the turn budget or raises a notice: needs the turn boundary and the notice drain.
  needsTurn: true,
  seam: SEAMS.USER_QUESTIONS_REQUEST,
  seamClass: 'exclusive',
  settings: {
    minProbability: {
      type: 'number',
      default: DEFAULT_MIN_PROBABILITY,
      description: 'Answer only when the top option reaches this probability.',
    },
    minMargin: {
      type: 'number',
      default: DEFAULT_MIN_MARGIN,
      description: 'Answer only when the top option beats the runner-up by at least this.',
    },
    deadlineMs: {
      type: 'number',
      default: DEFAULT_DEADLINE_MS,
      description: 'Wall-clock budget for the judgment. Past it the question is delegated.',
    },
  },

  /**
   * Answer the batch, or delegate it to the human.
   *
   * @param request the `AskUserQuestionRequestEvent`.
   * @param api the module context from docs/CONTRACT.md.
   * @param next the registry's guarded continuation; calling it delegates.
   */
  async handle(request, api, next) {
    const delegate = typeof next === 'function' ? next : () => undefined;
    let plan;
    try {
      plan = await evaluate(request, api);
    } catch (error) {
      plan = errorPlan(request, api);
      try {
        api?.log?.warn?.('[answer.questions] the evaluation failed; delegating', error);
      } catch {
        // Logging must not become the failure.
      }
    }
    // Record and publish before the continuation: `next()` blocks until the
    // human answers, and the decision moment is now.
    record(api, plan);
    publish(api, plan);
    if (plan.answered) {
      return { answers: plan.items.map((item) => ({ id: item.id, selected: [item.chosen] })) };
    }
    return delegate();
  },
};
