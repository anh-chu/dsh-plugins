/**
 * `rank.files` — rank `glob` path candidates to steer the next read.
 *
 * ## The seam, and the one thing this module must never do
 *
 * `tools/result` is an emit: `(exec, result) => undefined` (dsh-tools
 * `lib/types/index.d.ts:92`). The harness ignores a listener's return, so a
 * broadcast observer cannot rewrite a result even by accident, and the registry
 * packs the two payload arguments as `{ exec, result }`.
 *
 * `admit.output` is the only transformer of `glob` output, on the exclusive
 * `tools/post-execute` seam. This module is the second thing to look at the same
 * result, and it is a ranker, not a second judge on the output: it returns
 * `undefined`, mutates nothing, and reports what it found through the ledger and
 * at most one advisory notice. `result.value.paths` is the authoritative,
 * complete candidate list — a `tools/post-execute` decision may replace
 * `content` but never `value` — so the ranking sees every path the glob
 * discovered, not only the page the model was shown.
 *
 * ## What the ranking is
 *
 * One `noul` question per candidate: "is `candidates.c<i>` a strong next file to
 * read for this task?" The judge's probabilities are compared as a ranking, and
 * the top candidate is reported when its score reaches `threshold`. The ledger
 * row keeps the whole ranking in the contract's `probabilities` map, keyed by
 * path, with `wouldBe` naming the path that should be read next. Nothing outside
 * the contract's record keys is written: `packages/core/src/ledger.js` strips
 * every extra field.
 *
 * A notice is raised only when the ranking has something to say: at least
 * `minCandidates` candidates (fewer than two is nothing to steer, whatever the
 * setting), a judge answer, and a top score at or above `threshold`. In shadow
 * mode the ranking is recorded and nothing is raised.
 *
 * Fail-open is `no-ranking`: an unavailable or unreadable judge records the skip
 * and leaves the next read to the agent.
 *
 * ponytail: at most `maxCandidates` paths are judged per result, taken as the
 * prefix of glob's modification-time order. The ceiling is the paid-call cost on
 * a very broad glob; the upgrade path is a path-shape pre-filter or a batched
 * judgment over the whole list.
 *
 * @module dsh-jev-layer/modules/rank-files
 */
import { createHash } from 'node:crypto';
import { SEAMS } from '../seams.js';

/** Stable id: config key, ledger key, shadow key and notice tag. */
const ID = 'rank.files';
/** Top score at or above which the next read is named. */
const DEFAULT_THRESHOLD = 0.7;
/** Candidates below which there is no ranking worth reporting. */
const DEFAULT_MIN_CANDIDATES = 3;
/** Bound on the judged set, because every candidate is a paid question. */
const DEFAULT_MAX_CANDIDATES = 20;
/** Path-candidate tools this module ranks. */
const DEFAULT_TOOL_ALLOWLIST = ['glob'];
/** Advisory notices carry no ordering pressure; kind already separates them. */
const NOTICE_PRIORITY = 10;
/** The ledger question id; the ranking itself is the probabilities map. */
const LEDGER_QUESTION = 'best next file to read';
/** How much of the call the task description carries. */
const MAX_TASK_CHARS = 2000;
/** How many candidates the notice names. */
const MAX_NOTICE_PATHS = 3;

/** Read a setting, unwrapping a volatile reference defensively. */
function settingOf(api, key) {
  const value = api?.config?.get?.(key);
  return value && typeof value.get === 'function' ? value.get() : value;
}

/** Read a numeric setting, falling back when it is absent or not finite. */
function numberSetting(api, key, fallback) {
  const value = settingOf(api, key);
  return Number.isFinite(value) ? value : fallback;
}

/** Read a string-list setting, falling back when it is absent or not a list. */
function listSetting(api, key, fallback) {
  const value = settingOf(api, key);
  return Array.isArray(value) ? value : fallback;
}

/** The readable text of a tool result, from its `text` content blocks. */
function textOf(result) {
  const content = result?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

/**
 * The candidate paths of a `glob` result.
 *
 * `result.value.paths` is the complete list and wins. The model-facing text is
 * the fallback for a host that does not carry `value` at `tools/result`; it is
 * exactly one path per line up to the cap, so the header and the recovery line
 * of an over-cap page are dropped by shape.
 */
function candidatesOf(result) {
  const paths = result?.value?.paths;
  if (Array.isArray(paths)) {
    return [...new Set(paths.filter((path) => typeof path === 'string' && path !== ''))];
  }
  const lines = textOf(result)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('(') && !line.startsWith('No files found'));
  return [...new Set(lines)];
}

/**
 * One relevance probability out of an answer. An absent or wrongly-typed answer
 * is a communication failure, so it is `undefined` rather than a confident zero.
 */
function readProbability(answer) {
  if (typeof answer === 'number' && Number.isFinite(answer)) return answer;
  if (!answer || typeof answer !== 'object') return undefined;
  const value = answer.noul ?? answer.probability;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Describe what the candidates are being ranked against.
 *
 * `api` carries no conversation task, so the call itself is the task: the tool
 * and the arguments it was asked with. A richer task on the event wins.
 */
function buildTask(exec, event) {
  if (typeof event?.task === 'string' && event.task.trim() !== '') {
    return event.task.trim().slice(0, MAX_TASK_CHARS);
  }
  let args = '';
  try {
    args = JSON.stringify(exec?.arguments ?? null) ?? '';
  } catch {
    args = '';
  }
  return `the ${exec?.name ?? 'glob'} call with arguments ${args}`.slice(0, MAX_TASK_CHARS);
}

/** A stable fingerprint of one ranking, for the arbiter's dedupe. */
function fingerprint(tool, task, paths) {
  const digest = createHash('sha256').update([tool, task, ...paths].join('|')).digest('hex');
  return `${ID}:${digest.slice(0, 16)}`;
}

/** The notice text: the next file to read, then the runners-up. */
function noticeText(tool, exec, judged, ranked, probabilities) {
  const pattern = exec?.arguments?.pattern;
  const target = typeof pattern === 'string' && pattern !== '' ? ` \`${pattern}\`` : '';
  const head = `\`${tool}\`${target} returned ${judged.length} candidate paths; `
    + `read \`${ranked[0]}\` next (relevance ${probabilities[ranked[0]].toFixed(2)}).`;
  const rest = ranked
    .slice(1, MAX_NOTICE_PATHS)
    .map((path) => `\`${path}\` (${probabilities[path].toFixed(2)})`);
  return rest.length === 0 ? head : `${head} Next best: ${rest.join(', ')}.`;
}

/** Append one ranking to the ledger. The ledger is a cache; never fail for it. */
function record(api, exec, probabilities, decision, wouldBe, threshold, mode) {
  try {
    api?.ledger?.append?.({
      featureId: ID,
      callId: exec?.callId ?? '',
      question: LEDGER_QUESTION,
      probabilities,
      threshold,
      decision,
      wouldBe,
      mode,
      at: Date.now(),
    });
  } catch {
    // A ledger that is down must not change the next read.
  }
}

export default {
  id: ID,
  description: 'Ranks path candidates to steer the next read.',
  label: 'Rank files to read next',
  // Spends the turn budget or raises a notice: needs the turn boundary and the notice drain.
  needsTurn: true,
  seam: SEAMS.TOOLS_RESULT,
  seamClass: 'broadcast',
  settings: {
    threshold: {
      type: 'number',
      default: DEFAULT_THRESHOLD,
      description: 'Top candidate score at or above which the next file to read is reported.',
    },
    minCandidates: {
      type: 'number',
      default: DEFAULT_MIN_CANDIDATES,
      description: 'Fewer candidate paths than this are not ranked; a lone candidate is never reported.',
    },
    maxCandidates: {
      type: 'number',
      default: DEFAULT_MAX_CANDIDATES,
      description: 'Most candidate paths judged per result, bounding the paid calls on a broad glob.',
    },
    toolAllowlist: {
      type: 'stringArray',
      default: [...DEFAULT_TOOL_ALLOWLIST],
      description: 'Path-candidate tools whose results are ranked. Defaults to glob only.',
    },
  },

  /**
   * Observe one `tools/result` and rank its path candidates.
   *
   * Never returns a value: the seam's contract is `undefined` for every
   * listener, so the result is left exactly as it arrived.
   */
  async handle(event, api) {
    try {
      const exec = event?.exec ?? event;
      const result = event?.result ?? event?.executionResult;
      const tool = typeof exec?.name === 'string' ? exec.name : '';
      if (!listSetting(api, 'toolAllowlist', DEFAULT_TOOL_ALLOWLIST).includes(tool)) return undefined;
      if (result?.isError === true) return undefined;
      if (exec?.signal?.aborted === true) return undefined;

      const candidates = candidatesOf(result);
      // A lone path needs no steering, whatever the setting says.
      if (candidates.length < 2) return undefined;
      const minCandidates = Math.max(1, Math.floor(numberSetting(api, 'minCandidates', DEFAULT_MIN_CANDIDATES)));
      if (candidates.length < minCandidates) return undefined;

      // Cheapest refusal first: an unconfigured judge costs nothing to detect.
      if (api?.judge?.configured === false) return undefined;

      // Take the budget unit only once a request will actually go out.
      if (typeof api?.budget?.tryAcquire === 'function' && api.budget.tryAcquire(ID, 1) === false) return undefined;

      const maxCandidates = Math.max(2, Math.floor(numberSetting(api, 'maxCandidates', DEFAULT_MAX_CANDIDATES)));
      const judged = candidates.slice(0, maxCandidates);
      const task = buildTask(exec, event);
      const questions = {};
      for (let i = 0; i < judged.length; i += 1) {
        // English on purpose: the text goes to the model, not to the reader.
        questions[`c${i}`] = {
          type: 'noul',
          instructions:
            `Is \`candidates.c${i}\` a strong next file to read for \`task\`: should it be read `
            + 'before the other candidates?',
          criteria: {
            true: 'it is likely to contain the definition, entry point, or evidence the task needs next',
            false: 'it is a look-alike, a generated or vendored file, or unrelated to the task',
          },
        };
      }

      const answers = await api.judge.ask(
        { task, candidates: Object.fromEntries(judged.map((path, i) => [`c${i}`, path])) },
        questions,
        { featureId: ID, failOpen: 'no-ranking' },
      );

      const mode = api?.shadow?.isShadow?.(ID) === true ? 'shadow' : 'enforce';
      const threshold = numberSetting(api, 'threshold', DEFAULT_THRESHOLD);

      const probabilities = {};
      let readable = answers !== null && answers !== undefined;
      for (let i = 0; i < judged.length; i += 1) {
        const probability = readProbability(answers?.[`c${i}`]);
        if (probability === undefined) readable = false;
        else probabilities[judged[i]] = probability;
      }

      // Fail-open: no ranking, no notice, and the skip is recorded.
      if (!readable || Object.keys(probabilities).length === 0) {
        record(api, exec, probabilities, 'skipped', 'none', threshold, mode);
        return undefined;
      }

      const ranked = [...judged].sort((a, b) => probabilities[b] - probabilities[a]);
      const top = ranked[0];
      const worth = probabilities[top] >= threshold;
      record(api, exec, probabilities, worth ? 'ranked' : 'silent', worth ? top : 'none', threshold, mode);

      // Shadow records the decision and acts on nothing.
      if (!worth || mode === 'shadow') return undefined;

      api.notice.request({
        kind: 'advisory',
        priority: NOTICE_PRIORITY,
        text: noticeText(tool, exec, judged, ranked, probabilities),
        tag: ID,
        dedupeKey: fingerprint(tool, task, ranked.slice(0, MAX_NOTICE_PATHS)),
      });
      return undefined;
    } catch (error) {
      // Fail open: ranking is advisory, so a failure raises no notice and must
      // never change the tool result for the harness or for other observers.
      try {
        api?.log?.warn?.('[rank.files] the candidates were left unranked', error);
      } catch {
        // Logging must not become the failure.
      }
      return undefined;
    }
  },
};
