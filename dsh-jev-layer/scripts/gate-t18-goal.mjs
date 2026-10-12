/**
 * G-T18-1 (CID-19) — `supervise.goal`.
 *
 * Two outcomes, from TICKETS.md:
 *
 *   (a) a stalled run raises exactly one notice after the configured rounds, and
 *       a second run of stalled rounds raises none; and
 *   (b) the event the module is handed comes back identical — the deep-equality
 *       assertion is the one the ticket names, and identity is asserted too,
 *       because a broadcast observer on `agent/pre-step` shares the waterfall
 *       with `select.skill` and may never rewrite the step decision.
 *
 * The progress fixture follows the real loop: a text-only turn ends after step 1
 * (`step()` returns `{ kind: 'completed' }` and `turnEnds` breaks the loop),
 * while a tool call that does not conclude the turn forces a pre-step with
 * `step >= 2`. A stalled round is therefore one `step: 1` event; a working round
 * is `step: 1` followed by `step: 2`.
 *
 * Positive controls, in the order the absence checks need them:
 *   - the detector sees the notice after the threshold before any "no notice"
 *     case is believed;
 *   - a run with tool work and a run with new user input both stay silent,
 *     against the same fixture that does fire when neither is present;
 *   - shadow raises nothing while the same fixture in enforce mode raises one;
 *   - the goal-service detector fires on a probe line before it is believed
 *     silent about this module;
 *   - the registry's per-agent registration is proven live before `stop()` is
 *     believed to have released it.
 *
 * Contract conflict, resolved by the integration agent: `docs/CONTRACT.md` says
 * a broadcast module "must return the event unchanged", and `registry.js`'s
 * `runBroadcast` warned when a broadcast observer returned anything on a
 * waterfall seam. The registry now warns only when the return is neither
 * `undefined` nor the event itself, so this contract-conforming observer is
 * silent while a rewrite is still reported. The decision passes through
 * unchanged, which is what the registry section below asserts.
 *
 * Run from the repository root: `node scripts/gate-t18-goal.mjs`
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import mod from '../packages/plugin/src/modules/supervise-goal.js';
import { SEAMS } from '../packages/plugin/src/seams.js';
import { createRegistry } from '../packages/plugin/src/registry.js';
import { fakeAgent, fakeCore, fakeCtx, makeConfig } from '../packages/plugin/test/fixtures/harness.js';

const ID = 'supervise.goal';
const DEFAULT_ROUNDS = 4;

/** The goal round driver's continuation: injected context, never user input. */
function roundPrompt(round) {
  return {
    role: 'user',
    source: { kind: 'goal', goalId: 'goal-1', revision: 1, round },
    content: [{ type: 'text', text: `<goal_round>\nRound: ${round}/10\n\nContinue working toward the objective.\n</goal_round>` }],
  };
}

/** A message the user wrote. */
function userMessage(text) {
  return { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] };
}

/** One `agent/pre-step` payload, shaped like the harness payload. */
function preStep(agent, turn, step = 1, messages = [roundPrompt(turn)]) {
  return { agent, messages, turn, step, signal: undefined };
}

/** An equal, separately built copy, for the "was the event mutated?" comparison. */
function rebuilt(agent, turn, step = 1, messages = [roundPrompt(turn)]) {
  return preStep(agent, turn, step, messages);
}

/**
 * A minimal stand-in for the module context: no network, no host, no core.
 * `degraded` removes every optional service, which is the host that has none.
 */
function makeApi({ stalledRounds, shadow = false, degraded = false, noticeThrows = false } = {}) {
  const notices = [];
  const ledger = [];
  const registered = [];
  const requested = { count: 0 };
  const api = {
    id: ID,
    log: { warn() {} },
    notice: {
      request(notice) {
        requested.count += 1;
        if (noticeThrows) throw new Error('arbiter down');
        notices.push(notice);
        return 'accepted';
      },
    },
    ledger: { append: (row) => ledger.push(row) },
    shadow: { isShadow: () => shadow },
    config: { get: (key) => (key === 'stalledRounds' ? stalledRounds : undefined) },
    registerAgent(agent, setup) {
      registered.push(agent);
      const teardown = setup({ id: agent?.id });
      let done = false;
      return () => {
        if (done) return;
        done = true;
        if (typeof teardown === 'function') teardown();
      };
    },
  };
  if (degraded) {
    return { api: { id: ID, log: { warn() {} } }, notices, ledger, registered, requested };
  }
  return { api, notices, ledger, registered, requested };
}

/** Fire one event and hold the module to the never-rewrite rule. */
async function fire(agent, event, api, expected = event) {
  const out = await mod.handle(event, api);
  assert.deepEqual(out, expected, 'the returned event is deep-equal to the input');
  assert.equal(out, event, 'and it is the very object the module was handed');
  return out;
}

// ── 1. A stalled run: nothing early, exactly one notice at the threshold ────
const stalledAgent = fakeAgent('agent-stall');
const stalled = makeApi();
{
  const event = preStep(stalledAgent, 1);
  await fire(stalledAgent, event, stalled.api);
  assert.deepEqual(event, rebuilt(stalledAgent, 1), 'the event was not mutated');
  assert.equal(stalled.registered.length, 1, 'the agent is registered on its first round');

  // Rounds 1 to 4 make no progress. Round 4's verdict needs a round boundary,
  // which is round 5, so nothing may be raised before it.
  for (let turn = 2; turn <= 4; turn += 1) await fire(stalledAgent, preStep(stalledAgent, turn), stalled.api);
  assert.equal(stalled.notices.length, 0, `no notice before the ${DEFAULT_ROUNDS}-round run is complete`);
  assert.equal(stalled.registered.length, 1, 'and the agent is still registered only once');

  // Positive control for every later absence check: the detector fires here.
  await fire(stalledAgent, preStep(stalledAgent, 5), stalled.api);
  assert.equal(stalled.notices.length, 1, `the run of ${DEFAULT_ROUNDS} stalled rounds raises exactly one notice`);

  const notice = stalled.notices[0];
  assert.equal(notice.kind, 'advisory', 'the notice is advisory, not blocking');
  assert.equal(notice.tag, ID, 'the notice carries the module tag');
  assert.equal(notice.dedupeKey, `${ID}:agent-stall`, 'the notice carries a per-agent dedupe key');
  assert.ok(typeof notice.text === 'string' && notice.text.length > 0, 'the notice says something');

  assert.equal(stalled.ledger.length, 1, 'exactly one decision reached the ledger');
  const row = stalled.ledger[0];
  assert.equal(row.featureId, ID, 'the record is keyed by the module id');
  assert.equal(row.decision, 'stall', 'the record names the decision');
  assert.equal(row.wouldBe, 'notice', 'the record names what the decision produced');
  assert.equal(row.mode, 'enforce', 'the record is in enforce mode');
  assert.equal(row.threshold, DEFAULT_ROUNDS, 'the record carries the round budget');
}

// ── 2. It never fires twice for one agent in one session ────────────────────
{
  for (let turn = 6; turn <= 15; turn += 1) await fire(stalledAgent, preStep(stalledAgent, turn), stalled.api);
  assert.equal(stalled.notices.length, 1, 'ten more stalled rounds raise no second notice');
  assert.equal(stalled.ledger.length, 1, 'and record no second decision');
  assert.equal(stalled.requested.count, 1, 'the arbiter was asked exactly once');
}

// ── 3. Tool work is progress: eight rounds, no notice ──────────────────────
{
  const agent = fakeAgent('agent-work');
  const api = makeApi();
  for (let turn = 1; turn <= 8; turn += 1) {
    await fire(agent, preStep(agent, turn), api.api);
    await fire(agent, preStep(agent, turn, 2), api.api);
  }
  assert.equal(api.notices.length, 0, 'a round that reached the tool loop is progress');
  assert.equal(api.ledger.length, 0, 'and no stall decision is recorded');
}

// ── 4. New user input is progress: eight rounds, no notice ─────────────────
{
  const agent = fakeAgent('agent-chat');
  const api = makeApi();
  for (let turn = 1; turn <= 8; turn += 1) {
    await fire(agent, preStep(agent, turn, 1, [userMessage(`question ${turn}`)]), api.api);
  }
  assert.equal(api.notices.length, 0, 'a round a human drove is not a stalled round');
}

// ── 5. The threshold is configurable ───────────────────────────────────────
{
  const agent = fakeAgent('agent-two');
  const api = makeApi({ stalledRounds: 2 });
  await fire(agent, preStep(agent, 1), api.api);
  await fire(agent, preStep(agent, 2), api.api);
  assert.equal(api.notices.length, 0, 'two rounds are not yet a run of two complete rounds');
  await fire(agent, preStep(agent, 3), api.api);
  assert.equal(api.notices.length, 1, 'the configured budget of two fires a round earlier');
  assert.equal(api.ledger[0].threshold, 2, 'the record carries the configured budget');
}

// ── 6. Shadow records the notice it would have raised and raises nothing ───
{
  const agent = fakeAgent('agent-shadow');
  const api = makeApi({ shadow: true });
  for (let turn = 1; turn <= 6; turn += 1) await fire(agent, preStep(agent, turn), api.api);
  assert.equal(api.notices.length, 0, 'shadow raises no notice');
  assert.equal(api.ledger.length, 1, 'shadow records the would-be notice once');
  assert.equal(api.ledger[0].mode, 'shadow', 'the record is marked shadow');
  assert.equal(api.ledger[0].wouldBe, 'notice', 'the record keeps what would have happened');
}

// ── 7. Per-agent state: a second agent starts from its own counter ─────────
{
  const agent = fakeAgent('agent-second');
  const api = makeApi();
  await fire(agent, preStep(agent, 1), api.api);
  for (let turn = 2; turn <= 4; turn += 1) await fire(agent, preStep(agent, turn), api.api);
  assert.equal(api.notices.length, 0, 'an agent that arrives after another fired keeps its own count');
  await fire(agent, preStep(agent, 5), api.api);
  assert.equal(api.notices.length, 1, 'and reaches its own threshold independently');
  assert.equal(api.notices[0].dedupeKey, `${ID}:agent-second`, 'with its own dedupe key');
}

// ── 8. A host with no services, an event with no agent, a throwing arbiter ─
{
  const agent = fakeAgent('agent-bare');
  const bare = makeApi({ degraded: true });
  for (let turn = 1; turn <= 6; turn += 1) await fire(agent, preStep(agent, turn), bare.api);
  assert.equal(bare.notices.length, 0, 'a host with no notice service raises nothing and does not throw');

  const lonely = makeApi();
  const noAgent = preStep(undefined, 3);
  await fire(undefined, noAgent, lonely.api);
  assert.equal(lonely.notices.length, 0, 'an event with no agent is not judged');
  assert.equal(lonely.registered.length, 0, 'and registers nothing');

  const broken = makeApi({ noticeThrows: true });
  const brokenAgent = fakeAgent('agent-broken');
  for (let turn = 1; turn <= 6; turn += 1) await fire(brokenAgent, preStep(brokenAgent, turn), broken.api);
  assert.equal(broken.requested.count, 1, 'a throwing arbiter is asked once, not once per round');
  assert.equal(broken.ledger.length, 1, 'and the decision is still recorded');
}

// ── 9. The descriptor the registry reads ───────────────────────────────────
{
  assert.equal(mod.id, ID, 'the descriptor carries the stable id');
  assert.equal(mod.seam, SEAMS.AGENT_PRE_STEP, 'the descriptor claims agent/pre-step');
  assert.equal(mod.seamClass, 'broadcast', 'the descriptor observes and never rewrites');
  assert.equal(mod.targets, undefined, 'a broadcast observer declares no targets');
  assert.equal(mod.settings.stalledRounds.type, 'number', 'the round budget is a number');
  assert.equal(mod.settings.stalledRounds.default, DEFAULT_ROUNDS, `the default budget is ${DEFAULT_ROUNDS}`);
  assert.equal(typeof mod.stop, 'function', 'the module can release its per-agent state');
}

// ── 10. Through the real registry: the decision passes through, and the
//        per-agent registration is released on stop ─────────────────────────
{
  const agent = fakeAgent('agent-registry');
  const ctx = fakeCtx();
  const { core } = fakeCore();
  const registry = createRegistry({ modules: [mod], ctx, config: makeConfig([mod], [mod.id]), core });

  const states = await registry.start();
  assert.equal(states[0].started, true, 'the module starts under the real registry');
  assert.equal(ctx.listenerCount(SEAMS.AGENT_PRE_STEP), 1, 'one shared listener on the seam');

  const decision = { kind: 'enter', messages: [] };
  let nextCalls = 0;
  for (let turn = 1; turn <= 5; turn += 1) {
    const out = await ctx.fire(SEAMS.AGENT_PRE_STEP, preStep(agent, turn), () => {
      nextCalls += 1;
      return decision;
    });
    assert.equal(out, decision, 'the waterfall hands back the decision it was given');
  }
  assert.equal(nextCalls, 5, 'the continuation ran exactly once per step');
  assert.ok(agent.liveEffects() > 0, 'positive control: the per-agent registration is live');

  await registry.stop();
  assert.equal(agent.liveEffects(), 0, 'stop() released the per-agent registration');
  assert.equal(ctx.listenerCount(SEAMS.AGENT_PRE_STEP), 0, 'and the seam listener');
}

// ── 11. Static: no goal service, one import. Positive control first ─────────
{
  const here = dirname(fileURLToPath(import.meta.url));
  const file = join(here, '..', 'packages', 'plugin', 'src', 'modules', 'supervise-goal.js');
  const source = readFileSync(file, 'utf8');

  const goalService = /\bgoals\b/;
  assert.ok(goalService.test('const current = api.goals.current(agent);'), 'the detector fires on goal-service access (positive control)');
  assert.equal(goalService.test(source), false, 'supervise.goal never reaches for the goal service');
  assert.deepEqual(
    source.match(/^import .*$/gm),
    ["import { SEAMS } from '../seams.js';"],
    'its only import is the frozen seam-name source',
  );
}

console.log('GATE-T18-GOAL-OK');
