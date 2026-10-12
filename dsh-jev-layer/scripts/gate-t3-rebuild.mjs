/**
 * G-T3-4 — the ledger is a derived cache: deleting it and rebuilding from a
 * committed event list yields the same decisions, and a tampered event changes
 * the rebuilt decision (the positive control that proves the rebuild reads the
 * events rather than replaying a stored answer).
 *
 * Run from the repo root: node scripts/gate-t3-rebuild.mjs
 */
import assert from 'node:assert/strict';
import { createCore } from '../packages/core/src/index.js';

const settingsFor = (values) => ({ get: (key) => values[key] });

/** A session's worth of judgments, as a real module would append them. */
function recordSession(core) {
  core.ledger.append({
    featureId: 'admit.output',
    callId: 'call-1',
    question: { type: 'noul', instructions: 'Keep this segment?' },
    probabilities: { q1: 0.9 },
    threshold: 0.5,
    decision: 'keep',
    wouldBe: 'keep 28 segments',
    mode: 'enforce',
    at: 100,
  });
  core.ledger.append({
    featureId: 'admit.output',
    callId: 'call-2',
    question: { type: 'noul', instructions: 'Keep this segment?' },
    probabilities: { q1: 0.1 },
    threshold: 0.5,
    decision: 'drop',
    mode: 'enforce',
    at: 200,
  });
  // No explicit decision: the ledger derives it from the probabilities.
  core.ledger.append({
    featureId: 'screen.fetch',
    callId: 'call-3',
    question: { type: 'noul', instructions: 'Does this page address the model?' },
    probabilities: { q1: 0.83 },
    threshold: 0.75,
    mode: 'enforce',
    at: 300,
  });
  core.ledger.append({
    featureId: 'select.skill',
    callId: 'call-4',
    question: { type: 'choice', instructions: 'Which skill?' },
    probabilities: { alpha: 0.55, beta: 0.2 },
    threshold: 0.4,
    decision: 'alpha',
    mode: 'shadow',
    at: 400,
  });
}

const session = createCore({ settings: settingsFor({ 'admit.output.mode': 'enforce' }), now: () => 999 });
recordSession(session);

const original = session.ledger.read();
const originalDecisions = original.map((record) => record.decision);
assert.deepEqual(originalDecisions, ['keep', 'drop', 'accept', 'alpha']);

// The committed log: the ledger's own events plus the session's other traffic.
const log = [
  { type: 'user/message', data: { text: 'prune this flood' } },
  ...JSON.parse(JSON.stringify(session.ledger.events())),
  { type: 'tools/result', data: { tool: 'grep', content: 'noise' } },
];

// "Delete" the ledger: a fresh core starts with nothing.
const rebuiltCore = createCore({ settings: settingsFor({}), now: () => 999 });
assert.equal(rebuiltCore.ledger.size(), 0, 'the fresh ledger must start empty');
assert.deepEqual(rebuiltCore.ledger.read(), []);

const rebuilt = rebuiltCore.ledger.rebuild(log);
assert.equal(rebuilt.length, original.length);
assert.deepEqual(rebuilt.map((record) => record.decision), originalDecisions, 'the decisions must survive the rebuild');
assert.deepEqual(rebuilt, original, 'the whole record must survive the rebuild');
assert.deepEqual(rebuiltCore.ledger.read('admit.output').map((r) => r.decision), ['keep', 'drop']);

// --- positive control: the rebuild must follow the events --------------------

const tampered = JSON.parse(JSON.stringify(log));
const target = tampered.findIndex((event) => event.record?.callId === 'call-1');
assert.notEqual(target, -1);
tampered[target].record.decision = 'drop';
const afterTamper = rebuiltCore.ledger.rebuild(tampered).map((record) => record.decision);
assert.notDeepEqual(afterTamper, originalDecisions, 'a tampered event must change the rebuilt decision');
assert.deepEqual(afterTamper, ['drop', 'drop', 'accept', 'alpha']);

// A decision recorded without one is derived from the event's probabilities.
const derivedLog = [
  {
    type: 'jev-layer/ledger',
    record: { featureId: 'screen.fetch', callId: 'call-3', probabilities: { q1: 0.83 }, threshold: 0.75, at: 300 },
  },
];
assert.deepEqual(rebuiltCore.ledger.rebuild(derivedLog).map((record) => record.decision), ['accept']);
derivedLog[0].record.probabilities = { q1: 0.1 };
assert.deepEqual(rebuiltCore.ledger.rebuild(derivedLog).map((record) => record.decision), ['reject']);

// --- a third rebuild reproduces the second, so the rebuild is deterministic ---

assert.deepEqual(rebuiltCore.ledger.rebuild(log), original);

console.log('GATE-T3-REBUILD-OK');
