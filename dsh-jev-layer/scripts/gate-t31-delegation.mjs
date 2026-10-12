/**
 * G-T31-1: a refusal from the harness's own continuation reaches the harness unchanged.
 *
 * `answer.questions` owns `user-questions/request` and delegates by calling `next`. On a
 * headless host nothing mounts a human answerer, so the harness's continuation REJECTS
 * with "no user-questions answerer accepted the request". The registry caught that
 * rejection as if the module had thrown, warned, and returned `undefined`. A waterfall
 * that resolves `undefined` reads as an answer, so the model saw
 * "Cannot read properties of undefined (reading 'answers')" instead of the harness's own
 * error. Gates passed because every continuation they supplied resolved.
 *
 * This drives the REAL registry through the listener the harness calls, with a
 * continuation that rejects, resolves, or is slow, and with a module that returns
 * nothing, delegates, or throws.
 *
 * Run: node scripts/gate-t31-delegation.mjs
 */
import assert from 'node:assert/strict';

import { createCore } from '../packages/core/src/index.js';
import { createRegistry } from '../packages/plugin/src/registry.js';
import { SEAMS } from '../packages/plugin/src/seams.js';

const SEAM = SEAMS.USER_QUESTIONS_REQUEST;

function fakeCtx() {
  const listeners = new Map();
  return {
    listeners,
    on(seam, fn) { listeners.set(seam, fn); return () => listeners.delete(seam); },
    get: () => undefined,
    inject: () => () => {},
    effect: (fn) => { fn(); return () => {}; },
    logger: { warn() {}, info() {} },
  };
}

/** An exclusive-seam module whose behaviour the test chooses. */
function module(behaviour) {
  return {
    id: 'answer.questions',
    seam: SEAM,
    seamClass: 'exclusive',
    settings: {},
    handle: behaviour,
  };
}

async function listenerFor(behaviour) {
  const ctx = fakeCtx();
  const core = createCore({ settings: { get: () => undefined }, now: () => 1 });
  const registry = createRegistry({
    modules: [module(behaviour)],
    ctx,
    config: { 'answer.questions': { enabled: { get: () => true } } },
    core,
  });
  await registry.start();
  return { listener: ctx.listeners.get(SEAM), registry };
}

const REFUSAL = new Error('no user-questions answerer accepted the request');

// ── a module that delegates, and the harness refuses ────────────────────────
{
  let calls = 0;
  const { listener, registry } = await listenerFor(async (_event, _api, next) => next());
  await assert.rejects(
    () => listener({ questions: [] }, () => { calls += 1; return Promise.reject(REFUSAL); }),
    (error) => error === REFUSAL,
    'the harness\'s own rejection reaches the harness, the very same error',
  );
  assert.equal(calls, 1, 'and the continuation ran exactly once');
  await registry.stop();
}

// ── a module that returns nothing: the registry delegates for it, same rule ──
{
  let calls = 0;
  const { listener, registry } = await listenerFor(async () => undefined);
  await assert.rejects(
    () => listener({ questions: [] }, () => { calls += 1; return Promise.reject(REFUSAL); }),
    (error) => error === REFUSAL,
    'a module that returns nothing still lets the harness\'s rejection through',
  );
  assert.equal(calls, 1, 'the continuation ran once on that path too');
  await registry.stop();
}

// ── a module that throws before delegating: fail open to the harness path ───
{
  let calls = 0;
  const { listener, registry } = await listenerFor(async () => { throw new Error('module bug'); });
  const answer = await listener({ questions: [] }, () => { calls += 1; return { answers: [{ id: 'q', selected: ['a'] }] }; });
  assert.deepEqual(answer, { answers: [{ id: 'q', selected: ['a'] }] }, 'a throwing module fails open to the human path');
  assert.equal(calls, 1, 'and the continuation ran once');

  const refusing = await listenerFor(async () => { throw new Error('module bug'); });
  await assert.rejects(
    () => refusing.listener({ questions: [] }, () => Promise.reject(REFUSAL)),
    (error) => error === REFUSAL,
    'a throwing module whose fail-open path is then refused still surfaces the harness\'s error',
  );
  await refusing.registry.stop();
  await registry.stop();
}

// ── controls: what must not change ──────────────────────────────────────────
{
  // A module that answers claims the request and never calls next.
  let calls = 0;
  const { listener, registry } = await listenerFor(async () => ({ answers: [{ id: 'q', selected: ['x'] }] }));
  const answer = await listener({ questions: [] }, () => { calls += 1; return Promise.reject(REFUSAL); });
  assert.deepEqual(answer, { answers: [{ id: 'q', selected: ['x'] }] }, 'control: an answered batch is returned');
  assert.equal(calls, 0, 'control: an answered batch never reaches the continuation');
  await registry.stop();
}
{
  // A delegation the human answers returns the human's answer.
  const { listener, registry } = await listenerFor(async (_event, _api, next) => next());
  const human = { answers: [{ id: 'q', selected: ['human'] }] };
  const answer = await listener({ questions: [] }, async () => human);
  assert.equal(answer, human, 'control: the human\'s answer is returned untouched');
  await registry.stop();
}

console.log('GATE-T31-DELEGATION-OK');
