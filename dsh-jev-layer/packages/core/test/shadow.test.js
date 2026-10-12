/**
 * Shadow mode: the would-be decision is recorded and no action is performed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createCore } from '../src/index.js';

/** Build a core over a mutable settings map with an action counter. */
function rig(values) {
  const settings = { get: (key) => values[key] };
  const actions = [];
  const core = createCore({ settings, now: () => 42 });
  const probe = (featureId) =>
    core.act({
      featureId,
      callId: 'c1',
      question: { type: 'noul', instructions: 'act?' },
      probabilities: { q: 1 },
      threshold: 0.5,
      wouldBe: 'rewrite the result',
      apply: () => actions.push(featureId),
    });
  return { settings, core, actions, probe };
}

test('the answering feature defaults to shadow, every other feature to enforce', () => {
  const { core } = rig({});
  assert.equal(core.shadow.isShadow('answer.questions'), true);
  assert.equal(core.shadow.isShadow('admit.output'), false);
});

test('a feature mode overrides the global mode', () => {
  const { core } = rig({ mode: 'enforce', 'admit.output.mode': 'shadow' });
  assert.equal(core.shadow.isShadow('admit.output'), true);
  assert.equal(core.shadow.isShadow('screen.fetch'), false);
});

test('the global mode is the default for a feature without its own', () => {
  const { core } = rig({ mode: 'shadow' });
  assert.equal(core.shadow.isShadow('admit.output'), true);
  assert.equal(core.shadow.isShadow('answer.questions'), true);
});

test('in shadow the ledger holds the would-be decision and the action does not run', async () => {
  const { core, actions, probe } = rig({ 'admit.output.mode': 'shadow' });
  const outcome = await probe('admit.output');
  assert.equal(outcome.acted, false);
  assert.equal(actions.length, 0);
  const [record] = core.ledger.read('admit.output');
  assert.equal(record.mode, 'shadow');
  assert.equal(record.wouldBe, 'rewrite the result');
  assert.equal(record.decision, 'accept');
});

test('enforce runs the action — the positive control for the shadow check', async () => {
  const { core, actions, probe } = rig({ 'admit.output.mode': 'enforce' });
  const outcome = await probe('admit.output');
  assert.equal(outcome.acted, true);
  assert.deepEqual(actions, ['admit.output']);
  assert.equal(core.ledger.read('admit.output')[0].mode, 'enforce');
});
