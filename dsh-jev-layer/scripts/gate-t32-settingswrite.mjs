/**
 * G-T32-1: the settings page writes a path the host accepts, for every module and setting.
 *
 * The page built its write path with `'admit.output.enabled'.split('.')`. Module ids contain
 * a dot, and the schema keys each module section by the WHOLE id, so that produced
 * `['admit', 'output', 'enabled']`. The host's `SettingsForms.write` checks every op path with
 * `isVolatilePath(schema, path)` and throws `Config field "admit.output.enabled" is not
 * volatile`; the client turns the failed write into "the host refused admit.output".
 * No module with a dotted id could be toggled or edited from the page, which is all of them.
 *
 * The host's `isVolatilePath` is not exported, so its five lines are copied below. The
 * schema is the plugin's OWN `Config`, and the paths are the ones the page's `__setOp`
 * builds, for every field the schema declares.
 *
 * Run: node scripts/gate-t32-settingswrite.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { Config } from '../packages/plugin/src/index.js';

const clientSource = readFileSync(new URL('../packages/plugin/client.js', import.meta.url), 'utf8');
let captured;
new Function('window', clientSource)({ __ModuleLoader__: { load: (spec) => { captured = spec; } } });
const bundle = captured.factory((id) => (id === 'react' ? { createElement: () => null } : undefined));

/** Copy of `isVolatilePath` from @deepseek-ai/dsh-settings (lib/index.js). */
function isVolatilePath(schema, path) {
  if (schema.meta.volatile) return true;
  const [key, ...rest] = path;
  const child = key === undefined ? undefined : schema.dict?.[key];
  return child !== undefined && isVolatilePath(child, rest);
}

// Control: the old construction is refused by the host's rule, so the check can fail.
assert.equal(
  isVolatilePath(Config, 'admit.output.enabled'.split('.')),
  false,
  'control: the old dotted split names a path the host refuses',
);

// Every module section and every leaf the page can write.
const sections = Object.keys(Config.dict).filter((key) => Config.dict[key]?.dict !== undefined);
assert.ok(sections.length >= 17, `the schema declares the module sections (found ${sections.length})`);
let leaves = 0;
for (const id of sections) {
  for (const key of Object.keys(Config.dict[id].dict)) {
    const op = bundle.__setOp([id, key], key === 'enabled' ? true : 'x');
    assert.equal(op.op, 'set');
    assert.deepEqual(op.path, [id, key], `${id}.${key}: the module id stays ONE key in the path`);
    assert.equal(isVolatilePath(Config, op.path), true, `the host accepts a write to [${id}, ${key}]`);
    leaves += 1;
  }
}
assert.ok(leaves > 60, `a write was checked for every module setting (found ${leaves})`);

// Global scalars are one key.
for (const key of Object.keys(Config.dict).filter((k) => Config.dict[k]?.dict === undefined)) {
  const op = bundle.__setOp([key], 'x');
  assert.deepEqual(op.path, [key]);
  if (Config.dict[key]?.meta?.volatile) assert.equal(isVolatilePath(Config, op.path), true, `the host accepts a write to ${key}`);
}

// The page itself must not build a path by splitting on dots.
assert.ok(!/\.split\(\s*['"]\.['"]\s*\)/.test(clientSource), 'the client never splits a settings path on dots');
assert.ok(/write\(\[id, 'enabled'\]/.test(clientSource), 'the module switch writes the key array [id, enabled]');

console.log('GATE-T32-SETTINGSWRITE-OK');
