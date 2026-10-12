/**
 * G-T21-1 (CID-21) — seam classes in the registry.
 *
 * Three outcomes, from `docs/CONTRACT.md` "Seam classes":
 *
 *   (a) two `broadcast` owners on one seam both run, in registration order,
 *       behind one listener, and the waterfall decision passes through unchanged;
 *   (b) two `exclusive` owners whose `targets` intersect are a startup error that
 *       names both ids, and nothing is registered;
 *   (c) two `exclusive` owners with disjoint `targets` coexist on one seam, each
 *       handles its own target, and an unowned target falls through.
 *
 * Every fixture case is built from `test/fixtures/harness.js`, so this gate needs
 * no live host and no network. The last two sections are not fixtures: they load
 * the shipped module list and, through the real entry's `apply()`, the plugin
 * itself, to prove the rule holds for the artifact the host mounts. `makeModule`
 * drops fields it does not know, so the descriptors below add `seamClass` and
 * `targets` on top of it — that stripping is reported as a contract problem
 * rather than patched here.
 *
 * Positive controls: (c) and the runtime sections show the listener and
 * registration detectors firing where modules do start, so the zero-registration
 * assertion in (b) is not a detector that can never fire.
 *
 * Run from the repository root: `node scripts/gate-t21-seamclass.mjs`
 */

import assert from 'node:assert/strict';

import { createRegistry } from '../packages/plugin/src/registry.js';
import MODULES from '../packages/plugin/src/modules/index.js';
import { SEAMS, fakeCore, fakeCtx, makeConfig, makeModule } from '../packages/plugin/test/fixtures/harness.js';

const { core } = fakeCore();

/** A fixture descriptor carrying the class and targets `makeModule` strips. */
function descriptor({ id, seam, seamClass, targets, start, stop, handle }) {
  return {
    ...makeModule({ id, seam, start, stop, handle }),
    seamClass,
    ...(targets === undefined ? {} : { targets }),
  };
}

// ── (a) broadcast: several observers, one listener, the decision unchanged ──
{
  const seen = [];
  let nextCalls = 0;
  const modules = [
    descriptor({
      id: 'first',
      seam: SEAMS.AGENT_PRE_STEP,
      seamClass: 'broadcast',
      handle: () => {
        seen.push('first');
      },
    }),
    descriptor({
      id: 'second',
      seam: SEAMS.AGENT_PRE_STEP,
      seamClass: 'broadcast',
      handle: () => {
        seen.push('second');
      },
    }),
  ];
  const ctx = fakeCtx();
  const registry = createRegistry({
    modules,
    ctx,
    config: makeConfig(modules, ['first', 'second']),
    core,
  });

  const states = await registry.start();
  assert.deepEqual(states.map((state) => state.started), [true, true], 'both broadcast owners start');
  assert.equal(ctx.listenerCount(SEAMS.AGENT_PRE_STEP), 1, 'one shared listener, not one per observer');

  const decision = await ctx.fire(SEAMS.AGENT_PRE_STEP, { turn: 1 }, () => {
    nextCalls += 1;
    return { kind: 'accept' };
  });
  assert.deepEqual(seen, ['first', 'second'], 'observers run in registration order');
  assert.equal(nextCalls, 1, 'the waterfall continuation runs exactly once');
  assert.deepEqual(decision, { kind: 'accept' }, 'a broadcast seam hands the decision back unchanged');

  await registry.stop();
  assert.equal(ctx.listenerCount(SEAMS.AGENT_PRE_STEP), 0, 'stop() releases the shared listener');
}

// ── (a2) broadcast on an emit seam: many observers, one listener ───────────
{
  const seen = [];
  const modules = [
    descriptor({
      id: 'one',
      seam: SEAMS.TOOLS_RESULT,
      seamClass: 'broadcast',
      handle: () => {
        seen.push('one');
      },
    }),
    descriptor({
      id: 'two',
      seam: SEAMS.TOOLS_RESULT,
      seamClass: 'broadcast',
      handle: () => {
        seen.push('two');
      },
    }),
  ];
  const ctx = fakeCtx();
  const registry = createRegistry({ modules, ctx, config: makeConfig(modules, ['one', 'two']), core });
  const states = await registry.start();

  assert.deepEqual(states.map((state) => state.started), [true, true], 'an emit seam takes many observers');
  assert.equal(ctx.listenerCount(SEAMS.TOOLS_RESULT), 1, 'one listener on the emit seam');
  await ctx.fire(SEAMS.TOOLS_RESULT, { exec: {}, result: {} });
  assert.deepEqual(seen, ['one', 'two'], 'both emit observers run');
  await registry.stop();
}

// ── (b) intersecting targets: refused at startup, both ids named ───────────
{
  const modules = [
    descriptor({
      id: 'admit.output',
      seam: SEAMS.TOOLS_POST_EXECUTE,
      seamClass: 'exclusive',
      targets: ['read', 'grep'],
      handle: () => 'read-handled',
    }),
    descriptor({
      id: 'admit.terminal',
      seam: SEAMS.TOOLS_POST_EXECUTE,
      seamClass: 'exclusive',
      targets: ['grep', 'bash'],
      handle: () => 'terminal-handled',
    }),
  ];
  const ctx = fakeCtx();
  const registry = createRegistry({
    modules,
    ctx,
    config: makeConfig(modules, ['admit.output', 'admit.terminal']),
    core,
  });

  await assert.rejects(
    () => registry.start(),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /admit\.output/, 'the first id is named');
      assert.match(error.message, /admit\.terminal/, 'the second id is named');
      assert.match(error.message, /tools\/post-execute/, 'the seam is named');
      return true;
    },
  );
  assert.equal(ctx.registrations(), 0, 'a refused composition registers nothing');
  assert.deepEqual(
    registry.state().map((state) => state.started),
    [false, false],
    'nothing starts when the composition is refused',
  );
}

// ── (c) disjoint targets: both coexist and each handles its own target ─────
{
  const seen = [];
  const modules = [
    descriptor({
      id: 'admit.output',
      seam: SEAMS.TOOLS_POST_EXECUTE,
      seamClass: 'exclusive',
      targets: ['read'],
      async handle(event, api, next) {
        seen.push('output');
        if (event?.name !== 'read') return undefined;
        const downstream = await next();
        return { ...downstream, read: true };
      },
    }),
    descriptor({
      id: 'admit.terminal',
      seam: SEAMS.TOOLS_POST_EXECUTE,
      seamClass: 'exclusive',
      targets: ['bash'],
      async handle(event, api, next) {
        seen.push('terminal');
        if (event?.name !== 'bash') return undefined;
        const downstream = await next();
        return { ...downstream, bash: true };
      },
    }),
  ];
  const ctx = fakeCtx();
  const registry = createRegistry({
    modules,
    ctx,
    config: makeConfig(modules, ['admit.output', 'admit.terminal']),
    core,
  });

  const states = await registry.start();
  assert.deepEqual(
    states.map((state) => `${state.id}:${state.started}`),
    ['admit.output:true', 'admit.terminal:true'],
    'disjoint-target owners coexist on one exclusive seam',
  );
  // Positive control for (b): the same detector sees a listener and registrations
  // where the owners do start, so the zero in (b) is meaningful.
  assert.equal(ctx.listenerCount(SEAMS.TOOLS_POST_EXECUTE), 1, 'one shared listener for the disjoint owners');
  assert.ok(ctx.registrations() > 0, 'starting owners register a listener');

  seen.length = 0;
  const read = await ctx.fire(SEAMS.TOOLS_POST_EXECUTE, { name: 'read' }, () => ({ kind: 'accept' }));
  assert.deepEqual(seen, ['output', 'terminal'], 'both owners see a read event; the non-owner passes it on');
  assert.deepEqual(read, { kind: 'accept', read: true }, 'the owning module rewrites the decision');

  seen.length = 0;
  const bash = await ctx.fire(SEAMS.TOOLS_POST_EXECUTE, { name: 'bash' }, () => ({ kind: 'accept' }));
  assert.deepEqual(seen, ['output', 'terminal'], 'both owners see a bash event');
  assert.deepEqual(bash, { kind: 'accept', bash: true }, 'the other target reaches the other owner');

  seen.length = 0;
  const other = await ctx.fire(SEAMS.TOOLS_POST_EXECUTE, { name: 'write' }, () => ({ kind: 'accept' }));
  assert.deepEqual(seen, ['output', 'terminal'], 'an unowned target still reaches both owners');
  assert.deepEqual(other, { kind: 'accept' }, 'an unowned target falls through unchanged');

  const reported = registry.state().find((state) => state.id === 'admit.output');
  assert.equal(reported.seamClass, 'exclusive', 'state() reports the class');
  assert.deepEqual(reported.targets, ['read'], 'state() reports the targets');
  await registry.stop();
}

// ── the same rule at runtime: intersection refused, disjoint starts ────────
{
  const modules = [
    descriptor({ id: 'owner', seam: SEAMS.TOOLS_POST_EXECUTE, seamClass: 'exclusive', targets: ['read', 'grep'], handle: () => 'owner' }),
    descriptor({ id: 'clash', seam: SEAMS.TOOLS_POST_EXECUTE, seamClass: 'exclusive', targets: ['grep'], handle: () => 'clash' }),
    descriptor({ id: 'mate', seam: SEAMS.TOOLS_POST_EXECUTE, seamClass: 'exclusive', targets: ['bash'], handle: () => 'mate' }),
  ];
  const config = makeConfig(modules, ['owner']);
  const ctx = fakeCtx();
  const registry = createRegistry({ modules, ctx, config, core });
  await registry.start();

  config.clash.enabled.set(true);
  const afterClash = await registry.applyConfig();
  const blocked = afterClash.find((state) => state.id === 'clash');
  assert.equal(blocked.enabled, true, 'the intersecting module stays switched on');
  assert.equal(blocked.started, false, 'but it does not start');
  assert.match(blocked.error, /owner/, 'the refusal names the owner it intersects');

  config.mate.enabled.set(true);
  const afterMate = await registry.applyConfig();
  assert.equal(
    afterMate.find((state) => state.id === 'mate').started,
    true,
    'positive control: a disjoint module does start at runtime',
  );
  assert.equal(ctx.listenerCount(SEAMS.TOOLS_POST_EXECUTE), 1, 'still one listener on the seam');
  await registry.stop();
}

// ── the shipped list carries its classes and targets, and starts together ──
/** Every shipped module, its class, and the targets it declares. */
const EXPECTED = new Map([
  ['admit.output', ['exclusive', ['read', 'grep', 'glob', 'web_fetch', 'web_search']]],
  ['admit.terminal', ['exclusive', ['bash', 'pwsh']]],
  ['screen.fetch', ['broadcast', null]],
  ['select.skill', ['broadcast', null]],
  ['gate.completion', ['broadcast', null]],
  ['tools.ask', ['broadcast', null]],
  ['supervise.goal', ['broadcast', null]],
  ['remind.drift', ['broadcast', null]],
  ['guide.instructions', ['broadcast', null]],
  ['answer.questions', ['exclusive', null]],
  ['nag.nogoal', ['broadcast', null]],
  ['notify.decline', ['broadcast', null]],
  ['tools.surface', ['broadcast', null]],
  ['rank.files', ['broadcast', null]],
  ['route.interjection', ['broadcast', null]],
  ['approve.workspace', ['exclusive', ['write', 'edit', 'bash', 'pwsh', 'run_code']]],
  ['guide.shared', ['broadcast', null]],
]);

{
  const ids = MODULES.map((module) => module.id);
  assert.deepEqual([...ids].sort(), [...EXPECTED.keys()].sort(), 'the gate knows every shipped module');

  const ctx = fakeCtx();
  const registry = createRegistry({ modules: MODULES, ctx, config: makeConfig(MODULES, ids), core });
  const states = await registry.start();

  assert.deepEqual(states.map((state) => state.id), ids, 'state() reports the shipped list in order');
  assert.deepEqual(
    states.map((state) => state.started),
    ids.map(() => true),
    `all ${ids.length} shipped modules start together`,
  );

  const byId = new Map(states.map((state) => [state.id, state]));
  for (const [id, [seamClass, targets]] of EXPECTED) {
    assert.equal(byId.get(id).seamClass, seamClass, `${id} runs as ${seamClass}`);
    assert.deepEqual(byId.get(id).targets, targets, `${id} declares its targets`);
  }

  // The two exclusive owners share one seam and one listener, because their
  // declared targets do not intersect. That disjointness is what CID-18 rests on.
  assert.equal(byId.get('admit.output').seam, SEAMS.TOOLS_POST_EXECUTE);
  assert.equal(byId.get('admit.terminal').seam, SEAMS.TOOLS_POST_EXECUTE);
  assert.equal(ctx.listenerCount(SEAMS.TOOLS_POST_EXECUTE), 1, 'the two admit owners share one listener');

  const preStep = states.filter((state) => state.seam === SEAMS.AGENT_PRE_STEP);
  assert.equal(preStep.length, 6, 'six shipped modules observe agent/pre-step');
  assert.equal(ctx.listenerCount(SEAMS.AGENT_PRE_STEP), 1, 'the six observers share one listener');
  assert.equal(
    states.filter((state) => state.seam === SEAMS.TOOLS_RESULT).length,
    4,
    'four shipped observers share tools/result',
  );
  assert.equal(ctx.listenerCount(SEAMS.TOOLS_RESULT), 1, 'the emit seam keeps one listener');
  await registry.stop();
  assert.equal(ctx.listenerCount(SEAMS.TOOLS_POST_EXECUTE), 0, 'stop() releases the shared listener');
}

// ── the real entry, not fixtures: the plugin mounts with both admit owners ─
//
// The registry is driven above with fixture descriptors. This section proves the
// same rule through the artifact the host actually loads: the real entry's
// `apply()`, the real module list, and the real config shape. A fake context
// stands in for the host — no network, no profile.
{
  const entry = await import('../packages/plugin/src/index.js');
  const config = makeConfig(MODULES, ['admit.output', 'admit.terminal']);
  const ctx = fakeCtx({ services: { settings: { configure: () => () => {} } } });

  entry.apply(ctx, config);
  assert.equal(ctx.registrations(), 0, 'apply() returns before anything registers');

  const deadline = Date.now() + 5000;
  let state = entry.registryState();
  while (Date.now() < deadline && !state.some((module) => module.id === 'admit.terminal' && module.started)) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    state = entry.registryState();
  }

  const byId = new Map(state.map((module) => [module.id, module]));
  assert.equal(
    byId.get('admit.output')?.started,
    true,
    `the real plugin starts admit.output (state: ${JSON.stringify(state)})`,
  );
  assert.equal(byId.get('admit.terminal')?.started, true, 'the real plugin starts admit.terminal');
  assert.equal(byId.get('admit.output')?.error, null, 'admit.output reports no error');
  assert.equal(byId.get('admit.terminal')?.error, null, 'admit.terminal reports no error');
  assert.equal(
    state.filter((module) => module.started).length,
    2,
    'only the two enabled admit modules start',
  );
  assert.equal(ctx.listenerCount(SEAMS.TOOLS_POST_EXECUTE), 1, 'the real entry registers one listener');
  assert.equal(ctx.warnings.filter((line) => line.includes('intersecting')).length, 0, 'no composition refusal is warned');

  // A real third module claiming a target of a real owner is refused by name.
  const clashModules = [
    ...MODULES,
    { ...MODULES.find((module) => module.id === 'admit.terminal'), id: 'admit.clash', targets: ['bash'] },
  ];
  const clashCtx = fakeCtx();
  const clash = createRegistry({
    modules: clashModules,
    ctx: clashCtx,
    config: makeConfig(clashModules, ['admit.output', 'admit.terminal', 'admit.clash']),
    core,
  });
  await assert.rejects(
    () => clash.start(),
    (error) => {
      assert.match(error.message, /admit\.terminal/, 'the real owner is named');
      assert.match(error.message, /admit\.clash/, 'the invented module is named');
      return true;
    },
  );
  assert.equal(clashCtx.registrations(), 0, 'a refused real composition registers nothing');

  // The same clash against the other real owner names admit.output instead.
  const clashOutput = [
    ...MODULES,
    { ...MODULES.find((module) => module.id === 'admit.output'), id: 'admit.grep-clash', targets: ['grep'] },
  ];
  const outputCtx = fakeCtx();
  const other = createRegistry({
    modules: clashOutput,
    ctx: outputCtx,
    config: makeConfig(clashOutput, ['admit.output', 'admit.terminal', 'admit.grep-clash']),
    core,
  });
  await assert.rejects(
    () => other.start(),
    (error) => {
      assert.match(error.message, /admit\.output/, 'the real owner is named');
      assert.match(error.message, /admit\.grep-clash/, 'the invented module is named');
      return true;
    },
  );
  assert.equal(outputCtx.registrations(), 0, 'the second refused composition registers nothing');
}

console.log('GATE-T21-SEAMCLASS-OK');
