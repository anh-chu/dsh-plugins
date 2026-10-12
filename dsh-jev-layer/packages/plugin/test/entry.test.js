/**
 * Entry development check: `apply()` returns before anything starts, and the
 * deferred boot wires the core and the registry.
 *
 * It runs against a throwaway copy of `packages/plugin` plus a stub core and
 * stub module files, so it depends on neither the real core nor the real
 * modules — both are written by other agents in parallel. The copy uses the
 * frozen barrel `src/modules/index.js` unchanged, so the entry really does
 * resolve its module list through it. The relative core import in `index.js`
 * (`../../core/src/index.js`) is exercised by the same copy.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { SEAMS, fakeCtx, volatileRef } from './fixtures/harness.js';

const SOURCE = fileURLToPath(new URL('../src', import.meta.url));
const CORE = fileURLToPath(new URL('../../core/src', import.meta.url));

/** The frozen barrel imports exactly these five files. */
const STUBS = {
  'admit-output.js': ['admit.output', 'TOOLS_POST_EXECUTE'],
  'screen-fetch.js': ['screen.fetch', 'TOOLS_POST_EXECUTE'],
  'select-skill.js': ['select.skill', 'SKILL_CATALOG'],
  'gate-completion.js': ['gate.completion', 'AGENT_PRE_STEP'],
  'tools-ask.js': ['tools.ask', 'TOOLS_RESULT'],
};

function stubModule(id, seam) {
  return `import { SEAMS } from '../seams.js';

export default {
  id: ${JSON.stringify(id)},
  seam: SEAMS.${seam},
  settings: { level: { type: 'number', default: 1, description: 'stub' } },
  start() {
    (globalThis.__entryTest.started ??= []).push(${JSON.stringify(id)});
  },
  stop() {
    (globalThis.__entryTest.stopped ??= []).push(${JSON.stringify(id)});
  },
  handle() {
    (globalThis.__entryTest.handled ??= []).push(${JSON.stringify(id)});
    return ${JSON.stringify(`handled:${id}`)};
  },
};
`;
}

const CORE_STUB = `export function createCore(options) {
  globalThis.__entryTest.core = options;
  return {
    judge: { configured: false, lastError: null, ask: async () => null },
    budget: { beginTurn() {}, tryAcquire: () => true, remaining: () => 0 },
    ledger: { append() {}, read: () => [], rebuild: (events) => events },
    shadow: { isShadow: () => false },
    notice: { request: () => 'accepted', drain: () => [] },
    notifications: { send: async () => 'sent' },
    log: { warn() {}, info() {} },
  };
}
`;

const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

test('apply() returns before any module starts, then boots the registry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-jev-layer-entry-'));
  try {
    const pluginSrc = join(root, 'packages/plugin/src');
    cpSync(SOURCE, pluginSrc, { recursive: true });
    for (const [file, [id, seam]] of Object.entries(STUBS)) {
      // Unconditional: the copy must not depend on the real module files.
      writeFileSync(join(pluginSrc, 'modules', file), stubModule(id, seam));
    }
    mkdirSync(join(root, 'packages/core/src'), { recursive: true });
    writeFileSync(join(root, 'packages/core/src/index.js'), CORE_STUB);

    globalThis.__entryTest = { started: [], stopped: [] };
    // The schema library is deliberately made unreachable for this case. The copy
    // under test has no `node_modules`, and the loader also looks at two roots
    // outside it — the harness entry point and any profile under `$HOME` — so both
    // are pointed at the temp tree here. Without this the assertion below would
    // pass only by accident of where the test happens to run.
    const realHome = process.env.HOME;
    const realArgv1 = process.argv[1];
    process.env.HOME = root;
    process.argv[1] = join(root, 'no-entry.js');
    let entry;
    try {
      entry = await import(pathToFileURL(join(pluginSrc, 'index.js')).href);
    } finally {
      process.env.HOME = realHome;
      process.argv[1] = realArgv1;
    }

    assert.equal(entry.name, 'dsh-jev-layer');
    assert.deepEqual(entry.inject, []);
    assert.equal(typeof entry.apply, 'function');
    assert.equal(entry.Config, undefined, 'no schemastery in this tree, so no schema, and the plugin still loads');

    const ctx = fakeCtx({ services: { settings: { configure: () => () => {} } } });
    const config = {
      'admit.output': { enabled: volatileRef(true), level: volatileRef(1) },
      'tools.ask': { enabled: volatileRef(false), level: volatileRef(1) },
    };

    entry.apply(ctx, config);

    // The deferral, asserted before anything can run: apply() has returned.
    assert.equal(ctx.registrations(), 0, 'apply() registers nothing itself');
    assert.deepEqual(globalThis.__entryTest.started, [], 'apply() starts no module');

    await settle();

    // Positive control: the same detectors now see the booted state.
    assert.deepEqual(globalThis.__entryTest.started, ['admit.output'], 'only the enabled module started');
    assert.equal(ctx.listenerCount(SEAMS.TOOLS_POST_EXECUTE), 1);
    assert.equal(ctx.listenerCount(SEAMS.TOOLS_RESULT), 0);
    assert.equal(await ctx.fire(SEAMS.TOOLS_POST_EXECUTE, {}), 'handled:admit.output');
    assert.equal(entry.registryState().find((state) => state.id === 'admit.output').started, true);

    // The core received a reader that unwraps volatile fields.
    assert.equal(globalThis.__entryTest.core.settings.get('endpoint'), 'https://api.typesafe.ai/v1/systemone');
    assert.equal(globalThis.__entryTest.core.settings.get('mode'), 'shadow');

    // A runtime toggle arrives as the settings service emits it.
    config['tools.ask'].enabled.set(true);
    ctx.fire('settings/document-updated', 'dsh-jev-layer');
    await settle();
    assert.deepEqual(globalThis.__entryTest.started, ['admit.output', 'tools.ask']);
    assert.equal(ctx.listenerCount(SEAMS.TOOLS_RESULT), 1);
    // `tools/result` is an emit seam: the harness ignores what a listener returns,
    // so the registry hands back nothing at all. The module's run is observed
    // through its own effect, and a stray return is a descriptor bug the registry
    // warns about rather than a value a caller could act on.
    assert.equal(await ctx.fire(SEAMS.TOOLS_RESULT, {}), undefined, 'an emit seam decides nothing');
    assert.deepEqual(
      globalThis.__entryTest.handled,
      ['admit.output', 'tools.ask'],
      'both seams still reached their module',
    );

    // An unrelated namespace is ignored.
    config['tools.ask'].enabled.set(false);
    ctx.fire('settings/document-updated', 'some-other-plugin');
    await settle();
    assert.equal(entry.registryState().find((state) => state.id === 'tools.ask').started, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
