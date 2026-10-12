/**
 * G-T3-1 — the ledger records a decision with its probabilities and threshold,
 * keyed by feature id, and touches no filesystem path unless one is given.
 *
 * Run from the repo root: node scripts/gate-t3-ledger.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore } from '../packages/core/src/index.js';

const RECORD_KEYS = ['featureId', 'callId', 'question', 'probabilities', 'threshold', 'decision', 'wouldBe', 'reason', 'mode', 'at'];
const settingsFor = (values) => ({ get: (key) => values[key] });
const NOW = 1_700_000_000_000;

// --- shape ------------------------------------------------------------------

const core = createCore({ settings: settingsFor({}), now: () => NOW });
const stored = core.ledger.append({
  featureId: 'admit.output',
  callId: 'call-1',
  question: { type: 'noul', instructions: 'Keep this segment?' },
  probabilities: { q1: 0.82 },
  threshold: 0.5,
  decision: 'accept',
  wouldBe: 'keep 28 of 40 segments',
  unlisted: 'must not travel into the record',
});

assert.deepEqual(Object.keys(stored), RECORD_KEYS, 'a record has exactly the contract shape');
assert.equal(stored.featureId, 'admit.output');
assert.equal(stored.callId, 'call-1');
assert.deepEqual(stored.question, { type: 'noul', instructions: 'Keep this segment?' });
assert.deepEqual(stored.probabilities, { q1: 0.82 }, 'the probabilities are recorded');
assert.equal(stored.threshold, 0.5, 'the threshold is recorded');
assert.equal(stored.decision, 'accept', 'the decision is recorded');
assert.equal(stored.wouldBe, 'keep 28 of 40 segments');
assert.equal(stored.mode, 'enforce');
assert.equal(stored.at, NOW);
assert.equal(stored.unlisted, undefined);

// --- scores handed over as an array are kept, not dropped --------------------
// `admit.output`, `admit.terminal` and `guide.shared` pass one score per segment as
// a plain array. The ledger used to coerce that to `{}`, so every score they
// recorded vanished; this was found by reading real rows from a live turn, and no
// gate had a fixture shaped like the callers' real input.
const arrayCore = createCore({ settings: settingsFor({}), now: () => NOW });
const fromArray = arrayCore.ledger.append({ featureId: 'admit.output', decision: 'shadow', probabilities: [0.9, 0.1, 0.05] });
assert.deepEqual(fromArray.probabilities, { s0: 0.9, s1: 0.1, s2: 0.05 }, 'an array of scores is kept, keyed by position');
const nonNumeric = arrayCore.ledger.append({ featureId: 'admit.output', decision: 'shadow', probabilities: [0.4, 'x', NaN, 0.6] });
assert.deepEqual(nonNumeric.probabilities, { s0: 0.4, s3: 0.6 }, 'a non-numeric entry is skipped and positions stay stable');
assert.equal(arrayCore.ledger.append({ featureId: 'admit.output', threshold: 0.5, probabilities: [0.2] }).decision, 'reject', 'a decision is derived from an array too');

// --- keyed by feature id, and by call id ------------------------------------

core.ledger.append({ featureId: 'screen.fetch', callId: 'call-2', probabilities: { q1: 0.1 }, threshold: 0.75, decision: 'reject' });
core.ledger.append({ featureId: 'admit.output', callId: 'call-3', probabilities: { q1: 0.2 }, threshold: 0.5, decision: 'reject' });
assert.equal(core.ledger.read('admit.output').length, 2);
assert.equal(core.ledger.read('screen.fetch').length, 1);
assert.deepEqual(core.ledger.read('admit.output', 'call-1').map((r) => r.decision), ['accept']);
assert.equal(core.ledger.read('admit.output', 'call-9').length, 0);
assert.equal(core.ledger.read('nothing.registered').length, 0);

// --- no filesystem path unless one is given ---------------------------------

const dir = mkdtempSync(join(tmpdir(), 'jev-gate-t3-ledger-'));
try {
  const probePath = join(dir, 'ledger.jsonl');
  const withoutPath = createCore({ settings: settingsFor({}), now: () => NOW });
  withoutPath.ledger.append({ featureId: 'admit.output', callId: 'call-1', decision: 'accept' });
  assert.equal(existsSync(probePath), false, 'no ledger file without options.statePath');
  assert.deepEqual(readdirSync(dir), [], 'a core without statePath writes nothing');

  // Positive control: the same workload with a statePath does write, so the
  // detector above fires on the case where the path exists.
  const withPath = createCore({ settings: settingsFor({}), now: () => NOW, statePath: probePath });
  const first = withPath.ledger.append({ featureId: 'admit.output', callId: 'call-1', probabilities: { q1: 0.9 }, threshold: 0.5, decision: 'accept' });
  const second = withPath.ledger.append({ featureId: 'screen.fetch', callId: 'call-2', probabilities: { q1: 0.1 }, threshold: 0.75, decision: 'reject' });
  assert.equal(existsSync(probePath), true, 'statePath must be written when given');
  const lines = readFileSync(probePath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), first);
  assert.deepEqual(JSON.parse(lines[1]), second);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('GATE-T3-LEDGER-OK');
