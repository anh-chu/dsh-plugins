/**
 * G-T34-1: a tool registration the harness refuses is retried, and reported, not forgotten.
 *
 * At boot another plugin (`dsh-jev-tools`) already owned `jev_ask` and `jev_gate`. The harness
 * threw "already registered"; `tools.ask` and `gate.completion` caught it and only logged it.
 * The status route showed both modules started with no error. When the other plugin was
 * switched off the names were free, but nothing registered them again, so neither plugin
 * offered the tools. A real session found it: `jev_ask` and `jev_gate` were in no tool list.
 *
 * The registry now keeps a refused registration pending, retries it when the harness emits
 * `tools/change`, and shows it in `state()` as a `warning` while it is pending.
 *
 * This drives the REAL registry and the REAL modules with a host whose `register` refuses a
 * taken name, frees the name, emits `tools/change`, and reads the result and the state.
 *
 * Run: node scripts/gate-t34-toolretry.mjs
 */
import assert from 'node:assert/strict';

import { createCore } from '../packages/core/src/index.js';
import gateCompletion from '../packages/plugin/src/modules/gate-completion.js';
import toolsAsk from '../packages/plugin/src/modules/tools-ask.js';
import { createRegistry } from '../packages/plugin/src/registry.js';

/** A host whose tool registry refuses a taken name, as the harness does. */
function host(taken) {
  const listeners = new Map();
  const registered = new Map();
  return {
    registered,
    taken,
    listeners,
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event)?.delete(fn);
    },
    emit(event) { for (const fn of [...(listeners.get(event) ?? [])]) fn(); },
    get(name) {
      if (name !== 'tools') return undefined;
      return {
        register: (definition) => {
          if (taken.has(definition.name) || registered.has(definition.name)) {
            throw new Error(`tool "${definition.name}" is already registered`);
          }
          registered.set(definition.name, definition);
          return () => registered.delete(definition.name);
        },
      };
    },
    inject: () => () => {},
    effect: (fn) => { fn(); return () => {}; },
    logger: { warn() {}, info() {} },
  };
}

const config = { 'tools.ask': { enabled: { get: () => true } }, 'gate.completion': { enabled: { get: () => true } } };
const newRegistry = (ctx) => createRegistry({
  modules: [toolsAsk, gateCompletion],
  ctx,
  config,
  core: createCore({ settings: { get: () => undefined }, now: () => 1 }),
});
const stateOf = (registry, id) => registry.state().find((row) => row.id === id);

// ── a taken name is reported, then registered once it is free ───────────────
{
  const ctx = host(new Set(['jev_ask', 'jev_gate']));
  const registry = newRegistry(ctx);
  await registry.start();

  assert.equal(ctx.registered.size, 0, 'neither tool is registered while the names are taken');
  assert.match(stateOf(registry, 'tools.ask').warning ?? '', /jev_ask is not registered/, 'the refusal is visible in the status, not only in a log');
  assert.match(stateOf(registry, 'gate.completion').warning ?? '', /jev_gate is not registered/);
  assert.equal(stateOf(registry, 'tools.ask').started, true, 'the module itself still runs');
  assert.equal(stateOf(registry, 'tools.ask').error, null, 'a pending tool is a warning, not a failed module');

  // Nothing changes until the harness says the tool set changed.
  ctx.emit('tools/change');
  assert.equal(ctx.registered.size, 0, 'a change event while the names are still taken registers nothing');
  assert.ok(stateOf(registry, 'tools.ask').warning, 'and the warning stays');

  // The other plugin lets go of the names.
  ctx.taken.clear();
  ctx.emit('tools/change');
  assert.deepEqual([...ctx.registered.keys()].sort(), ['jev_ask', 'jev_gate'], 'both tools register on the change that frees the names');
  assert.equal(stateOf(registry, 'tools.ask').warning, null, 'and the warning clears');
  assert.equal(stateOf(registry, 'gate.completion').warning, null);
  assert.ok((ctx.listeners.get('tools/change')?.size ?? 0) === 0, 'the watcher is removed once nothing is pending');

  await registry.stop();
  assert.equal(ctx.registered.size, 0, 'stop releases what was registered late');
}

// ── a disabled module is not left pending ───────────────────────────────────
{
  const ctx = host(new Set(['jev_ask']));
  const registry = newRegistry(ctx);
  await registry.start();
  assert.ok(stateOf(registry, 'tools.ask').warning, 'pending while the name is taken');
  await registry.stop();
  ctx.taken.clear();
  ctx.emit('tools/change');
  assert.equal(ctx.registered.has('jev_ask'), false, 'a stopped registry does not register a tool afterwards');
}

// ── controls: the normal path is unchanged ──────────────────────────────────
{
  const ctx = host(new Set());
  const registry = newRegistry(ctx);
  await registry.start();
  assert.deepEqual([...ctx.registered.keys()].sort(), ['jev_ask', 'jev_gate'], 'control: free names register at start');
  assert.equal(stateOf(registry, 'tools.ask').warning, null, 'control: no warning when nothing was refused');
  assert.equal((ctx.listeners.get('tools/change')?.size ?? 0), 0, 'control: no watcher is installed when nothing is pending');
  await registry.stop();
}

// ── the bridge still offers the rest of the host's tools service ─────────────
// `nag.nogoal` asks `api.tools.get('create_goal', agent)`. A wrapper that kept only `register`
// made it nag the operator instead of the agent, and gate-t13-nag caught it.
{
  const ctx = host(new Set());
  const seen = [];
  const real = ctx.get.bind(ctx);
  ctx.get = (name) => {
    const service = real(name);
    return service === undefined ? undefined : { ...service, get: (toolName, scope) => { seen.push([toolName, scope]); return { name: toolName }; } };
  };
  let bridge;
  const probe = { id: 'probe.get', seam: null, seamClass: 'broadcast', settings: {}, handle() {}, start(api) { bridge = api.tools; } };
  const registry = createRegistry({
    modules: [probe],
    ctx,
    config: { 'probe.get': { enabled: { get: () => true } } },
    core: createCore({ settings: { get: () => undefined }, now: () => 1 }),
  });
  await registry.start();
  assert.equal(bridge.get('create_goal', 'agent-1')?.name, 'create_goal', 'get is passed through to the host service');
  assert.deepEqual(seen, [['create_goal', 'agent-1']], 'with its arguments');
  await registry.stop();
}

console.log('GATE-T34-TOOLRETRY-OK');
