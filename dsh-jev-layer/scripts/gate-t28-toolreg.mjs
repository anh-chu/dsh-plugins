/**
 * G-T28-1: every tool a module registers is accepted by the harness's own registration rule.
 *
 * `gate.completion` registered `jev_gate` with no `output`. The harness's
 * `tools.register` throws on that, and the module's `start` catches the throw and only
 * logs it, so the module stayed "on" while its tool never existed. On a real turn the
 * model answered "no tool named jev_gate exists in this session". Every earlier gate
 * called `execute` on the definition directly, which never goes through registration.
 *
 * This gate hands each tool-registering module a `tools.register` that applies the same
 * rule the harness applies (dsh-tools `ToolRuntime.register`): `output` must be an object
 * with a `render` function, `presentationMeta` if present must be a function, and both
 * the parameter and output schemas must pass the harness's schema subset check. The
 * subset check uses the harness's own `assertSupportedJsonSchema` when that package can
 * be found, so the gate cannot drift from what the harness accepts.
 *
 * Run: node scripts/gate-t28-toolreg.mjs
 */
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import gateCompletion from '../packages/plugin/src/modules/gate-completion.js';
import toolsAsk from '../packages/plugin/src/modules/tools-ask.js';

/** The harness's schema checker, or null when its package cannot be found. */
async function harnessSchemaCheck() {
  const candidates = [process.env.DSH_TOOLS_PATH];
  try {
    const root = execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    candidates.push(join(root, '@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js'));
  } catch { /* no npm: fall through to the replicated rule */ }
  for (const path of candidates) {
    if (path && existsSync(path)) return (await import(pathToFileURL(path).href)).assertSupportedJsonSchema;
  }
  return null;
}

const schemaCheck = await harnessSchemaCheck();

/** The registration rule, as `ToolRuntime.register` applies it. Throws what the harness throws. */
function register(definition) {
  const { name, output } = definition;
  if (
    output === undefined
    || typeof output !== 'object'
    || typeof output.render !== 'function'
    || (output.presentationMeta !== undefined && typeof output.presentationMeta !== 'function')
  ) {
    throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`);
  }
  if (schemaCheck) {
    schemaCheck(definition.parameters);
    schemaCheck(output.schema);
  }
  if (definition.timeoutMs !== undefined && !(Number.isFinite(definition.timeoutMs) && definition.timeoutMs > 0)) {
    throw new TypeError(`tool "${name}" timeoutMs must be a positive finite number`);
  }
  return () => {};
}

function apiWith(registerFn) {
  const warnings = [];
  return {
    api: {
      id: 'probe',
      tools: { register: registerFn },
      config: { get: () => undefined },
      judge: { configured: true, ask: async () => null },
      budget: { tryAcquire: () => true },
      ledger: { append() {} },
      shadow: { isShadow: () => false },
      log: { warn: (line) => warnings.push(String(line)) },
    },
    warnings,
  };
}

/** The rule must be able to fail: a definition with no `output` is refused. */
assert.throws(
  () => register({ name: 'bare', parameters: { type: 'object', properties: {} } }),
  /must declare output/,
  'control: the rule refuses a tool with no output',
);

const cases = [
  { module: gateCompletion, tool: 'jev_gate' },
  { module: toolsAsk, tool: 'jev_ask' },
];

for (const { module, tool } of cases) {
  const registered = [];
  const { api, warnings } = apiWith((definition) => {
    const disposer = register(definition);
    registered.push(definition.name);
    return disposer;
  });
  module.stop?.();
  module.start(api);
  assert.deepEqual(registered, [tool], `${module.id}: ${tool} passes the harness registration rule`);
  assert.deepEqual(warnings, [], `${module.id}: registration logged no warning (a swallowed throw shows up here)`);

  // The renderer is total: the model always gets a line, even for a value it did not expect.
  const definition = (() => {
    let captured;
    const { api: probe } = apiWith((d) => { captured = d; return () => {}; });
    module.start(probe);
    return captured;
  })();
  for (const value of [undefined, null, {}, { ok: false }, { report: '' }]) {
    const blocks = definition.output.render({}, value);
    assert.ok(Array.isArray(blocks) && blocks.length > 0 && typeof blocks[0].text === 'string' && blocks[0].text !== '',
      `${module.id}: render(${JSON.stringify(value)}) returns a non-empty text block`);
  }
  module.stop();
}

// The runner wants the marker alone on its line, so the note goes first.
console.log(schemaCheck ? 'harness schema check applied' : 'replicated rule only: dsh-tools not found');
console.log('GATE-T28-TOOLREG-OK');
