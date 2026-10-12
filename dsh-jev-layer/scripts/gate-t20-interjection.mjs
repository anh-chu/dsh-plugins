/**
 * G-T20-1 (CID-24) — `route.interjection` acceptance gate.
 *
 * The outcome under test: the `agent/pre-step` decision comes back deep-equal to
 * the one the harness would have produced, and a user correction queued while the
 * turn was running is routed to the next step exactly once. Nothing on the
 * observed event or in the agent's inbox is rewritten.
 *
 * Order matters: every absence assertion below is preceded by the case that
 * proves the detector fires — case 1 is the positive control for cases 3 to 8,
 * and case 9 asserts against a deliberately altered decision so the deep-equal
 * check is shown to be able to fail.
 *
 * The module is exercised twice over: directly against a synthetic api (no
 * network, no host, no core) so the injected message and the ledger row are read
 * from the call itself, and through the real registry's broadcast dispatch
 * (`packages/plugin/test/fixtures/harness.js`) so "the decision passes through
 * unchanged" is proven on the path the host actually uses.
 *
 * Run from the repository root: `node scripts/gate-t20-interjection.mjs`
 */
import assert from 'node:assert/strict';

import { createRegistry } from '../packages/plugin/src/registry.js';
import route from '../packages/plugin/src/modules/route-interjection.js';
import { SEAMS, fakeAgent, fakeCore, fakeCtx, makeConfig } from '../packages/plugin/test/fixtures/harness.js';

const ID = 'route.interjection';
const QUESTION_ID = 'correction';
const MARKER = 'GATE-T20-INTERJECTION-OK';

// ── fixtures ─────────────────────────────────────────────────────────────

/** One user-authored message, as the harness writes it. */
function userMessage(id, text, kind = 'user') {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind },
  };
}

/**
 * A fake agent with the two things this module touches: the pending turn queue
 * and `inject`. The scoped context comes from the shared fixture, so the
 * per-agent registration the module makes is the real one the registry uses.
 */
function makeAgent(id, pending = []) {
  const agent = fakeAgent(id);
  const injected = [];
  agent.inbox = { nextTurn: pending, nextStep: [] };
  agent.inject = (message) => {
    injected.push(message);
  };
  return { agent, inbox: agent.inbox, injected };
}

/** The `agent/pre-step` payload. `turn`/`step` are what the harness passes. */
function stepEvent(agent, { turn = 1, step = 2, messages = [] } = {}) {
  return { agent, messages, turn, step, signal: undefined };
}

/** Snapshot of everything a broadcast observer must leave alone. */
function snapshot(event) {
  return JSON.parse(JSON.stringify(event));
}

/**
 * The synthetic module api. Config returns nothing unless a case overrides it,
 * and every channel the module may use is recorded.
 */
function makeApi({
  probability = 0.9,
  answer,
  judgeError = false,
  configured = true,
  shadow = false,
  budget = true,
  config = {},
} = {}) {
  const ledger = [];
  const calls = [];
  const registered = [];
  const api = {
    id: ID,
    config: { get: (key) => config[key] },
    judge: {
      configured,
      ask: async (state, questions, opts) => {
        calls.push({ state, questions, opts });
        if (judgeError) throw new Error('judge down');
        if (answer !== undefined) return answer;
        return { [QUESTION_ID]: { noul: probability } };
      },
    },
    budget: { tryAcquire: () => budget },
    ledger: { append: (row) => ledger.push(row) },
    shadow: { isShadow: () => shadow },
    /**
     * The container's `api.inject` is a thin bridge to `Agent.inject`; the
     * double does the same, so a delivered correction is read from the agent
     * exactly as the host would record it.
     */
    inject: (agent, message) => {
      if (typeof agent?.inject !== 'function') return false;
      agent.inject(message);
      return true;
    },
    registerAgent: (agent, setup) => {
      registered.push(agent);
      const teardown = typeof setup === 'function' ? setup(agent.ctx) : undefined;
      return () => {
        if (typeof teardown === 'function') teardown();
      };
    },
    log: { warn: () => {} },
  };
  return { api, ledger, calls, registered };
}

// ── 1. positive control: a queued correction is routed, once, correctly ──────
{
  const correction = userMessage('u-1', 'Stop: the endpoint moved to /v2.');
  const { agent, inbox, injected } = makeAgent('agent-1', [correction]);
  const { api, ledger, calls, registered } = makeApi();
  const event = stepEvent(agent, { turn: 1, step: 2 });
  const before = snapshot(event);

  const out = await route.handle(event, api);

  assert.equal(out, undefined, 'a broadcast observer returns undefined, never a rewritten decision');
  assert.equal(injected.length, 1, 'one queued correction produces exactly one route');

  const message = injected[0];
  assert.equal(message.role, 'user', 'the delivered context is a user-role message');
  assert.notEqual(message.id, correction.id, 'the delivered message has its own identity, not the queued one');
  assert.equal(typeof message.id, 'string');
  assert.ok(message.id.length > 0, 'the identity is present');
  assert.equal(message.source.kind, ID, 'the injected context carries this module source kind');
  assert.notEqual(message.source.kind, 'user', 'an unlabelled context would render as a user prompt');
  assert.equal(message.source.form, 'notice', 'the form is the one the harness fixes for a notice');
  assert.ok(
    typeof message.source.summary === 'string' && message.source.summary.length <= 120,
    'a notice summary is bounded to the harness bound of 120 characters',
  );
  assert.equal(message.content.length, 1, 'text only: attachments and images are not carried');
  assert.equal(message.content[0].type, 'text');
  assert.match(message.content[0].text, /endpoint moved to \/v2/, 'the correction text is carried');
  assert.ok(Object.isFrozen(message), 'the built message is frozen, like the harness freezes its own');

  assert.deepEqual(snapshot(event), before, 'the observed payload comes back unchanged');
  assert.equal(inbox.nextTurn.length, 1, 'the original stays queued: the inbox is not rewritten');
  assert.equal(inbox.nextTurn[0], correction, 'the exact pending message is still pending');

  assert.equal(calls.length, 1, 'exactly one judge request');
  assert.equal(registered.length, 1, 'the per-agent state was registered through api.registerAgent');
  assert.equal(registered[0], agent);

  const row = ledger.filter((entry) => entry.decision === 'route');
  assert.equal(row.length, 1, 'the route is recorded');
  assert.equal(row[0].featureId, ID, 'the record is keyed by the module id');
  assert.equal(row[0].callId, 'u-1', 'the record names the message it routed');
  assert.equal(row[0].question, QUESTION_ID, 'the record names the question');
  assert.equal(row[0].wouldBe, 'inject', 'the record names the delivery it made');
  assert.equal(row[0].mode, 'enforce', 'the record is in enforce mode');
  assert.equal(typeof row[0].probabilities[QUESTION_ID], 'number', 'the answer that decided it is kept');
}

// ── 2. the same pending message is judged once, however often pre-step fires ──
{
  const correction = userMessage('u-2', 'Use branch release-2, not main.');
  const { agent, injected } = makeAgent('agent-2', [correction]);
  const { api, calls } = makeApi();

  await route.handle(stepEvent(agent, { turn: 1, step: 2 }), api);
  await route.handle(stepEvent(agent, { turn: 1, step: 3 }), api);
  await route.handle(stepEvent(agent, { turn: 2, step: 1 }), api);

  assert.equal(injected.length, 1, 'one correction is routed once, not once per step');
  assert.equal(calls.length, 1, 'and judged once');

  // The control for the same detector: a new pending message does route.
  agent.inbox.nextTurn.push(userMessage('u-3', 'Also run the linter.'));
  await route.handle(stepEvent(agent, { turn: 2, step: 2 }), api);
  assert.equal(injected.length, 2, 'a second, new correction still routes');
}

// ── 3. a queue drains one message per step, each exactly once ───────────────
{
  const first = userMessage('u-4', 'The failing test is in the parser, not the loader.');
  const second = userMessage('u-5', 'Skip the network test; this host is offline.');
  const { agent, injected } = makeAgent('agent-3', [first, second]);
  const { api } = makeApi();

  await route.handle(stepEvent(agent, { turn: 1, step: 2 }), api);
  await route.handle(stepEvent(agent, { turn: 1, step: 2 }), api);
  await route.handle(stepEvent(agent, { turn: 1, step: 3 }), api);
  await route.handle(stepEvent(agent, { turn: 1, step: 4 }), api);

  assert.equal(injected.length, 2, 'each queued correction routes exactly once');
  assert.match(injected[0].content[0].text, /parser/, 'the older correction goes first');
  assert.match(injected[1].content[0].text, /network test/, 'the next one follows on the next step');
}

// ── 4. a message that is not the user's is left queued ──────────────────────
{
  const notice = userMessage('u-6', 'Background job 3 finished.', 'tool-jobs');
  const { agent, injected } = makeAgent('agent-4', [notice]);
  const { api, calls, ledger } = makeApi();

  await route.handle(stepEvent(agent), api);

  assert.equal(injected.length, 0, 'another producer context is queued, not routed');
  assert.equal(calls.length, 0, 'and never reaches the judge');
  assert.equal(ledger.length, 0, 'and records nothing: there was no candidate');
}

// ── 5. the judge decides: below threshold it stays queued, at it routes ─────
{
  const low = makeAgent('agent-5', [userMessage('u-7', 'Actually, hold off on the rename.')]);
  const lowApi = makeApi({ probability: 0.2 });
  await route.handle(stepEvent(low.agent), lowApi.api);
  assert.equal(low.injected.length, 0, 'a declined candidate delivers nothing');
  const declined = lowApi.ledger.find((entry) => entry.decision === 'queued');
  assert.ok(declined, 'the refusal is recorded, so it does not look like a module that never fired');
  assert.equal(declined.wouldBe, 'queue');

  // The control for the threshold: the same candidate at the default 0.5 routes.
  const high = makeAgent('agent-6', [userMessage('u-8', 'Actually, hold off on the rename.')]);
  const highApi = makeApi({ probability: 0.8 });
  await route.handle(stepEvent(high.agent), highApi.api);
  assert.equal(high.injected.length, 1, 'a candidate at or above the threshold routes');

  // A configured threshold moves the line.
  const strict = makeAgent('agent-7', [userMessage('u-9', 'Maybe rename it later?')]);
  const strictApi = makeApi({ probability: 0.8, config: { threshold: 0.95 } });
  await route.handle(stepEvent(strict.agent), strictApi.api);
  assert.equal(strict.injected.length, 0, 'a raised threshold is honoured');
}

// ── 6. every judge failure is "do nothing", and it is recorded ──────────────
{
  const cases = [
    ['a null answer', makeApi({ answer: null })],
    ['a raising judge', makeApi({ judgeError: true })],
    ['an unconfigured judge', makeApi({ configured: false })],
    ['an exhausted budget', makeApi({ budget: false })],
  ];
  for (const [label, built] of cases) {
    const { agent, injected } = makeAgent(`agent-fail-${label}`, [userMessage(`u-${label}`, 'Change the plan.')]);
    await route.handle(stepEvent(agent), built.api);
    assert.equal(injected.length, 0, `${label}: nothing is delivered`);
    assert.ok(
      built.ledger.length >= 1,
      `${label}: the outcome is recorded rather than silently skipped`,
    );
  }

  const noBudget = makeApi({ budget: false });
  const target = makeAgent('agent-fail-budget-2', [userMessage('u-budget-2', 'Change the plan.')]);
  await route.handle(stepEvent(target.agent), noBudget.api);
  assert.equal(noBudget.calls.length, 0, 'an exhausted budget never reaches the judge');
}

// ── 7. shadow records the route it would have made and delivers nothing ─────
{
  const { agent, injected } = makeAgent('agent-8', [userMessage('u-10', 'Use the other fixture.')]);
  const { api, ledger } = makeApi({ shadow: true });

  await route.handle(stepEvent(agent), api);

  assert.equal(injected.length, 0, 'shadow injects nothing');
  const row = ledger.find((entry) => entry.decision === 'route');
  assert.ok(row, 'shadow records the decision it would have taken');
  assert.equal(row.mode, 'shadow', 'the record is marked shadow');
  assert.equal(row.wouldBe, 'inject', 'the would-be delivery is named');
}

// ── 8. text-free content is skipped, not delivered empty ────────────────────
{
  const { agent, injected } = makeAgent('agent-9', [userMessage('u-11', '   ')]);
  const { api, ledger } = makeApi();

  await route.handle(stepEvent(agent), api);

  assert.equal(injected.length, 0, 'a message with no text is not routed');
  assert.equal(ledger.filter((entry) => entry.decision === 'skipped').length, 1, 'the skip is recorded');
}

// ── 9. the host's own path: the decision passes through unchanged ────────────
{
  const correction = userMessage('u-12', 'Keep the old call site.');
  const { agent, injected } = makeAgent('agent-10', [correction]);
  const modules = [route];
  const ctx = fakeCtx();
  const { core, appended } = fakeCore({
    judge: {
      configured: true,
      lastError: null,
      ask: async () => ({ [QUESTION_ID]: { noul: 0.9 } }),
    },
  });
  const registry = createRegistry({ modules, ctx, config: makeConfig(modules, [ID]), core });

  const states = await registry.start();
  assert.deepEqual(
    states.map((state) => ({ id: state.id, seam: state.seam, seamClass: state.seamClass })),
    [{ id: ID, seam: SEAMS.AGENT_PRE_STEP, seamClass: 'broadcast' }],
    'the descriptor declares the frozen broadcast seam',
  );
  assert.equal(ctx.listenerCount(SEAMS.AGENT_PRE_STEP), 1, 'the registry registers one listener for the seam');

  const event = stepEvent(agent, { turn: 3, step: 4 });
  const before = snapshot(event);
  const pendingBefore = agent.inbox.nextTurn.slice();

  let nextCalls = 0;
  let produced;
  const returned = await ctx.fire(SEAMS.AGENT_PRE_STEP, event, () => {
    nextCalls += 1;
    produced = { kind: 'enter', messages: [userMessage('m-1', 'the admitted batch')] };
    return produced;
  });

  assert.equal(nextCalls, 1, 'the waterfall continuation runs exactly once');
  assert.deepEqual(returned, produced, 'the pre-step decision comes back deep-equal to its input');
  assert.equal(returned, produced, 'and it is the harness decision itself, not a rebuilt copy');
  // The positive control for that equality check: an altered decision is caught.
  assert.notDeepEqual(returned, { kind: 'enter', messages: [] }, 'the deep-equal check can fail');

  assert.deepEqual(snapshot(event), before, 'the payload is still what the harness handed over');
  assert.deepEqual(agent.inbox.nextTurn, pendingBefore, 'the inbox was not rewritten by the observer');
  assert.equal(agent.inbox.nextTurn[0], correction, 'the pending correction is still the queued object');
  assert.equal(injected.length, 1, 'the correction was still routed through the container api');
  assert.equal(injected[0].source.kind, ID, 'the container delivered this module labelled message');
  assert.equal(appended.filter((row) => row.decision === 'route').length, 1, 'the route reaches the shared ledger');

  await registry.stop();
  assert.equal(ctx.listenerCount(SEAMS.AGENT_PRE_STEP), 0, 'stop() releases the shared listener');
  assert.equal(agent.liveEffects(), 0, 'stop() releases the per-agent registration');
}

console.log(MARKER);
