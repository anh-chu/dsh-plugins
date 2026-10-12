/**
 * admit.output — keep the task-relevant segments of an oversized tool result.
 *
 * Owns `SEAMS.TOOLS_POST_EXECUTE` for the read-family tools. A result above the
 * token threshold is split into chunks, each chunk is judged for relevance to
 * the call's own task, and the irrelevant chunks are dropped. The retention is
 * *scattered*: the selection is ordered by relevance, so a relevant chunk late
 * in the payload survives while irrelevant chunks before it do not. It is never
 * one contiguous cut.
 *
 * Three rules shape everything below.
 *
 *   - **Rank, never threshold.** The raw probabilities are under-confident by
 *     construction. They order chunks well and read as probabilities poorly, so
 *     chunks are sorted and cut to a budget instead of filtered at 0.5.
 *   - **Deterministic floors.** The head and the tail of the payload, and any
 *     chunk the judge is confident about, are always kept, and the result never
 *     shrinks past a floor. A model that loses how a file starts cannot use the
 *     rest of it.
 *   - **Pure fail-open.** Any failure — judge unavailable, a malformed answer,
 *     a refused budget, an unexpected throw — returns the result unchanged.
 *     Pruning is an optimisation; it must never be why a task failed.
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
 *   - an exec-shaped object carrying `result`.
 *
 * The fail-open return follows the same shape: the downstream decision when the
 * module took one, otherwise `undefined` to mean "no replacement".
 *
 * @module dsh-jev-layer/modules/admit-output
 */
import { SEAMS } from '../seams.js';

/** Tools whose output is the model's material for the current task. */
const TOOL_ALLOWLIST = new Set(['read', 'grep', 'glob', 'web_fetch', 'web_search']);

/** A chunk larger than this is split by lines so no one question dominates. */
const CHUNK_TOKENS = 400;
/** Share of the payload's tokens the head and the tail together may claim. */
const FLOOR_TOKEN_SHARE = 0.5;
/** Lines guaranteed at the head of the payload. */
const HEAD_LINES = 40;
/** Lines guaranteed at the tail of the payload. */
const TAIL_LINES = 40;
/** A chunk at or above this probability is kept unconditionally. */
const KEEP_HIGH = 0.5;
/** The payload is never reduced below this share of its original tokens. */
const MIN_KEEP_RATIO = 0.2;
/** Task text longer than this is truncated before it reaches the judge. */
const MAX_TASK_CHARS = 400;

/** Marker placed where chunks were dropped. */
const OMISSION = '\n… {n} omitted …\n';

/**
 * Characters that tokenize near one per character.
 *
 * Deliberately the same heuristic the baseline uses, so a threshold measured
 * against real sessions means the same thing here.
 */
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
 * enough to choose a threshold and to guard a budget; it is not billing.
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

/** Split text into the chunks each judged on their own. */
function chunkText(text) {
  const chunks = [];
  const push = (raw) => {
    const trimmed = raw.trim();
    if (trimmed === '') return;
    const lines = trimmed.split('\n').length;
    chunks.push({ text: `${trimmed}\n`, lines, tokens: estimateTokens(trimmed) });
  };
  for (const paragraph of text.split(/\n\s*\n/)) {
    if (estimateTokens(paragraph) <= CHUNK_TOKENS) {
      push(paragraph);
      continue;
    }
    let bucket = [];
    let bucketTokens = 0;
    for (const line of paragraph.split('\n')) {
      const lineTokens = estimateTokens(line);
      if (bucketTokens > 0 && bucketTokens + lineTokens > CHUNK_TOKENS) {
        push(bucket.join('\n'));
        bucket = [];
        bucketTokens = 0;
      }
      bucket.push(line);
      bucketTokens += lineTokens;
    }
    push(bucket.join('\n'));
  }
  return chunks;
}

/**
 * Choose which chunks to keep. Ordering is by relevance, but the floors are
 * applied before the budget, so a large irrelevant opening can never crowd out
 * a required one.
 */
function selectChunks(chunks, relevance) {
  const keep = chunks.map(() => false);
  let original = 0;
  for (const chunk of chunks) original += chunk.tokens;

  // Floor 1: the head and the tail are always present. Each end is capped by
  // its share of the payload, but the first chunk at each end is kept
  // unconditionally — the guarantee only weakens as far as it must for pruning
  // to be possible at all.
  const endCap = (original * FLOOR_TOKEN_SHARE) / 2;
  let head = 0;
  let headTokens = 0;
  for (let i = 0; i < chunks.length && head < HEAD_LINES; i += 1) {
    if (i > 0 && headTokens >= endCap) break;
    keep[i] = true;
    head += chunks[i].lines;
    headTokens += chunks[i].tokens;
  }
  let tail = 0;
  let tailTokens = 0;
  for (let i = chunks.length - 1; i >= 0 && tail < TAIL_LINES; i -= 1) {
    if (i < chunks.length - 1 && tailTokens >= endCap) break;
    keep[i] = true;
    tail += chunks[i].lines;
    tailTokens += chunks[i].tokens;
  }

  // Floor 2: anything the judge is confident about stays.
  for (let i = 0; i < chunks.length; i += 1) {
    if ((relevance[i] ?? 0) >= KEEP_HIGH) keep[i] = true;
  }

  // Fill the rest by relevance until the floor is reached. The target is a
  // *floor*, not a target: keeping more than MIN_KEEP_RATIO is always safe.
  const floor = original * MIN_KEEP_RATIO;
  let keptTokens = 0;
  for (let i = 0; i < chunks.length; i += 1) {
    if (keep[i] === true) keptTokens += chunks[i].tokens;
  }
  const order = chunks.map((_, i) => i).sort((a, b) => (relevance[b] ?? 0) - (relevance[a] ?? 0));
  for (const index of order) {
    if (keptTokens >= floor) break;
    if (keep[index] === true) continue;
    keep[index] = true;
    keptTokens += chunks[index].tokens;
  }
  return { keep, keptTokens };
}

/** Reassemble the payload, marking each place where chunks were dropped. */
function reassemble(chunks, keep) {
  const parts = [];
  let pending = 0;
  for (let i = 0; i < chunks.length; i += 1) {
    if (keep[i] === true) {
      if (pending > 0) {
        parts.push(OMISSION.replace('{n}', String(pending)));
        pending = 0;
      }
      parts.push(chunks[i].text);
    } else {
      pending += 1;
    }
  }
  if (pending > 0) parts.push(OMISSION.replace('{n}', String(pending)));
  return parts.join('\n');
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

/**
 * Read one relevance probability out of a judge answer.
 *
 * A missing or wrongly-typed answer is a communication failure, not a confident
 * "not relevant". Reading it as 0 would drop the chunk and still record the
 * judgment as successful, so it returns `undefined` and the caller fails open.
 */
function readProbability(answer) {
  if (typeof answer === 'number' && Number.isFinite(answer)) return answer;
  if (!answer || typeof answer !== 'object') return undefined;
  const value = answer.noul ?? answer.probability;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Describe what the payload is being judged against.
 *
 * `api` carries no conversation task, so the call itself is the task: the tool
 * name and the arguments it was asked for. When the registry can supply a
 * richer task on the event, that wins.
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
  return `the ${exec?.name ?? 'tool'} call with arguments ${args}`.slice(0, MAX_TASK_CHARS);
}

/** Append one decision to the ledger. The ledger is a cache; never fail for it. */
function record(api, exec, probabilities, decision, wouldBe, mode) {
  try {
    api?.ledger?.append?.({
      featureId: 'admit.output',
      callId: exec?.callId,
      question: 'segment relevance to the current task',
      probabilities,
      threshold: KEEP_HIGH,
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
  id: 'admit.output',
  description: 'Keeps the task-relevant parts of `read`, `grep`, `glob`, `web_fetch` and `web_search` results above a token threshold.',
  label: 'Trim large file and search results',
  // Spends the turn budget or raises a notice: needs the turn boundary and the notice drain.
  needsTurn: true,
  seam: SEAMS.TOOLS_POST_EXECUTE,
  seamClass: 'exclusive',
  targets: [...TOOL_ALLOWLIST],
  settings: {
    minTokens: {
      type: 'number',
      default: 2000,
      description: 'Only judge tool results estimated above this many tokens.',
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
      // which one it sends. When no `result` arrives, take the downstream
      // decision and rewrite its content, which is the shape the harness
      // waterfall needs and is also what the baseline does.
      const exec = event?.exec ?? event;
      let result = event?.result;
      if (!result && typeof next === 'function') {
        downstream = await next();
        // A block, or a value-shaped accept, carries no content to rewrite.
        if (!downstream || downstream.kind !== 'accept' || !Array.isArray(downstream.content)) {
          return downstream;
        }
        result = { isError: false, content: downstream.content };
      }
      if (!exec || typeof exec.name !== 'string' || !result) return unchanged();
      if (result.isError === true) return unchanged();
      if (readConfig(api, 'enabled') === false) return unchanged();
      if (!TOOL_ALLOWLIST.has(exec.name)) return unchanged();

      const content = Array.isArray(result.content) ? result.content : undefined;
      if (content === undefined) return unchanged();

      const text = textOf(content);
      const originalTokens = estimateTokens(text);
      const minTokens = asNumber(readConfig(api, 'minTokens'), 2000);
      if (!(originalTokens > minTokens)) return unchanged();

      // Cheapest refusal first: an unconfigured judge costs nothing to detect.
      if (api?.judge?.configured === false) return unchanged();

      const chunks = chunkText(text);
      if (chunks.length < 2) return unchanged();

      // Take the budget unit only once a request will actually go out: a payload
      // that resolves to a single chunk is never sent, so it must not spend.
      if (api?.budget?.tryAcquire?.('admit.output', 1) === false) return unchanged();

      const task = buildTask(exec, event);
      const questions = {};
      for (let i = 0; i < chunks.length; i += 1) {
        // English on purpose: the text goes to the model, not to the reader.
        questions[`s${i}`] = {
          type: 'noul',
          instructions:
            `Is \`segments.s${i}\` directly relevant to \`task\`: does it contain material `
            + 'needed to locate, change, or cite something for that task?',
          criteria: {
            true: 'the segment contains specific material the task needs to locate, change, or cite',
            false: 'the segment is unrelated to the task — boilerplate, another file, or an already-finished log',
          },
        };
      }

      const answers = await api.judge.ask(
        { task, segments: Object.fromEntries(chunks.map((c, i) => [`s${i}`, c.text])) },
        questions,
        { featureId: 'admit.output', failOpen: 'keep-everything' },
      );
      // Fail-open path 1: the judge is unavailable. Keep everything.
      if (!answers) return unchanged();

      const relevance = [];
      for (let i = 0; i < chunks.length; i += 1) {
        const probability = readProbability(answers[`s${i}`]);
        // Fail-open path 2: an unreadable answer. Keep everything.
        if (probability === undefined) return unchanged();
        relevance.push(probability);
      }

      const { keep, keptTokens } = selectChunks(chunks, relevance);
      const saving = originalTokens === 0 ? 0 : (originalTokens - keptTokens) / originalTokens;
      const minSaving = asNumber(readConfig(api, 'minSaving'), 0.15);
      if (saving < minSaving) {
        record(api, exec, relevance, 'keep-everything', 'keep-everything', 'enforce');
        return unchanged();
      }

      // Shadow mode: judge and record, change nothing. The numbers are real;
      // only their application is withheld.
      if (api?.shadow?.isShadow?.('admit.output') === true) {
        record(api, exec, relevance, 'shadow', 'prune', 'shadow');
        return unchanged();
      }

      const rebuilt = withText(content, reassemble(chunks, keep));
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
        api?.log?.warn?.('[admit.output] kept the result unchanged after an error', error);
      } catch {
        // Logging must not become the failure.
      }
      return unchanged();
    }
  },
};
