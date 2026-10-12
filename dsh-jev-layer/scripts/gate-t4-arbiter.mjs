/**
 * G-T4-1 — two notice requests in one turn produce exactly one notice, and the
 * loser is recorded rather than dropped.
 *
 * Run from the repo root: node scripts/gate-t4-arbiter.mjs
 */
import assert from 'node:assert/strict';
import { createCore } from '../packages/core/src/index.js';

const settingsFor = (values) => ({ get: (key) => values[key] });
const rig = (values = {}) => {
  const settings = settingsFor(values);
  return createCore({ settings, now: () => 1_000 });
};

// --- one notice per turn -----------------------------------------------------

// Positive control for the counter that follows: a lone request is delivered.
const lone = rig();
assert.equal(lone.notice.request({ kind: 'advisory', text: 'only me', tag: 'remind.drift' }), 'accepted');
assert.equal(lone.notice.drain().length, 1, 'the delivery detector fires on a lone notice');

// Two requests in one turn: exactly one notice, the loser recorded.
const core = rig();
assert.equal(core.notice.request({ kind: 'advisory', text: 'first', tag: 'remind.drift' }), 'accepted');
assert.equal(core.notice.request({ kind: 'advisory', text: 'second', tag: 'guide.instructions' }), 'suppressed');
const drained = core.notice.drain();
assert.equal(drained.length, 1, 'exactly one notice per turn');
assert.equal(drained[0].text, 'first');

const suppressor = core.notice.suppressed();
assert.equal(suppressor.length, 1, 'the loser is recorded, not dropped');
assert.equal(suppressor[0].reason, 'one-per-turn');
assert.equal(suppressor[0].tag, 'guide.instructions');
assert.equal(suppressor[0].text, 'second');

// The suppression is in the ledger too, keyed by the losing module's tag.
const ledgerRecord = core.ledger.read('guide.instructions').at(-1);
assert.equal(ledgerRecord.decision, 'notice-suppressed');
assert.equal(ledgerRecord.wouldBe, 'one-per-turn');

// A delivered notice frees the turn only when the turn is closed.
assert.equal(core.notice.drain().length, 0, 'the turn is now empty');
core.notice.beginTurn();
assert.equal(core.notice.request({ kind: 'advisory', text: 'a new turn', tag: 'remind.drift' }), 'accepted');
assert.equal(core.notice.drain().length, 1);

// --- blocked outranks advisory ----------------------------------------------

const blocked = rig();
assert.equal(blocked.notice.request({ kind: 'advisory', text: 'heads up', tag: 'remind.drift' }), 'accepted');
assert.equal(blocked.notice.request({ kind: 'blocked', text: 'stop', tag: 'gate.completion' }), 'accepted');
const blocking = blocked.notice.drain();
assert.equal(blocking.length, 1);
assert.equal(blocking[0].kind, 'blocked', 'the blocked notice wins the turn');
assert.equal(blocked.notice.suppressed()[0].reason, 'outranked');
assert.equal(blocked.notice.suppressed()[0].tag, 'remind.drift');

// And the reverse order: a lower-ranked request never displaces a blocked one.
const reversed = rig();
assert.equal(reversed.notice.request({ kind: 'blocked', text: 'stop', tag: 'gate.completion' }), 'accepted');
assert.equal(reversed.notice.request({ kind: 'advisory', text: 'heads up', tag: 'remind.drift' }), 'suppressed');
assert.equal(reversed.notice.drain()[0].kind, 'blocked');
assert.equal(reversed.notice.suppressed()[0].reason, 'one-per-turn');

// --- content-hash dedupe -----------------------------------------------------

const deduped = rig();
assert.equal(deduped.notice.request({ kind: 'advisory', text: 'identical words', tag: 'remind.drift' }), 'accepted');
assert.equal(deduped.notice.drain().length, 1);
deduped.notice.beginTurn();
assert.equal(deduped.notice.request({ kind: 'advisory', text: 'identical words', tag: 'remind.drift' }), 'suppressed');
assert.equal(deduped.notice.suppressed()[0].reason, 'duplicate');
// A different text is not a duplicate.
deduped.notice.beginTurn();
assert.equal(deduped.notice.request({ kind: 'advisory', text: 'different words', tag: 'remind.drift' }), 'accepted');

// --- per-session cap ---------------------------------------------------------

const capped = rig({ noticeSessionCap: 1 });
assert.equal(capped.notice.request({ kind: 'advisory', text: 'one', tag: 'a' }), 'accepted');
assert.equal(capped.notice.drain().length, 1);
capped.notice.beginTurn();
assert.equal(capped.notice.request({ kind: 'advisory', text: 'two', tag: 'b' }), 'suppressed');
assert.equal(capped.notice.suppressed()[0].reason, 'cap');
assert.equal(capped.notice.drain().length, 0, 'the cap holds across turns');

// --- a summary never repeats within a session --------------------------------

const summarised = rig();
assert.equal(summarised.notice.request({ kind: 'advisory', text: 'summary one', tag: 'report', summary: true }), 'accepted');
assert.equal(summarised.notice.drain().length, 1);
summarised.notice.beginTurn();
// Different words, so content dedupe alone would let it through.
assert.equal(summarised.notice.request({ kind: 'advisory', text: 'summary two', tag: 'report', summary: true }), 'suppressed');
assert.equal(summarised.notice.suppressed()[0].reason, 'summary-repeat');
// A non-summary notice is unaffected.
summarised.notice.beginTurn();
assert.equal(summarised.notice.request({ kind: 'advisory', text: 'summary three', tag: 'report' }), 'accepted');

// --- the turn boundary is shared with the budget -----------------------------

const shared = rig();
assert.equal(shared.notice.request({ kind: 'blocked', text: 'held', tag: 'a' }), 'accepted');
shared.budget.beginTurn();
assert.equal(shared.notice.pending().length, 0, 'a new turn clears the held notice');
assert.equal(shared.notice.suppressed().at(-1).reason, 'turn-ended');
assert.equal(shared.notice.drain().length, 0);

console.log('GATE-T4-ARBITER-OK');
