/**
 * The notice arbiter: one per turn, blocked outranks advisory, dedupe, the
 * session cap, a summary that never repeats, and every suppression recorded.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createCore } from '../src/index.js';

/** Build a core over a mutable settings map. */
function rig(values = {}) {
  const settings = { get: (key) => values[key] };
  return { settings, core: createCore({ settings, now: () => 1_000 }) };
}

test('one notice per turn, and the loser is recorded', () => {
  const { core } = rig();
  assert.equal(core.notice.request({ kind: 'advisory', text: 'first', tag: 'a' }), 'accepted');
  assert.equal(core.notice.request({ kind: 'advisory', text: 'second', tag: 'b' }), 'suppressed');
  const drained = core.notice.drain();
  assert.equal(drained.length, 1);
  assert.equal(drained[0].text, 'first');
  assert.deepEqual(
    core.notice.suppressed().map((s) => s.reason),
    ['one-per-turn'],
  );
});

test('a blocked notice displaces an advisory one and the advisory is recorded', () => {
  const { core } = rig();
  assert.equal(core.notice.request({ kind: 'advisory', text: 'heads up', tag: 'remind.drift' }), 'accepted');
  assert.equal(core.notice.request({ kind: 'blocked', text: 'stop', tag: 'gate.completion' }), 'accepted');
  const drained = core.notice.drain();
  assert.equal(drained.length, 1);
  assert.equal(drained[0].kind, 'blocked');
  const [suppression] = core.notice.suppressed();
  assert.equal(suppression.reason, 'outranked');
  assert.equal(suppression.text, 'heads up');
});

test('a suppressed request reaches the ledger under the module tag', () => {
  const { core } = rig();
  core.notice.request({ kind: 'blocked', text: 'stop', tag: 'gate.completion' });
  core.notice.request({ kind: 'advisory', text: 'later', tag: 'remind.drift' });
  const [record] = core.ledger.read('remind.drift');
  assert.equal(record.decision, 'notice-suppressed');
  assert.equal(record.wouldBe, 'one-per-turn');
});

test('content-hash dedupe stops an identical notice repeating in a later turn', () => {
  const { core } = rig();
  core.notice.request({ kind: 'advisory', text: 'same words', tag: 'a' });
  assert.equal(core.notice.drain().length, 1);
  core.notice.beginTurn();
  assert.equal(core.notice.request({ kind: 'advisory', text: 'same words', tag: 'a' }), 'suppressed');
  assert.equal(core.notice.suppressed()[0].reason, 'duplicate');
});

test('the per-session cap holds', () => {
  const { core } = rig({ noticeSessionCap: 1 });
  core.notice.request({ kind: 'advisory', text: 'one', tag: 'a' });
  assert.equal(core.notice.drain().length, 1);
  core.notice.beginTurn();
  assert.equal(core.notice.request({ kind: 'advisory', text: 'two', tag: 'b' }), 'suppressed');
  assert.equal(core.notice.suppressed()[0].reason, 'cap');
  assert.equal(core.notice.drain().length, 0);
});

test('a summary never repeats within a session', () => {
  const { core } = rig();
  assert.equal(core.notice.request({ kind: 'advisory', text: 'summary one', tag: 'a', summary: true }), 'accepted');
  assert.equal(core.notice.drain().length, 1);
  core.notice.beginTurn();
  assert.equal(core.notice.request({ kind: 'advisory', text: 'summary two', tag: 'a', summary: true }), 'suppressed');
  assert.equal(core.notice.suppressed()[0].reason, 'summary-repeat');
});

test('budget.beginTurn closes the notice turn too', () => {
  const { core } = rig();
  core.notice.request({ kind: 'advisory', text: 'one', tag: 'a' });
  core.budget.beginTurn();
  assert.equal(core.notice.pending().length, 0);
  assert.equal(core.notice.suppressed()[0].reason, 'turn-ended');
});
