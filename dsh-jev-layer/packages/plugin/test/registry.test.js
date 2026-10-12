/**
 * Registry development checks. The gates are the acceptance record; these run
 * under `node --test` and cover the same rules with less ceremony.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createRegistry } from '../src/registry.js';
import { createSettings } from '../src/config.js';
import { SEAMS, fakeAgent, fakeCore, fakeCtx, makeConfig, makeModule, volatileRef } from './fixtures/harness.js';

test('a module that throws on start leaves the others started and is marked off', async () => {
  const boom = new Error('nope');
  const modules = [
    makeModule({ id: 'a', seam: SEAMS.TOOLS_POST_EXECUTE, handle: () => 'a' }),
    makeModule({ id: 'b', seam: SEAMS.TOOLS_RESULT, start: () => { throw boom; } }),
    makeModule({ id: 'c', seam: SEAMS.AGENT_PRE_STEP }),
  ];
  const ctx = fakeCtx();
  const { core, appended } = fakeCore();
  const registry = createRegistry({ modules, ctx, config: makeConfig(modules, ['a', 'b', 'c']), core });

  const states = await registry.start();
  const byId = new Map(states.map((state) => [state.id, state]));
  assert.equal(byId.get('a').started, true);
  assert.equal(byId.get('c').started, true);
  assert.equal(byId.get('b').started, false);
  assert.equal(byId.get('b').enabled, false);
  assert.match(byId.get('b').error, /nope/);
  assert.equal(ctx.listenerCount(SEAMS.TOOLS_RESULT), 0);
  assert.equal(appended.find((record) => record.featureId === 'b').decision, 'off');
});

test('a disabled module registers nothing; a volatile toggle starts only that module', async () => {
  const order = [];
  const modules = [
    makeModule({ id: 'a', seam: SEAMS.TOOLS_POST_EXECUTE, start: () => order.push('a'), stop: () => order.push('-a'), handle: () => 'a' }),
    makeModule({ id: 'b', seam: SEAMS.AGENT_PRE_STEP, start: () => order.push('b') }),
  ];
  const config = makeConfig(modules);
  const ctx = fakeCtx();
  const { core } = fakeCore();
  const registry = createRegistry({ modules, ctx, config, core });

  await registry.start();
  assert.equal(ctx.registrations(), 0);
  assert.deepEqual(order, []);

  config.a.enabled.set(true);
  await registry.applyConfig();
  assert.deepEqual(order, ['a']);
  assert.equal(ctx.listenerCount(SEAMS.TOOLS_POST_EXECUTE), 1);
  assert.equal(await ctx.fire(SEAMS.TOOLS_POST_EXECUTE, {}), 'a');

  config.a.enabled.set(false);
  await registry.applyConfig();
  assert.deepEqual(order, ['a', '-a']);
  assert.equal(ctx.listenerCount(SEAMS.TOOLS_POST_EXECUTE), 0);
});

test('disabling a module runs its per-agent disposers', async () => {
  const hits = { disposed: 0 };
  const keeper = makeModule({
    id: 'keeper',
    seam: SEAMS.AGENT_CREATED,
    handle(event, api) {
      api.registerAgent(event.agent, (agentCtx) => {
        const off = agentCtx.on('tools/result', () => {});
        return () => {
          hits.disposed += 1;
          off();
        };
      });
    },
  });
  const config = makeConfig([keeper], ['keeper']);
  const ctx = fakeCtx();
  const { core } = fakeCore();
  const registry = createRegistry({ modules: [keeper], ctx, config, core });
  const agent = fakeAgent('agent-1');

  await registry.start();
  await ctx.fire(SEAMS.AGENT_CREATED, { agent });
  assert.equal(agent.liveEffects(), 1);

  config.keeper.enabled.set(false);
  await registry.applyConfig();
  assert.equal(hits.disposed, 1);
  assert.equal(agent.liveEffects(), 0);
  assert.equal(agent.liveHandlers(), 0);
});

test('two enabled modules on one exclusive seam is refused, naming both ids', async () => {
  const modules = [
    makeModule({ id: 'admit.output', seam: SEAMS.TOOLS_POST_EXECUTE }),
    makeModule({ id: 'screen.fetch', seam: SEAMS.TOOLS_POST_EXECUTE }),
  ];
  const ctx = fakeCtx();
  const { core } = fakeCore();
  const registry = createRegistry({
    modules,
    ctx,
    config: makeConfig(modules, ['admit.output', 'screen.fetch']),
    core,
  });

  await assert.rejects(() => registry.start(), /admit\.output[\s\S]*screen\.fetch/);
  assert.equal(ctx.registrations(), 0);
  assert.deepEqual(registry.state().map((state) => state.started), [false, false]);

  // A later settings event must not start the first claimant.
  const after = await registry.applyConfig();
  assert.equal(ctx.registrations(), 0);
  assert.deepEqual(after.map((state) => state.started), [false, false]);
});

test('the broadcast seam starts several modules behind one listener', async () => {
  const seen = [];
  const modules = [
    makeModule({ id: 'one', seam: SEAMS.AGENT_CREATED, handle: (event) => seen.push(`one:${event.agent.id}`) }),
    makeModule({ id: 'two', seam: SEAMS.AGENT_CREATED, handle: (event) => seen.push(`two:${event.agent.id}`) }),
  ];
  const ctx = fakeCtx();
  const { core } = fakeCore();
  const registry = createRegistry({ modules, ctx, config: makeConfig(modules, ['one', 'two']), core });

  const states = await registry.start();
  assert.deepEqual(states.map((state) => state.started), [true, true]);
  assert.equal(ctx.listenerCount(SEAMS.AGENT_CREATED), 1);
  await ctx.fire(SEAMS.AGENT_CREATED, { agent: { id: 'agent-1' } });
  assert.deepEqual(seen, ['one:agent-1', 'two:agent-1']);
});

test('an observer on a waterfall seam passes the call through', async () => {
  const modules = [makeModule({ id: 'observer', seam: SEAMS.TOOLS_POST_EXECUTE, handle: () => undefined })];
  const ctx = fakeCtx();
  const { core } = fakeCore();
  const registry = createRegistry({ modules, ctx, config: makeConfig(modules, ['observer']), core });
  await registry.start();

  let passed = 0;
  const out = await ctx.fire(SEAMS.TOOLS_POST_EXECUTE, { exec: {} }, () => {
    passed += 1;
    return 'from-next';
  });
  assert.equal(passed, 1);
  assert.equal(out, 'from-next');

  // A transformer replaces the value and does not consume the chain twice.
  const transformer = makeModule({ id: 'transformer', seam: SEAMS.TOOLS_PRE_EXECUTE, handle: () => 'replaced' });
  const otherCtx = fakeCtx();
  const other = createRegistry({ modules: [transformer], ctx: otherCtx, config: makeConfig([transformer], ['transformer']), core });
  await other.start();
  let second = 0;
  const replaced = await otherCtx.fire(SEAMS.TOOLS_PRE_EXECUTE, {}, () => {
    second += 1;
    return 'from-next';
  });
  assert.equal(replaced, 'replaced');
  assert.equal(second, 0);
});

test('a mounted skills service is exposed directly on the module api', async () => {
  const service = { list: async () => [] };
  const captured = {};
  const modules = [
    makeModule({ id: 'picker', seam: SEAMS.SKILL_CATALOG, start: (api) => { captured.api = api; } }),
  ];
  const ctx = fakeCtx({ services: { skills: service } });
  const registry = createRegistry({
    modules,
    ctx,
    config: makeConfig(modules, ['picker']),
    core: fakeCore().core,
  });

  await registry.start();
  // Positive control for the absent case below: the detector does see a service.
  assert.equal(captured.api.skills, service);
  assert.equal(registry.skillsService(), service);
});

test('an absent skills service is not an error, and a later mount is still seen', async () => {
  const services = {};
  const captured = {};
  const modules = [
    makeModule({ id: 'picker', seam: SEAMS.SKILL_CATALOG, start: (api) => { captured.api = api; } }),
  ];
  const ctx = fakeCtx({ services });
  const registry = createRegistry({
    modules,
    ctx,
    config: makeConfig(modules, ['picker']),
    core: fakeCore().core,
  });

  await registry.start();
  // A getter, not a snapshot: the service may mount after the module starts.
  assert.equal(typeof captured.api.skills, 'function');
  assert.equal(captured.api.skills(), undefined, 'a host with no skills service yields undefined, and never throws');
  assert.equal(registry.skillsService(), undefined);

  // The same holder now sees the service once the host mounts it.
  services.skills = { list: async () => [] };
  assert.equal(captured.api.skills(), services.skills);
  assert.equal(registry.skillsService(), services.skills);
});

test('the settings reader answers apiKey from the resolved credential, not from config', () => {
  let resolved = 'a-key-value';
  const settings = createSettings({ mode: volatileRef('enforce') }, () => resolved);

  assert.equal(settings.get('apiKey'), 'a-key-value');
  assert.equal(settings.get('mode'), 'enforce', 'every other key still comes from the config object');

  // An empty resolution is "no credential", not an empty bearer token.
  resolved = '';
  assert.equal(settings.get('apiKey'), undefined);
});

test('broadcast owners on one seam both run and the decision passes through', async () => {
  const seen = [];
  let nextCalls = 0;
  const modules = [
    {
      ...makeModule({
        id: 'first',
        seam: SEAMS.AGENT_PRE_STEP,
        handle: () => { seen.push('first'); },
      }),
      seamClass: 'broadcast',
    },
    {
      ...makeModule({
        id: 'second',
        seam: SEAMS.AGENT_PRE_STEP,
        handle: () => { seen.push('second'); },
      }),
      seamClass: 'broadcast',
    },
  ];
  const ctx = fakeCtx();
  const registry = createRegistry({
    modules,
    ctx,
    config: makeConfig(modules, ['first', 'second']),
    core: fakeCore().core,
  });

  const states = await registry.start();
  assert.deepEqual(states.map((state) => state.started), [true, true]);
  assert.deepEqual(states.map((state) => state.seamClass), ['broadcast', 'broadcast']);
  assert.equal(ctx.listenerCount(SEAMS.AGENT_PRE_STEP), 1, 'one listener, not one per observer');

  const out = await ctx.fire(SEAMS.AGENT_PRE_STEP, { turn: 1 }, () => {
    nextCalls += 1;
    return { kind: 'accept' };
  });
  assert.deepEqual(seen, ['first', 'second'], 'observers run in registration order');
  assert.equal(nextCalls, 1, 'the continuation runs exactly once');
  assert.deepEqual(out, { kind: 'accept' }, 'the decision is returned unchanged');
});

test('exclusive owners with intersecting targets are refused, naming both', async () => {
  const modules = [
    {
      ...makeModule({ id: 'a', seam: SEAMS.TOOLS_POST_EXECUTE }),
      seamClass: 'exclusive',
      targets: ['read', 'grep'],
    },
    {
      ...makeModule({ id: 'b', seam: SEAMS.TOOLS_POST_EXECUTE }),
      seamClass: 'exclusive',
      targets: ['grep', 'bash'],
    },
  ];
  const ctx = fakeCtx();
  const registry = createRegistry({
    modules,
    ctx,
    config: makeConfig(modules, ['a', 'b']),
    core: fakeCore().core,
  });

  await assert.rejects(() => registry.start(), (error) => {
    assert.match(error.message, /"a"/);
    assert.match(error.message, /"b"/);
    assert.match(error.message, /tools\/post-execute/);
    return true;
  });
  assert.equal(ctx.registrations(), 0, 'a refused composition registers nothing');
});

test('exclusive owners with disjoint targets coexist and handle their own targets', async () => {
  const seen = [];
  const modules = [
    {
      ...makeModule({
        id: 'reader',
        seam: SEAMS.TOOLS_POST_EXECUTE,
        async handle(event, api, next) {
          seen.push('reader');
          if (event?.name !== 'read') return undefined;
          return { ...(await next()), read: true };
        },
      }),
      seamClass: 'exclusive',
      targets: ['read'],
    },
    {
      ...makeModule({
        id: 'terminal',
        seam: SEAMS.TOOLS_POST_EXECUTE,
        async handle(event, api, next) {
          seen.push('terminal');
          if (event?.name !== 'bash') return undefined;
          return { ...(await next()), bash: true };
        },
      }),
      seamClass: 'exclusive',
      targets: ['bash'],
    },
  ];
  const ctx = fakeCtx();
  const registry = createRegistry({
    modules,
    ctx,
    config: makeConfig(modules, ['reader', 'terminal']),
    core: fakeCore().core,
  });

  const states = await registry.start();
  assert.deepEqual(states.map((state) => state.started), [true, true], 'disjoint owners coexist');
  assert.equal(ctx.listenerCount(SEAMS.TOOLS_POST_EXECUTE), 1);
  assert.deepEqual(states.find((state) => state.id === 'reader').targets, ['read']);

  seen.length = 0;
  const read = await ctx.fire(SEAMS.TOOLS_POST_EXECUTE, { name: 'read' }, () => ({ kind: 'accept' }));
  assert.deepEqual(seen, ['reader', 'terminal'], 'both owners see the event');
  assert.deepEqual(read, { kind: 'accept', read: true }, 'the owning module rewrites the decision');

  seen.length = 0;
  const other = await ctx.fire(SEAMS.TOOLS_POST_EXECUTE, { name: 'write' }, () => ({ kind: 'accept' }));
  assert.deepEqual(seen, ['reader', 'terminal']);
  assert.deepEqual(other, { kind: 'accept' }, 'an unowned target falls through unchanged');
});
