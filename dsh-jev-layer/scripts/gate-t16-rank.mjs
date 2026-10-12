/**
 * G-T16-1 (CID-23) — `rank.files` acceptance gate.
 *
 * Three outcomes, from the ticket and `docs/CONTRACT.md` "Seam classes":
 *
 *   (a) the observed `tools/result` event comes back deep-equal to its input and
 *       the module's return is `undefined` — it never transforms a result, which
 *       is what leaves `admit.output` the only transformer of `glob` output;
 *   (b) the ranking is recorded: the ledger rows carry the per-path
 *       probabilities and name the path to read next;
 *   (c) at most one advisory notice is raised, and only when the ranking has
 *       something worth saying.
 *
 * The positive controls come first: a broad glob with one clearly relevant path
 * must rank, record and raise before any absence case is asserted, and the
 * event-mutation detector must fire on an observer that really does change the
 * event. Synthetic api, no network, no host. The last sections drive the real
 * registry and the real core ledger, so "recorded" and "never transformed" are
 * shown on the shipped dispatcher and the shipped record normalizer, not only on
 * a stub.
 *
 * Run from the repo root: node scripts/gate-t16-rank.mjs
 */
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

import rankFiles from '../packages/plugin/src/modules/rank-files.js';
import { createCore } from '../packages/core/src/index.js';
import { createRegistry } from '../packages/plugin/src/registry.js';
import { SEAMS, fakeCore, fakeCtx, makeConfig, makeModule } from '../packages/plugin/test/fixtures/harness.js';

const NOW = 1_700_000_000_000;

const PATHS = ['docs/guide.md', 'src/app.js', 'vendor/lib.js', 'src/app.test.js', 'dist/app.js'];
/** One clearly relevant path; everything else scores below the default threshold. */
const SCORES = { 'src/app.js': 0.93 };

/** Whether a value differs from a reference taken before the call. */
function changed(reference, value) {
  return !isDeepStrictEqual(reference, value);
}

/** Answer every `noul` question from a path-to-probability map or a function. */
function scoreAnswers(state, questions, scores) {
  const answers = {};
  for (const id of Object.keys(questions)) {
    const path = state.candidates[id];
    answers[id] = { type: 'noul', noul: typeof scores === 'function' ? scores(path) : (scores[path] ?? 0.1) };
  }
  return answers;
}

/** One packed `tools/result` payload, the shape the registry dispatches. */
function globEvent(paths, { pattern = '**/*.js', callId = 'call_1', isError = false, aborted = false } = {}) {
  return {
    exec: { callId, name: 'glob', arguments: { pattern }, signal: { aborted } },
    result: {
      isError,
      value: { root: '.', paths },
      content: [{ type: 'text', text: paths.join('\n') }],
    },
  };
}

/**
 * A minimal stand-in for the module context. `config` returns `undefined` unless
 * a case overrides a key, so the module's own defaults are what run by default.
 * `ledger` may be a real core ledger, which records and normalizes the row.
 */
function makeApi({
  scores = SCORES,
  answers = null,
  judgeNull = false,
  judgeThrows = false,
  shadow = false,
  budgetOk = true,
  configured = true,
  config = {},
  realLedger = null,
} = {}) {
  const notices = [];
  const ledger = [];
  const judge = { calls: 0, state: null, questions: null, opts: null };
  const api = {
    id: 'rank.files',
    config: { get: (key) => config[key] },
    judge: {
      configured,
      async ask(state, questions, opts) {
        judge.calls += 1;
        judge.state = state;
        judge.questions = questions;
        judge.opts = opts;
        if (judgeThrows) throw new Error('judge offline');
        if (judgeNull) return null;
        if (answers !== null) return answers;
        return scoreAnswers(state, questions, scores);
      },
    },
    budget: { tryAcquire: () => budgetOk },
    ledger: {
      append: (record) => {
        ledger.push(record);
        return realLedger?.append?.(record);
      },
    },
    shadow: { isShadow: () => shadow },
    notice: {
      request: (notice) => {
        notices.push(notice);
        return 'accepted';
      },
    },
    log: { warn: () => {} },
  };
  return { api, notices, ledger, judge };
}

/** Deep-freeze an event the way the harness freezes a result at `tools/result`. */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

// ── 1. Positive control: a broad glob with one relevant path ranks it ──────
{
  const { api, notices, ledger, judge } = makeApi();
  const event = globEvent(PATHS);
  const before = structuredClone(event);

  const out = await rankFiles.handle(event, api);

  assert.equal(out, undefined, 'rank.files is an observer: it must never transform the result');
  assert.equal(changed(before, event), false, 'the observed event comes back deep-equal to its input');
  assert.equal(judge.calls, 1, 'the candidate list is judged exactly once');
  assert.equal(judge.opts.featureId, 'rank.files', 'the judge call is keyed by the module id');
  assert.equal(judge.opts.failOpen, 'no-ranking', 'the fail-open meaning at this call site is "no ranking"');
  assert.deepEqual(Object.keys(judge.state.candidates), ['c0', 'c1', 'c2', 'c3', 'c4'], 'every candidate is a question');
  assert.equal(judge.state.candidates.c1, 'src/app.js', 'the candidate text is the path itself');

  assert.equal(ledger.length, 1, 'the ranking is recorded');
  const row = ledger[0];
  assert.equal(row.featureId, 'rank.files', 'the row is keyed by the module id');
  assert.equal(row.callId, 'call_1', 'the row carries the call id');
  assert.equal(row.question, 'best next file to read', 'the row names the ranking question');
  assert.equal(row.threshold, 0.7, 'the row keeps the threshold');
  assert.equal(row.decision, 'ranked', 'the row records that a ranking was reported');
  assert.equal(row.wouldBe, 'src/app.js', 'the row names the path to read next');
  assert.equal(row.mode, 'enforce', 'the row is marked enforce');
  assert.deepEqual(
    Object.keys(row.probabilities).sort(),
    [...PATHS].sort(),
    'the row keeps one probability per candidate, keyed by path',
  );
  assert.equal(row.probabilities['src/app.js'], 0.93, 'the row keeps the judged probabilities');

  assert.equal(notices.length, 1, 'exactly one notice is requested');
  const notice = notices[0];
  assert.equal(notice.kind, 'advisory', 'the notice is advisory, not blocked');
  assert.equal(notice.tag, 'rank.files', 'the notice carries the module tag');
  assert.ok(typeof notice.dedupeKey === 'string' && notice.dedupeKey.startsWith('rank.files:'), 'the notice carries a dedupe key');
  assert.match(notice.text, /src\/app\.js/, 'the notice names the path to read next');
  assert.match(notice.text, /\*\*\/\*\.js/, 'the notice names the glob pattern');
  assert.match(notice.text, /0\.93/, 'the notice reports the top score');
}

// ── 2. The same event, deep-frozen: unchanged, and still ranked ────────────
{
  const { api, notices, ledger } = makeApi();
  const event = deepFreeze(globEvent(PATHS));
  const before = structuredClone(event);
  const out = await rankFiles.handle(event, api);

  assert.equal(out, undefined, 'a frozen result is still never transformed');
  assert.equal(changed(before, event), false, 'a frozen event is left unchanged');
  assert.equal(ledger.length, 1, 'freezing the result does not stop the ranking');
  assert.equal(notices.length, 1, 'freezing the result does not stop the notice');
}

// ── 3. The real registry: broadcast dispatch leaves the event untouched ────
{
  const modules = [rankFiles];
  const ctx = fakeCtx();
  const { core, appended } = fakeCore({ judge: { configured: true, ask: async (state, questions) => scoreAnswers(state, questions, SCORES) } });
  const registry = createRegistry({ modules, ctx, config: makeConfig(modules, ['rank.files']), core });
  const states = await registry.start();

  assert.equal(states[0].seamClass, 'broadcast', 'the descriptor declares the broadcast class');
  assert.equal(ctx.listenerCount(SEAMS.TOOLS_RESULT), 1, 'one shared listener on the emit seam');

  const event = globEvent(PATHS);
  const before = structuredClone(event);
  const out = await ctx.fire(SEAMS.TOOLS_RESULT, event);

  assert.equal(out, undefined, 'an emit seam hands back nothing at all, so there is no rewrite to act on');
  assert.equal(changed(before, event), false, 'the dispatched event is unchanged on the real seam');
  const rows = appended.filter((record) => record.featureId === 'rank.files');
  assert.equal(rows.length, 1, 'the real dispatch records the ranking through the core ledger');
  assert.equal(rows[0].wouldBe, 'src/app.js', 'the recorded ranking names the top path');

  await registry.stop();
  assert.equal(ctx.listenerCount(SEAMS.TOOLS_RESULT), 0, 'stop() releases the shared listener');
}

// ── 4. Positive control for the mutation detector ─────────────────────────
//    The check in sections 1-3 can only be evidence if it fires when an
//    observer really does rewrite the event.
{
  const mutator = {
    ...makeModule({
      id: 'mutator',
      seam: SEAMS.TOOLS_RESULT,
      handle: (event) => {
        event.result.content.push({ type: 'text', text: 'injected' });
      },
    }),
    seamClass: 'broadcast',
  };
  const modules = [mutator];
  const ctx = fakeCtx();
  const registry = createRegistry({ modules, ctx, config: makeConfig(modules, ['mutator']), core: fakeCore().core });
  await registry.start();

  const event = globEvent(PATHS);
  const before = structuredClone(event);
  await ctx.fire(SEAMS.TOOLS_RESULT, event);
  assert.equal(changed(before, event), true, 'the mutation detector fires when an observer does transform the event');

  await registry.stop();
}

// ── 5. The real core ledger: the ranking survives record normalization ─────
{
  const core = createCore({ settings: { get: () => undefined }, now: () => NOW });
  const { api, notices, ledger } = makeApi({ realLedger: core.ledger });
  await rankFiles.handle(globEvent(PATHS), api);

  assert.equal(ledger.length, 1, 'the module appends one row');
  const stored = core.ledger.read('rank.files');
  assert.equal(stored.length, 1, 'the real ledger keeps the row under the module id');
  assert.deepEqual(
    Object.keys(stored[0]),
    ['featureId', 'callId', 'question', 'probabilities', 'threshold', 'decision', 'wouldBe', 'reason', 'mode', 'at'],
    'the row has exactly the contract shape; extra fields would be stripped',
  );
  assert.deepEqual(stored[0].probabilities, ledger[0].probabilities, 'the ranking survives normalization');
  assert.equal(stored[0].wouldBe, 'src/app.js', 'the path to read next survives normalization');
  assert.ok(Number.isFinite(stored[0].at), 'the row carries a timestamp');
  assert.equal(notices.length, 1, 'the notice is still raised');
}

// ── 6. Absence cases, each with section 1 as its positive control ─────────
for (const [label, options] of [
  ['a non-allowlisted tool', { tool: 'read' }],
  ['a grep result', { tool: 'grep' }],
  ['an errored result', { isError: true }],
  ['an aborted call', { aborted: true }],
  ['a single candidate', { paths: ['src/app.js'] }],
  ['two candidates, under minCandidates', { paths: ['src/app.js', 'src/util.js'] }],
]) {
  const { api, notices, ledger, judge } = makeApi();
  const event = globEvent(options.paths ?? PATHS, options);
  if (options.tool !== undefined) event.exec.name = options.tool;
  const out = await rankFiles.handle(event, api);
  assert.equal(out, undefined, `${label}: still no return value`);
  assert.equal(judge.calls, 0, `${label}: the judge is never asked`);
  assert.equal(ledger.length, 0, `${label}: nothing is recorded without a judgment`);
  assert.equal(notices.length, 0, `${label}: no notice is raised`);
}

// ── 7. Refusals that must not spend: budget, unconfigured judge ────────────
{
  const refused = makeApi({ budgetOk: false });
  await rankFiles.handle(globEvent(PATHS), refused.api);
  assert.equal(refused.judge.calls, 0, 'no judge call when the budget refuses');
  assert.equal(refused.notices.length, 0, 'no notice when the budget refuses');

  const unconfigured = makeApi({ configured: false });
  await rankFiles.handle(globEvent(PATHS), unconfigured.api);
  assert.equal(unconfigured.judge.calls, 0, 'no judge call when the judge is unconfigured');
  assert.equal(unconfigured.notices.length, 0, 'no notice when the judge is unconfigured');
}

// ── 8. Fail-open: an unavailable or unreadable answer ranks nothing ────────
{
  const nothing = makeApi({ judgeNull: true });
  await rankFiles.handle(globEvent(PATHS), nothing.api);
  assert.equal(nothing.judge.calls, 1, 'a null answer means the request was attempted');
  assert.equal(nothing.notices.length, 0, 'a null answer raises no notice');
  assert.equal(nothing.ledger.length, 1, 'a null answer is recorded');
  assert.equal(nothing.ledger[0].decision, 'skipped', 'the record marks the skip');
  assert.equal(nothing.ledger[0].wouldBe, 'none', 'the skip names no next read');

  const broken = makeApi({ judgeThrows: true });
  const out = await rankFiles.handle(globEvent(PATHS), broken.api);
  assert.equal(out, undefined, 'a throwing judge still returns no value');
  assert.equal(broken.notices.length, 0, 'a thrown judge raises no notice');

  const partial = makeApi({ answers: { c0: { type: 'noul', noul: 0.9 }, c1: { type: 'noul', noul: 0.8 } } });
  await rankFiles.handle(globEvent(PATHS), partial.api);
  assert.equal(partial.notices.length, 0, 'a partial answer raises no notice');
  assert.equal(partial.ledger.length, 1, 'a partial answer is recorded');
  assert.equal(partial.ledger[0].decision, 'skipped', 'a partial answer is a failed judgment, not a ranking');
}

// ── 9. Below the threshold: recorded, silent ──────────────────────────────
{
  const { api, notices, ledger } = makeApi({ scores: () => 0.2 });
  await rankFiles.handle(globEvent(PATHS), api);
  assert.equal(notices.length, 0, 'a weak field raises no notice');
  assert.equal(ledger.length, 1, 'a weak field is still recorded');
  assert.equal(ledger[0].decision, 'silent', 'the record marks the silence');
  assert.equal(ledger[0].wouldBe, 'none', 'a silence names no next read');
}

// ── 10. The threshold setting is honored, not the default ─────────────────
{
  const { api, notices, ledger } = makeApi({ config: { threshold: 0.95 } });
  await rankFiles.handle(globEvent(PATHS), api);
  assert.equal(ledger[0].threshold, 0.95, 'the configured threshold is recorded');
  assert.equal(ledger[0].decision, 'silent', '0.93 is below a configured 0.95');
  assert.equal(notices.length, 0, 'a configured higher threshold keeps 0.93 silent');
}

// ── 11. Shadow mode records the would-be next read and raises nothing ─────
{
  const { api, notices, ledger } = makeApi({ shadow: true });
  await rankFiles.handle(globEvent(PATHS), api);
  assert.equal(notices.length, 0, 'shadow raises no notice');
  assert.equal(ledger[0].mode, 'shadow', 'the row is marked shadow');
  assert.equal(ledger[0].decision, 'ranked', 'shadow records the ranking it would have reported');
  assert.equal(ledger[0].wouldBe, 'src/app.js', 'shadow records the path it would have named');
}

// ── 12. The judged set is capped, so a broad glob cannot spend without bound ─
{
  const many = Array.from({ length: 30 }, (_, i) => `src/file-${String(i).padStart(2, '0')}.js`);
  const { api, ledger, judge, notices } = makeApi({ scores: () => 0.8 });
  await rankFiles.handle(globEvent(many), api);
  assert.equal(Object.keys(judge.questions).length, 20, 'the default cap judges at most 20 candidates');
  assert.equal(Object.keys(ledger[0].probabilities).length, 20, 'the record keeps exactly the judged candidates');
  assert.equal(notices.length, 1, 'the capped ranking still reports');
}

// ── 13. The dedupe key is stable for the same ranking ─────────────────────
{
  const first = makeApi();
  const second = makeApi();
  const event = globEvent(PATHS);
  await rankFiles.handle(event, first.api);
  await rankFiles.handle(event, second.api);
  assert.equal(first.notices[0].dedupeKey, second.notices[0].dedupeKey, 'identical rankings yield an identical dedupe key');
}

// ── 14. The text fallback ranks when `value` is absent ────────────────────
{
  const { api, notices, ledger } = makeApi();
  const event = globEvent(PATHS);
  delete event.result.value;
  await rankFiles.handle(event, api);
  assert.equal(ledger.length, 1, 'the model-facing text is a usable candidate source');
  assert.equal(notices.length, 1, 'the text fallback still reports the ranking');
}

console.log('GATE-T16-RANK-OK');
