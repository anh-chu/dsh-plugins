/**
 * G-T6-2: with the judge unavailable the result is unchanged.
 *
 * Every path that cannot produce a trustworthy selection must return the result
 * untouched. Pruning is an optimisation; it must never be why a task failed.
 *
 * The gate opens with a positive control: the same fixture, driven through the
 * same `handle()`, IS pruned when the judge answers. Without it, "unchanged"
 * would also be satisfied by a module that never prunes anything at all.
 *
 * Run from the repo root: node scripts/gate-t6-failopen.mjs
 */
import assert from 'node:assert/strict';
import admitOutput from '../packages/plugin/src/modules/admit-output.js';
import { SEAMS } from '../packages/plugin/src/seams.js';

// ── fixture: 8 paragraphs, each its own chunk, ~305 estimated tokens each ────
const SEGMENTS = [];
for (let i = 0; i < 8; i += 1) {
  const lines = [];
  for (let j = 0; j < 10; j += 1) lines.push(`SEG${i} line ${j} ${'x'.repeat(110)}`);
  SEGMENTS.push(lines.join('\n'));
}
const FIXTURE_TEXT = `${SEGMENTS.join('\n\n')}\n`;
const FIXTURE_CONTENT = [{ type: 'text', text: FIXTURE_TEXT }];

/** The task needs SEG0, SEG2 and SEG5; SEG3 and SEG4 are noise. */
const ANSWERS = {
  s0: { type: 'noul', noul: 0.9 },
  s1: { type: 'noul', noul: 0.1 },
  s2: { type: 'noul', noul: 0.91 },
  s3: { type: 'noul', noul: 0.05 },
  s4: { type: 'noul', noul: 0.05 },
  s5: { type: 'noul', noul: 0.88 },
  s6: { type: 'noul', noul: 0.1 },
  s7: { type: 'noul', noul: 0.1 },
};

const EVENT = {
  exec: { name: 'read', callId: 'call-t6-2', arguments: { path: '/src/retry.js' } },
  result: { isError: false, value: { bytes: 9812 }, content: FIXTURE_CONTENT },
};

/** A synthetic module context matching docs/CONTRACT.md. */
function makeApi(options = {}) {
  const ledger = [];
  const calls = { ask: 0 };
  const config = { enabled: true, ...(options.config ?? {}) };
  const api = {
    id: 'admit.output',
    config: { get: (key) => config[key] },
    judge: {
      configured: options.configured ?? true,
      ask: async () => {
        calls.ask += 1;
        if (options.throws) throw new Error('judge transport failed');
        if ('answers' in options) return options.answers;
        return ANSWERS;
      },
    },
    budget: {
      tryAcquire: () => {
        if (options.budgetThrows) throw new Error('budget unavailable');
        return options.acquire === undefined ? true : options.acquire;
      },
    },
    ledger: { append: (entry) => ledger.push(entry) },
    shadow: { isShadow: () => false },
    notice: { request: () => 'accepted' },
    notifications: { send: async () => 'sent' },
    log: { warn: () => {} },
    registerAgent: () => () => {},
    seams: SEAMS,
  };
  return { api, ledger, calls };
}

/** Drive handle and assert the caller keeps exactly the original result. */
async function assertUnchanged(label, api, event = EVENT) {
  const before = structuredClone(event.result);
  const out = await admitOutput.handle(event, api);
  assert.equal(out, undefined, `${label}: the module returned no replacement`);
  assert.deepEqual(event.result, before, `${label}: the input result was not mutated`);
  assert.equal(event.result.content[0].text, FIXTURE_TEXT, `${label}: every segment is still there`);
  for (let i = 0; i < 8; i += 1) {
    assert.ok(event.result.content[0].text.includes(`SEG${i} `), `${label}: segment ${i} survived`);
  }
}

// ── positive control: the detector is honest, the same fixture does prune ───
{
  const { api, ledger, calls } = makeApi();
  const out = await admitOutput.handle(EVENT, api);
  assert.notEqual(out, undefined, 'positive control: a judge that answers does prune this fixture');
  const text = out.content[0].text;
  assert.ok(!text.includes('SEG3 ') && !text.includes('SEG4 '), 'positive control: the irrelevant segments were dropped');
  assert.ok(text.includes('SEG2 ') && text.includes('SEG5 '), 'positive control: the relevant segments were kept');
  assert.equal(calls.ask, 1, 'positive control: one judge request went out');
  assert.equal(ledger.length, 1, 'positive control: the decision was recorded');
}

// ── fail-open path 1: the judge returns null (unavailable) ─────────────────
{
  const { api } = makeApi({ answers: null });
  await assertUnchanged('judge returns null', api);
}

// ── fail-open path 2: the judge throws ─────────────────────────────────────
{
  const { api } = makeApi({ throws: true });
  await assertUnchanged('judge throws', api);
}

// ── fail-open path 3: no judge is configured, so nothing is asked ──────────
{
  const { api, calls } = makeApi({ configured: false });
  await assertUnchanged('judge unconfigured', api);
  assert.equal(calls.ask, 0, 'an unconfigured judge costs no request');
}

// ── fail-open path 4: an unreadable answer is a failure, not a zero ────────
{
  const missing = { ...ANSWERS };
  delete missing.s3;
  const { api } = makeApi({ answers: missing });
  await assertUnchanged('a missing answer', api);
}
{
  const wrongType = { ...ANSWERS, s4: { type: 'noul', noul: 'very relevant' } };
  const { api } = makeApi({ answers: wrongType });
  await assertUnchanged('a wrongly-typed answer', api);
}
{
  const { api } = makeApi({ answers: 'not an answer map' });
  await assertUnchanged('a non-object answer map', api);
}

// ── fail-open path 5: the budget refuses ───────────────────────────────────
{
  const { api, calls } = makeApi({ acquire: false });
  await assertUnchanged('budget refuses', api);
  assert.equal(calls.ask, 0, 'a refused budget costs no request');
}

// ── fail-open path 6: an unexpected throw anywhere is contained ────────────
{
  const { api } = makeApi({ budgetThrows: true });
  await assertUnchanged('the budget throws', api);
}

// ── the registry's real convention fails open by handing back downstream ───
// The registry pops the waterfall `next` and passes only the exec as the event,
// so the unchanged answer in that shape must be the downstream decision itself.
for (const [label, options] of [
  ['registry shape, judge returns null', { answers: null }],
  ['registry shape, judge throws', { throws: true }],
  ['registry shape, budget refuses', { acquire: false }],
]) {
  const { api, calls } = makeApi(options);
  let nextCalls = 0;
  const downstream = { kind: 'accept', content: FIXTURE_CONTENT, additionalContexts: [{ text: 'keep' }] };
  const out = await admitOutput.handle(EVENT.exec, api, async () => {
    nextCalls += 1;
    return downstream;
  });
  assert.equal(nextCalls, 1, `${label}: the downstream decision was taken once`);
  assert.equal(out, downstream, `${label}: the downstream decision is handed back unchanged`);
  assert.equal(out.content[0].text, FIXTURE_TEXT, `${label}: every segment is still there`);
  assert.equal(out.additionalContexts.length, 1, `${label}: nothing else was dropped either`);
  if (options.acquire === false) assert.equal(calls.ask, 0, `${label}: no request was paid for`);
}

// ── the registry's own promise: a throw never leaves the hook unanswered ───
{
  const { api } = makeApi({ budgetThrows: true });
  const downstream = { kind: 'accept', content: FIXTURE_CONTENT };
  const out = await admitOutput.handle(EVENT.exec, api, async () => downstream);
  assert.equal(out, downstream, 'an unexpected throw still hands the downstream decision back');
}

// ── an errored tool result is never rewritten ──────────────────────────────
{
  const { api } = makeApi();
  const errored = structuredClone(EVENT);
  errored.result.isError = true;
  const out = await admitOutput.handle(errored, api);
  assert.equal(out, undefined, 'an errored result is left alone');
}

console.log('GATE-T6-FAILOPEN-OK');
