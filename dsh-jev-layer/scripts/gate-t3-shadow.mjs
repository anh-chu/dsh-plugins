/**
 * G-T3-3 — in shadow the ledger holds the would-be decision and no action is
 * performed; the same probe in enforce performs it.
 *
 * Run from the repo root: node scripts/gate-t3-shadow.mjs
 */
import assert from 'node:assert/strict';
import { createCore } from '../packages/core/src/index.js';

const settingsFor = (values) => ({ get: (key) => values[key] });

/** A core whose probe action is observable. */
function rig(values) {
  const settings = settingsFor(values);
  const performed = [];
  const core = createCore({ settings, now: () => 500 });
  const probe = () =>
    core.act({
      featureId: 'admit.output',
      callId: 'call-1',
      question: { type: 'noul', instructions: 'Rewrite this tool result?' },
      probabilities: { q1: 0.82 },
      threshold: 0.5,
      wouldBe: 'drop 12 of 40 segments',
      apply: () => {
        performed.push('rewrote the result');
        return 'rewritten';
      },
    });
  return { core, probe, performed };
}

// --- shadow: recorded, not acted on -----------------------------------------

const shadowed = rig({ 'admit.output.mode': 'shadow' });
assert.equal(shadowed.core.shadow.isShadow('admit.output'), true);
const shadowOutcome = await shadowed.probe();
assert.equal(shadowOutcome.acted, false, 'shadow must not act');
assert.equal(shadowed.performed.length, 0, 'shadow must perform no action');

const shadowRecords = shadowed.core.ledger.read('admit.output');
assert.equal(shadowRecords.length, 1, 'shadow must still record the decision');
const shadowRecord = shadowRecords[0];
assert.equal(shadowRecord.decision, 'accept');
assert.equal(shadowRecord.mode, 'shadow');
assert.equal(shadowRecord.wouldBe, 'drop 12 of 40 segments', 'the would-be action is recorded');
assert.deepEqual(shadowRecord.probabilities, { q1: 0.82 });
assert.equal(shadowRecord.threshold, 0.5);

// --- enforce: the positive control for the shadow check ----------------------

const enforced = rig({ 'admit.output.mode': 'enforce' });
assert.equal(enforced.core.shadow.isShadow('admit.output'), false);
const enforceOutcome = await enforced.probe();
assert.equal(enforceOutcome.acted, true, 'enforce must act');
assert.equal(enforceOutcome.result, 'rewritten');
assert.deepEqual(enforced.performed, ['rewrote the result'], 'the detector fires when the action is allowed');
assert.equal(enforced.core.ledger.read('admit.output')[0].mode, 'enforce');

// --- the mode is resolved from settings, live --------------------------------

const live = settingsFor({});
const liveCore = createCore({ settings: live, now: () => 1 });
assert.equal(liveCore.shadow.isShadow('admit.output'), false);
assert.equal(liveCore.shadow.isShadow('answer.questions'), true, 'the answering feature defaults to shadow');
live.get = (key) => (key === 'admit.output.mode' ? 'shadow' : undefined);
assert.equal(liveCore.shadow.isShadow('admit.output'), true, 'a mode change needs no restart');

console.log('GATE-T3-SHADOW-OK');
