/**
 * tools.ask — the `jev_ask` tool: typed judgment the model asks for itself.
 *
 * This is the one module that registers a harness tool instead of handling a
 * seam event. Its seam is `SEAMS.TOOLS_RESULT`, which it only observes: the
 * registry owns the listener, this module returns `undefined` and transforms
 * nothing.
 *
 * The registration route, and the contract gap behind it.
 * `ToolsService.register(definition)` is the real API
 * (`@deepseek-ai/dsh-tools/lib/types/index.d.ts:636`, returning the disposer) and
 * the baseline reaches it through the plugin context:
 * `ctx.inject(['tools'], scope => scope.tools.register(...))`
 * (`dsh-jev-tools/lib/index.js`, the `tools.register(create(shared))` loop at the
 * end of `apply`). The frozen module api (docs/CONTRACT.md, "The module context")
 * exposes neither `ctx` nor a `tools` service, and the registry builds `api`
 * without either, so this module resolves the service defensively:
 *
 *   api.tools            — a direct bridge, when the registry adds one
 *   api.ctx.get('tools') — the plugin context, when the registry passes it
 *
 * With neither, the module stays loaded, keeps observing `tools/result`, and
 * warns once that `jev_ask` is not registered. It never throws from `start`:
 * a throw there marks the whole module off. The registry change is reported as
 * a contract problem, not worked around.
 *
 * Why the tool is total. A model that receives `{ ok: false, problem, message }`
 * can tell the operator what to fix; a thrown error surfaces as an opaque tool
 * failure and the operator learns nothing. Every path below returns a value.
 *
 * Why shadow mode still answers. This tool is read-only: it judges material and
 * returns probabilities. Shadow records the call in the ledger and withholds
 * nothing, because there is no action to withhold. `mode: 'shadow'` on the
 * record is what makes the call visible to the operator as shadow traffic.
 *
 * @module dsh-jev-layer/modules/tools-ask
 */
import { SEAMS } from '../seams.js';

/** The feature id: config key, ledger key, shadow key, notice tag. */
const FEATURE_ID = 'tools.ask';

/** The question types the tool accepts, from the vendor's contract. */
const QUESTION_TYPES = new Set(['noul', 'choice', 'score']);

/** Deadline for one judgment; the tool forwards `exec.signal` as well. */
const TIMEOUT_MS = 15_000;

/**
 * The English tool description. A model reads this text, so it states the call
 * contract, the limits and the two ways a probability is misread.
 */
const DESCRIPTION =
  'Ask Jev for typed decisions over a piece of content: a yes/no with a probability, one choice '
  + 'from a defined set, or a score on an ordered scale. Every question is answered in one pass. '
  + 'Use it when the same judgment must be made many times (classify, route, triage, rank), '
  + 'never for text generation, counting, arithmetic or date comparison. Probabilities are '
  + 'uncalibrated and may saturate on easy inputs: rank with them, never read them as an '
  + 'accuracy figure or route on a fixed confidence threshold.';

/** The parameter schema. Ids are the caller's own and are echoed back verbatim. */
const PARAMETERS = {
  type: 'object',
  properties: {
    state: {
      description:
        'The material to judge: a string, an object, or an array. Keep it minimal — '
        + 'unrelated content in `state` measurably degrades accuracy.',
    },
    questions: {
      // Typed on purpose. With only prose here the model has to guess the encoding, and on
      // a real turn it sent a JSON *string* four times running, each refused as "must be an
      // object". The harness's schema subset allows only a boolean `additionalProperties`.
      type: 'object',
      additionalProperties: true,
      description:
        'Map of your own question id to a question object. Ids are echoed back verbatim and are '
        + 'never sent to the model, so every question must be self-describing in `instructions`. '
        + 'Shape: { type: "noul", instructions, criteria?: { true, false } } | '
        + '{ type: "choice", instructions, criteria: { option: rubric } } (at most 255 options) | '
        + '{ type: "score", instructions, criteria: [level0, level1, ...] } (2 to 10 levels). '
        + 'For multiple labels that can hold at once, use one `noul` per label instead of a `choice`.',
    },
    model: { type: 'string', description: 'Override the configured model for this call.' },
  },
  required: ['state', 'questions'],
  additionalProperties: false,
};

/** The canonical output declaration. `output` is mandatory on a ToolDefinition. */
const OUTPUT = {
  schema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean', description: 'Whether a judgment was produced.' },
      problem: { type: 'string', description: 'Why no judgment was produced, when `ok` is false.' },
      message: { type: 'string', description: 'One line a person can act on.' },
      probabilities: {
        type: 'object',
        description: 'One probability per question id. A null value means the judge returned no usable answer for that id.',
        additionalProperties: true,
      },
      missing: {
        type: 'array',
        description: 'Question ids the judge did not answer usefully.',
        items: { type: 'string' },
      },
      report: { type: 'string', description: 'Human-readable answers, one line per question.' },
    },
    required: ['ok'],
    additionalProperties: true,
  },
  /**
   * Project the canonical value to model-facing content.
   *
   * Total by contract: it must not throw, so the reader always gets a line.
   */
  render(_args, value) {
    const text = value && typeof value.report === 'string' && value.report !== '' ? value.report : '(no judgment)';
    return [{ type: 'text', text }];
  },
};

/** Log through the api if it has a logger; logging must never be the failure. */
function warn(api, message) {
  try {
    api?.log?.warn?.(`[${FEATURE_ID}] ${message}`);
  } catch {
    /* logging must never be the failure */
  }
}

/**
 * A `questions` argument that arrived as a JSON string is the object it encodes.
 *
 * Models do this when a parameter's type is unclear, and refusing it only teaches the
 * model to retry the same string. Anything that is not a string that parses to a plain
 * object is returned unchanged, so validation still decides.
 */
function objectFrom(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{')) return value;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

/**
 * Validate the `questions` argument before anything leaves the machine.
 *
 * @param {unknown} questions the raw argument.
 * @returns {string | null} one message, or null when the argument is usable.
 */
function validateQuestions(questions) {
  if (questions === null || typeof questions !== 'object' || Array.isArray(questions)) {
    return '`questions` must be an object: question id to question.';
  }
  const entries = Object.entries(questions);
  if (entries.length === 0) return '`questions` must hold at least one question.';
  for (const [id, question] of entries) {
    if (question === null || typeof question !== 'object' || Array.isArray(question)) {
      return `\`questions.${id}\` must be an object.`;
    }
    if (!QUESTION_TYPES.has(question.type)) {
      return `\`questions.${id}.type\` must be one of noul, choice, score (got ${JSON.stringify(question.type)}).`;
    }
    if (typeof question.instructions !== 'string' || question.instructions.trim() === '') {
      return `\`questions.${id}.instructions\` must be a non-empty string; ids are never sent to the judge.`;
    }
  }
  return null;
}

/**
 * Read one probability out of one judge answer.
 *
 * The vendor's answer carries a `type` and a type-specific field. A bare number
 * is accepted too, because a wrapper that returns a count where a probability
 * belongs is exactly the failure SPEC.md warns about, and it must be visible
 * rather than silently read as confidence.
 *
 * @param {unknown} answer the answer for one question id.
 * @param {string} type the question's declared type.
 * @returns {number | undefined} the probability, or undefined when unreadable.
 */
function probabilityOf(answer, type) {
  if (typeof answer === 'number' && Number.isFinite(answer)) return answer;
  if (answer === null || typeof answer !== 'object') return undefined;
  const value = type === 'noul'
    ? (answer.noul ?? answer.probability)
    : type === 'choice'
      ? (typeof answer.choice === 'string' ? answer.probabilities?.[answer.choice] : undefined) ?? answer.confidence
      : (answer.score ?? answer.confidence);
  // A choice answer whose spread is unreadable still reports its confidence.
  const fallback = answer.noul ?? answer.probability ?? answer.score ?? answer.confidence;
  const chosen = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return typeof chosen === 'number' && Number.isFinite(chosen) ? chosen : undefined;
}

/** Render one line per question id, for the model and the operator. */
function buildReport(ok, probabilities, missing, subject) {
  if (!ok) return subject;
  const lines = [];
  for (const [id, p] of Object.entries(probabilities)) {
    lines.push(p === null ? `${id}: (no usable answer)` : `${id}: ${p.toFixed(3)}`);
  }
  if (missing.length > 0) lines.push(`missing: ${missing.join(', ')}`);
  return lines.join('\n');
}

/**
 * Build the tool definition.
 *
 * A pure factory: it captures the module api and registers nothing itself, so a
 * gate can build one against a synthetic api and call `execute` directly.
 *
 * @param {object} api the module context from docs/CONTRACT.md.
 * @returns {object} the ToolDefinition to hand to `tools.register`.
 */
export function createJevAskTool(api) {
  /**
   * One declined call. `report` is always set: the renderer reads only `report`,
   * so a decline that carried just `message` would display as `(no judgment)`.
   */
  function declined(problem, message) {
    return { ok: false, problem, message, report: `${problem}: ${message}` };
  }

  /** Append one decision to the ledger. The ledger is a cache; never fail for it. */
  function record(fields) {
    try {
      api?.ledger?.append?.({
        featureId: FEATURE_ID,
        callId: fields.callId ?? null,
        question: fields.ids,
        probabilities: fields.probabilities ?? {},
        threshold: null,
        decision: fields.decision,
        wouldBe: fields.wouldBe,
        mode: fields.mode,
        at: Date.now(),
      });
    } catch {
      // A ledger that is down must not change what the model receives.
    }
  }

  return {
    name: 'jev_ask',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: OUTPUT,
    isConcurrencySafe: () => true,
    timeoutMs: TIMEOUT_MS,

    async execute(rawArgs, exec) {
      const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
      const questions = objectFrom(args.questions);
      const violations = validateQuestions(questions);
      if (violations !== null) return declined('invalid-request', violations);

      const ids = Object.keys(questions);
      const mode = api?.shadow?.isShadow?.(FEATURE_ID) === true ? 'shadow' : 'enforce';

      // Cheapest refusal first: an unconfigured judge costs nothing to detect and
      // must report as such rather than surface as a transport failure.
      if (api?.judge === undefined || api.judge.configured !== true) {
        record({ ids, decision: 'unconfigured', wouldBe: 'answer', mode, callId: exec?.callId });
        return declined(
          'unconfigured',
          'No judge credential resolves. Set the credential named by the apiKeyRef setting, then retry.',
        );
      }

      // The budget unit is taken only once a request will actually go out.
      if (api?.budget?.tryAcquire?.(FEATURE_ID, 1) === false) {
        record({ ids, decision: 'budget-exhausted', wouldBe: 'answer', mode, callId: exec?.callId });
        return declined('budget-exhausted', 'The per-turn judge ceiling is reached; retry in the next turn.');
      }

      let answers = null;
      try {
        answers = await api.judge.ask(
          args.state ?? '',
          questions,
          {
            featureId: FEATURE_ID,
            callId: exec?.callId,
            signal: exec?.signal,
            failOpen: 'report-unavailable',
          },
        );
      } catch {
        // The core never throws; a foreign judge implementation might.
        answers = null;
      }

      if (answers === null || typeof answers !== 'object') {
        // `lastError.kind` distinguishes unconfigured from a transport failure.
        // An unconfigured judge that the getter missed is caught here too.
        const kind = api?.judge?.lastError?.kind ?? 'unavailable';
        record({ ids, decision: kind, wouldBe: 'answer', mode, callId: exec?.callId });
        return declined(kind, 'The judge returned no usable answer.');
      }

      const probabilities = {};
      const missing = [];
      for (const id of ids) {
        const probability = probabilityOf(answers[id], questions[id]?.type);
        if (probability === undefined) {
          probabilities[id] = null;
          missing.push(id);
        } else {
          probabilities[id] = probability;
        }
      }

      record({
        ids,
        probabilities,
        decision: missing.length === ids.length ? 'no-answer' : 'answer',
        wouldBe: 'answer',
        mode,
        callId: exec?.callId,
      });

      // Shadow mode changes nothing here: this is a read-only judgment, so the
      // model still gets the answers and the ledger records the shadow call.
      return {
        ok: true,
        probabilities,
        ...(missing.length > 0 ? { missing } : {}),
        report: buildReport(true, probabilities, missing, ''),
      };
    },
  };
}

/**
 * Find the tools service behind the module api.
 *
 * The frozen api exposes neither member; both resolutions are kept so the
 * registry can wire either one without a change here.
 */
function resolveTools(api) {
  const direct = api?.tools;
  if (direct !== undefined && direct !== null) return direct;
  const viaCtx = api?.ctx?.get?.('tools');
  return viaCtx ?? null;
}

/** The one live registration, released by `stop()`. */
let disposer = null;

export default {
  id: FEATURE_ID,
  description: 'The `jev_ask` tool: typed `noul`, `choice` and `score` questions in, probabilities out.',
  label: 'Ask-a-question tool',
  // Spends the turn budget or raises a notice: needs the turn boundary and the notice drain.
  needsTurn: true,
  seam: SEAMS.TOOLS_RESULT,
  seamClass: 'broadcast',
  settings: {},

  /**
   * Register `jev_ask` through the tools service.
   *
   * Never throws: a failed registration must not take the module off, because
   * the `tools/result` observation still works and the warning names the gap.
   */
  start(api) {
    // A restart without a stop must not leave the old registration behind.
    const previous = disposer;
    disposer = null;
    if (typeof previous === 'function') previous();
    const tools = resolveTools(api);
    if (tools === null || typeof tools.register !== 'function') {
      warn(
        api,
        'no tools service is reachable from the module api, so jev_ask is not registered; '
        + 'the registry must expose ctx (or a tools bridge) on api',
      );
      return;
    }
    try {
      const released = tools.register(createJevAskTool(api));
      disposer = typeof released === 'function' ? released : null;
    } catch (error) {
      warn(api, `jev_ask could not be registered: ${error instanceof Error ? error.message : String(error)}`);
    }
  },

  /** Release exactly what `start` registered. */
  stop() {
    const released = disposer;
    disposer = null;
    if (typeof released === 'function') released();
  },

  /**
   * Observe `tools/result` only.
   *
   * The registry calls `next` itself when a handler returns `undefined`, so an
   * observer never consumes the waterfall.
   */
  handle() {
    return undefined;
  },
};
