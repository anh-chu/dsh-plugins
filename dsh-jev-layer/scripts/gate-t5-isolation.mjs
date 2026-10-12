/**
 * G-T5-1 (CID-3): a module that throws on start does not fail the loader entry;
 * the other modules start, and the failed module is recorded as off.
 *
 * The registry is exercised directly, because that is the artifact that owns
 * this behaviour. `start()` standing in for the deferred boot: it must resolve,
 * not reject, and must leave the healthy seams live.
 */

import assert from 'node:assert/strict';
import { createRegistry } from '../packages/plugin/src/registry.js';
import { SEAMS, fakeCore, fakeCtx, makeConfig, makeModule } from '../packages/plugin/test/fixtures/harness.js';

const started = [];
const boom = new Error('fixture refuses to start');

const alpha = makeModule({
  id: 'alpha',
  seam: SEAMS.TOOLS_POST_EXECUTE,
  start: () => {
    started.push('alpha');
  },
  handle: () => ({ kept: true, by: 'alpha' }),
});
const broken = makeModule({
  id: 'broken',
  seam: SEAMS.TOOLS_RESULT,
  start: () => {
    throw boom;
  },
});
const gamma = makeModule({
  id: 'gamma',
  seam: SEAMS.AGENT_PRE_STEP,
  start: () => {
    started.push('gamma');
  },
});

const modules = [alpha, broken, gamma];
const config = makeConfig(modules, ['alpha', 'broken', 'gamma']);
const ctx = fakeCtx();
const { core, appended, warnings } = fakeCore();
const registry = createRegistry({ modules, ctx, config, core });

// The whole point: this resolves. A rejection here is the loader entry failing.
const states = await registry.start();

assert.deepEqual(started, ['alpha', 'gamma'], 'the other modules start');

const byId = new Map(states.map((state) => [state.id, state]));
assert.equal(byId.get('alpha').started, true);
assert.equal(byId.get('gamma').started, true);
assert.equal(byId.get('broken').started, false, 'the throwing module is not started');
assert.equal(byId.get('broken').enabled, false, 'the throwing module is marked off');
assert.match(byId.get('broken').error, /refuses to start/, 'the failure reason is kept');
assert.equal(byId.get('alpha').error, null);

// The healthy seams are live, and the failed module registered nothing.
assert.equal(ctx.listenerCount(SEAMS.TOOLS_POST_EXECUTE), 1);
assert.equal(ctx.listenerCount(SEAMS.AGENT_PRE_STEP), 1);
assert.equal(ctx.listenerCount(SEAMS.TOOLS_RESULT), 0, 'the failed module holds no listener');

// Positive control for the listener detector: it fires where a listener exists,
// and the live listener really dispatches the module's handler.
assert.deepEqual(await ctx.fire(SEAMS.TOOLS_POST_EXECUTE, { exec: {} }), { kept: true, by: 'alpha' });
assert.equal(await ctx.fire(SEAMS.TOOLS_RESULT, {}), undefined, 'nothing answers on the failed seam');

// Acceptance criterion 3: the ledger records the failed module as off.
const off = appended.find((record) => record.featureId === 'broken');
assert.ok(off, 'the ledger has a record for the failed module');
assert.equal(off.decision, 'off');
assert.equal(off.mode, 'shadow');

// The failure was reported once, and did not leak into the healthy modules.
assert.equal(warnings.filter((line) => line.includes('"broken"')).length, 1);

await registry.stop();
assert.equal(ctx.listenerCount(SEAMS.TOOLS_POST_EXECUTE), 0, 'stop() releases the seams');

console.log('GATE-T5-ISOLATION-OK');
