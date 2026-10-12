/**
 * The ledger: the contract's record shape, reads by feature and call, and a
 * rebuild that derives its decisions from the event list rather than from the
 * store it replaces.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createCore } from '../src/index.js';

const RECORD_KEYS = ['featureId', 'callId', 'question', 'probabilities', 'threshold', 'decision', 'wouldBe', 'reason', 'mode', 'at'];

/** Build a core with a fixed clock. */
function coreWith(values = {}) {
  return createCore({ settings: { get: (key) => values[key] }, now: () => 1_700_000_000_000 });
}

test('a record has exactly the contract shape, and the clock fills `at`', () => {
  const core = coreWith();
  const record = core.ledger.append({
    featureId: 'admit.output',
    callId: 'c1',
    question: { type: 'noul', instructions: 'keep?' },
    probabilities: { q1: 0.82 },
    threshold: 0.5,
    decision: 'accept',
    wouldBe: 'prune 12 of 40 segments',
    reason: 'the recipient is not a live agent',
    extra: 'dropped',
  });
  assert.deepEqual(Object.keys(record), RECORD_KEYS);
  assert.equal(record.featureId, 'admit.output');
  assert.equal(record.at, 1_700_000_000_000);
  assert.equal(record.probabilities.q1, 0.82);
  assert.equal(record.threshold, 0.5);
  assert.equal(record.decision, 'accept');
  assert.equal(record.wouldBe, 'prune 12 of 40 segments');
  assert.equal(record.reason, 'the recipient is not a live agent', 'a stated reason travels');
  assert.equal(record.extra, undefined);
});

test('a record without a reason says null rather than dropping the key', () => {
  const core = coreWith();
  assert.equal(core.ledger.append({ featureId: 'a', decision: 'accept' }).reason, null);
});

test('a decision is derived from the probabilities when the caller leaves it out', () => {
  const core = coreWith();
  assert.equal(core.ledger.append({ featureId: 'a', probabilities: { q: 0.9 }, threshold: 0.5 }).decision, 'accept');
  assert.equal(core.ledger.append({ featureId: 'a', probabilities: { q: 0.1 }, threshold: 0.5 }).decision, 'reject');
  assert.equal(core.ledger.append({ featureId: 'a' }).decision, null);
});

test('read filters by feature and by call', () => {
  const core = coreWith();
  core.ledger.append({ featureId: 'a', callId: 'c1', decision: 'x' });
  core.ledger.append({ featureId: 'a', callId: 'c2', decision: 'y' });
  core.ledger.append({ featureId: 'b', callId: 'c1', decision: 'z' });
  assert.equal(core.ledger.read('a').length, 2);
  assert.deepEqual(core.ledger.read('a', 'c2').map((r) => r.decision), ['y']);
  assert.equal(core.ledger.read('b').length, 1);
  assert.equal(core.ledger.read('a', 'nope').length, 0);
});

test('the records round-trip through the event list, and the rebuild reads the events', () => {
  const core = coreWith();
  core.ledger.append({ featureId: 'a', callId: 'c1', probabilities: { q: 0.9 }, threshold: 0.5, decision: 'accept' });
  core.ledger.append({ featureId: 'b', callId: 'c2', probabilities: { q: 0.2 }, threshold: 0.5, decision: 'reject' });
  const events = JSON.parse(JSON.stringify(core.ledger.events()));

  const rebuilt = coreWith();
  const records = rebuilt.ledger.rebuild(events);
  assert.deepEqual(records.map((r) => r.decision), ['accept', 'reject']);
  assert.deepEqual(rebuilt.ledger.read('a'), core.ledger.read('a'));

  // Positive control: tamper with one event and the rebuild must follow it.
  const tampered = JSON.parse(JSON.stringify(events));
  tampered[0].record.decision = 'reject';
  assert.deepEqual(rebuilt.ledger.rebuild(tampered).map((r) => r.decision), ['reject', 'reject']);

  // And a derivation path: no decision in the event, so probabilities decide.
  const derived = rebuilt.ledger.rebuild([
    { type: 'jev-layer/ledger', record: { featureId: 'a', callId: 'c1', probabilities: { q: 0.05 }, threshold: 0.5 } },
  ]);
  assert.deepEqual(derived.map((r) => r.decision), ['reject']);
});

test('non-ledger events are skipped instead of corrupting the store', () => {
  const core = coreWith();
  const records = core.ledger.rebuild([
    { type: 'user/message', data: { text: 'hello' } },
    { type: 'jev-layer/ledger', record: { featureId: 'a', callId: 'c1', decision: 'accept' } },
    { featureId: 'b', callId: 'c2', decision: 'reject' },
    null,
  ]);
  assert.deepEqual(records.map((r) => r.featureId), ['a', 'b']);
});
