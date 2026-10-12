/**
 * G-T15-2 (CID-13) — tools.surface changes one session's tool set at most once.
 *
 * Every change rewrites the tool schemas in the prompt prefix, so the module
 * computes its filter once per session and a *different* filter for the same
 * session is refused once the budget is spent and recorded in the ledger. This
 * gate drives the real module through its real entry (`handle` on
 * `agent/created`) against a synthetic api and tools service. No host, no
 * network.
 *
 * One fact shapes the cases below: `agent/created` fires again on resume, clear
 * and compaction. Each new agent is a new scope with the inherited surface, so
 * the same filter must be applied again — refusing that would hand the agent
 * back the tools the operator removed, which is itself a change of the
 * presented set.
 *
 * What the gate proves:
 *
 *   (a) the module is off by default and says so: it declares no `enabled`
 *       field (the registry owns that toggle and defaults it to false) and every
 *       setting description states the off-by-default posture;
 *   (b) with the declared default budget of one, the first change is applied and
 *       recorded, and a second request with a different filter for the same
 *       session is refused — it never reaches the service — and recorded; the
 *       same filter on a re-created agent is re-applied without spending the
 *       budget and without a refusal;
 *   (c) POSITIVE CONTROL for (b): with a budget of two the very same second
 *       request is applied and recorded, so the refusal is the cap and not a
 *       code path that can never change twice;
 *   (d) the budget is per session: a second session still gets its own change
 *       while the first session is refused;
 *   (e) shadow mode records the would-be restriction and calls `restrict` not at
 *       all (docs/CONTRACT.md rule 4, SPEC.md criterion 7);
 *   (f) fail open: a name the service rejects leaves the inherited surface
 *       intact, records the failure and never throws out of `handle`;
 *   (g) the change and the refusal survive the real core ledger, in exactly the
 *       nine contract keys, not only in the test fixture.
 *
 * Run from the repository root: `node scripts/gate-t15-once.mjs`
 */

import assert from 'node:assert/strict';
import toolsSurface from '../packages/plugin/src/modules/tools-surface.js';
import { SEAMS } from '../packages/plugin/src/seams.js';
import { createCore } from '../packages/core/src/index.js';
import { fakeAgent, fakeCore } from '../packages/plugin/test/fixtures/harness.js';

/** Marker printed last, after every assertion passed. */
const MARKER = 'GATE-T15-ONCE-OK';

/** The inherited surface, as the host would present it to one agent scope. */
const INHERITED = ['read', 'grep', 'jev_probe'];

/** The nine keys docs/CONTRACT.md fixes for one ledger record. */
const RECORD_KEYS = ['featureId', 'callId', 'question', 'probabilities', 'threshold', 'decision', 'wouldBe', 'reason', 'mode', 'at'];

/** The synthetic tools service. Every agent scope gets its own instance. */
function fakeToolService(inheritedNames) {
  const inherited = [...inheritedNames];
  const live = new Set();
  let restrictCalls = 0;

  function visible(name) {
    if (!inherited.includes(name)) return false;
    for (const entry of live) {
      const filter = entry.filter;
      if (Array.isArray(filter.allow) && !filter.allow.includes(name)) return false;
      if (Array.isArray(filter.deny) && filter.deny.includes(name)) return false;
    }
    return true;
  }

  return {
    restrict(filter) {
      restrictCalls += 1;
      if (!filter || (filter.allow === undefined && filter.deny === undefined)) {
        throw new Error('a restriction must name allow or deny');
      }
      for (const name of [...(filter.allow ?? []), ...(filter.deny ?? [])]) {
        if (!inherited.includes(name)) throw new Error(`unknown tool "${name}"`);
      }
      const entry = { filter };
      live.add(entry);
      return () => live.delete(entry);
    },
    visible,
    names: () => inherited.filter(visible),
    get restrictCalls() {
      return restrictCalls;
    },
  };
}

/** The registry's `registerAgent` contract, as in `gate-t15-restrict.mjs`. */
function fakeApi({ core, config, registrations = [] }) {
  return {
    id: 'tools.surface',
    config: { get: (key) => config[key] },
    ledger: core.ledger,
    shadow: core.shadow,
    log: core.log,
    registerAgent(agent, setup) {
      const scope = agent?.ctx;
      if (!scope || typeof scope.effect !== 'function' || typeof setup !== 'function') return () => {};
      const dispose = scope.effect(() => {
        const teardown = setup(scope);
        return () => {
          if (typeof teardown === 'function') teardown();
        };
      }, 'tools.surface: per-agent registration');
      registrations.push(dispose);
      return dispose;
    },
  };
}

function scopedAgent(id, tools) {
  const agent = fakeAgent(id);
  agent.ctx.tools = tools;
  return agent;
}

const decisions = (appended) =>
  appended.filter((record) => record.featureId === 'tools.surface').map((record) => record.decision);

// ── (a) the descriptor: off by default, and it says so ─────────────────────
{
  assert.equal(toolsSurface.id, 'tools.surface', 'the feature id is stable');
  assert.equal(toolsSurface.seam, SEAMS.AGENT_CREATED, 'the module observes agent creation');
  assert.equal(toolsSurface.seamClass, 'broadcast', 'it observes only, so it is a broadcast owner');
  assert.equal(toolsSurface.settings.enabled, undefined, 'the registry owns the off-by-default toggle');
  assert.equal(toolsSurface.settings.maxChanges.default, 1, 'the declared change budget is one per session');
  for (const [name, spec] of Object.entries(toolsSurface.settings)) {
    assert.match(spec.description, /off by default/i, `the "${name}" description states the off-by-default posture`);
  }
}

// ── (b) defaults: one change, then a different filter is refused ────────────
{
  const toolsA = fakeToolService(INHERITED);
  const { core, appended } = fakeCore();
  const config = { allow: [], deny: ['jev_probe'], maxChanges: toolsSurface.settings.maxChanges.default };
  const api = fakeApi({ core, config });

  toolsSurface.start(api);
  toolsSurface.handle({ agent: scopedAgent('session-once', toolsA), source: 'startup' }, api);
  assert.equal(toolsA.restrictCalls, 1, 'the first request reaches the service once');
  assert.equal(toolsA.visible('jev_probe'), false, 'the first change is applied');
  assert.deepEqual(decisions(appended), ['restrict'], 'the applied change is recorded');

  // The same session asks for a *different* set: that is a change, and the
  // budget is spent.
  const toolsB = fakeToolService(INHERITED);
  config.deny = ['grep'];
  toolsSurface.handle({ agent: scopedAgent('session-once', toolsB), source: 'resume' }, api);
  assert.equal(toolsB.restrictCalls, 0, 'the refused request never reaches the service');
  assert.deepEqual(toolsB.names(), INHERITED, 'the refused request leaves the new scope inherited');
  assert.equal(toolsA.visible('jev_probe'), false, 'the first restriction still stands');
  assert.deepEqual(decisions(appended), ['restrict', 'refused:already-changed'], 'the refusal is recorded');
  const refusal = appended.find((record) => record.decision.startsWith('refused:'));
  assert.equal(refusal.callId, 'session-once', 'the refusal names the session');
  assert.deepEqual(
    refusal.question,
    { filter: { deny: ['grep'] } },
    'the refusal records the filter it declined, in the one field that travels',
  );

  // A new agent scope in the same session is handed the surface it inherited,
  // so the unchanged filter is applied again — without spending the budget.
  const toolsC = fakeToolService(INHERITED);
  config.deny = ['jev_probe'];
  toolsSurface.handle({ agent: scopedAgent('session-once', toolsC), source: 'compact' }, api);
  assert.equal(toolsC.restrictCalls, 1, 'the unchanged filter is re-applied to the new scope');
  assert.equal(toolsC.visible('jev_probe'), false, 'the new scope presents the same set as the first');
  assert.deepEqual(
    decisions(appended),
    ['restrict', 'refused:already-changed', 'restrict'],
    're-applying the unchanged filter is not a change, so it is never refused',
  );
  toolsSurface.stop();
}

// ── (c) positive control: a budget of two applies the same second request ───
{
  const toolsA = fakeToolService(INHERITED);
  const { core, appended } = fakeCore();
  const config = { allow: [], deny: ['jev_probe'], maxChanges: 2 };
  const api = fakeApi({ core, config });

  toolsSurface.start(api);
  toolsSurface.handle({ agent: scopedAgent('session-two', toolsA), source: 'startup' }, api);
  assert.equal(toolsA.restrictCalls, 1, 'the first request is applied');
  assert.equal(toolsA.visible('jev_probe'), false, 'the probe is restricted after the first change');

  const toolsB = fakeToolService(INHERITED);
  config.deny = ['grep'];
  toolsSurface.handle({ agent: scopedAgent('session-two', toolsB), source: 'resume' }, api);
  assert.equal(toolsB.restrictCalls, 1, 'with a budget of two the same request is applied, so (b) refused on the cap');
  assert.equal(toolsB.visible('grep'), false, 'the changed filter is applied to the new scope');
  assert.equal(toolsB.visible('jev_probe'), true, 'a restriction belongs to one agent scope, not to the session');
  assert.equal(toolsA.visible('jev_probe'), false, 'the first scope keeps the set it was given');
  assert.deepEqual(decisions(appended), ['restrict', 'restrict'], 'both changes are recorded');
  assert.deepEqual(
    appended[1].question,
    { filter: { deny: ['grep'] } },
    'the second record carries the second filter',
  );
  toolsSurface.stop();
}

// ── (d) the budget is per session, not per process ─────────────────────────
{
  const toolsA = fakeToolService(INHERITED);
  const toolsA2 = fakeToolService(INHERITED);
  const toolsB = fakeToolService(INHERITED);
  const { core, appended } = fakeCore();
  const config = { allow: [], deny: ['jev_probe'], maxChanges: 1 };
  const api = fakeApi({ core, config });

  toolsSurface.start(api);
  toolsSurface.handle({ agent: scopedAgent('session-a', toolsA), source: 'startup' }, api);
  config.deny = ['grep'];
  toolsSurface.handle({ agent: scopedAgent('session-a', toolsA2), source: 'resume' }, api);
  assert.equal(toolsA2.restrictCalls, 0, 'session a spends its one change and then has a different one refused');

  toolsSurface.handle({ agent: scopedAgent('session-b', toolsB), source: 'startup' }, api);
  assert.equal(toolsB.restrictCalls, 1, 'session b still gets its own change');
  assert.equal(toolsB.visible('grep'), false, 'session b presents its own filter');
  assert.deepEqual(
    decisions(appended),
    ['restrict', 'refused:already-changed', 'restrict'],
    'each session records its own decision',
  );
  assert.equal(appended[2].callId, 'session-b', 'the third record belongs to session b');
  toolsSurface.stop();
}

// ── (e) shadow records the would-be restriction and acts on nothing ────────
{
  const tools = fakeToolService(INHERITED);
  const { core, appended } = fakeCore({ shadow: { isShadow: () => true } });
  const api = fakeApi({ core, config: { allow: [], deny: ['jev_probe'], maxChanges: 1 } });
  const agent = scopedAgent('session-shadow', tools);

  toolsSurface.start(api);
  toolsSurface.handle({ agent, source: 'startup' }, api);
  assert.equal(tools.restrictCalls, 0, 'shadow mode never calls restrict');
  assert.deepEqual(tools.names(), INHERITED, 'shadow mode leaves the inherited surface untouched');
  const record = appended.find((entry) => entry.featureId === 'tools.surface');
  assert.equal(record.decision, 'restrict', 'shadow records the would-be restriction');
  assert.equal(record.mode, 'shadow', 'the record says it was shadow traffic');
  toolsSurface.stop();
}

// ── (f) fail open: a rejected name changes nothing and is recorded ─────────
{
  const tools = fakeToolService(INHERITED);
  const { core, appended } = fakeCore();
  const api = fakeApi({ core, config: { allow: [], deny: ['not_a_tool'], maxChanges: 1 } });
  const agent = scopedAgent('session-bad', tools);

  toolsSurface.start(api);
  assert.equal(
    toolsSurface.handle({ agent, source: 'startup' }, api),
    undefined,
    'a rejected filter never throws out of the broadcast observer',
  );
  assert.equal(tools.restrictCalls, 1, 'the request did reach the service, which rejected it');
  assert.deepEqual(tools.names(), INHERITED, 'the inherited surface is intact after the rejection');
  const record = appended.find((entry) => entry.featureId === 'tools.surface');
  assert.match(record.decision, /^error:.*unknown tool "not_a_tool"/, 'the record names what the service rejected');
  toolsSurface.stop();
}

// ── (g) the record survives the real ledger, not just the fixture ──────────
{
  const core = createCore({ settings: { get: () => undefined }, now: () => 1_700_000_000_000 });
  const config = { allow: [], deny: ['jev_probe'], maxChanges: 1 };
  const api = fakeApi({ core, config });

  toolsSurface.start(api);
  toolsSurface.handle({ agent: scopedAgent('session-real-ledger', fakeToolService(INHERITED)), source: 'startup' }, api);
  config.deny = ['grep'];
  toolsSurface.handle({ agent: scopedAgent('session-real-ledger', fakeToolService(INHERITED)), source: 'resume' }, api);

  const stored = core.ledger.read('tools.surface', 'session-real-ledger');
  assert.deepEqual(
    stored.map((entry) => entry.decision),
    ['restrict', 'refused:already-changed'],
    'the real ledger keeps the change and the refusal, readable back by feature and session',
  );
  assert.deepEqual(
    Object.keys(stored[1]),
    RECORD_KEYS,
    'the refusal is stored in exactly the contract shape, so nothing about it is dropped',
  );
  assert.deepEqual(stored[1].question, { filter: { deny: ['grep'] } }, 'the declined filter is stored');
  toolsSurface.stop();
}

console.log(MARKER);
