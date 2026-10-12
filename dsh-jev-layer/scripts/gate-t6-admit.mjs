/**
 * G-T6-1: a fixture result keeps the segments the task needs and drops the ones
 * it does not, and the retention is scattered rather than one contiguous cut.
 *
 * Drives the real `handle()` of the real module with a synthetic `api` built to
 * docs/CONTRACT.md. No network, no dependency on the core package.
 *
 * Run from the repo root: node scripts/gate-t6-admit.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import admitOutput from '../packages/plugin/src/modules/admit-output.js';
import { SEAMS } from '../packages/plugin/src/seams.js';

const MODULE_URL = new URL('../packages/plugin/src/modules/admit-output.js', import.meta.url);

// ── fixture: 8 paragraphs, each its own chunk, ~305 estimated tokens each ────
const SEGMENTS = [];
for (let i = 0; i < 8; i += 1) {
  const lines = [];
  for (let j = 0; j < 10; j += 1) lines.push(`SEG${i} line ${j} ${'x'.repeat(110)}`);
  SEGMENTS.push(lines.join('\n'));
}
const FIXTURE_TEXT = `${SEGMENTS.join('\n\n')}\n`;
const FIXTURE_CONTENT = [
  { type: 'text', text: FIXTURE_TEXT },
  { type: 'image', mimeType: 'image/png', data: 'AAAA' },
];

/** One probability per segment: the task needs SEG0, SEG2 and SEG5. */
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
  exec: { name: 'read', callId: 'call-t6-1', arguments: { path: '/src/retry.js' } },
  result: { isError: false, value: { bytes: 9812 }, content: FIXTURE_CONTENT },
};

/** A synthetic module context matching docs/CONTRACT.md. */
function makeApi(options = {}) {
  const ledger = [];
  const calls = { ask: [], acquire: [] };
  const config = { enabled: true, ...(options.config ?? {}) };
  const api = {
    id: 'admit.output',
    config: { get: (key) => config[key] },
    judge: {
      configured: options.configured ?? true,
      ask: async (state, questions, opts) => {
        calls.ask.push({ state, questions, opts });
        return options.answers === undefined ? ANSWERS : options.answers;
      },
    },
    budget: {
      tryAcquire: (featureId, units) => {
        calls.acquire.push({ featureId, units });
        return options.acquire === undefined ? true : options.acquire;
      },
    },
    ledger: { append: (entry) => ledger.push(entry) },
    shadow: { isShadow: () => options.shadow ?? false },
    notice: { request: () => 'accepted' },
    notifications: { send: async () => 'sent' },
    log: { warn: () => {} },
    registerAgent: () => () => {},
    seams: SEAMS,
  };
  return { api, ledger, calls };
}

// ── the module descriptor ───────────────────────────────────────────────────
assert.equal(admitOutput.id, 'admit.output', 'module id is the stable config/ledger/shadow key');
assert.equal(admitOutput.seam, SEAMS.TOOLS_POST_EXECUTE, 'module owns the post-execute seam');
assert.equal(typeof admitOutput.handle, 'function', 'the registry calls handle(event, api)');
assert.equal(admitOutput.settings.minTokens.default, 2000, 'the default token threshold is 2000');

// ── absence check: the module must not register its own listener ────────────
// Positive control first: the detector does fire on the thing whose absence is
// asserted.
const CTX_ON = /ctx\s*\.\s*on\s*\(/;
assert.ok(CTX_ON.test('export function apply(ctx) { ctx.on("tools/post-execute", fn); }'), 'positive control: the ctx.on detector fires when ctx.on is present');
const source = readFileSync(MODULE_URL, 'utf8');
assert.ok(!CTX_ON.test(source), 'admit.output must not call ctx.on; the registry owns the listener');

// ── the positive path: an oversized, prunable result is pruned ──────────────
{
  const { api, ledger, calls } = makeApi();
  const out = await admitOutput.handle(EVENT, api);

  assert.notEqual(out, undefined, 'an oversized result must be transformed');
  assert.equal(out.isError, false, 'the outcome stays a success');
  assert.deepEqual(out.value, { bytes: 9812 }, 'the canonical value is untouched');
  assert.notEqual(out.content, FIXTURE_CONTENT, 'the content array is replaced, not mutated');

  const text = out.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
  const kept = (i) => text.includes(`SEG${i} `);
  const dropped = (i) => !text.includes(`SEG${i} `);

  // The segments the task needs survived.
  for (const i of [0, 2, 5]) assert.ok(kept(i), `segment ${i} is relevant and must be kept`);
  // The segments it does not need were dropped.
  for (const i of [3, 4]) assert.ok(dropped(i), `segment ${i} is irrelevant and must be dropped`);
  // The deterministic floors hold: the head and the tail survive.
  for (const i of [1, 6, 7]) assert.ok(kept(i), `segment ${i} is a head/tail floor and must be kept`);

  // Scattered, not one contiguous cut: a dropped segment lies between two kept
  // ones, so no prefix/suffix rule could have produced this.
  assert.ok(kept(2) && dropped(3) && dropped(4) && kept(5), 'retention is scattered across the payload, not one contiguous cut');
  assert.ok(text.includes('omitted'), 'the dropped segments are marked where they were');

  // Non-text blocks are carried through untouched.
  assert.ok(out.content.some((block) => block.type === 'image'), 'an image block survives the rewrite');

  // The judgment went through the injected judge with the fail-open contract.
  assert.equal(calls.ask.length, 1, 'exactly one judge request');
  assert.equal(calls.ask[0].opts.featureId, 'admit.output', 'the request names its feature');
  assert.equal(calls.ask[0].opts.failOpen, 'keep-everything', 'the fail-open meaning is pruning-specific');
  assert.equal(Object.keys(calls.ask[0].questions).length, 8, 'one question per segment');
  assert.equal(calls.ask[0].questions.s0.type, 'noul', 'the question type is typed');
  assert.ok(calls.ask[0].state.segments.s5.includes('SEG5 '), 'the segment text is what is judged');

  // The budget was asked before the call.
  assert.deepEqual(calls.acquire, [{ featureId: 'admit.output', units: 1 }], 'the budget is asked once, before the judge');

  // The decision is in the ledger, with the numbers behind it.
  assert.equal(ledger.length, 1, 'one decision recorded');
  const [entry] = ledger;
  assert.equal(entry.featureId, 'admit.output');
  assert.equal(entry.callId, 'call-t6-1');
  assert.equal(entry.decision, 'prune');
  assert.equal(entry.mode, 'enforce');
  assert.equal(entry.threshold, 0.5);
  assert.equal(entry.probabilities.length, 8, 'every probability is recorded');
  assert.equal(entry.probabilities[5], 0.88);
  assert.equal(typeof entry.at, 'number');
}

// ── absence check: a tool outside the allowlist is never touched ────────────
{
  const { api, calls } = makeApi();
  const out = await admitOutput.handle({ ...EVENT, exec: { ...EVENT.exec, name: 'bash' } }, api);
  assert.equal(out, undefined, 'bash output is not pruned');
  assert.equal(calls.ask.length, 0, 'a tool outside the allowlist costs no judge request');
}

// ── absence check: a result below the threshold is never touched ────────────
{
  const { api, calls } = makeApi();
  const small = { type: 'text', text: `SEG0 short ${'x'.repeat(80)}` };
  const out = await admitOutput.handle({ ...EVENT, result: { ...EVENT.result, content: [small] } }, api);
  assert.equal(out, undefined, 'a result under 2000 tokens is left alone');
  assert.equal(calls.ask.length, 0, 'an undersized result costs no judge request');
}

// ── absence check: a single-chunk payload spends no budget ─────────────────
// Reachable whenever minTokens is set below one chunk: the payload is over the
// threshold but resolves to a single chunk, so no request is ever sent.
{
  const { api, ledger, calls } = makeApi({ config: { minTokens: 10 } });
  const single = { type: 'text', text: `SEG0 one paragraph ${'x'.repeat(120)}` };
  const out = await admitOutput.handle({ ...EVENT, result: { ...EVENT.result, content: [single] } }, api);
  assert.equal(out, undefined, 'a payload that is one chunk is left alone');
  assert.equal(calls.acquire.length, 0, 'a payload that is never sent must not spend a budget unit');
  assert.equal(calls.ask.length, 0, 'a payload that is one chunk costs no request');
  assert.equal(ledger.length, 0, 'nothing was decided, so nothing is recorded');
}

// ── shadow mode records the would-be decision and changes nothing ───────────
{
  const { api, ledger } = makeApi({ shadow: true });
  const out = await admitOutput.handle(EVENT, api);
  assert.equal(out, undefined, 'shadow mode returns the result unchanged');
  assert.equal(ledger.length, 1, 'shadow mode still records the decision');
  assert.equal(ledger[0].mode, 'shadow');
  assert.equal(ledger[0].wouldBe, 'prune');
  assert.equal(ledger[0].decision, 'shadow');
}

// ── a refused budget keeps everything and costs no request ─────────────────
{
  const { api, ledger, calls } = makeApi({ acquire: false });
  const out = await admitOutput.handle(EVENT, api);
  assert.equal(out, undefined, 'a refused budget returns the result unchanged');
  assert.equal(calls.ask.length, 0, 'a refused budget must not pay for a judgment');
  assert.equal(ledger.length, 0, 'nothing was decided, so nothing is recorded');
}

// ── handle accepts the exec-shaped event the contract leaves ambiguous ──────
{
  const { api } = makeApi();
  const flattened = { ...EVENT.exec, result: EVENT.result };
  const out = await admitOutput.handle(flattened, api);
  assert.notEqual(out, undefined, 'an exec-shaped event carrying result is handled the same way');
  assert.ok(!out.content[0].text.includes('SEG3 '), 'the same segments are dropped');
}

// ── the registry's real convention: handle(exec, api, next) ────────────────
// The registry's dispatch pops the waterfall `next` and passes only `args[0]`
// (the exec) as the event, so a module that cannot reach the result through
// `next()` would silently never prune anything.
{
  const { api, ledger } = makeApi();
  let nextCalls = 0;
  const next = async () => {
    nextCalls += 1;
    return { kind: 'accept', content: FIXTURE_CONTENT };
  };
  const out = await admitOutput.handle(EVENT.exec, api, next);

  assert.equal(nextCalls, 1, 'the module took the downstream decision exactly once');
  assert.equal(out?.kind, 'accept', 'the module answers the waterfall with a decision');
  assert.ok(Array.isArray(out.content), 'the decision carries content');
  const text = out.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
  assert.ok(text.includes('SEG2 ') && text.includes('SEG5 '), 'the relevant segments survived');
  assert.ok(!text.includes('SEG3 ') && !text.includes('SEG4 '), 'the irrelevant segments were dropped');
  assert.ok(out.content.some((block) => block.type === 'image'), 'non-text blocks carried through the decision');
  assert.equal(ledger.length, 1, 'the decision is recorded in this shape too');
  assert.equal(ledger[0].mode, 'enforce');
}

// ── a block from downstream is passed straight through ────────────────────
{
  const { api, calls } = makeApi();
  const blocked = { kind: 'block', feedback: [{ type: 'text', text: 'denied' }] };
  const out = await admitOutput.handle(EVENT.exec, api, async () => blocked);
  assert.equal(out, blocked, 'a blocked call is returned untouched, not rewritten');
  assert.equal(calls.ask.length, 0, 'a blocked call costs no judge request');
}

console.log('GATE-T6-ADMIT-OK');
