/**
 * G-T5-3 (CID-5): disabling a module runs its per-agent registrations' disposer.
 *
 * A per-agent registration is made through `api.registerAgent` from inside the
 * module's own `agent/created` handling, wrapped in the agent scope's `effect`.
 * Unloading the plugin does not dispose an agent's registrations by itself, so
 * the registry must run them when the module is switched off — and again, if any
 * remain, when the whole registry stops.
 *
 * The probe counts live registrations on the agent scope. Its positive control
 * is inside the gate: the count is 1 while the module is on, so a detector that
 * never fires cannot be mistaken for a clean disposal.
 */

import assert from 'node:assert/strict';
import { createRegistry } from '../packages/plugin/src/registry.js';
import { SEAMS, fakeAgent, fakeCore, fakeCtx, makeConfig, makeModule } from '../packages/plugin/test/fixtures/harness.js';

const hits = { handler: 0, disposed: 0 };

const keeper = makeModule({
  id: 'keeper',
  seam: SEAMS.AGENT_CREATED,
  handle(event, api) {
    api.registerAgent(event.agent, (agentCtx) => {
      const off = agentCtx.on('tools/result', () => {
        hits.handler += 1;
      });
      return () => {
        hits.disposed += 1;
        off();
      };
    });
  },
});
const observer = makeModule({
  id: 'observer',
  seam: SEAMS.TOOLS_RESULT,
  handle: () => undefined,
});

const modules = [keeper, observer];
const config = makeConfig(modules, ['keeper', 'observer']);
const ctx = fakeCtx();
const { core } = fakeCore();
const registry = createRegistry({ modules, ctx, config, core });

const first = fakeAgent('agent-a');
const second = fakeAgent('agent-b');

await registry.start();
// One shared listener for the broadcast seam, not one per module.
assert.equal(ctx.listenerCount(SEAMS.AGENT_CREATED), 1);

await ctx.fire(SEAMS.AGENT_CREATED, { agent: first });
await ctx.fire(SEAMS.AGENT_CREATED, { agent: second });

// Positive control: the detector sees the registrations while the module is on.
assert.equal(first.liveEffects(), 1, 'the per-agent registration is live');
assert.equal(first.liveHandlers(), 1);
assert.equal(second.liveEffects(), 1);
assert.equal(hits.disposed, 0);

// Disable the module: its stop() path must dispose both agents' registrations.
config.keeper.enabled.set(false);
const states = await registry.applyConfig();

assert.equal(states.find((state) => state.id === 'keeper').started, false);
assert.equal(hits.disposed, 2, 'both per-agent disposers ran');
assert.equal(first.liveEffects(), 0, 'no registration remains for the first agent');
assert.equal(first.liveHandlers(), 0, 'no handler remains for the first agent');
assert.equal(second.liveEffects(), 0);
assert.equal(second.liveHandlers(), 0);
assert.equal(ctx.listenerCount(SEAMS.AGENT_CREATED), 0, 'a disabled module keeps no listener');
// The disabled module no longer registers anything for a new agent either.
const third = fakeAgent('agent-c');
await ctx.fire(SEAMS.AGENT_CREATED, { agent: third });
assert.equal(third.liveEffects(), 0, 'a disabled module registers nothing for a new agent');

// The unload path: a registration made while enabled is disposed by stop().
config.keeper.enabled.set(true);
await registry.applyConfig();
const fourth = fakeAgent('agent-d');
await ctx.fire(SEAMS.AGENT_CREATED, { agent: fourth });
assert.equal(fourth.liveEffects(), 1);
await registry.stop();
assert.equal(hits.disposed, 3, 'stop() disposed the remaining per-agent registration');
assert.equal(fourth.liveEffects(), 0);

console.log('GATE-T5-DISPOSAL-OK');
