/**
 * G-T5-4 (CID-6): two enabled modules on one exclusive seam is a startup error
 * that names both ids.
 *
 * The rule exists so that the outcome of a hook never depends on registration
 * order. `start()` rejects, nothing is started, and no listener is registered,
 * because a half-started composition is worse than a refused one.
 *
 * Positive control, first: with one of the two enabled, the same composition
 * starts and the seam dispatches — so the gate proves the detector can tell the
 * two cases apart.
 */

import assert from 'node:assert/strict';
import { createRegistry } from '../packages/plugin/src/registry.js';
import { SEAMS, fakeCore, fakeCtx, makeConfig, makeModule, volatileRef } from '../packages/plugin/test/fixtures/harness.js';

const admit = makeModule({
  id: 'admit.output',
  seam: SEAMS.TOOLS_POST_EXECUTE,
  handle: () => 'admit-handled',
});
const screen = makeModule({
  id: 'screen.fetch',
  seam: SEAMS.TOOLS_POST_EXECUTE,
  handle: () => 'screen-handled',
});
const modules = [admit, screen];
const { core } = fakeCore();

// ── positive control: one enabled owner starts and dispatches ────────────
const controlCtx = fakeCtx();
const control = createRegistry({
  modules,
  ctx: controlCtx,
  config: makeConfig(modules, ['admit.output']),
  core,
});
await control.start();
assert.equal(controlCtx.listenerCount(SEAMS.TOOLS_POST_EXECUTE), 1);
assert.equal(await controlCtx.fire(SEAMS.TOOLS_POST_EXECUTE, {}), 'admit-handled');
await control.stop();
assert.equal(controlCtx.listenerCount(SEAMS.TOOLS_POST_EXECUTE), 0);

// ── both enabled: the composition is refused, both ids named ─────────────
const ctx = fakeCtx();
const registry = createRegistry({
  modules,
  ctx,
  config: makeConfig(modules, ['admit.output', 'screen.fetch']),
  core,
});

await assert.rejects(
  () => registry.start(),
  (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /admit\.output/, 'the first id is named');
    assert.match(error.message, /screen\.fetch/, 'the second id is named');
    assert.match(error.message, /tools\/post-execute/, 'the seam is named');
    return true;
  },
);

assert.equal(ctx.listenerCount(SEAMS.TOOLS_POST_EXECUTE), 0, 'a refused composition registers no listener');
assert.equal(ctx.registrations(), 0, 'nothing is registered at all');
assert.deepEqual(
  registry.state().map((state) => state.started),
  [false, false],
  'nothing starts when the composition is refused',
);

// A settings event after the refusal must not silently start the first
// claimant: the composition is still impossible, so it stays down.
const stillRefused = await registry.applyConfig();
assert.equal(ctx.registrations(), 0, 'a settings event does not start a refused composition');
assert.deepEqual(stillRefused.map((state) => state.started), [false, false]);

// Removing one claimant makes the composition possible again.
await registry.applyConfig({
  'admit.output': { enabled: volatileRef(true) },
  'screen.fetch': { enabled: volatileRef(false) },
});
assert.deepEqual(
  registry.state().map((state) => `${state.id}:${state.started}`),
  ['admit.output:true', 'screen.fetch:false'],
  'the surviving claimant starts once the conflict is gone',
);
assert.equal(ctx.listenerCount(SEAMS.TOOLS_POST_EXECUTE), 1);
await registry.stop();

// The message names both ids in list order and in reverse order alike.
const reversedCtx = fakeCtx();
const reversed = createRegistry({
  modules: [screen, admit],
  ctx: reversedCtx,
  config: makeConfig([screen, admit], ['admit.output', 'screen.fetch']),
  core,
});
await assert.rejects(
  () => reversed.start(),
  (error) => {
    assert.match(error.message, /admit\.output/);
    assert.match(error.message, /screen\.fetch/);
    return true;
  },
);

// ── the same rule at runtime: the second owner stays off ─────────────────
const runtimeCtx = fakeCtx();
const runtimeModules = [admit, screen];
const runtimeConfig = makeConfig(runtimeModules, ['admit.output']);
const runtime = createRegistry({ modules: runtimeModules, ctx: runtimeCtx, config: runtimeConfig, core });
await runtime.start();
runtimeConfig['screen.fetch'].enabled.set(true);
const afterEnable = await runtime.applyConfig();
const blocked = afterEnable.find((state) => state.id === 'screen.fetch');
assert.equal(blocked.enabled, true, 'the module stays switched on');
assert.equal(blocked.started, false, 'but it does not start');
assert.match(blocked.error, /admit\.output/, 'the refusal names the owner');
assert.equal(runtimeCtx.listenerCount(SEAMS.TOOLS_POST_EXECUTE), 1, 'still exactly one listener on the seam');

// The owner is switched off: the blocked module starts by itself, no restart.
runtimeConfig['admit.output'].enabled.set(false);
const afterOff = await runtime.applyConfig();
assert.equal(afterOff.find((state) => state.id === 'admit.output').started, false);
assert.equal(afterOff.find((state) => state.id === 'screen.fetch').started, true);
assert.equal(runtimeCtx.listenerCount(SEAMS.TOOLS_POST_EXECUTE), 1);
assert.equal(await runtimeCtx.fire(SEAMS.TOOLS_POST_EXECUTE, {}), 'screen-handled');
await runtime.stop();

console.log('GATE-T5-SEAM-OK');
