/**
 * The judge client and the shared limiter.
 *
 * Every failure path is exercised with a stub transport, so the suite needs no
 * network and no host.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createCore } from '../src/index.js';

/** A settings reader over a mutable map. */
function settingsFor(values) {
  return { get: (key) => values[key] };
}

/** A configured settings map. */
function configured(extra = {}) {
  return settingsFor({
    endpoint: 'https://example.invalid/v1/systemone',
    apiKey: 'k',
    ...extra,
  });
}

/** A fetch stub that answers once and counts calls. */
function stubFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init, calls.length);
  };
  impl.calls = calls;
  return impl;
}

/** A minimal Response stand-in. */
function response(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    json: async () => body,
  };
}

const QUESTIONS = { q1: { type: 'noul', instructions: 'Is this relevant?' } };

test('unconfigured judge reports rather than throws, and never calls fetch', async () => {
  const fetchImpl = stubFetch(() => response(200, { answers: {} }));
  const core = createCore({ settings: settingsFor({}), fetchImpl, now: () => 5 });
  assert.equal(core.judge.configured, false);
  assert.equal(await core.judge.ask('state', QUESTIONS), null);
  assert.equal(core.judge.lastError.kind, 'unconfigured');
  assert.equal(fetchImpl.calls.length, 0);
});

test('a configured judge posts to the configured endpoint and returns the answers', async () => {
  const fetchImpl = stubFetch(() => response(200, { model: 'jev-1', answers: { q1: { type: 'noul', noul: 0.9 } } }));
  const core = createCore({ settings: configured({ model: 'jev-x' }), fetchImpl, now: () => 5 });
  assert.equal(core.judge.configured, true);
  const answers = await core.judge.ask({ text: 'body' }, QUESTIONS, { featureId: 'admit.output' });
  assert.deepEqual(answers, { q1: { type: 'noul', noul: 0.9 } });
  assert.equal(core.judge.lastError, null);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, 'https://example.invalid/v1/systemone');
  assert.equal(fetchImpl.calls[0].init.headers.authorization, 'Bearer k');
  assert.equal(JSON.parse(fetchImpl.calls[0].init.body).model, 'jev-x');
});

test('every HTTP failure returns null with a typed lastError', async () => {
  const core = createCore({
    settings: configured(),
    fetchImpl: stubFetch(() => response(401, {})),
    now: () => 7,
  });
  assert.equal(await core.judge.ask('s', QUESTIONS, { featureId: 'screen.fetch', failOpen: 'clean' }), null);
  assert.equal(core.judge.lastError.kind, 'http');
  assert.equal(core.judge.lastError.status, 401);
  assert.equal(core.judge.lastError.featureId, 'screen.fetch');
  assert.equal(core.judge.lastError.failOpen, 'clean');
});

test('an unreadable body is malformed-response, and empty questions never leave the machine', async () => {
  const bad = createCore({
    settings: configured(),
    fetchImpl: stubFetch(() => response(200, { model: 'jev-1' })),
    now: () => 7,
  });
  assert.equal(await bad.judge.ask('s', QUESTIONS), null);
  assert.equal(bad.judge.lastError.kind, 'malformed-response');

  const empty = createCore({
    settings: configured(),
    fetchImpl: stubFetch(() => response(200, { answers: {} })),
    now: () => 7,
  });
  assert.equal(await empty.judge.ask('s', {}), null);
  assert.equal(empty.judge.lastError.kind, 'invalid-request');
});

test('a transport throw and a timeout are distinguishable, and neither escapes', async () => {
  const thrown = createCore({
    settings: configured(),
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
    now: () => 7,
  });
  assert.equal(await thrown.judge.ask('s', QUESTIONS), null);
  assert.equal(thrown.judge.lastError.kind, 'network');

  const timedOut = createCore({
    settings: configured(),
    fetchImpl: async () => {
      const error = new Error('The operation was aborted due to timeout');
      error.name = 'TimeoutError';
      throw error;
    },
    now: () => 7,
  });
  assert.equal(await timedOut.judge.ask('s', QUESTIONS, { timeoutMs: 1 }), null);
  assert.equal(timedOut.judge.lastError.kind, 'timeout');
});

test('the limiter retries 429 honouring Retry-After, then returns the success', async () => {
  const waits = [];
  let attempt = 0;
  const fetchImpl = stubFetch(() => {
    attempt += 1;
    return attempt === 1 ? response(429, {}, { 'retry-after': '2' }) : response(200, { answers: { q1: { type: 'noul', noul: 0.4 } } });
  });
  const core = createCore({
    settings: configured(),
    fetchImpl,
    now: () => 5,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  const answers = await core.judge.ask('s', QUESTIONS);
  assert.deepEqual(answers, { q1: { type: 'noul', noul: 0.4 } });
  assert.deepEqual(waits, [2000]);
  assert.equal(fetchImpl.calls.length, 2);
});

test('429 past the retry limit becomes rate-limited, not http', async () => {
  const core = createCore({
    settings: configured(),
    fetchImpl: stubFetch(() => response(529, {})),
    now: () => 5,
    sleep: async () => {},
  });
  assert.equal(await core.judge.ask('s', QUESTIONS), null);
  assert.equal(core.judge.lastError.kind, 'rate-limited');
  assert.equal(core.judge.lastError.status, 529);
});

test('all calls serialize through one lane', async () => {
  let inFlight = 0;
  let peak = 0;
  const fetchImpl = async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return response(200, { answers: { q1: { type: 'noul', noul: 1 } } });
  };
  const core = createCore({ settings: configured(), fetchImpl, now: () => 5, sleep: async () => {} });
  await Promise.all([core.judge.ask('a', QUESTIONS), core.judge.ask('b', QUESTIONS), core.judge.ask('c', QUESTIONS)]);
  assert.equal(peak, 1);
});
