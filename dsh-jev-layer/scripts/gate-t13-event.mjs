/**
 * G-T13-2 (CID-22) — the delegation event, the shadow ledger, and the seam's
 * single owner.
 *
 * Three outcomes, from TICKETS.md:
 *
 *   (a) exactly one `question/evaluated` is published per delegated question,
 *       with the failing gate named in `reason` and the question's own text and
 *       option labels carried along;
 *   (b) in shadow the ledger holds the would-be answer and nothing is answered;
 *   (c) no module observes `user-questions/request` other than
 *       `answer.questions`.
 *
 * Positive controls, in the order the absence checks need them:
 *   - the same input in enforce answers and publishes nothing, against a rig
 *     that publishes an event for the same batch in shadow;
 *   - the seam detector fires on a real seam claim and on the literal seam
 *     string before it is believed to find no other owner;
 *   - the `ctx.on` detector fires on a synthetic call before the module is
 *     believed never to make one;
 *   - two delegations in one rig are counted per call id, so "exactly one" is
 *     not an accident of there being only one batch.
 *
 * Run from the repository root: `node scripts/gate-t13-event.mjs`
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import mod from '../packages/plugin/src/modules/answer-questions.js';
import { SEAMS } from '../packages/plugin/src/seams.js';
import { createCore } from '../packages/core/src/index.js';
import { createRegistry } from '../packages/plugin/src/registry.js';
import { fakeCtx, makeConfig } from '../packages/plugin/test/fixtures/harness.js';

const ID = 'answer.questions';
const ARMED = { phase: 'active', activation: 'armed' };
const HUMAN = Object.freeze({ answers: [{ id: 'q1', selected: ['human'] }] });
const MODULE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'plugin', 'src', 'modules');
/** The one seam a module may only declare if it is the answerer. */
const SEAM_TOKEN = /SEAMS\.USER_QUESTIONS_REQUEST|user-questions\/request/;
/** The one call a module must never make for its own seam. */
const CTX_ON = /ctx\s*\.\s*on\s*\(/;

/** One `AskUserQuestionItem`. */
function question(id, labels, extra = {}) {
  return { id, question: `Question ${id}?`, options: labels.map((label) => ({ label })), ...extra };
}

/** The vendor's `choice` answer. */
function choice(chosen, probabilities) {
  return { type: 'choice', choice: chosen, probabilities, confidence: probabilities[chosen] };
}

/** A request event shaped like `AskUserQuestionRequestEvent`. */
function request(questions, callId) {
  return { questions, agent: { id: 'agent-1' }, wait: { callId } };
}

/** Remove comments so a doc line naming a seam is not read as a seam claim. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * The real core and the real registry, so every service the module reads is the
 * shipped one. `mode` is the core's own shadow resolution: absent, the
 * answering feature defaults to shadow.
 */
async function rig({ goal = ARMED, mode = null, answers = {} } = {}) {
  const values = {
    endpoint: 'https://stub.invalid/v1/systemone',
    turnCeiling: 30,
    'answer.questions.budget': 2,
  };
  if (mode !== null) values[`${ID}.mode`] = mode;
  const core = createCore({
    settings: { get: (key) => values[key] },
    fetchImpl: async () => ({ status: 200, headers: { get: () => null }, json: async () => ({ answers }) }),
    now: () => 7_000,
    apiKey: 'stub-key',
    log: { warn() {} },
  });
  const ctx = fakeCtx({ services: { goals: { get: () => goal } } });
  const registry = createRegistry({ modules: [mod], ctx, config: makeConfig([mod], [ID]), core });
  const states = await registry.start();
  assert.equal(states[0].started, true, 'the module starts under the real registry');
  assert.equal(ctx.listenerCount(SEAMS.USER_QUESTIONS_REQUEST), 1, 'one shared listener on the seam');

  async function fire(req) {
    let nextCalls = 0;
    const out = await ctx.fire(SEAMS.USER_QUESTIONS_REQUEST, req, () => {
      nextCalls += 1;
      return HUMAN;
    });
    return { out, nextCalls };
  }
  return { core, ctx, registry, fire };
}

/** Every event a core channel received, in order. */
function eventsOf(core, name = SEAMS.INTERNAL_QUESTION_EVALUATED) {
  const seen = [];
  core.events.subscribe(name, (payload) => seen.push(payload));
  return seen;
}

// ── (c) The static check: one owner, and never `ctx.on` ────────────────────
{
  // Positive controls first: both detectors must fire on the shapes they exist
  // to find, or "found nothing" would prove nothing.
  assert.ok(SEAM_TOKEN.test('  seam: SEAMS.USER_QUESTIONS_REQUEST,'), 'the seam detector fires on a declaration');
  assert.ok(SEAM_TOKEN.test("ctx.on('user-questions/request', fn)"), 'the seam detector fires on the literal string');
  assert.ok(CTX_ON.test('ctx.on(SEAMS.TOOLS_RESULT, fn)'), 'the ctx.on detector fires on a synthetic call');

  const files = readdirSync(MODULE_DIR).filter((name) => name.endsWith('.js'));
  assert.ok(files.length > 1, 'the module directory holds more than the answerer');
  const offenders = [];
  let owner = null;
  for (const name of files) {
    const code = stripComments(readFileSync(join(MODULE_DIR, name), 'utf8'));
    if (!SEAM_TOKEN.test(code)) continue;
    if (name === 'answer-questions.js') owner = name;
    else offenders.push(name);
  }
  assert.equal(owner, 'answer-questions.js', 'the answerer declares the seam it owns');
  assert.deepEqual(offenders, [], 'no other module observes user-questions/request');
  assert.equal(CTX_ON.test(stripComments(readFileSync(join(MODULE_DIR, 'answer-questions.js'), 'utf8'))), false,
    'the module never calls ctx.on; the registry owns the listener');
}

// ── (b) Shadow: the would-be answer is recorded and nothing is answered ────
{
  const answers = { q1: choice('a', { a: 0.95, b: 0.03 }), q2: choice('c', { c: 0.93, d: 0.02 }) };
  const { core, registry, fire } = await rig({ answers });
  const seen = eventsOf(core);
  const event = request([question('q1', ['a', 'b']), question('q2', ['c', 'd'])], 'call-shadow');
  const { out, nextCalls } = await fire(event);

  assert.equal(nextCalls, 1, 'shadow delegates anyway: the continuation ran once');
  assert.equal(out, HUMAN, 'shadow answers nothing; the human answer is what comes back');
  assert.equal(seen.length, 2, 'one event per question of the delegated batch');
  for (const payload of seen) {
    assert.equal(payload.callId, 'call-shadow', 'the event carries the call id');
    assert.equal(payload.outcome, 'delegated', 'the outcome is a delegation');
    assert.equal(payload.reason, 'shadow', 'every gate held; only the mode stopped the answer');
    assert.equal(typeof payload.at, 'number', 'the event carries its time');
    assert.equal(payload.agent, event.agent, 'the event names the asking agent, so the nag has a recipient');
  }
  assert.deepEqual(
    seen.map((payload) => payload.question),
    ['Question q1?', 'Question q2?'],
    'each event carries its own question',
  );
  assert.deepEqual(seen.map((payload) => payload.options), [['a', 'b'], ['c', 'd']], 'and its own option labels');

  const rows = core.ledger.read(ID, 'call-shadow');
  assert.equal(rows.length, 2, 'one ledger row per question');
  assert.deepEqual(rows.map((row) => row.decision), ['delegated:shadow', 'delegated:shadow'], 'the mode is the recorded reason');
  assert.deepEqual(rows.map((row) => row.mode), ['shadow', 'shadow'], 'the rows are marked shadow');
  assert.deepEqual(rows.map((row) => row.wouldBe), ['a', 'c'], 'the would-be answer is recorded');
  for (const row of rows) {
    assert.ok(Object.keys(row.probabilities).length >= 2, 'the distribution accompanies the would-be answer');
  }
  await registry.stop();
}

// ── (a) The positive control: enforce answers the same batch and is silent ─
{
  const answers = { q1: choice('a', { a: 0.95, b: 0.03 }), q2: choice('c', { c: 0.93, d: 0.02 }) };
  const { core, registry, fire } = await rig({ answers, mode: 'enforce' });
  const seen = eventsOf(core);
  const { out, nextCalls } = await fire(request([question('q1', ['a', 'b']), question('q2', ['c', 'd'])], 'call-enforce'));

  assert.deepEqual(out, { answers: [{ id: 'q1', selected: ['a'] }, { id: 'q2', selected: ['c'] }] }, 'the batch is answered');
  assert.equal(nextCalls, 0, 'nothing is delegated');
  assert.equal(seen.length, 0, 'an answered batch publishes no delegation event');
  assert.deepEqual(
    core.ledger.read(ID, 'call-enforce').map((row) => row.decision),
    ['answered', 'answered'],
    'the ledger records the answer',
  );
  await registry.stop();
}

// ── (a) Exactly one event per delegated question, counted per call ──────────
{
  const { core, registry, fire } = await rig({ mode: 'enforce' });
  const seen = eventsOf(core);

  const first = await fire(request([question('q1', ['a', 'b']), question('q2', ['same', 'same'])], 'call-a'));
  assert.equal(first.nextCalls, 1, 'the batch is delegated');
  const second = await fire(request([question('q9', ['only-one'])], 'call-b'));
  assert.equal(second.nextCalls, 1, 'the second batch is delegated too');

  const byCall = (callId) => seen.filter((payload) => payload.callId === callId);
  assert.equal(byCall('call-a').length, 2, 'exactly one event per question of the first batch');
  assert.equal(byCall('call-b').length, 1, 'and one for the second batch, not a second copy');
  assert.deepEqual(byCall('call-a').map((payload) => payload.reason), ['batch', 'labels'], 'the failing gate is named');
  assert.deepEqual(byCall('call-b').map((payload) => payload.reason), ['free-text'], 'and so is the next one');
  assert.deepEqual(byCall('call-a').map((payload) => payload.question), ['Question q1?', 'Question q2?'], 'the events follow the batch order');
  assert.deepEqual(byCall('call-a')[1].options, ['same', 'same'], 'the colliding labels are carried');

  // The ledger holds the same reason, so the nag can read either.
  assert.deepEqual(
    core.ledger.read(ID, 'call-a').map((row) => row.decision),
    ['delegated:batch', 'delegated:labels'],
    'the ledger names the same failing gate',
  );
  assert.equal(core.ledger.read(ID, 'call-b')[0].decision, 'delegated:free-text', 'and the second batch too');
  await registry.stop();
}

// ── The event does not invent a recipient ──────────────────────────────────
{
  // Positive control for the check below: the shadow case proves the agent is
  // carried when the request has one.
  const { core, registry, fire } = await rig({ mode: 'enforce' });
  const seen = eventsOf(core);
  const { out, nextCalls } = await fire({ questions: [question('q1', ['a', 'b'])], wait: { callId: 'call-nobody' } });

  assert.equal(nextCalls, 1, 'a request with no agent is delegated');
  assert.equal(out, HUMAN, 'and the human path returns');
  assert.equal(seen.length, 1, 'exactly one event for the one delegated question');
  assert.equal(seen[0].reason, 'no-agent', 'the event names the gate that failed');
  assert.equal(seen[0].agent ?? null, null, 'and carries no recipient it does not have');
  await registry.stop();
}

console.log('GATE-T13-EVENT-OK');
