/**
 * G-T5-2 (CID-4): a runtime toggle changes the active set without a restart.
 *
 * The toggle is modelled exactly as the harness does it: `settings.update`
 * writes through the volatile reference in place, then the settings service
 * emits `settings/document-updated` and the entry calls `applyConfig`. So the
 * gate mutates `ref.set(...)` and calls `applyConfig` again on the same config
 * object. Nothing restarts, and only the module whose switch changed is
 * started or stopped.
 */

import assert from 'node:assert/strict';
import { createRegistry } from '../packages/plugin/src/registry.js';
import { SEAMS, fakeCore, fakeCtx, makeConfig, makeModule } from '../packages/plugin/test/fixtures/harness.js';

const order = [];
const alpha = makeModule({
  id: 'alpha',
  seam: SEAMS.TOOLS_POST_EXECUTE,
  start: () => order.push('start-alpha'),
  stop: () => order.push('stop-alpha'),
  handle: () => 'alpha-handled',
});
const beta = makeModule({
  id: 'beta',
  seam: SEAMS.AGENT_PRE_STEP,
  start: () => order.push('start-beta'),
  stop: () => order.push('stop-beta'),
  handle: () => 'beta-handled',
});

const modules = [alpha, beta];
const config = makeConfig(modules);
const ctx = fakeCtx();
const { core } = fakeCore();
const registry = createRegistry({ modules, ctx, config, core });

// A fresh install: every module off, and a disabled module registers nothing.
const initial = await registry.start();
assert.deepEqual(initial.map((state) => state.started), [false, false], 'every module is off on a fresh install');
assert.equal(ctx.registrations(), 0, 'a disabled module registers nothing at all');
assert.deepEqual(order, [], 'nothing starts while everything is off');

// Toggle alpha on, through its volatile reference.
config.alpha.enabled.set(true);
const afterAlpha = await registry.applyConfig();
assert.deepEqual(order, ['start-alpha'], 'only the toggled module started');
assert.equal(afterAlpha.find((state) => state.id === 'alpha').started, true);
assert.equal(afterAlpha.find((state) => state.id === 'beta').started, false);
assert.equal(ctx.listenerCount(SEAMS.TOOLS_POST_EXECUTE), 1, 'the toggled seam is live');
assert.equal(ctx.listenerCount(SEAMS.AGENT_PRE_STEP), 0, 'the untouched module registered nothing');
assert.equal(await ctx.fire(SEAMS.TOOLS_POST_EXECUTE, {}), 'alpha-handled', 'the toggled module now handles its seam');

// Toggle beta on: alpha must not be restarted.
config.beta.enabled.set(true);
await registry.applyConfig();
assert.deepEqual(order, ['start-alpha', 'start-beta'], 'toggling one module does not restart another');
assert.equal(ctx.listenerCount(SEAMS.AGENT_PRE_STEP), 1);
assert.equal(await ctx.fire(SEAMS.AGENT_PRE_STEP, {}), 'beta-handled');

// Toggle alpha off: its stop runs, its listener goes, beta is untouched.
config.alpha.enabled.set(false);
const afterOff = await registry.applyConfig();
assert.deepEqual(order, ['start-alpha', 'start-beta', 'stop-alpha'], 'disabling runs stop()');
assert.equal(afterOff.find((state) => state.id === 'alpha').started, false);
assert.equal(ctx.listenerCount(SEAMS.TOOLS_POST_EXECUTE), 0, 'the disabled seam is released');
assert.equal(ctx.listenerCount(SEAMS.AGENT_PRE_STEP), 1, 'the other module keeps its seam');
assert.equal(order.filter((line) => line === 'start-beta').length, 1, 'no restart happened');

await registry.stop();
assert.equal(ctx.registrations() >= 2, true);

console.log('GATE-T5-TOGGLE-OK');
