/**
 * `approve.workspace` — put an eligible one-time sandbox escalation in front of
 * the human, and never let it pass silently.
 *
 * ## The seam
 *
 * `tools/pre-execute` is an exclusive waterfall owned by this module. The
 * registry registers the one listener and calls `handle(exec, api, next)`;
 * `next()` is the harness's own continuation and ends in `{ kind: 'allow' }`
 * when nothing else objects. Returning `{ kind: 'ask' }` sends the call through
 * the harness's approval service, which asks the human; an unmounted approval
 * service degrades that call to a denial, so `ask` can never widen a call on
 * its own.
 *
 * ## What an escalation request is
 *
 * On this host the model asks for wider access with the native argument pair
 * `sandbox_permissions` + `justification`
 * (`@deepseek-ai/dsh-sandbox/lib/types/escalation.d.ts`,
 * `validateEscalationArgs`). `sandbox_permissions` is advertised whenever the
 * composition confines, and its value is the mode the one call wants. The
 * escalation ladder is one step wide:
 *
 *   read-only        -> workspace-write | danger-full-access
 *   workspace-write  -> danger-full-access
 *
 * So an escalation request from `workspace-write` is exactly
 * `sandbox_permissions: 'danger-full-access'`, which is the only request this
 * module handles. A request whose target equals the mode the call already runs
 * in needs no approval at all (`approveEscalation` returns the effective mode),
 * which is why reading the mode matters: without it the module cannot tell an
 * escalation from a no-op.
 *
 * This module does not raise the escalation itself; the tool body does that
 * through `ctx.approval`. The module adds the human decision at the pre-execute
 * gate, and it is the only thing it adds.
 *
 * ## Eligibility is four facts, and the judge is the last one
 *
 *   1. The call is a well-formed escalation request: a target-capable tool, the
 *      native argument pair, and the per-tool argument shape the tool's own
 *      schema requires (`write`, `edit`, `bash`, `pwsh`, `run_code`).
 *   2. The call has an agent. Without one there is no session to audit and no
 *      human to route to, and the harness itself refuses an agentless ask.
 *   3. The session's sandbox mode is `workspace-write`. The mode is read from
 *      `api.sandboxPolicy.resolve({ session })`, the host's
 *      `ctx.sandboxPolicy`. A host that does not hand that service over leaves
 *      the mode unknown, and an unknown mode is not eligible: the module must
 *      not consult the human for a call it cannot prove needs escalation.
 *   4. The judge returns a readable `choice` answer. A judge that is
 *      unconfigured, refused by the budget, unreachable, past the deadline, or
 *      unreadable is not an answer, and a missing answer is not an approval.
 *
 * ## Every judged outcome asks the human
 *
 * `approve`, `unauthorized`, `unknown`, and `approve` below the confidence
 * floor all return `{ kind: 'ask' }`. The posture of this module is that it may
 * raise a human decision and may never make one: its judge can tell the human
 * what it thought, and it can never grant the call. There is deliberately no
 * code path that returns `allow`, `deny` or `cancel`. "Non-affirmative returns
 * to human approval rather than allowing" is therefore structural here, not a
 * branch that has to be remembered.
 *
 * Two consequences are recorded rather than hidden:
 *
 *   - A judged escalation is asked twice: once here, and once by the tool body's
 *     own `approveEscalation`, which re-reads the session policy and sees the
 *     same confined mode. Answering instead of asking would need the
 *     `approval/request` seam, which the ticket forbids and `SEAMS` does not
 *     name. The module can add a prompt; it cannot remove the native one.
 *   - The judge never blocks: past `deadlineMs` the call is passed through, and
 *     the harness's own escalation path still reaches the human. A pass-through
 *     is the harness's decision, not this module's.
 *
 * ## Recording
 *
 * One ledger row per judged call: `decision` is `ask:<choice>` or
 * `pass:<reason>`, `wouldBe` is `ask`, and the probabilities, threshold and mode
 * are carried. In shadow mode the row records `pass:shadow` with
 * `wouldBe: 'ask'` and the call is passed through untouched.
 *
 * @module dsh-jev-layer/modules/approve-workspace
 */
import { SEAMS } from '../seams.js';

/** Stable id: config key, ledger key, shadow key and notice tag. */
const ID = 'approve.workspace';

/** The single question put to the judge for one escalation request. */
const QUESTION_ID = 'authorization';

/** The escalation target this module handles: the only mode wider than `workspace-write`. */
const TARGET = 'danger-full-access';

/** The mode the call must currently run in for this module to act. */
const REQUIRED_MODE = 'workspace-write';

/** The tools whose schemas carry the native escalation argument pair. */
const TARGETS = Object.freeze(['write', 'edit', 'bash', 'pwsh', 'run_code']);

/** The judge's closed choice vocabulary. */
const CANDIDATES = Object.freeze(['approve', 'unauthorized', 'unknown']);

/** Below this, an `approve` is recorded but is not called confident. */
const DEFAULT_MIN_PROBABILITY = 0.9;

/** Wall-clock budget for the judgment. Past it the call is passed through. */
const DEFAULT_DEADLINE_MS = 2500;

/**
 * Bound on one string carried into the judge state.
 *
 * ponytail: a `write` argument can be a whole file, and this module judges
 * whether to *ask*, not what the content means. The ceiling keeps one prompt
 * finite; the upgrade path, if judgement ever needs the full body, is the same
 * bounded read `workspace-approval.ts` did through `ctx.fs` (128 KB default).
 */
const MAX_DETAIL_CHARS = 4000;

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
 * The session's sandbox mode, through the host service the registry hands over
 * as `api.sandboxPolicy` (`ctx.sandboxPolicy`). `undefined` means the mode is
 * unknown, which is not eligible.
 */
function policyMode(api, agent) {
  const service = api?.sandboxPolicy;
  if (!service || typeof service.resolve !== 'function') return undefined;
  try {
    const policy = service.resolve({ session: agent?.session });
    return typeof policy?.mode === 'string' ? policy.mode : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The per-tool argument shape the tool's own schema requires, from
 * `workspace-approval.ts` `nativeArgs`. A malformed escalation request is not
 * an escalation request.
 */
function shapeOk(name, args) {
  switch (name) {
    case 'write':
      return typeof args.file_path === 'string' && typeof args.content === 'string';
    case 'edit':
      return typeof args.file_path === 'string'
        && typeof args.old_string === 'string'
        && typeof args.new_string === 'string';
    case 'bash':
    case 'pwsh':
      return typeof args.command === 'string' && typeof args.description === 'string';
    case 'run_code':
      return typeof args.code === 'string' && typeof args.description === 'string';
    default:
      return false;
  }
}

/**
 * The first structural reason this call is not an eligible escalation, or
 * `null` when it is. The judge is not consulted here.
 */
function structuralProblem(exec, api) {
  if (!isRecord(exec) || typeof exec.name !== 'string' || !TARGETS.includes(exec.name)) return 'tool';
  if (exec.agent === undefined || exec.agent === null) return 'no-agent';
  const args = exec.arguments;
  if (!isRecord(args)) return 'shape';
  if (args.sandbox_permissions !== TARGET) return 'no-escalation';
  if (typeof args.justification !== 'string' || args.justification.trim() === '') return 'justification';
  if (!shapeOk(exec.name, args)) return 'shape';
  const mode = policyMode(api, exec.agent);
  if (mode === undefined) return 'mode-unknown';
  if (mode !== REQUIRED_MODE) return `mode:${mode}`;
  return null;
}

/** A deep copy with every string bounded to {@link MAX_DETAIL_CHARS}. */
function bounded(value) {
  if (typeof value === 'string') {
    return value.length > MAX_DETAIL_CHARS ? `${value.slice(0, MAX_DETAIL_CHARS)}… [truncated]` : value;
  }
  if (Array.isArray(value)) return value.map(bounded);
  if (isRecord(value)) {
    const out = {};
    for (const [key, entry] of Object.entries(value)) out[key] = bounded(entry);
    return out;
  }
  return value;
}

/** The material the judge sees: one operation, its arguments and its reason. */
function judgeState(exec) {
  return {
    request: {
      tool: exec.name,
      arguments: bounded(exec.arguments),
      justification: exec.arguments.justification,
      requestedMode: TARGET,
      currentMode: REQUIRED_MODE,
    },
  };
}

/** The one `choice` question. English on purpose: this text goes to the model. */
function authorizationQuestion() {
  return {
    type: 'choice',
    instructions:
      'Decide whether this complete one-time sandbox escalation is clearly within the task the '
      + 'operator authorized. A clear ordinary step needed to finish a requested task may be '
      + 'approved. An action that needs explicit authorization, such as publishing, deleting or '
      + 'sending, is unauthorized. Choose unknown when the effects or the authorization are not '
      + 'clear. This covers one call only and grants nothing later.',
    criteria: {
      approve: 'The complete one-time operation is clearly within the current task and its limits.',
      unauthorized: 'The operation is outside the current authorization or contradicts a restriction.',
      unknown: 'The available information is not enough to decide the operation and its effects.',
    },
  };
}

/**
 * Ask the judge under one deadline.
 *
 * The call is bounded twice: `timeoutMs` so the request itself gives up at the
 * deadline, and the race so a judge that ignores its timeout still cannot hold
 * the call past it. `api.judge.ask` never throws by contract; the inner catch
 * covers a host that hands out something else.
 *
 * @returns `{ answer, expired }`; `answer` is `null` for every failure.
 */
async function runJudge(exec, api, deadlineAt) {
  const state = judgeState(exec);
  const payload = { [QUESTION_ID]: authorizationQuestion() };
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve(EXPIRED), Math.max(0, deadlineAt - Date.now()));
  });
  try {
    const call = (async () => {
      try {
        return await api?.judge?.ask?.(state, payload, {
          featureId: ID,
          // "Do nothing" at this call site is "let the harness's own escalation
          // path reach the human".
          failOpen: 'pass-through',
          timeoutMs: Math.max(1, deadlineAt - Date.now()),
          signal: exec?.signal,
        });
      } catch {
        return null;
      }
    })();
    const outcome = await Promise.race([call, expired]);
    if (outcome === EXPIRED) return { answer: null, expired: true };
    return { answer: outcome ?? null, expired: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read one judgment into a verdict. `choice: null` means the answer was not a
 * usable choice at all, which is a communication failure rather than a vote.
 * `confident` is recorded, never acted on differently: every readable verdict
 * asks the human.
 */
function readVerdict(answer, minProbability) {
  if (!isRecord(answer) || typeof answer.choice !== 'string' || !CANDIDATES.includes(answer.choice)) {
    return { choice: null, probabilities: {}, confident: false };
  }
  const probabilities = {};
  if (isRecord(answer.probabilities)) {
    for (const candidate of CANDIDATES) {
      const value = answer.probabilities[candidate];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) {
        probabilities[candidate] = value;
      }
    }
  }
  const top = probabilities[answer.choice];
  return {
    choice: answer.choice,
    probabilities,
    confident: Number.isFinite(top) && top >= minProbability,
  };
}

/** One ledger row. Bookkeeping never decides, so it never throws. */
function record(api, row) {
  try {
    api?.ledger?.append?.({
      featureId: ID,
      callId: row.callId,
      question: {
        id: row.callId,
        text: `${row.exec.name}: ${TARGET} — ${row.exec.arguments.justification}`,
        options: [...CANDIDATES],
      },
      probabilities: row.probabilities,
      threshold: row.threshold,
      decision: row.decision,
      wouldBe: row.wouldBe,
      mode: row.mode,
      at: Date.now(),
    });
  } catch {
    // The ledger is a derived cache; a failure to record must not change the
    // decision or stop the call reaching the human.
  }
}

export default {
  id: ID,
  description: 'Returns `ask` for an eligible escalation instead of letting it through.',
  label: 'Approval for workspace changes',
  // Spends the turn budget or raises a notice: needs the turn boundary and the notice drain.
  needsTurn: true,
  seam: SEAMS.TOOLS_PRE_EXECUTE,
  seamClass: 'exclusive',
  targets: [...TARGETS],
  settings: {
    minProbability: {
      type: 'number',
      default: DEFAULT_MIN_PROBABILITY,
      description: 'Record an approve below this probability as low confidence. Every verdict still asks the human.',
    },
    deadlineMs: {
      type: 'number',
      default: DEFAULT_DEADLINE_MS,
      description: 'Wall-clock budget for the judgment. Past it the call is passed through to the harness.',
    },
  },

  /**
   * Ask the human about one eligible escalation request, or pass the call
   * through untouched.
   *
   * @param exec the `ToolExecution` on `tools/pre-execute`.
   * @param api the module context from docs/CONTRACT.md.
   * @param next the registry's guarded continuation: the harness's own decision.
   * @returns the harness's decision unchanged, or `{ kind: 'ask' }`.
   */
  async handle(exec, api, next) {
    const pass = typeof next === 'function' ? next : () => undefined;
    const callId = typeof exec?.callId === 'string' ? exec.callId : '';

    // Not an escalation request this module owns: the harness's decision
    // stands, and no judge is paid for.
    if (structuralProblem(exec, api) !== null) return pass();

    const minProbability = numberSetting(api, 'minProbability', DEFAULT_MIN_PROBABILITY);
    const deadlineMs = Math.max(1, numberSetting(api, 'deadlineMs', DEFAULT_DEADLINE_MS));

    // The judgment, bounded by its own deadline. `failure` is a reason why no
    // readable verdict exists; it is never treated as an approval.
    let failure = null;
    let verdict = { choice: null, probabilities: {}, confident: false };
    try {
      if (api?.judge?.configured === false) {
        failure = 'judge-unconfigured';
      } else if (
        typeof api?.budget?.tryAcquire === 'function'
        && api.budget.tryAcquire(ID, 1) === false
      ) {
        failure = 'budget';
      } else {
        const outcome = await runJudge(exec, api, Date.now() + deadlineMs);
        if (outcome.expired) failure = 'deadline';
        else if (outcome.answer === null) failure = 'judge';
        else {
          // `judge.ask` returns one answer per question id, as
          // `answer.questions` reads it; a response without this question's
          // answer is a communication failure.
          verdict = readVerdict(outcome.answer?.[QUESTION_ID], minProbability);
          if (verdict.choice === null) failure = 'judge';
        }
      }
    } catch (error) {
      // A judge that throws against its contract is a failure, not a verdict.
      failure = 'judge';
      try {
        api?.log?.warn?.('[approve.workspace] the judgment failed; passing the call through', error);
      } catch {
        // Logging must not become the failure.
      }
    }

    // The harness's own decision, taken exactly once. It is returned unchanged
    // on every path that does not ask, so a deny or a cancel upstream is never
    // weakened and the module never builds an `allow` of its own.
    const downstream = await pass();
    const kind = isRecord(downstream) ? downstream.kind : undefined;

    if (api?.shadow?.isShadow?.(ID) !== false) {
      record(api, {
        callId,
        exec,
        probabilities: verdict.probabilities,
        threshold: minProbability,
        decision: failure === null ? 'pass:shadow' : `pass:${failure}`,
        wouldBe: 'ask',
        mode: 'shadow',
      });
      return downstream;
    }

    if (failure !== null) {
      record(api, {
        callId,
        exec,
        probabilities: verdict.probabilities,
        threshold: minProbability,
        decision: `pass:${failure}`,
        wouldBe: 'ask',
        mode: 'enforce',
      });
      return downstream;
    }

    // Something else already refused or rewrote the call: that decision stands,
    // and asking the human about a call that will not run would be noise.
    if (kind !== 'allow') {
      record(api, {
        callId,
        exec,
        probabilities: verdict.probabilities,
        threshold: minProbability,
        decision: `pass:downstream-${String(kind)}`,
        wouldBe: 'ask',
        mode: 'enforce',
      });
      return downstream;
    }

    const decision = verdict.choice === 'approve' && verdict.confident
      ? 'ask:approve'
      : `ask:${verdict.choice}${verdict.confident ? '' : '-low'}`;
    record(api, {
      callId,
      exec,
      probabilities: verdict.probabilities,
      threshold: minProbability,
      decision,
      wouldBe: 'ask',
      mode: 'enforce',
    });

    const justification = exec.arguments.justification.trim().slice(0, 400);
    return {
      kind: 'ask',
      reason: `${ID}: ${exec.name} requests ${TARGET} for one call — ${justification}`,
      displayReason: {
        en: `Jev judged this one-time escalation: ${verdict.choice}`
          + `${verdict.confident ? '' : ' (low confidence)'}. The human decides.`,
      },
    };
  },
};
