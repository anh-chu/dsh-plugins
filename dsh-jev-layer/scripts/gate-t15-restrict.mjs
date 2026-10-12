/**
 * G-T15-1 (CID-13) — tools.surface reduces the presented tool set by scope.
 *
 * The real module is driven through its real entry (`handle` on `agent/created`)
 * against a synthetic api that reproduces the registry's `registerAgent`
 * contract, and against a synthetic tools service that reproduces the two facts
 * `restrict` guarantees: it only ever removes, and it returns the exact disposer
 * that lifts the restriction. No host, no network, no core import.
 *
 * What the gate proves:
 *
 *   (a) POSITIVE CONTROL, before any restriction: the presented-set detector
 *       reads the probe tool present and an unregistered name absent, so the
 *       absence asserted below is a result the detector can distinguish;
 *   (b) after one `agent/created`, the probe the filter denies is absent from
 *       the presented set while the tools it does not name are still present;
 *   (c) disposing the per-agent registration — the disposer the registry keeps
 *       and runs — lifts the restriction and restores the inherited surface;
 *   (d) the module's own `stop()` lifts a live restriction too, and because
 *       `registry.stopModule` reaches the same disposer twice — `stop()` first,
 *       then the per-agent registration unwinding — the restriction is lifted
 *       exactly once, not twice;
 *   (e) the observer returns `undefined` and leaves the event unchanged, because
 *       `agent/created` runs as a broadcast seam.
 *
 * (c) has its own positive control: the restriction is asserted live immediately
 * before the disposer runs, so the restoration cannot be a detector that never
 * saw the restriction in the first place.
 *
 * Run from the repository root: `node scripts/gate-t15-restrict.mjs`
 */

import assert from 'node:assert/strict';
import toolsSurface from '../packages/plugin/src/modules/tools-surface.js';
import { fakeAgent, fakeCore } from '../packages/plugin/test/fixtures/harness.js';

/** Marker printed last, after every assertion passed. */
const MARKER = 'GATE-T15-RESTRICT-OK';

/** The inherited surface, as the host would present it to one agent scope. */
const INHERITED = ['read', 'grep', 'jev_probe'];

/**
 * A synthetic tools service, reduced to the two contracts `restrict` fixes.
 *
 * It models "restrictions intersect and can only reduce": each live filter is
 * applied to the inherited names, and a disposer removes exactly its own filter.
 * It also rejects what the real service rejects — an empty filter and an unknown
 * name — so a module that abuses the call is caught here.
 */
function fakeToolService(inheritedNames) {
  const inherited = [...inheritedNames];
  const live = new Set();
  let restrictCalls = 0;
  let releaseCalls = 0;

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
      // The exact disposer the real service returns. A second call is counted,
      // so a restriction lifted twice is visible to this gate.
      return () => {
        releaseCalls += 1;
        live.delete(entry);
      };
    },
    visible,
    names: () => inherited.filter(visible),
    get restrictCalls() {
      return restrictCalls;
    },
    get releaseCalls() {
      return releaseCalls;
    },
  };
}

/**
 * A synthetic module api. `config`, `ledger`, `shadow` and `log` follow
 * docs/CONTRACT.md, and `registerAgent` reproduces `registry.js`: the setup runs
 * inside the agent scope's own `effect`, and the returned disposer is kept by
 * whoever registered — here the gate, standing in for `disposeAgentRegistrations`.
 */
function fakeApi({ core, config, registrations }) {
  return {
    id: 'tools.surface',
    config: { get: (key) => config[key] },
    judge: core.judge,
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

/** One agent scope with the tools service the host would hand it. */
function scopedAgent(id, tools) {
  const agent = fakeAgent(id);
  agent.ctx.tools = tools;
  return agent;
}

// ── (a) the positive control: the detector tells present from absent ────────
{
  const tools = fakeToolService(INHERITED);
  assert.equal(tools.visible('jev_probe'), true, 'the probe tool reads present before any restriction');
  assert.equal(tools.visible('read'), true, 'the untouched tool reads present before any restriction');
  assert.equal(tools.visible('not_a_tool'), false, 'an unregistered name reads absent, so absence is observable');
  assert.deepEqual(tools.names(), INHERITED, 'the inherited surface is exactly what the host presents');
}

// ── (b) one restriction removes the denied tool, and nothing else ───────────
{
  const tools = fakeToolService(INHERITED);
  const registrations = [];
  const { core, appended } = fakeCore();
  const api = fakeApi({ core, config: { allow: [], deny: ['jev_probe'], maxChanges: 1 }, registrations });
  const agent = scopedAgent('session-restrict', tools);
  const event = { agent, source: 'fresh' };

  toolsSurface.start(api);
  assert.equal(toolsSurface.handle(event, api), undefined, '(e) the broadcast observer returns undefined');
  assert.equal(event.agent, agent, '(e) the observed event is left exactly as it arrived');

  assert.equal(tools.restrictCalls, 1, 'exactly one restriction reaches the service');
  assert.equal(tools.visible('jev_probe'), false, 'the denied probe is absent from the presented set');
  assert.equal(tools.visible('read'), true, 'a tool the filter does not name is still present');
  assert.equal(tools.visible('grep'), true, 'the second unnamed tool is still present');
  assert.deepEqual(tools.names(), ['read', 'grep'], 'the presented set is the inherited set minus the probe');

  const records = appended.filter((record) => record.featureId === 'tools.surface');
  assert.equal(records.length, 1, 'the change is recorded exactly once');
  assert.equal(records[0].decision, 'restrict', 'the record names the action');
  assert.equal(records[0].callId, 'session-restrict', 'the record is keyed by the session');
  assert.deepEqual(
    records[0].question,
    { filter: { deny: ['jev_probe'] } },
    'the record carries the filter that was applied, in the one field that travels',
  );

  // ── (c) the registration disposer lifts the restriction ──────────────────
  assert.equal(registrations.length, 1, 'the module registered once through registerAgent');
  assert.equal(tools.visible('jev_probe'), false, 'positive control: the restriction is live before disposal');
  registrations[0]();
  assert.equal(tools.visible('jev_probe'), true, 'disposing the registration restores the inherited surface');
  assert.deepEqual(tools.names(), INHERITED, 'every inherited tool is presented again');
  assert.equal(tools.releaseCalls, 1, 'the restriction disposer ran exactly once');
}

// ── (d) stop() lifts, and the registry's later unwind does not lift again ───
{
  const tools = fakeToolService(INHERITED);
  const registrations = [];
  const { core } = fakeCore();
  const api = fakeApi({ core, config: { allow: [], deny: ['grep'], maxChanges: 1 }, registrations });
  const agent = scopedAgent('session-stop', tools);

  toolsSurface.start(api);
  toolsSurface.handle({ agent, source: 'resume' }, api);
  assert.equal(tools.visible('grep'), false, 'positive control: the restriction is live before stop()');
  assert.equal(tools.visible('jev_probe'), true, 'the denied tool is only the named one');

  // `registry.stopModule` runs the module's stop() first and then unwinds the
  // per-agent registrations, so the restriction disposer is reachable twice and
  // must still run once.
  toolsSurface.stop();
  assert.equal(tools.visible('grep'), true, 'stop() lifts the live restriction');
  assert.equal(tools.visible('jev_probe'), true, 'stop() leaves every inherited tool presented');
  assert.deepEqual(tools.names(), INHERITED, 'the whole inherited surface is back');
  assert.equal(tools.releaseCalls, 1, 'the module lifts its restriction once, on the stop() path');

  for (const dispose of registrations) dispose();
  assert.equal(tools.releaseCalls, 1, 'the registry unwinding the agent scope does not lift it a second time');
  assert.deepEqual(tools.names(), INHERITED, 'the surface is still the inherited one');
}

// ── a filter that is not configured does nothing and calls nothing ─────────
{
  const tools = fakeToolService(INHERITED);
  const registrations = [];
  const { core, appended } = fakeCore();
  const api = fakeApi({ core, config: { allow: [], deny: [], maxChanges: 1 }, registrations });
  const agent = scopedAgent('session-empty', tools);

  toolsSurface.start(api);
  toolsSurface.handle({ agent, source: 'fresh' }, api);
  assert.equal(tools.restrictCalls, 0, 'an empty filter never reaches a service that rejects one');
  assert.deepEqual(tools.names(), INHERITED, 'the inherited surface is untouched');
  assert.equal(registrations.length, 0, 'nothing is registered when there is nothing to restrict');
  assert.equal(appended.length, 0, 'no decision is recorded when there is no decision to make');
  toolsSurface.stop();
}

console.log(MARKER);
