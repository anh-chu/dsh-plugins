/**
 * The per-turn budget: one shared ceiling, per-feature sub-budgets, explicit
 * priority for the answering feature.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createCore } from '../src/index.js';

/** Build a core over a mutable settings map. */
function coreWith(values) {
  const settings = { get: (key) => values[key] };
  return { settings, core: createCore({ settings, now: () => 1 }) };
}

test('the ceiling bounds the turn and beginTurn resets it', () => {
  const { core } = coreWith({ turnCeiling: 5, 'answer.questions.budget': 2, 'admit.output.budget': 10 });
  assert.equal(core.budget.tryAcquire('admit.output'), true);
  assert.equal(core.budget.tryAcquire('admit.output'), true);
  assert.equal(core.budget.tryAcquire('admit.output'), true);
  assert.equal(core.budget.tryAcquire('admit.output'), false);
  assert.equal(core.budget.remaining('admit.output'), 0);
  core.budget.beginTurn();
  assert.equal(core.budget.remaining('admit.output'), 3);
});

test('a per-feature sub-budget caps one feature below the shared ceiling', () => {
  const { core } = coreWith({ turnCeiling: 10, 'answer.questions.budget': 2, 'admit.output.budget': 2 });
  assert.equal(core.budget.tryAcquire('admit.output', 2), true);
  assert.equal(core.budget.tryAcquire('admit.output'), false);
  assert.equal(core.budget.remaining('admit.output'), 0);
  assert.equal(core.budget.tryAcquire('screen.fetch'), true);
});

test('with the shared pool exhausted the answering feature keeps its reservation', () => {
  const { core } = coreWith({ turnCeiling: 10, 'answer.questions.budget': 3, 'admit.output.budget': 20 });
  while (core.budget.tryAcquire('admit.output')) {
    // Pruning burns everything the reservation leaves it.
  }
  assert.equal(core.budget.remaining('admit.output'), 0);
  assert.equal(core.budget.remaining('answer.questions'), 3);
  assert.equal(core.budget.tryAcquire('answer.questions', 3), true);
  assert.equal(core.budget.tryAcquire('answer.questions'), false);
  assert.equal(core.budget.tryAcquire('admit.output'), false);
});

test('priority is a declared table, not the order of the calls', () => {
  const { core } = coreWith({ turnCeiling: 10 });
  assert.equal(core.budget.priority('answer.questions'), 100);
  assert.equal(core.budget.priority('admit.output'), 0);
});
