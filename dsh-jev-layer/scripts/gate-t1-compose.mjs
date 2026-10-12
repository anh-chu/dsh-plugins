/**
 * G-T1-1 (CID-1): the profile composes with the plugin row present, and every
 * module is off on a fresh install.
 *
 * Composition is checked against the real loader: a throwaway profile is
 * created from the shipped `web` template in a temporary DSH_HOME, and the
 * plugin's own `cordis.patch.yml` is applied as an overlay. The same profile is
 * dumped without the overlay first, as the positive control for the row
 * detector.
 *
 * This proves composition, not activation: `--dump-config` prints the composed
 * tree and does not load plugin JavaScript. Module activation is covered by the
 * T5 gates and by the live gate.
 *
 * A `file:` install of the plugin could not be run: the frozen
 * `packages/plugin/package.json` declares `dsh-jev-layer-core: workspace:*`, and
 * pnpm rejects that outside the workspace (ERR_PNPM_WORKSPACE_PKG_NOT_FOUND).
 * Reported to the integrator.
 *
 * The "every module off" half is asserted on the real schema: schemastery is
 * resolved from the installed harness, the schema is built from fixture module
 * descriptors, and one fresh-install resolution must yield a volatile `false`
 * for every module id.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  GLOBAL_DEFAULTS,
  buildConfig,
  isVolatileRef,
  readConfig,
} from '../packages/plugin/src/config.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PATCH = join(ROOT, 'packages/plugin/cordis.patch.yml');
const PROFILE = 'gate-t1';

const home = mkdtempSync(join(tmpdir(), 'dsh-jev-layer-gate-'));
const tmpRoot = realpathSync(tmpdir());

/** One `dsh --dump-config` run in the throwaway home. */
function dumpConfig({ patch, create }) {
  const args = ['--profile', PROFILE, '--dump-config'];
  if (create) args.push('--from-default-profile', 'web');
  if (patch) args.push('--patch', patch);
  const env = { ...process.env, DSH_HOME: home };
  for (const key of ['DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_SESSION_ID', 'DSH_WEB_URL']) delete env[key];
  const result = spawnSync('dsh', args, { env, encoding: 'utf8', timeout: 240_000, maxBuffer: 64 * 1024 * 1024 });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
}

/** The installed harness package root, found through the `dsh` on PATH. */
function dshRoot() {
  for (const dir of (process.env.PATH ?? '').split(':').filter(Boolean)) {
    const binary = join(dir, 'dsh');
    if (!existsSync(binary)) continue;
    let real;
    try {
      real = realpathSync(binary);
    } catch {
      continue;
    }
    const root = dirname(dirname(real));
    if (existsSync(join(root, 'package.json'))) return root;
  }
  return null;
}

/** The ESM entry of the harness's own schemastery, or null. */
function schemasteryEntry(root) {
  const probe = spawnSync(
    process.execPath,
    ['-e', "process.stdout.write(require.resolve('@deepseek-ai/schemastery'))"],
    { cwd: root, encoding: 'utf8' },
  );
  if (probe.status !== 0) return null;
  let dir = dirname(probe.stdout.trim());
  for (let depth = 0; depth < 4; depth += 1) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
      if (pkg.name === '@deepseek-ai/schemastery') {
        const entry = pkg.exports?.['.']?.import ?? pkg.main ?? 'lib/index.mjs';
        return pathToFileURL(join(dir, entry)).href;
      }
    }
    dir = dirname(dir);
  }
  return pathToFileURL(probe.stdout.trim()).href;
}

try {
  // The skip detector is not vacuous: it fires on the text it looks for.
  assert.equal(/skipping profile bundle/.test('x skipping profile bundle y'), true);

  // ── composition: the profile without the overlay has no row ─────────────
  const baseline = dumpConfig({ create: true });
  assert.equal(baseline.error, undefined, `dsh --dump-config ran: ${baseline.error?.message ?? ''}`);
  assert.equal(baseline.status, 0, `the baseline profile composes (stderr: ${baseline.stderr.slice(0, 400)})`);
  assert.equal(
    /skipping profile bundle/.test(`${baseline.stdout}${baseline.stderr}`),
    false,
    'the baseline composes with zero skipped bundles',
  );
  assert.equal(
    baseline.stdout.split('\n').filter((line) => line.trim() === '- id: dsh-jev-layer').length,
    0,
    'the row is absent without the overlay (positive control for the row detector)',
  );

  // ── composition: the plugin's overlay inserts exactly one row ───────────
  const composed = dumpConfig({ patch: PATCH });
  assert.equal(composed.status, 0, `the plugin row composes (stderr: ${composed.stderr.slice(0, 400)})`);
  assert.equal(
    /skipping profile bundle/.test(`${composed.stdout}${composed.stderr}`),
    false,
    'the composed profile reports zero skipped bundles',
  );
  const lines = composed.stdout.split('\n').map((line) => line.trim());
  assert.equal(lines.filter((line) => line === '- id: dsh-jev-layer').length, 1, 'the plugin mounts as one row');
  assert.ok(
    lines.some((line) => line === "name: dsh-jev-layer"),
    'the row resolves by package name',
  );
  assert.ok(
    lines.some((line) => line === '# == ' + PATCH),
    'the overlay that inserted the row is the plugin\'s own patch',
  );

  // ── the schema: every module off on a fresh install ────────────────────
  const root = dshRoot();
  assert.ok(root, 'the harness package was found through the dsh on PATH');
  const entry = schemasteryEntry(root);
  assert.ok(entry, 'the harness ships @deepseek-ai/schemastery');
  const z = (await import(entry)).default;
  assert.equal(typeof z?.object, 'function', 'schemastery resolved from the installed harness');

  const fixtures = [
    { id: 'admit.output', settings: { minTokens: { type: 'number', default: 2000, description: 'x' } } },
    {
      id: 'screen.fetch',
      settings: {
        threshold: { type: 'number', default: 0.75, description: 'x' },
        toolAllowlist: { type: 'stringArray', default: ['web_fetch'], description: 'x' },
        // A module may not switch itself on; the registry owns the toggle.
        enabled: { type: 'boolean', default: true, description: 'x' },
      },
    },
  ];
  const schema = buildConfig(fixtures, z);
  assert.ok(schema, 'buildConfig returns a schema when the library resolves');
  const resolved = schema({});

  for (const key of Object.keys(GLOBAL_DEFAULTS)) {
    assert.ok(isVolatileRef(resolved[key]), `global ${key} is volatile`);
  }
  for (const id of ['admit.output', 'screen.fetch']) {
    assert.equal(readConfig(resolved[id], 'enabled'), false, `${id} is off on a fresh install`);
  }
  assert.equal(readConfig(resolved['admit.output'], 'minTokens'), 2000);
  assert.equal(readConfig(resolved['screen.fetch'], 'threshold'), 0.75);
  assert.deepEqual(readConfig(resolved['screen.fetch'], 'toolAllowlist'), ['web_fetch']);
  for (const [id, group] of Object.entries(resolved)) {
    // A global field is a volatile leaf itself; a module is a plain object of them.
    if (isVolatileRef(group)) continue;
    if (typeof group !== 'object' || group === null) continue;
    for (const [name, value] of Object.entries(group)) {
      assert.ok(isVolatileRef(value), `${id}.${name} resolves to a volatile reference`);
    }
  }

  // The resolver's reason to exist, as a positive control: a reference holding
  // `true` is not `true`, and comparing it directly silently fails.
  const truthy = { get: () => true };
  assert.equal(isVolatileRef(truthy), true);
  assert.equal(truthy === true, false, 'a volatile reference is never the bare value');
  assert.equal(readConfig({ flag: truthy }, 'flag', false), true, 'the resolver unwraps it');
  assert.equal(
    readConfig({ flag: { get() { throw new Error('released'); } } }, 'flag', false),
    false,
    'a broken reference falls back instead of throwing',
  );
  assert.equal(buildConfig(fixtures, null), undefined, 'no schema library means no schema, not a failure');

  // ── the files this ticket owns are syntactically whole ─────────────────
  for (const file of ['packages/plugin/src/index.js', 'packages/plugin/src/registry.js', 'packages/plugin/src/config.js']) {
    const check = spawnSync(process.execPath, ['--check', join(ROOT, file)], { encoding: 'utf8' });
    assert.equal(check.status, 0, `${file} passes node --check: ${check.stderr.slice(0, 300)}`);
  }
} finally {
  if (home.startsWith(tmpRoot) && home.includes('dsh-jev-layer-gate-')) {
    rmSync(home, { recursive: true, force: true });
  }
  assert.equal(existsSync(home), false, 'the throwaway profile was removed');
}

console.log('GATE-T1-COMPOSE-OK');
