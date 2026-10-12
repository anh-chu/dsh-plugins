/**
 * G-T2-1 — the judge client requests the configured endpoint and returns null on
 * every failure path without throwing, and all calls serialize through one
 * limiter that honours `Retry-After`.
 *
 * Run from the repo root: node scripts/gate-t2-client.mjs
 */
import assert from 'node:assert/strict';
import { createCore } from '../packages/core/src/index.js';

const ENDPOINT = 'https://judge.invalid/v1/systemone';
const QUESTIONS = { q1: { type: 'noul', instructions: 'Is this relevant?' } };

/** A settings reader over a plain map. */
const settingsFor = (values) => ({ get: (key) => values[key] });

/** A minimal Response stand-in. */
const response = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
  json: async () => body,
});

const OK_BODY = { model: 'jev-1.13-free', answers: { q1: { type: 'noul', noul: 0.82 } } };

/** A fetch stub that records calls and answers from a script. */
function stubFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init, calls.length);
  };
  impl.calls = calls;
  return impl;
}

/** Assert the client returned null and set exactly this typed error kind. */
async function expectFailure(core, questions, opts, kind) {
  let answers;
  await assert.doesNotReject(async () => {
    answers = await core.judge.ask('state', questions, opts);
  }, 'judge.ask must never throw');
  assert.equal(answers, null, `ask must return null on ${kind}`);
  assert.equal(core.judge.lastError?.kind, kind);
}

// --- the configured call: endpoint, credential and body ----------------------

const good = stubFetch(() => response(200, OK_BODY));
const configured = createCore({
  settings: settingsFor({ endpoint: ENDPOINT, apiKey: 'secret', model: 'jev-1.13-free' }),
  fetchImpl: good,
  now: () => 1_000,
});
assert.equal(configured.judge.configured, true);
const answers = await configured.judge.ask({ text: 'payload' }, QUESTIONS, { featureId: 'admit.output' });
assert.deepEqual(answers, OK_BODY.answers);
assert.equal(configured.judge.lastError, null);
assert.equal(good.calls.length, 1);
assert.equal(good.calls[0].url, ENDPOINT, 'the request must go to the configured endpoint');
assert.equal(good.calls[0].init.headers.authorization, 'Bearer secret');
const sent = JSON.parse(good.calls[0].init.body);
assert.equal(sent.model, 'jev-1.13-free', 'the model must come from settings');
assert.deepEqual(sent.state, { text: 'payload' });
assert.deepEqual(sent.questions, QUESTIONS);

// --- absence of a request when unconfigured, with its positive control -------

const empty = stubFetch(() => response(200, OK_BODY));
const unconfigured = createCore({ settings: settingsFor({ endpoint: ENDPOINT }), fetchImpl: empty, now: () => 1 });
assert.equal(unconfigured.judge.configured, false);
await expectFailure(unconfigured, QUESTIONS, {}, 'unconfigured');
assert.equal(empty.calls.length, 0, 'an unconfigured judge must not touch the network');
// Positive control: the detector fires on the configured case above.
assert.equal(good.calls.length, 1, 'a configured judge must make a request');

// --- every failure path ------------------------------------------------------

await expectFailure(
  createCore({ settings: settingsFor({ endpoint: ENDPOINT, apiKey: 'k' }), fetchImpl: stubFetch(() => response(401, {})), now: () => 1 }),
  QUESTIONS,
  {},
  'http',
);

const unauthorized = createCore({ settings: settingsFor({ endpoint: ENDPOINT, apiKey: 'k' }), fetchImpl: stubFetch(() => response(401, {})), now: () => 1 });
assert.equal(await unauthorized.judge.ask('s', QUESTIONS, { featureId: 'screen.fetch', failOpen: 'clean' }), null);
assert.equal(unauthorized.judge.lastError.status, 401);
assert.equal(unauthorized.judge.lastError.featureId, 'screen.fetch');
assert.equal(unauthorized.judge.lastError.failOpen, 'clean');
assert.equal(configured.judge.lastError, null, 'lastError stays null after a success');

await expectFailure(
  createCore({ settings: settingsFor({ endpoint: ENDPOINT, apiKey: 'k' }), fetchImpl: stubFetch(() => response(200, { model: 'x' })), now: () => 1 }),
  QUESTIONS,
  {},
  'malformed-response',
);
await expectFailure(
  createCore({ settings: settingsFor({ endpoint: ENDPOINT, apiKey: 'k' }), fetchImpl: stubFetch(() => response(200, {})), now: () => 1 }),
  {},
  {},
  'invalid-request',
);
await expectFailure(
  createCore({ settings: settingsFor({ endpoint: ENDPOINT, apiKey: 'k' }), fetchImpl: async () => { throw new TypeError('fetch failed'); }, now: () => 1 }),
  QUESTIONS,
  {},
  'network',
);
await expectFailure(
  createCore({
    settings: settingsFor({ endpoint: ENDPOINT, apiKey: 'k' }),
    fetchImpl: async () => {
      const error = new Error('timeout');
      error.name = 'TimeoutError';
      throw error;
    },
    now: () => 1,
  }),
  QUESTIONS,
  { timeoutMs: 1 },
  'timeout',
);
await expectFailure(
  createCore({
    settings: settingsFor({ endpoint: ENDPOINT, apiKey: 'k' }),
    fetchImpl: async (url, init) => {
      assert.equal(typeof init.signal?.aborted, 'boolean', 'every attempt carries an abort signal');
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    },
    now: () => 1,
  }),
  QUESTIONS,
  {},
  'aborted',
);
await expectFailure(
  createCore({ settings: settingsFor({ endpoint: ENDPOINT, apiKey: 'k' }), fetchImpl: stubFetch(() => response(529, {})), now: () => 1, sleep: async () => {} }),
  QUESTIONS,
  {},
  'rate-limited',
);

// --- Retry-After, honoured -----------------------------------------------

const waits = [];
let attempt = 0;
const flaky = stubFetch(() => {
  attempt += 1;
  return attempt <= 2
    ? response(429, {}, { 'retry-after': attempt === 1 ? '2' : '1' })
    : response(200, OK_BODY);
});
const retrying = createCore({
  settings: settingsFor({ endpoint: ENDPOINT, apiKey: 'k' }),
  fetchImpl: flaky,
  now: () => 1,
  sleep: async (ms) => {
    waits.push(ms);
  },
});
assert.deepEqual(await retrying.judge.ask('s', QUESTIONS), OK_BODY.answers);
assert.deepEqual(waits, [2_000, 1_000], 'the backoff must honour Retry-After');
assert.equal(flaky.calls.length, 3);

// --- one shared lane -----------------------------------------------------

let inFlight = 0;
let peak = 0;
const serial = createCore({
  settings: settingsFor({ endpoint: ENDPOINT, apiKey: 'k' }),
  now: () => 1,
  sleep: async () => {},
  fetchImpl: async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return response(200, OK_BODY);
  },
});
await Promise.all([
  serial.judge.ask('a', QUESTIONS),
  serial.judge.ask('b', QUESTIONS),
  serial.judge.ask('c', QUESTIONS),
]);
assert.equal(peak, 1, 'judge calls must serialize through one limiter');

console.log('GATE-T2-CLIENT-OK');
