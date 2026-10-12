/**
 * G-T8-1 — `select.skill` acceptance gate.
 *
 * Exercises the real module against a synthetic api and a fixture catalog: no
 * network, no host, and no dependency on the core package. The first case is the
 * positive control — a large catalog yields exactly one selection and exactly one
 * notice — before any small-catalog absence is asserted.
 *
 * The last case is a positive control for an absence too: a detector that proves
 * `select-skill.js` is the only module touching the skill catalog must fire on
 * that file before it is allowed to be silent on the others.
 *
 * Run from the repo root: node scripts/gate-t8-skill.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mod, { select } from '../packages/plugin/src/modules/select-skill.js';

const LONG = 'Please refactor the billing module and update its tests.';
const SHORT = 'ok';

/** A user-authored message with one text block. */
function userMessage(text) {
  return { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] };
}

/** Injected context: a user-role message that is not something the user wrote. */
function reminder(text) {
  return { role: 'user', source: { kind: 'skill-catalog', form: 'catalog' }, content: [{ type: 'text', text }] };
}

/** `n` model-invocable skills, the fixture catalog. */
function catalogOf(n) {
  return Array.from({ length: n }, (_, i) => ({
    name: `skill-${i + 1}`,
    description: `Handles task ${i + 1} end to end.`,
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'user-dsh',
    provider: 'filesystem',
  }));
}

/** The pre-step payload for one turn. */
function stepEvent(messages, { turn = 1, step = 1 } = {}) {
  return { agent: { id: 'agent-1', session: { header: { cwd: '/work' } } }, messages, turn, step, signal: undefined };
}

/**
 * A minimal stand-in for the module context. `config` returns `undefined` unless
 * a case overrides a key, so the module's own defaults are what run by default.
 */
function makeApi({
  catalog = catalogOf(20),
  choice = 'skill-7',
  confidence = 0.9,
  judgeNull = false,
  judgeThrows = false,
  shadow = false,
  budgetOk = true,
  noticeResult = 'accepted',
  config = {},
} = {}) {
  const notices = [];
  const ledger = [];
  const calls = { judge: 0, budget: 0, list: 0, states: [] };
  const api = {
    id: 'select.skill',
    config: { get: (key) => config[key] },
    skills: {
      async list() {
        calls.list += 1;
        return catalog;
      },
    },
    judge: {
      configured: true,
      async ask(state) {
        calls.judge += 1;
        calls.states.push(state);
        if (judgeThrows) throw new Error('judge offline');
        if (judgeNull) return null;
        return { pick: { type: 'choice', choice, confidence } };
      },
    },
    budget: {
      tryAcquire() {
        calls.budget += 1;
        return budgetOk;
      },
    },
    ledger: { append: (row) => ledger.push(row) },
    shadow: { isShadow: () => shadow },
    notice: {
      request(notice) {
        notices.push(notice);
        return noticeResult;
      },
    },
  };
  return { api, notices, ledger, calls };
}

const LARGE = stepEvent([userMessage(LONG)]);

// 1. Positive control: a large catalog selects exactly one skill, and the notice
//    says which one.
{
  const { api, notices, ledger, calls } = makeApi();
  const out = await mod.handle(LARGE, api);
  assert.equal(out, undefined, 'select.skill is an observer: it must never transform the step');
  assert.equal(calls.judge, 1, 'a large catalog is judged once');
  assert.equal(notices.length, 1, 'a large catalog yields exactly one notice');
  const notice = notices[0];
  assert.equal(notice.kind, 'advisory', 'the notice is advisory, not blocking');
  assert.equal(notice.tag, 'select.skill', 'the notice carries the module tag');
  assert.match(notice.text, /skill-7/, 'the notice names the selected skill');
  assert.ok(typeof notice.dedupeKey === 'string' && notice.dedupeKey.length > 0, 'the notice carries a dedupe key');
  const rows = ledger.filter((r) => r.decision === 'select');
  assert.equal(rows.length, 1, 'exactly one selection is recorded');
  assert.equal(rows[0].featureId, 'select.skill', 'the record is keyed by the module id');
  assert.equal(rows[0].wouldBe, 'skill-7', 'the record keeps the would-be skill');
  assert.equal(rows[0].probabilities.pick, 0.9, 'the record keeps the probability under the question id');
  assert.equal(rows[0].threshold, 0.3, 'the record keeps the confidence floor');
  assert.equal(rows[0].mode, 'enforce', 'the record is in enforce mode');

  const picked = await select(LARGE, api);
  assert.equal(picked.skill.name, 'skill-7', 'select returns the chosen skill');
  assert.equal(picked.confidence, 0.9, 'select returns the judged probability');
}

// 2. Below the size floor nothing is selected and nothing is judged.
{
  const { api, notices, ledger, calls } = makeApi({ catalog: catalogOf(14) });
  assert.equal(await select(LARGE, api), null, '14 skills are too few to pick from');
  await mod.handle(LARGE, api);
  assert.equal(calls.judge, 0, 'a small catalog costs no judge request');
  assert.equal(notices.length, 0, 'a small catalog raises no notice');
  assert.ok(ledger.length >= 1 && ledger.every((r) => r.decision === 'skipped'), 'the small catalog is recorded as a skip');
}

// 3. The floor is inclusive: 15 skills do select. Case 2 is the control that the
//    detector fires on 14.
{
  const { api, notices } = makeApi({ catalog: catalogOf(15) });
  await mod.handle(LARGE, api);
  assert.equal(notices.length, 1, '15 skills are enough to pick from');
}

// 4. Shadow records the would-be pick and acts on nothing.
{
  const { api, notices, ledger } = makeApi({ shadow: true });
  const out = await mod.handle(LARGE, api);
  assert.equal(out, undefined, 'shadow still transforms nothing');
  assert.equal(notices.length, 0, 'shadow raises no notice');
  const row = ledger.find((r) => r.decision === 'select');
  assert.ok(row, 'shadow records the selection it would have made');
  assert.equal(row.wouldBe, 'skill-7', 'the shadow record keeps the would-be skill');
  assert.equal(row.mode, 'shadow', 'the record is marked shadow');
}

// 5. Judge failure is not a verdict: no selection, no notice, no throw.
{
  const nothing = makeApi({ judgeNull: true });
  await mod.handle(LARGE, nothing.api);
  assert.equal(nothing.notices.length, 0, 'an unreadable answer raises no notice');
  assert.equal(nothing.ledger.at(-1).decision, 'skipped', 'the unreadable answer is recorded as a skip');

  const broken = makeApi({ judgeThrows: true });
  await mod.handle(LARGE, broken.api);
  assert.equal(broken.notices.length, 0, 'a thrown judge raises no notice');
}

// 6. The abstention and the confidence floor both select nothing.
{
  const abstain = makeApi({ choice: 'none' });
  assert.equal(await select(LARGE, abstain.api), null, 'the abstention selects nothing');
  await mod.handle(LARGE, abstain.api);
  assert.equal(abstain.notices.length, 0, 'the abstention raises no notice');
  assert.equal(abstain.ledger.at(-1).decision, 'none', 'the abstention is recorded as a non-selection');

  const weak = makeApi({ confidence: 0.2 });
  assert.equal(await select(LARGE, weak.api), null, 'a weak answer selects nothing');
  assert.equal(weak.ledger.at(-1).decision, 'none', 'a weak answer is recorded as a non-selection');

  const atFloor = makeApi({ confidence: 0.3 });
  const picked = await select(LARGE, atFloor.api);
  assert.equal(picked.skill.name, 'skill-7', 'a probability at the floor selects');

  const unknown = makeApi({ choice: 'skill-not-in-catalog' });
  assert.equal(await select(LARGE, unknown.api), null, 'a name outside the catalog selects nothing');
}

// 7. The task is the latest message when it carries signal, and the last three
//    when it does not. The call in case 1 was the control for the short path
//    never being taken on a long message.
{
  const short = makeApi();
  await select(stepEvent([userMessage(LONG), userMessage(SHORT)]), short.api);
  assert.ok(short.calls.states[0].task.includes(LONG), 'a short latest message falls back to the earlier messages');

  const long = makeApi();
  await select(stepEvent([userMessage(LONG), userMessage('And check the migration script while you are there.')]), long.api);
  assert.ok(
    !long.calls.states[0].task.includes(LONG),
    'a latest message with signal is judged alone, not diluted by the window',
  );

  const injected = makeApi();
  await select(stepEvent([userMessage(LONG), reminder('available skills: skill-1, skill-2')]), injected.api);
  assert.ok(
    !injected.calls.states[0].task.includes('available skills'),
    'injected context is not user text and does not become the task',
  );
}

// 8. A later step of the same turn does not judge again: one turn, one request.
{
  const { api, notices, calls } = makeApi();
  await select(LARGE, api);
  await mod.handle(stepEvent([userMessage(LONG)], { step: 2 }), api);
  assert.equal(calls.judge, 1, 'the turn judges once, at its start');
  assert.equal(notices.length, 0, 'a later step of the same turn raises no notice');
}

// 9. A suppressed notice is the arbiter's decision, not a failure here.
{
  const { api, notices, ledger } = makeApi({ noticeResult: 'suppressed' });
  const out = await mod.handle(LARGE, api);
  assert.equal(out, undefined, 'a suppressed notice does not throw or transform');
  assert.equal(notices.length, 1, 'the request still reached the arbiter');
  assert.ok(ledger.some((r) => r.decision === 'select'), 'the selection is recorded either way');
}

// 10. The floor counts what the model can invoke: a skill it cannot load is not a
//     choice. Case 3 is the control that 15 invocable skills do select.
{
  // 20 entries, 6 of them user-only: 14 are left for the model, one under the floor.
  const catalog = catalogOf(20);
  for (const skill of catalog.slice(14)) skill.invocation = { modelInvocable: false, userInvocable: true };
  const { api, notices, calls } = makeApi({ catalog });
  assert.equal(await select(LARGE, api), null, 'user-only skills do not reach the floor');
  assert.equal(calls.judge, 0, 'no request is spent on a catalog the model cannot use');
  assert.equal(notices.length, 0, 'no notice is raised for a catalog the model cannot use');
}

// 11. This is the plugin's only skill-selection implementation. Positive control
//     first: the detector must fire on this module before it is believed silent
//     about the others.
{
  const modulesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'plugin', 'src', 'modules');
  const picks = /(api\s*\??\.\s*skills\b|\bskills\s*\??\.\s*(list|snapshot|register)\s*\()/;
  const pickers = readdirSync(modulesDir)
    .filter((file) => file.endsWith('.js') && file !== 'index.js')
    .filter((file) => picks.test(readFileSync(join(modulesDir, file), 'utf8')));

  assert.ok(pickers.includes('select-skill.js'), 'the detector fires on the skill-selection module (positive control)');
  assert.deepEqual(pickers, ['select-skill.js'], 'no other module reads the skill catalog or picks a skill');
}

console.log('GATE-T8-SKILL-OK');
