/**
 * G-T9-1 — an unsupported claim is rejected and a supported one is accepted.
 *
 * Runs the real module against a synthetic module context: a stub judge, a
 * recording ledger, a recording notice arbiter and a synthetic `registerAgent`.
 * No core package, no host, no network.
 *
 * The stub judge decides from the content it is handed, so the verdicts below
 * come from the evidence that was actually supplied rather than from a canned
 * answer. That is what makes the controls real:
 *
 *   - negative control: "tests pass" is accepted on evidence mentioning tests
 *     while "docs updated" is not, on the same call — a gate that always rejects
 *     fails the first half;
 *   - absence control: with a judge that would answer `verified` for everything,
 *     a call with no evidence accepts nothing and never asks the judge;
 *   - the shadow "no notice" assertion is paired with an identical enforce run
 *     that does raise exactly one notice.
 *
 * Run from the repo root: `node scripts/gate-t9-completion.mjs`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import gate, {
  checkFinalAnswer,
  createGateTool,
  gateClaims,
  recordedEvidence,
  resetCompletionState,
} from '../packages/plugin/src/modules/gate-completion.js';
import { SEAMS } from '../packages/plugin/src/seams.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = join(HERE, '..', 'packages', 'plugin', 'src', 'modules', 'gate-completion.js');
/** A file that does call `ctx.on`, used as the positive control for the check below. */
const REGISTRY_PATH = join(HERE, '..', 'packages', 'plugin', 'src', 'registry.js');

/** The detector used on both files: one plain substring test. */
const mentionsCtxOn = (path) => readFileSync(path, 'utf8').includes('ctx.on');

/** The synthetic module context. Every dependency is a recorder. */
function makeApi(options = {}) {
  const settings = { autoAccept: 0.8, maxClaims: 16, autoCheck: true, ...(options.settings ?? {}) };
  const ledger = [];
  const notices = [];
  const calls = [];
  const registrations = [];
  return {
    id: 'gate.completion',
    config: { get: (key) => settings[key] },
    judge: {
      configured: options.configured !== false,
      ask: async (state, questions) => {
        calls.push({ state, questions });
        return typeof options.answers === 'function' ? options.answers(state, questions) : options.answers;
      },
    },
    budget: { tryAcquire: () => options.budget !== false },
    ledger: { append: (row) => ledger.push(row) },
    shadow: { isShadow: () => options.shadow === true },
    notice: {
      request: (notice) => {
        notices.push(notice);
        return 'accepted';
      },
    },
    notifications: { send: async () => 'sent' },
    log: { warn() {} },
    registerAgent(agent, setup) {
      const teardown = setup({ effect: (fn) => { const out = fn(); return () => out?.(); } });
      registrations.push(teardown);
      return () => teardown?.();
    },
    seams: SEAMS,
    __ledger: ledger,
    __notices: notices,
    __calls: calls,
    __registrations: registrations,
  };
}

/** The first significant word of a claim, used to look it up in the evidence. */
function keywordOf(claim) {
  const words = String(claim).toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 3);
  return words[0] ?? '';
}

/** A judge that answers from the content: verified only if the evidence names it. */
function contentJudge(state, questions) {
  const evidence = String(state?.evidence ?? '').toLowerCase();
  const answers = {};
  for (const [id, question] of Object.entries(questions)) {
    if (question.type !== 'choice') continue;
    const keyword = keywordOf(state.claims[id]);
    const supported = keyword !== '' && evidence.includes(keyword);
    answers[id] = {
      type: 'choice',
      choice: supported ? 'verified' : 'not_addressed',
      confidence: supported ? 0.95 : 0.9,
    };
  }
  return answers;
}

/** The fixed agent shape the handler needs for `registerAgent`. */
function agentOf(id) {
  return { id, ctx: {} };
}

/** Record one tool outcome for an agent. */
async function observe(api, id, text, isError = false) {
  const returned = await gate.handle(
    {
      exec: { name: 'bash', arguments: { command: 'node --test' }, agent: agentOf(id) },
      result: { isError, content: [{ type: 'text', text }] },
    },
    api,
  );
  assert.equal(returned, undefined, 'the observation seam handler must never transform a result');
}

// ── the frozen shape ───────────────────────────────────────────────────────

assert.equal(gate.id, 'gate.completion');
assert.equal(gate.seam, SEAMS.TOOLS_RESULT, 'a completion check observes; it does not block a call');
assert.equal(
  mentionsCtxOn(MODULE_PATH),
  false,
  'the registry owns the listener: a module must never call ctx.on',
);
assert.equal(mentionsCtxOn(REGISTRY_PATH), true, 'positive control: the ctx.on detector fires where it should');
assert.equal(createGateTool(makeApi()).name, 'jev_gate', 'the model-invoked form is exposed as jev_gate');

// ── (a) the model-invoked gate: negative and positive control ──────────────

resetCompletionState();
let api = makeApi({ answers: contentJudge });
let verdict = await gateClaims(
  { request: 'the tests pass', claims: ['tests pass', 'docs updated'], evidence: 'tests: 12 passed, 0 failed' },
  api,
);
const byId = Object.fromEntries(verdict.claims.map((reading) => [reading.id, reading]));
assert.equal(byId.c0.accepted, true, 'a claim the evidence supports is accepted');
assert.equal(byId.c0.verdict, 'verified');
assert.equal(byId.c1.accepted, false, 'a claim the evidence does not address is not accepted');
assert.notEqual(byId.c1.verdict, 'verified');
assert.equal(verdict.accepted, false, 'one unsupported claim withholds acceptance for the call');
assert.deepEqual(verdict.reasonCodes.includes('claims_not_addressed'), true);
assert.equal(api.__calls.length, 1, 'positive control: with evidence present the judge is asked');

// Positive control for the absence control below: the gate *can* accept.
api = makeApi({ answers: contentJudge });
verdict = await gateClaims(
  { request: 'the tests pass', claims: ['tests pass'], evidence: 'tests: 12 passed, 0 failed' },
  api,
);
assert.equal(verdict.claims[0].accepted, true);
assert.equal(verdict.accepted, true);
assert.equal(verdict.action, 'auto', 'an always-rejecting gate would fail here');

// ── (a) no evidence: nothing is accepted, and the judge is not asked ────────

api = makeApi({ answers: () => ({ c0: { type: 'choice', choice: 'verified', confidence: 0.99 } }) });
verdict = await gateClaims({ request: 'the tests pass', claims: ['tests pass'] }, api);
assert.equal(api.__calls.length, 0, 'with no evidence there is nothing to judge against');
assert.equal(verdict.claims[0].verdict, 'not_addressed');
assert.equal(verdict.claims[0].accepted, false, 'a judge that would say yes cannot accept an untied claim');
assert.equal(verdict.accepted, false);
assert.deepEqual(verdict.reasonCodes, ['no_evidence', 'claims_not_addressed']);

// ── (a) judge failure: never accepted, never a throw ───────────────────────

for (const failure of [
  { name: 'unavailable', options: { answers: null } },
  { name: 'unreadable', options: { answers: () => undefined } },
  { name: 'unconfigured', options: { configured: false } },
  { name: 'budget exhausted', options: { budget: false } },
]) {
  resetCompletionState();
  api = makeApi(failure.options);
  verdict = await gateClaims(
    { request: 'the tests pass', claims: ['tests pass'], evidence: 'tests: 12 passed, 0 failed' },
    api,
  );
  assert.equal(verdict.ok, false, `${failure.name}: no verdict is not a verdict`);
  assert.equal(verdict.action, 'escalate', `${failure.name}: nothing is approved`);
  assert.equal(verdict.claims.every((reading) => reading.accepted === false), true);
  assert.equal(api.__notices.length, 0, `${failure.name}: a gate never raises a notice`);
}

// ── (b) the automatic variant: one supplement, never more ──────────────────

resetCompletionState();
api = makeApi({ answers: () => ({ support: { type: 'noul', noul: 0.1 } }) });
await observe(api, 'agent-a', 'FAIL 3 tests', true);
assert.match(recordedEvidence('agent-a'), /FAIL 3 tests/, 'the observation seam records evidence');

let decision = await checkFinalAnswer({ answer: 'All tests pass.', agentId: 'agent-a', turn: 1 }, api);
assert.equal(decision.action, 'supplement');
assert.equal(decision.supplement, true);
assert.equal(decision.accepted, false);
assert.equal(api.__notices.length, 1, 'one unsupported answer requests exactly one supplemental attempt');
assert.equal(api.__ledger.at(-1).wouldBe, 'supplement');

decision = await checkFinalAnswer({ answer: 'All tests pass.', agentId: 'agent-a', turn: 1 }, api);
assert.equal(decision.supplement, false, 'never a second supplemental attempt in the same turn');
assert.equal(api.__notices.length, 1, 'no second notice');
assert.equal(decision.action, 'review');
assert.deepEqual(decision.reasonCodes.includes('supplement_spent'), true);

await observe(api, 'agent-b', 'FAIL 1 test', true);
decision = await checkFinalAnswer({ answer: 'Tests pass.', agentId: 'agent-b', turn: 1 }, api);
assert.equal(decision.supplement, true, 'the allowance is per agent, not global');
assert.equal(api.__notices.length, 2);

// Positive control for the automatic accept path.
api = makeApi({ answers: () => ({ support: { type: 'noul', noul: 0.95 } }) });
await observe(api, 'agent-c', 'tests: 12 passed');
decision = await checkFinalAnswer({ answer: 'All tests pass.', agentId: 'agent-c', turn: 1 }, api);
assert.equal(decision.action, 'accept');
assert.equal(decision.accepted, true);
assert.equal(decision.supplement, false);
assert.equal(api.__notices.length, 0);

// ── (b) judge failure: does not block and does not request a retry ─────────

for (const failure of [
  { name: 'unavailable', options: { answers: null } },
  { name: 'unconfigured', options: { configured: false } },
  { name: 'budget exhausted', options: { budget: false } },
]) {
  resetCompletionState();
  api = makeApi(failure.options);
  await observe(api, 'agent-f', 'FAIL 2 tests', true);
  decision = await checkFinalAnswer({ answer: 'All tests pass.', agentId: 'agent-f', turn: 1 }, api);
  assert.equal(decision.supplement, false, `${failure.name}: no retry is requested`);
  assert.equal(decision.accepted, false);
  assert.equal(api.__notices.length, 0, `${failure.name}: nothing is raised`);
  assert.equal(decision.action, 'unavailable');
}

// ── (b) shadow: the verdict is recorded and nothing is acted on ────────────

resetCompletionState();
api = makeApi({ shadow: true, answers: () => ({ support: { type: 'noul', noul: 0.05 } }) });
await observe(api, 'agent-s', 'FAIL 3 tests', true);
decision = await checkFinalAnswer({ answer: 'All tests pass.', agentId: 'agent-s', turn: 1 }, api);
assert.equal(decision.action, 'review', 'shadow acts on nothing');
assert.equal(decision.supplement, false);
assert.equal(decision.accepted, false);
assert.equal(api.__notices.length, 0);
assert.equal(api.__ledger.at(-1).wouldBe, 'supplement', 'the would-be supplement is recorded');
assert.equal(api.__ledger.at(-1).mode, 'shadow');
decision = await checkFinalAnswer({ answer: 'All tests pass.', agentId: 'agent-s', turn: 1 }, api);
assert.deepEqual(decision.reasonCodes.includes('supplement_spent'), true, 'shadow spends the allowance too');

// Positive control: the identical run in enforce raises the notice shadow withheld.
api = makeApi({ answers: () => ({ support: { type: 'noul', noul: 0.05 } }) });
await observe(api, 'agent-e', 'FAIL 3 tests', true);
decision = await checkFinalAnswer({ answer: 'All tests pass.', agentId: 'agent-e', turn: 1 }, api);
assert.equal(decision.action, 'supplement');
assert.equal(api.__notices.length, 1, 'the notice detector fires when it should');

// ── per-agent state is released through the disposer ───────────────────────

resetCompletionState();
api = makeApi({ answers: null });
await observe(api, 'agent-d', 'hello from the read tool');
await observe(api, 'agent-d', 'and again');
assert.match(recordedEvidence('agent-d'), /hello from the read tool/);
assert.equal(api.__registrations.length, 1, 'one registration per agent, not one per event');
api.__registrations[0]();
assert.equal(recordedEvidence('agent-d'), '', 'the per-agent disposer drops that agent evidence');

resetCompletionState();

console.log('GATE-T9-COMPLETION-OK');
