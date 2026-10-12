/**
 * G-T1-2 (CID-2): `engines.dsh` is a real range, and no `@deepseek-ai/dsh*` peer
 * range is a wildcard.
 *
 * A `*` range proves nothing: the package would claim compatibility with every
 * harness version, and the declaration could not fail. The same detector is run
 * against a synthetic manifest with a wildcard peer, so the gate shows the check
 * fires on the case it is meant to catch.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MANIFESTS = ['package.json', 'packages/plugin/package.json', 'packages/core/package.json'];
const EXPECTED_DSH_RANGE = '>=0.2.0-0 <0.3.0';
const WILDCARDS = new Set(['', '*', 'x', 'X', 'latest', 'any']);

/** Whether a peer range fails to constrain anything. */
function isWildcard(range) {
  const value = String(range ?? '').trim();
  if (WILDCARDS.has(value)) return true;
  return /^\*(\s|$)/.test(value) || /^>=\s*0(\.0)*(\s|<|\|\||$)/.test(value);
}

/** Peers on a gated `@deepseek-ai/dsh*` package whose range is a wildcard. */
function wildcardDshPeers(manifest) {
  const offenders = [];
  for (const [name, range] of Object.entries(manifest?.peerDependencies ?? {})) {
    if (!name.startsWith('@deepseek-ai/dsh')) continue;
    if (isWildcard(range)) offenders.push(`${name}@${String(range)}`);
  }
  return offenders;
}

/** Whether an `engines.dsh` value is a range that can fail. */
function isRealRange(range) {
  const value = String(range ?? '').trim();
  if (isWildcard(value)) return false;
  return /[<>=^~]|\s-\s|\|\|/.test(value);
}

// ── positive control: the detectors fire on the cases they exist to catch ──
const synthetic = { peerDependencies: { '@deepseek-ai/dsh-settings': '*', '@deepseek-ai/dsh-session': '' } };
assert.deepEqual(wildcardDshPeers(synthetic), ['@deepseek-ai/dsh-settings@*', '@deepseek-ai/dsh-session@']);
assert.equal(wildcardDshPeers({ peerDependencies: { '@deepseek-ai/dsh-settings': '>=0.2.0-0 <0.3.0' } }).length, 0);
assert.equal(isRealRange('*'), false, 'the range detector rejects a wildcard');
assert.equal(isRealRange('>=0.2.0-0 <0.3.0'), true, 'the range detector accepts a real range');

// ── the real manifests ─────────────────────────────────────────────────────
const manifests = new Map();
for (const relative of MANIFESTS) {
  const path = `${ROOT}${relative}`;
  assert.ok(existsSync(path), `${relative} exists`);
  manifests.set(relative, JSON.parse(readFileSync(path, 'utf8')));
}

for (const [relative, manifest] of manifests) {
  assert.deepEqual(wildcardDshPeers(manifest), [], `${relative} has no wildcard @deepseek-ai/dsh* peer`);
}

const plugin = manifests.get('packages/plugin/package.json');
assert.equal(plugin.engines?.dsh, EXPECTED_DSH_RANGE, 'engines.dsh is the declared 0.2 range');
assert.equal(isRealRange(plugin.engines.dsh), true);
for (const [name, range] of Object.entries(plugin.peerDependencies ?? {})) {
  assert.ok(String(range).trim().length > 0, `peer ${name} has a range`);
  assert.notEqual(String(range).trim(), '*', `peer ${name} is not a wildcard`);
}
// The row is inserted by this file; a manifest that points nowhere mounts nothing.
assert.equal(plugin.dsh?.bundle?.patch, './cordis.patch.yml');
assert.ok(existsSync(`${ROOT}packages/plugin/cordis.patch.yml`), 'cordis.patch.yml exists');

// The entry must export a schema, and a `link:` install is the case that loses it:
// with no `node_modules` above the plugin's real path the bare specifier fails, and
// the settings service then refuses to configure the entry at all — measured in the
// operator's live profile as `No configurable plugin entry "dsh-jev-layer"`, while
// every gate stayed green because they install with `file:`.
const { Config } = await import(`${ROOT}packages/plugin/src/index.js`);
const { default: MODULES_FOR_LABELS } = await import(`${ROOT}packages/plugin/src/modules/index.js`);
assert.notEqual(Config, undefined, 'the entry exports a Config schema, so the host can configure it');

// The browser half. In 0.2 the Plugins settings section is the client list slot
// `settings.plugins.tab`, so a host-only plugin has no page at all — this half is
// what puts the entry's own form on screen. The one defect that kills it silently
// is a module id that is not the package name: the loader then reports
// `loaded without registering "<pkg>"` and the tab never appears, with nothing in
// the host log. The id is derived here, not trusted.
assert.equal(plugin.exports?.['./client'], './client.js', 'the package exports its client half');
const clientPath = `${ROOT}packages/plugin/client.js`;
assert.ok(existsSync(clientPath), 'client.js exists');
const clientSource = readFileSync(clientPath, 'utf8');
const registered = clientSource.match(/__ModuleLoader__\s*\.\s*load\(\{\s*id:\s*'([^']+)'/)?.[1];
assert.equal(registered, plugin.name, 'the browser module registers under the package name');
assert.equal(plugin.dsh?.client?.platform, 'web', 'the client half declares the web platform');
assert.ok(
  Array.isArray(plugin.dsh?.client?.inject) && plugin.dsh.client.inject.length > 0,
  'the client half declares the packages it needs loaded',
);

// The panel's help text comes from the plugin's own schema, and that walk decides
// whether a field shows a description or a bare name — the operator's complaint
// about the first version was exactly that. It cannot be rendered here (this
// deployment ships no `react-dom/server`), so the walk is exercised directly.
{
  let captured;
  new Function('window', clientSource)({
    __ModuleLoader__: { load: (spec) => { captured = spec; } },
  });
  assert.equal(captured?.id, plugin.name, 'the bundle registers under the package name when evaluated');

  const bundle = captured.factory((id) => (id === 'react' ? { createElement: () => null } : undefined));
  assert.deepEqual(bundle.inject, ['slots', 'configForms'], 'the half injects the slot and form services');

  // The fixture is the plugin's OWN serialized schema, not a shape written by hand:
  // the first version of this check invented a nested tree, the walk agreed with it,
  // and the live panel showed nothing, because the real envelope is `{uid, refs}`.
  const schema = Config.toJSON();
  const describe = { getSnapshot: () => ({ view: { namespaces: [{ ns: plugin.name, schema }] } }) };
  const fields = bundle.__schemaFields(describe);
  assert.ok(
    fields.get('admit.output.minTokens')?.description?.includes('Only judge tool results'),
    'a module setting carries the description written at its declaration',
  );
  assert.equal(fields.get('admit.output.minTokens')?.default, 2000, 'the declared default is read too');
  assert.ok(
    fields.get('endpoint')?.description?.includes('Judge endpoint'),
    'a global setting carries its description',
  );
  assert.ok(fields.size > 30, `every declared field is reachable (found ${fields.size})`);
  assert.ok(
    fields.get('screen.fetch.enabled')?.description?.length > 20,
    'a module heading carries its own one-line purpose, on the switch the mirror keeps',
  );
  assert.equal(fields.get('nope.missing'), undefined, 'an absent path has no help rather than an empty one');

  // The settings mirror serves `volatileForm(schema)`, not the envelope the schema is
  // built as (dsh-settings/lib/index.js:122). A volatile leaf is kept whole; a
  // non-volatile object is REBUILT from its children, so the object's own description
  // is dropped. Measured on this host: a module purpose set on the object vanished
  // from the page, so it now rides on the volatile `enabled` leaf. The rule below is
  // copied from the harness source, because the function is not exported.
  const volatileForm = (node) => {
    if (node?.meta?.volatile) return node;
    if (node?.type === 'object') {
      const dict = {};
      for (const [key, child] of Object.entries(node.dict ?? {})) {
        const field = volatileForm(child);
        if (field !== undefined) dict[key] = field;
      }
      return Object.keys(dict).length === 0 ? undefined : { type: 'object', dict };
    }
    return undefined;
  };
  const envelope = Config.toJSON();
  /** Resolve refs into a plain tree so the rule above can run on it. */
  const expand = (value) => {
    if (typeof value === 'number' || typeof value === 'string') return expand(envelope.refs[value]);
    if (value === undefined || value === null || typeof value !== 'object') return value;
    const out = { ...value };
    if (value.dict) out.dict = Object.fromEntries(Object.entries(value.dict).map(([k, v]) => [k, expand(v)]));
    return out;
  };
  const served = volatileForm(expand(envelope.refs[envelope.uid]));
  const fromServed = bundle.__schemaFields({
    getSnapshot: () => ({ view: { namespaces: [{ ns: plugin.name, schema: { uid: 0, refs: { 0: served } } }] } }),
  });
  assert.ok(
    fromServed.get('screen.fetch.enabled')?.description?.includes('instructions aimed at the model'),
    'a module purpose survives the settings mirror projection',
  );
  assert.ok(
    fromServed.get('admit.output.minTokens')?.description?.includes('Only judge tool results'),
    'a field description survives the settings mirror projection',
  );
}

// A module heading reads as a name, not an id: the readable title travels on the
// enabled switch, and the panel shows it. Every shipped module must have one, and it
// must not simply repeat the id.
{
  for (const module of MODULES_FOR_LABELS) {
    const label = module.label;
    assert.equal(typeof label, 'string', `${module.id} declares a readable label`);
    assert.ok(label.length > 3 && label !== module.id, `${module.id} label is a name, not its id`);
  }
}

// The panel must not print a module id as its heading. A bare id is what the user
// called unreadable. The check is on the source, with a positive control: the same
// detector must fire on the old line it is meant to keep out.
{
  const idHeading = /h\(\s*'h4'[^)]*\},\s*id\s*\)/;
  assert.ok(idHeading.test("h('h4', { style: {} }, id)"), 'positive control: the detector fires on a raw-id heading');
  assert.ok(!idHeading.test(clientSource), 'the panel never prints a raw module id as a heading');
}

console.log('GATE-T1-MANIFEST-OK');
