/**
 * admit.terminal — keep the parts of an oversized terminal log that matter.
 *
 * The wave 1 baseline refuses to touch `bash` and `pwsh` output, because a
 * terminal log is not prose: it is a whole transcript, and the one line the
 * model needs can be a single failure buried under megabytes of progress. This
 * module takes that scope, and splits the decision in two.
 *
 *   - **Rules protect, the judge prunes.** Failures, their surrounding stack and
 *     diff lines, run summaries, the tests the task names, slow tests and the
 *     ends of the log are kept by deterministic rules, whatever the judge says.
 *     Only the remaining runs — ordinary progress and passing detail — become
 *     candidates, and only those are judged. A judge failure therefore cannot
 *     cost the model a failure line.
 *   - **Pure fail-open.** Any failure — judge unavailable, a malformed answer, a
 *     refused budget, an unexpected throw — returns the result unchanged.
 *     Pruning is an optimisation; it must never be why a task failed.
 *   - **Disjoint from `admit.output` by construction.** That module owns `read`,
 *     `grep`, `glob`, `web_fetch` and `web_search`; this one owns `bash` and
 *     `pwsh`. The two target sets do not intersect, so both may be enabled on
 *     one seam without either rewriting the other's events.
 *
 * A failing test run arrives with `result.isError === true`, and it is the main
 * input this module exists for, so an errored result is *not* skipped: its
 * failure lines are protected by rule, and only its ordinary detail is judged.
 * (`admit.output` skips errored results because a read error carries no material
 * to rank; a terminal error carries the evidence the task needs.)
 *
 * The registry owns the listener. This module never calls `ctx.on`: doing so
 * would put a second owner on the seam, which is the failure the registry exists
 * to prevent.
 *
 * `handle(event, api, next)` accepts every shape the registry might use, because
 * the frozen contract fixes `handle(event, api)` while the waterfall needs three
 * arguments:
 *
 *   - `{ exec, result }` — the packed form the contract implies; the return is
 *     the new result value.
 *   - `exec` plus `next` — the form the registry actually dispatches, which
 *     hands over only `args[0]` and pops `next`. The module takes the downstream
 *     decision and returns a replacement decision, as the baseline does.
 *
 * A non-target tool is answered *before* `next()` is taken, so a chained
 * `admit.output` still runs and this module never spends a judge call on a tool
 * it does not own.
 *
 * @module dsh-jev-layer/modules/admit-terminal
 */
import { SEAMS } from '../seams.js';

/** The terminal tools this module owns. Nothing else, ever. */
const TARGETS = ['bash', 'pwsh'];
const TARGET_SET = new Set(TARGETS);

/** Marker placed where a run of lines was dropped. */
const OMITTED = '… {n} lines omitted …';

/**
 * Lines kept at each end of the log.
 *
 * A transcript's first lines name the command and its environment, and its last
 * lines carry the exit state. Dropping either end saves almost nothing and can
 * leave the model without the frame the rest of the log needs.
 */
const HEAD_LINES = 3;
const TAIL_LINES = 5;

/** Indented lines after a failure that belong to it: a stack frame, a diff body. */
const CONTEXT_LINES = 8;

/** A candidate larger than this is split so no one question spans a whole log. */
const CHUNK_TOKENS = 400;

/**
 * The most candidates one request may carry.
 *
 * Beyond this the request cost grows with no better answer, so adjacent
 * candidates are merged until the count fits. Merging never spans a protected
 * line, so a merged candidate still cannot drop one.
 */
const MAX_CANDIDATES = 24;

/**
 * Below this probability the judge says the candidate is not needed.
 *
 * Only clearly-unneeded runs are dropped: the reference judge is under-confident
 * by construction, so a high score is weak evidence for *keeping* while a low
 * score is strong evidence for dropping. Everything at or above stays.
 */
const DROP_BELOW = 0.5;

/** Task text longer than this is truncated before it reaches the judge. */
const MAX_TASK_CHARS = 400;

/**
 * A line that reports a failure.
 *
 * Deliberately broad: keeping a line is cheap, dropping a failure is not, so a
 * false positive only costs a little retained text.
 */
const FAILURE_PATTERNS = [
  /\b(?:FAIL|FAILED|FAILURE|FATAL|PANIC|PANICKED)\b/,
  /\bnot ok\b/i,
  /^\s*(?:✗|✕|×|✖|●)\s/,
  /\b(?:AssertionError|Assertion failed|Traceback \(most recent call last\))\b/,
  /\bUnhandled (?:promise )?rejection\b/,
  /\b(?:npm|pnpm|yarn|bun) ERR!/,
  /\berror TS\d+/,
  /\bexit(?:ed|ing)?\s+(?:with\s+)?(?:code|status)\s*[:=]?\s*[1-9]/i,
  /\b(?:Segmentation fault|core dumped|command not found|permission denied|No such file or directory|Killed)\b/,
  /\b(?:error|exception|refused|timeout|timed out)\b/i,
];

/** A line that summarises a run rather than reporting one case. */
const SUMMARY_PATTERNS = [
  /^\s*(?:Test Suites|Tests|Snapshots|Test Files|Time|Duration|Ran \d+ tests?)\s*:/i,
  /^\s*Duration\s+[\d.]/,
  // A runner's FILE-level result (`PASS src/app.test.js`, optionally with a time) is
  // a summary. A PER-TEST line (`PASS test_500 ok 3ms`) is not: the pattern used to be
  // a bare `^PASS`, which protected every passing test line, so a log of nine hundred
  // passes left no candidate at all and the judge was never asked. Found on a real
  // turn whose ledger stayed empty; the file-level shape needs a path or an extension.
  /^\s*(?:PASS|PASSED)\s+\S*(?:\/|\.[a-z]{1,5}\b)\S*(?:\s+\([^)]*\))?\s*$/i,
  /^\s*#\s*(?:pass|fail|tests|skipped|todo)\b/i,
  /\b\d+\s+(?:passed|failed|errors?|skipped|pending|todo|flaky|warnings?)\b/,
  /\b(?:passed|failed)\s+in\s+[\d.]+\s*(?:m?s|seconds?|minutes?)\b/i,
  /^\s*[=~-]{3,}\s*.*\b(?:passed|failed|error|warning)s?\b.*\s*[=~-]{3,}\s*$/i,
];

/**
 * A line that carries a test outcome and the name of the case.
 *
 * The captured group is the name, with a trailing duration removed.
 */
const TEST_LINE = /^\s*(?:[✔✓√☑]|[✗✕×✖]|ok\s+\d+|not ok\s+\d+|PASS|FAIL|PASSED|FAILED)\s*(?:[-–—:]\s*)?(.+)$/;

/** Words that appear in almost every test name and anchor nothing. */
const NAME_STOPWORDS = new Set([
  'test', 'tests', 'spec', 'specs', 'suite', 'suites', 'case', 'cases',
  'should', 'when', 'then', 'given', 'with', 'from', 'into', 'that', 'this',
  'does', 'and', 'the', 'for', 'not', 'are', 'was', 'has',
]);

/** Characters that tokenize near one per character. */
function isDense(code) {
  return (
    (code >= 0x3040 && code <= 0x30ff) || // kana
    (code >= 0x3400 && code <= 0x4dbf) || // CJK extension A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK unified ideographs
    (code >= 0xac00 && code <= 0xd7af) || // hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility ideographs
    (code >= 0xff00 && code <= 0xffef) // fullwidth forms
  );
}

/**
 * Estimate the token count of a string. Accurate to roughly ±20%, which is
 * enough to choose a threshold and to guard a budget; it is not billing. The
 * heuristic is deliberately the one `admit.output` uses, so one measured
 * threshold means the same thing across both modules.
 */
function estimateTokens(text) {
  let dense = 0;
  let sparse = 0;
  for (const char of text) {
    if (isDense(char.codePointAt(0) ?? 0)) dense += 1;
    else sparse += 1;
  }
  return dense + sparse / 4;
}

/** Concatenate every text block of a content array. */
function textOf(content) {
  let text = '';
  for (const block of content) {
    if (block && typeof block.text === 'string' && typeof block.type === 'string') {
      text += `${block.text}\n`;
    }
  }
  return text;
}

/** Replace the text blocks with one text block; carry every other block through. */
function withText(content, text) {
  const out = [];
  let placed = false;
  for (const block of content) {
    if (block && typeof block.type === 'string' && typeof block.text === 'string') {
      if (!placed) {
        out.push({ type: 'text', text });
        placed = true;
      }
      continue;
    }
    out.push(block);
  }
  return placed ? out : undefined;
}

/**
 * Read one configuration value.
 *
 * The contract says `api.config.get` returns an already-unwrapped value. A
 * volatile field arriving as an object with `get()` would compare as truthy and
 * silently ignore the operator's setting, so unwrap defensively.
 */
function readConfig(api, key) {
  const value = api?.config?.get?.(key);
  return value && typeof value.get === 'function' ? value.get() : value;
}

/** Read a numeric setting, falling back when it is not a usable number. */
function asNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** True when the line reports a failure. */
function isFailure(line) {
  return FAILURE_PATTERNS.some((pattern) => pattern.test(line));
}

/** True when the line belongs to the failure above it. */
function isFailureContext(line) {
  return line.trim() !== '' && /^\s/.test(line);
}

/** True when the line summarises the run. */
function isSummary(line) {
  return SUMMARY_PATTERNS.some((pattern) => pattern.test(line));
}

/** The test name a line reports, or `undefined` when it reports no case. */
function testName(line) {
  const match = TEST_LINE.exec(line);
  if (!match) return undefined;
  const name = match[1]
    .replace(/\s*[([{]?\s*[\d.]+\s*(?:ms|s|sec|secs|seconds?|min|mins|minutes?)\s*[)\]}]\s*$/i, '')
    .trim();
  return name.length >= 3 ? name : undefined;
}

/** The duration a test line reports, in milliseconds, or `undefined`. */
function durationMs(line) {
  const match = /(?:^|[\s([{])([\d.]+)\s*(ms|s|sec|secs|seconds?|min|mins|minutes?)(?=$|[\s)\]},;])/i.exec(line);
  if (!match) return undefined;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value)) return undefined;
  const unit = match[2].toLowerCase();
  if (unit === 'ms') return value;
  return unit.startsWith('m') ? value * 60_000 : value * 1000;
}

/**
 * True when the task itself names this test.
 *
 * The name is split into words and a word of four or more characters that the
 * task contains is an anchor. Short and generic words are ignored, because they
 * would anchor every test in the log and protect the whole payload.
 */
function anchorsTask(name, task) {
  if (task === '') return false;
  const haystack = task.toLowerCase();
  for (const word of name.toLowerCase().split(/[^a-z0-9_$]+/)) {
    if (word.length < 4 || NAME_STOPWORDS.has(word)) continue;
    if (haystack.includes(word)) return true;
  }
  return false;
}

/**
 * Describe what the log is being judged against.
 *
 * The command is the task for a terminal call: `exec.arguments.command` is what
 * the model asked the shell to do. A richer task on the event wins when the
 * registry can supply one.
 */
function buildTask(exec, event) {
  if (typeof event?.task === 'string' && event.task.trim() !== '') {
    return event.task.trim().slice(0, MAX_TASK_CHARS);
  }
  const command = exec?.arguments?.command;
  if (typeof command === 'string' && command.trim() !== '') {
    return command.trim().slice(0, MAX_TASK_CHARS);
  }
  let args = '';
  try {
    args = JSON.stringify(exec?.arguments ?? null) ?? '';
  } catch {
    args = '';
  }
  return `the ${exec?.name ?? 'terminal'} command ${args}`.slice(0, MAX_TASK_CHARS);
}

/**
 * Mark every line that must survive.
 *
 * Rules only: failures and their context, summaries, and the tests the task
 * names or that ran slowly. The head and the tail are kept as well. Everything
 * else is a candidate.
 */
function protectLines(lines, task, slowTestMs) {
  const protect = lines.map(() => false);
  for (let i = 0; i < HEAD_LINES && i < lines.length; i += 1) protect[i] = true;
  for (let i = Math.max(0, lines.length - TAIL_LINES); i < lines.length; i += 1) protect[i] = true;

  let context = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (isFailure(line)) {
      protect[i] = true;
      context = CONTEXT_LINES;
      continue;
    }
    if (context > 0 && isFailureContext(line)) {
      protect[i] = true;
      context -= 1;
      continue;
    }
    context = 0;
    if (isSummary(line)) {
      protect[i] = true;
      continue;
    }
    const name = testName(line);
    if (name === undefined) continue;
    const duration = durationMs(line);
    if ((duration !== undefined && duration >= slowTestMs) || anchorsTask(name, task)) protect[i] = true;
  }
  return protect;
}

/**
 * Group runs of unprotected lines into candidates.
 *
 * A candidate is a list of line indices, never a span, so a candidate merged
 * past a protected line still cannot drop it.
 */
function candidateChunks(lines, protect) {
  const chunks = [];
  let current = { indices: [], tokens: 0 };
  const flush = () => {
    if (current.indices.length > 0) chunks.push(current);
    current = { indices: [], tokens: 0 };
  };
  for (let i = 0; i < lines.length; i += 1) {
    if (protect[i]) {
      flush();
      continue;
    }
    const tokens = estimateTokens(lines[i]);
    if (current.tokens > 0 && current.tokens + tokens > CHUNK_TOKENS) flush();
    current.indices.push(i);
    current.tokens += tokens;
  }
  flush();
  return chunks;
}

/** Merge adjacent candidates until at most `limit` remain, preserving the gaps. */
function mergeCandidates(chunks, limit) {
  let out = chunks;
  while (out.length > limit) {
    const merged = [];
    for (let i = 0; i < out.length; i += 2) {
      if (i + 1 >= out.length) {
        merged.push(out[i]);
        continue;
      }
      merged.push({
        indices: [...out[i].indices, ...out[i + 1].indices],
        tokens: out[i].tokens + out[i + 1].tokens,
      });
    }
    out = merged;
  }
  return out;
}

/**
 * Read one probability out of a judge answer.
 *
 * A missing or wrongly-typed answer is a communication failure, not a confident
 * "not needed". Reading it as 0 would drop the candidate and still record the
 * judgment as successful, so it returns `undefined` and the caller fails open.
 */
function readProbability(answer) {
  if (typeof answer === 'number' && Number.isFinite(answer)) return answer;
  if (!answer || typeof answer !== 'object') return undefined;
  const value = answer.noul ?? answer.probability;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Reassemble the log, replacing each run of dropped lines with one marker. */
function reassemble(lines, drop) {
  const parts = [];
  let pending = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (drop[i]) {
      pending += 1;
      continue;
    }
    if (pending > 0) {
      parts.push(OMITTED.replace('{n}', String(pending)));
      pending = 0;
    }
    parts.push(lines[i]);
  }
  if (pending > 0) parts.push(OMITTED.replace('{n}', String(pending)));
  return parts.join('\n');
}

/** Append one decision to the ledger. The ledger is a cache; never fail for it. */
function record(api, exec, probabilities, decision, wouldBe, mode) {
  try {
    api?.ledger?.append?.({
      featureId: 'admit.terminal',
      callId: exec?.callId,
      question: 'are these terminal-log lines still needed for the current task',
      probabilities,
      threshold: DROP_BELOW,
      decision,
      wouldBe,
      mode,
      at: Date.now(),
    });
  } catch {
    // A ledger that is down must not change what the model sees.
  }
}

export default {
  id: 'admit.terminal',
  description: 'The same pruning for `bash` and `pwsh` output: keeps failures, summaries, named and slow tests, drops ordinary passing detail.',
  label: 'Trim large command output',
  // Spends the turn budget or raises a notice: needs the turn boundary and the notice drain.
  needsTurn: true,
  seam: SEAMS.TOOLS_POST_EXECUTE,
  seamClass: 'exclusive',
  targets: [...TARGETS],
  settings: {
    minTokens: {
      type: 'number',
      default: 2000,
      description: 'Only judge a bash or pwsh result estimated above this many tokens.',
    },
    slowTestMs: {
      type: 'number',
      default: 300,
      description: 'A test at or above this duration is always kept, whatever the task names.',
    },
    minSaving: {
      type: 'number',
      default: 0.15,
      description: 'Keep everything when the achievable saving is below this ratio.',
    },
  },

  async handle(event, api, next) {
    // Fail open: hand back exactly what the call would have produced anyway.
    // Declared outside the try so the catch below can reach it too.
    let downstream;
    const unchanged = () => downstream;
    try {
      // The registry may pack the waterfall args, or pass the exec alone with the
      // waterfall `next` as its third argument: the frozen contract does not fix
      // which one it sends.
      const exec = event?.exec ?? event;
      // A tool this module does not own is answered before `next()` is taken, so
      // a chained owner still runs and this module spends nothing on the event.
      if (!exec || typeof exec.name !== 'string' || !TARGET_SET.has(exec.name)) {
        return typeof next === 'function' ? await next() : undefined;
      }
      let result = event?.result;
      if (!result && typeof next === 'function') {
        downstream = await next();
        // A block, or a value-shaped accept, carries no content to rewrite.
        if (!downstream || downstream.kind !== 'accept' || !Array.isArray(downstream.content)) {
          return downstream;
        }
        result = { isError: false, content: downstream.content };
      }
      if (!result) return unchanged();
      if (readConfig(api, 'enabled') === false) return unchanged();

      const content = Array.isArray(result.content) ? result.content : undefined;
      if (content === undefined) return unchanged();

      const text = textOf(content);
      const originalTokens = estimateTokens(text);
      const minTokens = asNumber(readConfig(api, 'minTokens'), 2000);
      if (!(originalTokens > minTokens)) return unchanged();

      const lines = text.split('\n');
      const task = buildTask(exec, event);
      const slowTestMs = asNumber(readConfig(api, 'slowTestMs'), 300);
      const protect = protectLines(lines, task, slowTestMs);
      const candidates = mergeCandidates(candidateChunks(lines, protect), MAX_CANDIDATES);
      // Nothing to ask about: every line is protected material.
      if (candidates.length === 0) return unchanged();

      // Cheapest refusals first: an unconfigured judge costs nothing to detect,
      // and a payload with no candidate never spends the budget.
      if (api?.judge?.configured === false) return unchanged();
      if (api?.budget?.tryAcquire?.('admit.terminal', 1) === false) return unchanged();

      const questions = {};
      const state = { task, candidates: {} };
      for (let i = 0; i < candidates.length; i += 1) {
        // English on purpose: the text goes to the model, not to the reader.
        questions[`c${i}`] = {
          type: 'noul',
          instructions:
            `The other lines of this terminal log are already retained by rule (failures, `
            + `summaries, named and slow tests). Is \`candidates.c${i}\` still needed for `
            + '`task`: does it contain an error, a result, a value, a path or a decision the '
            + 'task depends on?',
          criteria: {
            true: 'the lines hold evidence the task needs — an error not covered by a retained failure, a produced result, a value, a path, or a decision',
            false: 'the lines are ordinary progress, chatter or passing detail the task does not need',
          },
        };
        state.candidates[`c${i}`] = candidates[i].indices.map((index) => lines[index]).join('\n');
      }

      const answers = await api.judge.ask(state, questions, {
        featureId: 'admit.terminal',
        failOpen: 'keep-everything',
      });
      // Fail-open path 1: the judge is unavailable. Keep everything.
      if (!answers) return unchanged();

      const relevance = [];
      for (let i = 0; i < candidates.length; i += 1) {
        const probability = readProbability(answers[`c${i}`]);
        // Fail-open path 2: an unreadable answer. Keep everything.
        if (probability === undefined) return unchanged();
        relevance.push(probability);
      }

      const drop = lines.map(() => false);
      for (let i = 0; i < candidates.length; i += 1) {
        if (relevance[i] >= DROP_BELOW) continue;
        for (const index of candidates[i].indices) drop[index] = true;
      }

      let keptTokens = 0;
      for (let i = 0; i < lines.length; i += 1) {
        if (drop[i] !== true) keptTokens += estimateTokens(lines[i]);
      }
      const saving = originalTokens === 0 ? 0 : (originalTokens - keptTokens) / originalTokens;
      const minSaving = asNumber(readConfig(api, 'minSaving'), 0.15);
      if (saving < minSaving) {
        record(api, exec, relevance, 'keep-everything', 'keep-everything', 'enforce');
        return unchanged();
      }

      // Shadow mode: judge and record, change nothing. The numbers are real;
      // only their application is withheld.
      if (api?.shadow?.isShadow?.('admit.terminal') === true) {
        record(api, exec, relevance, 'shadow', 'prune', 'shadow');
        return unchanged();
      }

      const rebuilt = withText(content, reassemble(lines, drop));
      if (rebuilt === undefined) return unchanged();

      record(api, exec, relevance, 'prune', 'prune', 'enforce');
      // Answer in the shape the caller used: the harness waterfall needs a
      // decision back, while the contract's packed form needs the new value.
      if (downstream !== undefined) {
        return {
          kind: 'accept',
          content: rebuilt,
          ...(downstream.additionalContexts
            ? { additionalContexts: downstream.additionalContexts }
            : {}),
        };
      }
      return { ...result, content: rebuilt };
    } catch (error) {
      // Fail-open path 3: anything unexpected. Keep everything.
      try {
        api?.log?.warn?.('[admit.terminal] kept the result unchanged after an error', error);
      } catch {
        // Logging must not become the failure.
      }
      return unchanged();
    }
  },
};
