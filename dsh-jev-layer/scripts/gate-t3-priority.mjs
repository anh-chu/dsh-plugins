/**
 * G-T3-2 — with the shared per-turn ceiling exhausted, the answering feature
 * still gets its reserved sub-budget and the pruning feature starves.
 *
 * Run from the repo root: node scripts/gate-t3-priority.mjs
 */
import assert from 'node:assert/strict';
import { createCore } from '../packages/core/src/index.js';

const settingsFor = (values) => ({ get: (key) => values[key] });
const CEILING = 10;
const ANSWER_BUDGET = 3;
const settings = settingsFor({
  turnCeiling: CEILING,
  'answer.questions.budget': ANSWER_BUDGET,
  'admit.output.budget': 20,
});
const core = createCore({ settings, now: () => 1 });

// Priority is declared, not inferred from the order of the calls.
assert.equal(core.budget.priority('answer.questions'), 100);
assert.equal(core.budget.priority('admit.output'), 0);

// one shared ceiling with per-feature sub-budgets
assert.equal(core.budget.ceiling(), CEILING);
assert.equal(core.budget.subBudget('answer.questions'), ANSWER_BUDGET);

// Positive control: the pruning feature is granted units before exhaustion.
assert.equal(core.budget.tryAcquire('admit.output', 1), true);

// Burn the shared pool the reservation leaves to pruning.
while (core.budget.tryAcquire('admit.output', 1)) {
  // deliberately empty
}

// The pruning feature now starves ...
assert.equal(core.budget.remaining('admit.output'), 0);
assert.equal(core.budget.tryAcquire('admit.output', 1), false, 'pruning must starve at the pool');
// ... while the answering feature keeps its whole sub-budget.
assert.equal(core.budget.remaining('answer.questions'), ANSWER_BUDGET);
assert.equal(core.budget.tryAcquire('answer.questions', 1), true);
assert.equal(core.budget.tryAcquire('answer.questions', ANSWER_BUDGET - 1), true);
assert.equal(core.budget.remaining('answer.questions'), 0);
assert.equal(core.budget.tryAcquire('answer.questions', 1), false, 'the reservation is a bound too');

// `remaining` must predict what `tryAcquire` does.
assert.equal(core.budget.tryAcquire('admit.output', core.budget.remaining('admit.output') + 1), false);

// A new turn restores everything.
core.budget.beginTurn();
assert.equal(core.budget.remaining('admit.output') > 0, true);
assert.equal(core.budget.remaining('answer.questions'), ANSWER_BUDGET);

// A pruning feature with no sub-budget of its own is still capped by the pool.
const pools = createCore({ settings: settingsFor({ turnCeiling: 4, 'answer.questions.budget': 2 }), now: () => 1 });
assert.equal(pools.budget.tryAcquire('screen.fetch', 2), true);
assert.equal(pools.budget.tryAcquire('screen.fetch', 1), false);

console.log('GATE-T3-PRIORITY-OK');
