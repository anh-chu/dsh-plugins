/**
 * `select.skill` — at most one skill picked per turn, and only from a catalog
 * large enough that picking matters.
 *
 * A catalog of thirty skills named only in the system prompt asks the model to
 * have read all thirty before it answers. This module reads the catalog itself,
 * asks the judge once which single skill fits the current ask, and — when the
 * answer is confident enough — queues one advisory notice. It never loads a
 * skill and never rewrites the step: a wrong suggestion costs a line of prompt,
 * while a wrong transform costs the task.
 *
 * ## The seam
 *
 * `SEAMS.SKILL_CATALOG` resolves to `agent/pre-step`. The placeholder value
 * `skill/catalog` names no event on DSH 0.2.0-rc.2: the host Event catalog holds
 * no such event, and the only skills event is `skills/change`, an unfiltered
 * invalidation emit. Skill catalog assembly is an `agent/pre-step` waterfall —
 * `@deepseek-ai/dsh-tool-skill` snapshots the session catalog there — and the
 * parity baseline `dsh-jev-tools` 0.1.13 registers its skill-suggestion listener
 * on the same event.
 *
 * `agent/pre-step` is also where `event.messages` holds what is about to enter
 * the step and where `event.turn`/`event.step` name the position, so the two
 * inputs this decision needs arrive on one event.
 *
 * ## At most one judgment per turn
 *
 * `agent/pre-step` fires on every step of a turn. The decision is made only at
 * `step <= 1`, the turn's start, so no per-agent latch is needed and no state
 * can leak between agents.
 *
 * ## What counts as the task
 *
 * The latest message the user wrote, provided it carries signal. Below
 * `minTaskChars` the previous messages join it ("继续" names nothing on its own),
 * which keeps a short follow-up attached to the topic it follows.
 *
 * Delivery goes through the core notice arbiter, like `screen.fetch`, so one
 * notice per turn and the loser's suppression stay the arbiter's business.
 *
 * @module dsh-jev-layer/modules/select-skill
 */
import { SEAMS } from '../seams.js';

/** Stable id: config key, ledger key, shadow key and notice tag. */
const ID = 'select.skill';
/** The question id carrying the chosen skill. It never reaches the model. */
const QUESTION_ID = 'pick';
/** The judge's option for "nothing here fits". */
const ABSTAIN = 'none';
/** Below this catalog size a suggestion is noise, not routing. */
const DEFAULT_MIN_CATALOG = 15;
/** Silence beats a weak guess. */
const DEFAULT_MIN_CONFIDENCE = 0.3;
/** A latest message shorter than this is judged with the messages before it. */
const DEFAULT_MIN_TASK_CHARS = 12;
/** How many messages the fallback window holds. */
const FALLBACK_MESSAGES = 3;
/** Longest skill description sent as a rubric. */
const MAX_DESCRIPTION = 200;
/**
 * A `choice` question caps at 255 options; the abstention takes one, so the
 * catalog is cut here. A pathological deployment cannot produce a rejected
 * request.
 */
const MAX_OPTIONS = 254;
/** Advisory notices carry no ordering pressure; kind already separates them. */
const NOTICE_PRIORITY = 10;

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
 * Injected context — the skill catalog, reminders, tool notices — also arrives
 * as a user-role message and carries a `source.kind`. A missing source is
 * treated as user text, the conservative reading: skipping it would silently
 * lose the ask.
 */
function isUserAuthored(message) {
  const source = message?.source;
  return source === undefined || source === null || source.kind === 'user';
}

/**
 * The task text the judge sees.
 *
 * The latest user message alone when it is at least `minChars` long, otherwise
 * the last {@link FALLBACK_MESSAGES} of them joined, because a follow-up such as
 * "do that here" is only meaningful next to what it follows.
 */
function buildTask(messages, minChars) {
  const list = Array.isArray(messages) ? messages : [];
  const authored = [];
  for (const message of list) {
    if (!isUserAuthored(message)) continue;
    const text = textOf(message).trim();
    if (text !== '') authored.push(text);
  }
  if (authored.length === 0) return '';
  const latest = authored[authored.length - 1];
  if (latest.length >= minChars) return latest;
  return authored.slice(-FALLBACK_MESSAGES).join('\n');
}

/**
 * The skill registry, whether the api exposes it directly or behind a getter.
 * The registry may mount after the module, so a getter is the baseline's shape.
 */
function skillRegistry(api) {
  const holder = api?.skills;
  const registry = typeof holder === 'function' ? holder() : holder;
  return registry && typeof registry.list === 'function' ? registry : undefined;
}

/**
 * The skills the model may invoke, in catalog order.
 *
 * A user-only skill cannot be loaded by the model, so it counts toward neither
 * the size floor nor the options.
 */
function modelSkills(catalog) {
  if (!Array.isArray(catalog)) return [];
  const skills = [];
  for (const entry of catalog) {
    if (!entry || typeof entry.name !== 'string' || entry.name === '') continue;
    if (entry.invocation && entry.invocation.modelInvocable === false) continue;
    skills.push({
      name: entry.name,
      description: typeof entry.description === 'string' ? entry.description : '',
    });
  }
  return skills;
}

/**
 * Read one `choice` answer. An unreadable answer is a communication failure, not
 * a vote for the first option, so it returns `undefined`.
 */
function readChoice(answer) {
  if (typeof answer === 'string' && answer !== '') return { choice: answer, confidence: undefined };
  if (!answer || typeof answer !== 'object') return undefined;
  if (typeof answer.choice !== 'string' || answer.choice === '') return undefined;
  const probabilities = answer.probabilities;
  const raw = answer.confidence
    ?? (probabilities && typeof probabilities === 'object' ? probabilities[answer.choice] : undefined)
    ?? answer.probability;
  return { choice: answer.choice, confidence: Number.isFinite(raw) ? raw : undefined };
}

/** Append one ledger record in the frozen shape. Bookkeeping never decides. */
function record(api, fields) {
  try {
    api?.ledger?.append?.({
      featureId: ID,
      callId: '',
      question: QUESTION_ID,
      probabilities: fields.probabilities ?? {},
      threshold: numberSetting(api, 'minConfidence', DEFAULT_MIN_CONFIDENCE),
      decision: fields.decision,
      wouldBe: fields.wouldBe ?? 'none',
      mode: api?.shadow?.isShadow?.(ID) === true ? 'shadow' : 'enforce',
      at: Date.now(),
    });
  } catch {
    // A ledger that is down must not change the decision.
  }
}

/**
 * The decision itself: the one skill this turn asks for, or `null`.
 *
 * Pure apart from the ledger write, so it is directly testable. Every early exit
 * records a row: "never fired" and "fired and declined" must not look alike from
 * outside. In shadow mode it still returns the would-be pick — the ledger needs
 * it — and `handle` withholds the notice.
 *
 * @param event - the `agent/pre-step` payload.
 * @param api - the module context.
 * @returns `{ skill, confidence }` or `null`.
 */
export async function select(event, api) {
  const step = event?.step;
  // `agent/pre-step` runs per step; only the turn's start judges, so one turn
  // costs at most one request.
  if (Number.isFinite(step) && step > 1) return null;

  const task = buildTask(event?.messages, numberSetting(api, 'minTaskChars', DEFAULT_MIN_TASK_CHARS));
  if (task === '') {
    record(api, { decision: 'skipped' });
    return null;
  }

  const registry = skillRegistry(api);
  if (registry === undefined) {
    record(api, { decision: 'skipped' });
    return null;
  }

  let catalog;
  try {
    // `scope` is not optional in practice: an unscoped read covers the global
    // layer only, misses a preset's skills, and lands under the size floor.
    catalog = await registry.list({
      scope: event?.agent,
      cwd: event?.agent?.session?.header?.cwd,
      signal: event?.signal,
    });
  } catch {
    record(api, { decision: 'skipped' });
    return null;
  }

  const skills = modelSkills(catalog);
  if (skills.length < numberSetting(api, 'minCatalogSize', DEFAULT_MIN_CATALOG)) {
    record(api, { decision: 'skipped' });
    return null;
  }

  // Cheapest refusals last: neither of these should cost a request.
  if (api?.judge?.configured === false) {
    record(api, { decision: 'skipped' });
    return null;
  }
  if (typeof api?.budget?.tryAcquire === 'function' && api.budget.tryAcquire(ID, 1) === false) {
    record(api, { decision: 'skipped' });
    return null;
  }

  const options = skills.slice(0, MAX_OPTIONS);
  // English on purpose: this text goes to the model, not to the reader.
  const criteria = { [ABSTAIN]: 'no skill is relevant to the current task' };
  for (const skill of options) criteria[skill.name] = skill.description.slice(0, MAX_DESCRIPTION);

  let answers;
  try {
    answers = await api.judge.ask(
      { task },
      {
        [QUESTION_ID]: {
          type: 'choice',
          instructions: 'Which single skill is most appropriate for `task`? Recommend only one. '
            + `If no skill is relevant, choose ${ABSTAIN}.`,
          criteria,
        },
      },
      { featureId: ID, failOpen: 'no-selection' },
    );
  } catch {
    // A judge that throws is not a verdict.
    record(api, { decision: 'skipped' });
    return null;
  }

  const answer = readChoice(answers?.[QUESTION_ID]);
  const minConfidence = numberSetting(api, 'minConfidence', DEFAULT_MIN_CONFIDENCE);
  // An answer without a usable probability abstains: the floor cannot be applied
  // to a number that is not there, and selecting anyway would spend a notice on a
  // guess the judge never endorsed.
  if (answer === undefined || answer.confidence === undefined) {
    record(api, { decision: 'skipped' });
    return null;
  }

  const probabilities = { [QUESTION_ID]: answer.confidence };
  if (answer.choice === ABSTAIN || answer.confidence < minConfidence) {
    record(api, { decision: 'none', probabilities });
    return null;
  }

  const chosen = options.find((skill) => skill.name === answer.choice);
  if (chosen === undefined) {
    record(api, { decision: 'none', probabilities });
    return null;
  }

  record(api, { decision: 'select', wouldBe: chosen.name, probabilities });
  return { skill: chosen, confidence: answer.confidence };
}

export default {
  id: ID,
  description: 'Picks at most one skill per turn from a catalog of fifteen or more.',
  label: 'Suggest a skill',
  // Spends the turn budget or raises a notice: needs the turn boundary and the notice drain.
  needsTurn: true,
  seam: SEAMS.SKILL_CATALOG,
  seamClass: 'broadcast',
  settings: {
    minCatalogSize: {
      type: 'number',
      default: DEFAULT_MIN_CATALOG,
      description: 'Suggest a skill only when the model-facing catalog holds at least this many.',
    },
    minConfidence: {
      type: 'number',
      default: DEFAULT_MIN_CONFIDENCE,
      description: 'Silence beats a weak guess: below this probability nothing is suggested.',
    },
    minTaskChars: {
      type: 'number',
      default: DEFAULT_MIN_TASK_CHARS,
      description: 'A latest message shorter than this is judged together with the messages before it.',
    },
  },

  /**
   * Observe one `agent/pre-step`. Never returns a value: this module is advisory,
   * so the step's messages are left exactly as they arrived.
   */
  async handle(event, api) {
    try {
      const pick = await select(event, api);
      if (pick === null) return undefined;
      // Shadow records the would-be pick (in `select`) and acts on nothing.
      if (api?.shadow?.isShadow?.(ID) === true) return undefined;

      const probability = pick.confidence.toFixed(2);
      api?.notice?.request?.({
        kind: 'advisory',
        priority: NOTICE_PRIORITY,
        text: `Possibly relevant skill: ${pick.skill.name} (raw probability ${probability}, uncalibrated). `
          + 'This is only a suggestion — ignore it if it does not fit the task.',
        tag: ID,
        dedupeKey: `${ID}:${event?.turn ?? ''}:${pick.skill.name}`,
      });
      return undefined;
    } catch (error) {
      // Advisory by construction: a failure raises no notice and never breaks the
      // step for the modules that do transform it.
      try {
        api?.log?.warn?.('[select.skill] no selection after an error', error);
      } catch {
        // Logging must not become the failure.
      }
      return undefined;
    }
  },
};
