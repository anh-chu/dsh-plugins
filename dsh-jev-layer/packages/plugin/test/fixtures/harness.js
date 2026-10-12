/**
 * Test fixtures for the registry.
 *
 * The five real module files and the core are written by other agents in
 * parallel, so nothing here imports them. The gates inject these descriptors
 * through the public registry factory instead.
 *
 * `makeConfig` reproduces the shape the real schema resolves to: one object per
 * module id, holding volatile references. A volatile reference is what the
 * registry actually receives at runtime, so a fixture that passes bare booleans
 * would test a different program.
 */

import { SEAMS } from '../../src/seams.js';

export { SEAMS };

/** A volatile reference holding `initial`. `settings.update` writes through `set`. */
export function volatileRef(initial) {
  let value = initial;
  return {
    get: () => value,
    set: (next) => {
      value = next;
    },
  };
}

/**
 * The config object for a module list, with the named ids switched on.
 * Settings default to the module's declared default, like the real schema.
 */
export function makeConfig(modules, on = []) {
  const config = {};
  for (const module of modules) {
    const entry = { enabled: volatileRef(on.includes(module.id)) };
    for (const [name, spec] of Object.entries(module.settings ?? {})) {
      entry[name] = volatileRef(spec?.default);
    }
    config[module.id] = entry;
  }
  return config;
}

/** A module descriptor, with test doubles for the lifecycle. */
export function makeModule({ id, seam, settings, start, stop, handle }) {
  return { id, seam, settings, start, stop, handle };
}

/**
 * A fake Cordis context that records listeners, so a gate can assert that a
 * disabled module registered nothing and that disposal removed the listener.
 */
export function fakeCtx({ services = {} } = {}) {
  const handlers = new Map();
  const warnings = [];
  const disposedSeams = [];
  let registrations = 0;

  const ctx = {
    logger: {
      warn: (message) => warnings.push(String(message)),
      info: () => {},
      error: () => {},
    },
    on(seam, handler) {
      registrations += 1;
      const record = { handler, disposed: false };
      const list = handlers.get(seam) ?? [];
      list.push(record);
      handlers.set(seam, list);
      return () => {
        if (record.disposed) return;
        record.disposed = true;
        disposedSeams.push(seam);
        const index = list.indexOf(record);
        if (index >= 0) list.splice(index, 1);
      };
    },
    get(name) {
      return services[name];
    },
    effect(callback) {
      const teardown = callback();
      return () => {
        if (typeof teardown === 'function') teardown();
      };
    },
  };

  ctx.listenerCount = (seam) => (handlers.get(seam) ?? []).filter((record) => !record.disposed).length;
  ctx.registrations = () => registrations;
  ctx.disposedSeams = disposedSeams;
  ctx.warnings = warnings;
  /** Dispatch one event the way the harness would. */
  ctx.fire = (seam, event, next) => {
    const live = (handlers.get(seam) ?? []).filter((record) => !record.disposed);
    if (live.length === 0) return undefined;
    return live[live.length - 1].handler(event, next);
  };
  return ctx;
}

/** A fake agent with the scoped context the harness gives one. */
export function fakeAgent(id = 'agent-1') {
  const effects = new Set();
  const handlers = new Set();
  const ctx = {
    id,
    effect(callback, label) {
      const record = { label, active: true };
      effects.add(record);
      const teardown = callback();
      return () => {
        if (!record.active) return;
        record.active = false;
        effects.delete(record);
        if (typeof teardown === 'function') teardown();
      };
    },
    on(name, handler) {
      const record = { name, handler };
      handlers.add(record);
      return () => handlers.delete(record);
    },
  };
  return {
    id,
    ctx,
    liveEffects: () => [...effects].filter((record) => record.active).length,
    liveHandlers: () => handlers.size,
    disposeAll: () => {
      for (const record of [...effects]) {
        if (record.active) {
          record.active = false;
          effects.delete(record);
        }
      }
    },
  };
}

/** A fake core with the interfaces docs/CONTRACT.md fixes, recording what it is told. */
export function fakeCore(overrides = {}) {
  const appended = [];
  const warnings = [];
  const core = {
    judge: { configured: false, lastError: null, ask: async () => null },
    limiter: { run: (fn) => fn() },
    budget: { beginTurn: () => {}, tryAcquire: () => true, remaining: () => 0 },
    ledger: { append: (record) => appended.push(record), read: () => [], rebuild: (events) => events },
    shadow: { isShadow: () => false },
    notice: { request: () => 'accepted', drain: () => [] },
    notifications: { send: async () => 'sent' },
    log: { warn: (message) => warnings.push(String(message)), info: () => {} },
    ...overrides,
  };
  return { core, appended, warnings };
}
