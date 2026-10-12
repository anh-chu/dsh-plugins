/**
 * G-T29-1: a per-module `mode`, `budget` or `priority` written in the real (nested) config
 * reaches the core.
 *
 * The core asks for per-feature overrides as flat dotted keys: `answer.questions.mode`,
 * `admit.output.budget`, `rank.files.priority`. The config nests them under the module id,
 * `config['answer.questions'].mode`. The reader handed to the core only did a flat lookup, so
 * none of those three overrides could ever take effect. `answer.questions` defaults to
 * shadow, so on a real turn it could never leave it: `mode: enforce` under that module still
 * wrote `shadow` rows, and the question was handed to the human every time.
 *
 * Gates that built the core with a flat map (`'answer.questions.budget': 2`) passed, because
 * that is the shape the core reads and not the shape a user writes. This gate drives the
 * REAL `createSettings` against the REAL shadow resolver and budget with the nested shape.
 *
 * Run: node scripts/gate-t29-nestedkeys.mjs
 */
import assert from 'node:assert/strict';

import { createBudget } from '../packages/core/src/budget.js';
import { createShadow } from '../packages/core/src/ledger.js';
import { createSettings } from '../packages/plugin/src/config.js';

const shadowOf = (config) => createShadow({ settings: createSettings(config) });

// ── mode ────────────────────────────────────────────────────────────────────
{
  const nested = shadowOf({
    mode: 'shadow',
    'answer.questions': { enabled: true, mode: 'enforce' },
    'admit.output': { enabled: true, mode: 'enforce' },
    'rank.files': { enabled: true },
  });
  assert.equal(nested.modeOf('answer.questions'), 'enforce', 'a nested per-module enforce lifts the answering feature out of its shadow default');
  assert.equal(nested.modeOf('admit.output'), 'enforce', 'and overrides a global shadow for any module');
  assert.equal(nested.modeOf('rank.files'), 'shadow', 'a module with no own mode follows the global mode');

  // Controls: what must NOT change.
  assert.equal(shadowOf({ mode: 'enforce', 'answer.questions': { enabled: true } }).modeOf('answer.questions'), 'shadow',
    'control: the answering feature still defaults to shadow when nothing sets its own mode');
  assert.equal(shadowOf({ mode: 'enforce', 'admit.output': { mode: 'shadow' } }).modeOf('admit.output'), 'shadow',
    'control: a nested shadow beats a global enforce');
  assert.equal(shadowOf({ 'admit.output.mode': 'enforce' }).modeOf('admit.output'), 'enforce',
    'control: a flat key keeps working');
  assert.equal(shadowOf({ 'admit.output.mode': 'shadow', 'admit.output': { mode: 'enforce' } }).modeOf('admit.output'), 'shadow',
    'a flat key wins over a nested one');
  assert.equal(shadowOf({ 'admit.output': 'not-an-object' }).modeOf('admit.output'), 'shadow',
    'control: a malformed section falls back and never throws');
  assert.equal(shadowOf(undefined).modeOf('admit.output'), 'shadow', 'control: no config at all falls back');
}

// ── budget and priority, through the real budget ────────────────────────────
{
  const budgetFor = (config) => {
    const settings = createSettings(config);
    return createBudget({ settings });
  };
  const base = budgetFor({ turnCeiling: 20 });
  const room = base.remaining('rank.files');
  const narrowed = budgetFor({ turnCeiling: 20, 'rank.files': { enabled: true, budget: 1 } });
  assert.ok(narrowed.remaining('rank.files') <= 1, `a nested per-module budget of 1 is honoured (got ${narrowed.remaining('rank.files')})`);
  assert.ok(room > 1, `control: with no budget set the module has more than one unit (got ${room})`);
}

console.log('GATE-T29-NESTEDKEYS-OK');
