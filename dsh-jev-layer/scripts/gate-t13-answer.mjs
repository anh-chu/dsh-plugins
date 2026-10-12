/**
 * G-T13-1 (CID-11) — `answer.questions` answers a batch only when every hard
 * gate holds, and delegates when any one of them breaks.
 *
 * The positive control comes first, on the rig every later case reuses: with an
 * armed goal and a decisive stub judge the whole two-question batch is answered,
 * the continuation is never called and no event is published. Only then is each
 * gate broken in turn — disarmed, paused, no goal, no agent, a free-text
 * question, multi-select, duplicate labels, a label colliding with the injected
 * decline option, a probability below the floor, a margin below the floor,
 * `ask-human` chosen, an unreadable answer, an unconfigured judge, a judge that
 * throws, a judge that never answers, a refused budget and an expired deadline —
 * and each one must call the continuation exactly once and return what the
 * human's path returned.
 *
 * A partial batch is asserted against directly: a two-question call with one bad
 * question returns the human's answer, never a one-item answer object.
 *
 * The last section runs the real registry and the real core, so the handle
 * signature, the single seam listener and the continuation the registry offers
 * are exercised rather than assumed.
 *
 * Run from the repository root: `node scripts/gate-t13-answer.mjs`
 */
import assert from 'node:assert/strict';

import mod from '../packages/plugin/src/modules/answer-questions.js';
import { SEAMS } from '../packages/plugin/src/seams.js';
import { createCore } from '../packages/core/src/index.js';
import { createRegistry } from '../packages/plugin/src/registry.js';
import { fakeCtx, makeConfig } from '../packages/plugin/test/fixtures/harness.js';

const ID = 'answer.questions';
const CALL_ID = 'call-1';
const ARMED = { phase: 'active', activation: 'armed' };
/** What the human's path returns. A delegation must hand this back unchanged. */
const HUMAN = Object.freeze({ answers: [{ id: 'q1', selected: ['human'] }] });

/** One `AskUserQuestionItem`. */
function question(id, labels, extra = {}) {
  return { id, question: `Question ${id}?`, options: labels.map((label) => ({ label })), ...extra };
}

/** The vendor's `choice` answer. */
function choice(chosen, probabilities) {
  return { type: 'choice', choice: chosen, probabilities, confidence: probabilities[chosen] };
}

/** A stub judge: a map of question id to answer, or `null`. */
function stub(answers) {
  return () => answers;
}

/**
 * A synthetic module api. Every service docs/CONTRACT.md names is present, so a
 * failure in a case is the module's and not the rig's.
 */
function makeApi({
  judge = stub({}),
  goal = ARMED,
  configured = true,
  shadow = false,
  budget = true,
  config = {},
} = {}) {
  const rows = [];
  const events = [];
  const calls = [];
  const api = {
    id: ID,
    config: { get: (key) => config[key] },
    judge: {
      configured,
      lastError: null,
      async ask(state, questions, opts) {
        calls.push({ state, questions, opts });
        return judge(state, questions, opts);
      },
    },
    budget: { tryAcquire: () => budget },
    ledger: { append: (row) => rows.push(row) },
    shadow: { isShadow: () => shadow },
    events: {
      publish(name, payload) {
        events.push({ name, payload });
        return 1;
      },
    },
    goals: { get: () => goal },
    log: { warn() {} },
  };
  return { api, rows, events, calls };
}

/** Fire one request at the module and count the continuation. */
async function drive(request, api) {
  let nextCalls = 0;
  const out = await mod.handle(request, api, () => {
    nextCalls += 1;
    return HUMAN;
  });
  return { out, nextCalls };
}

/**
 * A request event shaped like `AskUserQuestionRequestEvent`. `null` for the
 * agent omits the field, because `request.agent` is optional in the event type
 * and an absent agent is not the same fact as a defaulted one.
 */
function request(questions, agent = { id: 'agent-1' }, callId = CALL_ID) {
  const event = { questions, wait: { callId } };
  if (agent !== null) event.agent = agent;
  return event;
}

/**
 * The shared shape of every delegating case: one continuation call, the human's
 * answer back, one ledger row and one event per question, all naming `reason`.
 */
async function expectsDelegate(label, reason, rig, req = request([question('q1', ['a', 'b'])])) {
  const { out, nextCalls } = await drive(req, rig.api);
  assert.equal(nextCalls, 1, `${label}: the continuation ran exactly once`);
  assert.equal(out, HUMAN, `${label}: the human's answer came back, not an answer batch`);
  assert.equal(rig.rows.length, req.questions.length, `${label}: one ledger row per question`);
  assert.equal(rig.events.length, req.questions.length, `${label}: one event per delegated question`);
  for (const row of rig.rows) {
    assert.equal(row.featureId, ID, `${label}: the row is keyed by the module id`);
    assert.equal(row.callId, req.wait.callId, `${label}: the row carries the call id`);
    assert.equal(row.decision, `delegated:${reason}`, `${label}: the reason is recorded`);
  }
  for (const event of rig.events) {
    assert.equal(event.name, SEAMS.INTERNAL_QUESTION_EVALUATED, `${label}: the plugin-internal event`);
    assert.equal(event.payload.outcome, 'delegated', `${label}: the outcome is a delegation`);
    assert.equal(event.payload.reason, reason, `${label}: the event names the failing gate`);
  }
  return out;
}

// ── 1. Positive control: every gate holds, the whole batch is answered ──────
{
  const judge = stub({ q1: choice('a', { a: 0.95, b: 0.03 }), q2: choice('c', { c: 0.91, d: 0.04 }) });
  const rig = makeApi({ judge });
  const batch = [question('q1', ['a', 'b']), question('q2', ['c', 'd'])];
  const { out, nextCalls } = await drive(request(batch), rig.api);

  assert.deepEqual(
    out,
    { answers: [{ id: 'q1', selected: ['a'] }, { id: 'q2', selected: ['c'] }] },
    'the whole batch is answered, one item per question in batch order',
  );
  assert.equal(nextCalls, 0, 'a claimed request never calls the continuation');
  assert.equal(rig.events.length, 0, 'an answered batch publishes nothing');
  assert.equal(rig.rows.length, 2, 'both decisions reach the ledger');
  for (const row of rig.rows) {
    assert.equal(row.decision, 'answered', 'the row names the decision');
    assert.equal(row.mode, 'enforce', 'the row carries the mode');
    assert.equal(row.threshold, 0.9, 'the row carries the probability threshold');
    assert.ok(Object.keys(row.probabilities).length >= 2, 'the row carries the distribution');
  }
  assert.deepEqual(
    rig.rows.map((row) => row.wouldBe),
    ['a', 'c'],
    'the row carries the chosen label',
  );
  assert.equal(rig.calls.length, 1, 'the batch costs exactly one judgment');
  assert.equal(rig.calls[0].opts.featureId, ID, 'the judgment is charged to this feature');
  assert.equal(rig.calls[0].opts.failOpen, 'delegate', 'the call site fail-open is a delegation');
}

// ── 2. Gate 1: the autonomy signal ─────────────────────────────────────────
{
  const disarmed = makeApi({ goal: { phase: 'active', activation: 'disarmed' } });
  await expectsDelegate('disarmed', 'disarmed', disarmed);

  const paused = makeApi({ goal: { phase: 'paused', activation: 'armed' } });
  await expectsDelegate('paused', 'goal-inactive', paused);

  const noGoal = makeApi({ goal: null });
  await expectsDelegate('no goal', 'no-goal', noGoal);

  const noAgent = makeApi();
  await expectsDelegate('no agent', 'no-agent', noAgent, request([question('q1', ['a', 'b'])], null));

  // An armed goal is what makes the difference: the same rig answers in case 1.
  assert.equal(disarmed.calls.length, 0, 'a refused autonomy gate costs no judgment');
}

// ── 3. Gate 2: the whole batch is answerable ───────────────────────────────
{
  const freeText = makeApi();
  await expectsDelegate('free text', 'free-text', freeText, request([question('q1', ['only-one'])]));

  const multi = makeApi();
  await expectsDelegate('multi-select', 'multi-select', multi, request([{ ...question('q1', ['a', 'b']), multiSelect: true }]));

  const blank = makeApi();
  await expectsDelegate('a blank label', 'free-text', blank, request([{ id: 'q1', question: 'x?', options: [{ label: '' }, { label: 'b' }] }]));

  const tooMany = makeApi();
  const wide = { id: 'q1', question: 'x?', options: Array.from({ length: 255 }, (_, index) => ({ label: `o${index}` })) };
  await expectsDelegate('more options than a judgment accepts', 'batch', tooMany, request([wide]));
}

// ── 4. Gate 3: labels are unambiguous ──────────────────────────────────────
{
  const duplicate = makeApi();
  await expectsDelegate('duplicate labels', 'labels', duplicate, request([question('q1', ['a', 'a'])]));

  const collides = makeApi();
  await expectsDelegate('a label equal to the decline option', 'labels', collides, request([question('q1', ['ask-human', 'b'])]));
}

// ── 5. Gate 4: Jev is decisive ─────────────────────────────────────────────
{
  const thin = makeApi({ judge: stub({ q1: choice('a', { a: 0.9, b: 0.7 }) }) });
  await expectsDelegate('a margin below the floor', 'margin', thin);

  const low = makeApi({ judge: stub({ q1: choice('a', { a: 0.8, b: 0.05 }) }) });
  await expectsDelegate('a probability below the floor', 'probability', low);

  const unreadable = makeApi({ judge: stub({ q1: choice('a', { a: 0.95, b: 0.02 }) }) });
  await expectsDelegate('a choice outside the candidates', 'judge', unreadable, request([question('q1', ['x', 'y'])]));

  const noSpread = makeApi({ judge: stub({ q1: { type: 'choice', choice: 'a', confidence: 0.99 } }) });
  await expectsDelegate('no distribution to measure a margin against', 'judge', noSpread);

  const empty = makeApi({ judge: stub(null) });
  await expectsDelegate('a judge that answers nothing', 'judge', empty);

  const throwing = makeApi({ judge: () => { throw new Error('judge exploded'); } });
  await expectsDelegate('a judge that throws', 'judge', throwing);

  const unconfigured = makeApi({ configured: false });
  await expectsDelegate('an unconfigured judge', 'judge', unconfigured);
  assert.equal(unconfigured.calls.length, 0, 'no request leaves the machine without a credential');

  const broke = makeApi({ budget: false });
  await expectsDelegate('a refused budget', 'budget', broke);
  assert.equal(broke.calls.length, 0, 'a refused budget costs no judgment');

  // The deadline bounds the wait even when the judge never settles. Positive
  // control: the same rig with a decisive judge answers (case 1), so the
  // deadline path is not the only outcome this rig can produce.
  const hanging = makeApi({ judge: () => new Promise(() => {}), config: { deadlineMs: 50 } });
  const started = Date.now();
  await expectsDelegate('the deadline', 'deadline', hanging);
  assert.ok(Date.now() - started < 2_000, 'the deadline bounded the wait');
}

// ── 6. Gate 5: the verdict is not the decline option ───────────────────────
{
  const declined = makeApi({ judge: stub({ q1: choice('ask-human', { 'ask-human': 0.95, a: 0.02, b: 0.01 }) }) });
  await expectsDelegate('the decline option chosen', 'ask-human', declined);
}

// ── 7. A partial batch is never sent ───────────────────────────────────────
{
  const rig = makeApi({ judge: stub({ q1: choice('a', { a: 0.95, b: 0.03 }) }) });
  const batch = [question('q1', ['a', 'b']), question('q2', ['only-one'])];
  const { out, nextCalls } = await drive(request(batch), rig.api);
  assert.equal(nextCalls, 1, 'the batch as a whole is delegated');
  assert.equal(out, HUMAN, 'the human answers the good question too; no partial batch leaves');
  assert.deepEqual(
    rig.rows.map((row) => row.decision),
    ['delegated:batch', 'delegated:free-text'],
    'the bad question names its gate and its sibling names the batch',
  );
  assert.equal(rig.calls.length, 0, 'an unanswerable batch costs no judgment');
}

// ── 8. An empty batch names no question, so there is nothing to answer ─────
{
  const rig = makeApi();
  const { out, nextCalls } = await drive(request([]), rig.api);
  assert.equal(nextCalls, 1, 'an empty batch is delegated');
  assert.equal(out, HUMAN, 'and the human path returns');
  assert.equal(rig.rows.length, 0, 'no row for a question that does not exist');
  assert.equal(rig.events.length, 0, 'and no event');
}

// ── 9. The real registry and the real core ─────────────────────────────────
{
  const answers = { q1: choice('a', { a: 0.95, b: 0.03 }) };
  const coreFor = ({ goal, mode }) => {
    const values = {
      endpoint: 'https://stub.invalid/v1/systemone',
      turnCeiling: 30,
      'answer.questions.budget': 2,
    };
    if (mode !== null) values[`${ID}.mode`] = mode;
    return createCore({
      settings: { get: (key) => values[key] },
      fetchImpl: async () => ({ status: 200, headers: { get: () => null }, json: async () => ({ answers }) }),
      now: () => 1_000,
      apiKey: 'stub-key',
      log: { warn() {} },
    });
  };
  const run = async (goal) => {
    const core = coreFor({ goal, mode: 'enforce' });
    const ctx = fakeCtx({ services: { goals: { get: () => goal } } });
    const registry = createRegistry({ modules: [mod], ctx, config: makeConfig([mod], [ID]), core });
    const states = await registry.start();
    assert.equal(states[0].started, true, 'the module starts under the real registry');
    assert.equal(ctx.listenerCount(SEAMS.USER_QUESTIONS_REQUEST), 1, 'one shared listener on the seam');
    let nextCalls = 0;
    const out = await ctx.fire(SEAMS.USER_QUESTIONS_REQUEST, request([question('q1', ['a', 'b'])], { id: 'agent-live' }, 'call-live'), () => {
      nextCalls += 1;
      return HUMAN;
    });
    return { core, out, nextCalls, registry };
  };

  const enforced = await run(ARMED);
  assert.deepEqual(enforced.out, { answers: [{ id: 'q1', selected: ['a'] }] }, 'the answer travels back through the registry');
  assert.equal(enforced.nextCalls, 0, 'the continuation is never offered the request');
  assert.equal(enforced.core.ledger.read(ID, 'call-live')[0].decision, 'answered', 'the decision is in the real ledger');
  await enforced.registry.stop();

  const delegated = await run({ phase: 'active', activation: 'disarmed' });
  assert.equal(delegated.out, HUMAN, 'a disarmed goal delegates through the registry');
  assert.equal(delegated.nextCalls, 1, 'and the continuation ran once');
  assert.equal(delegated.core.ledger.read(ID, 'call-live')[0].decision, 'delegated:disarmed', 'the reason is in the real ledger');
  await delegated.registry.stop();
}

console.log('GATE-T13-ANSWER-OK');
