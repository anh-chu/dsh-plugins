/**
 * T11 — install and live verification in a throwaway profile.
 *
 * This gate installs the plugin into a profile created for the occasion, boots
 * the real harness on a spare port, and exercises the plugin's own routes. It
 * proves five things, in order:
 *
 *   G-T11-1 active    the profile composes with the row present, zero bundles
 *                     skipped, and the plugin's status route answers — which it
 *                     cannot do unless `apply()` ran, the core loaded and the
 *                     registry was built.
 *   G-T11-2 toggle    a write through the settings service's own `update()` path
 *                     changes the active set with no restart, and changes it back.
 *   G-T11-3 status    module states and the ledger size are readable from the
 *                     plugin's status route.
 *   G-T11-4 uninstall `dsh plugin remove` takes the row out of the composed
 *                     config, and a fresh boot answers 404.
 *   G-T11-5 judge     the credential named by `apiKeyRef` really resolves in a
 *                     live host and one real judgment returns a probability.
 *                     Mounting, activating and toggling are not evidence of it:
 *                     a `configured` flag can be true while the judge never
 *                     resolved a key, because every module fails open.
 *
 * Why the status route is the evidence for activation. A loader row reports
 * "active" even when the plugin's `boot()` gave up before starting anything, so
 * the row alone proves nothing. `tools.ask` and `gate.completion` are the same
 * trap: they fail soft and register nothing. The status route is registered at
 * the end of `boot()`, after the core is built and the registry has started, so
 * a 200 with the module list is the honest signal. Each check names its positive
 * control: the toggle reads the module off before it writes, the uninstall reads
 * the same route 200 before it removes, and the judge reads a real probability
 * for a present credential before it asserts absence for an absent one.
 *
 * Why the judge check has its own profile. It rewrites `endpoint`, `model` and
 * `apiKeyRef`, and those writes must not leak into the profile the other four
 * checks share. `tmp-jev-judge` is therefore created, used and removed on its
 * own, on its own port.
 *
 * The credential. The child harness never inherits `TYPESAFE_API_KEY` or
 * `TYPESAFE_KEY` from this process: the plugin's resolution falls back to the
 * environment, and an inherited key would make the absent-credential control
 * pass for the wrong reason. With the environment stripped, the positive case
 * can only resolve through the DSH credential store — which is the path under
 * test. This gate never reads a credential file; the plugin resolves the value
 * through the host service and never returns it.
 *
 * Safety. The user's own `web` profile is fingerprinted (config, manifests, lock
 * file and the sorted `node_modules` listing) before anything runs and asserted
 * unchanged at the end. Every throwaway profile, the temp log directory and the
 * spawned servers are removed in a `finally` block. Nothing here touches port
 * 3081.
 *
 * Usage:  node scripts/gate-live.mjs [--check active|toggle|status|uninstall|judge]
 * With no `--check`, all five run and all five markers print.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = join(ROOT, 'packages', 'plugin');
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const PROFILE = 'tmp-jev-layer';
const JUDGE_PROFILE = 'tmp-jev-judge';
const PORT = Number(process.env.JEV_LIVE_PORT ?? 19391);
const JUDGE_PORT = Number(process.env.JEV_JUDGE_PORT ?? 19392);
const WEB_PROFILE = join(DSH_HOME, 'profiles', 'web');
const BOOT_TIMEOUT_MS = 120_000;

/** The endpoint and model the judge check drives. The default endpoint differs. */
const JUDGE_ENDPOINT = 'https://opencode.ai/zen/v1/systemone';
const JUDGE_MODEL = 'jev-1.13-free';
const JUDGE_REF = 'TYPESAFE_API_KEY';

const MARKERS = {
  active: 'GATE-LIVE-ACTIVE-OK',
  toggle: 'GATE-LIVE-TOGGLE-OK',
  status: 'GATE-LIVE-STATUS-OK',
  uninstall: 'GATE-LIVE-UNINSTALL-OK',
  judge: 'GATE-LIVE-JUDGE-OK',
};

/** `--check <name>` runs one; no flag runs every check in table order. */
const argv = process.argv.slice(2);
const only = argv.includes('--check') ? argv[argv.indexOf('--check') + 1] : null;
assert.ok(
  only === null || Object.hasOwn(MARKERS, only),
  `--check must be one of ${Object.keys(MARKERS).join(', ')}`,
);

const wanted = (check) => only === null || only === check;

/**
 * The process environment the child harness gets.
 *
 * The plugin's credential resolution falls back to `process.env[ref]` and then
 * to `TYPESAFE_API_KEY`. Inheriting either would let the absent-credential
 * control resolve a key it should not have found.
 */
const CHILD_ENV = { ...process.env };
for (const name of ['TYPESAFE_API_KEY', 'TYPESAFE_KEY']) delete CHILD_ENV[name];

/** The child's own output, on disk while it runs and removed in `finally`. */
const LOG_DIR = mkdtempSync(join(tmpdir(), 'dsh-jev-live-'));

// The profile in force. The judge check moves it to its own profile.
let profileName = PROFILE;
let profileDir = join(DSH_HOME, 'profiles', profileName);
let livePort = PORT;
let base = `http://127.0.0.1:${livePort}`;
let statusRoute = `${base}/dsh-jev-layer/status`;
let settingsRoute = `${base}/dsh-jev-layer/settings`;
let probeRoute = `${base}/dsh-jev-layer/probe`;

/** Point every path at one throwaway profile. */
function selectProfile(name, port) {
  profileName = name;
  profileDir = join(DSH_HOME, 'profiles', name);
  livePort = port;
  base = `http://127.0.0.1:${port}`;
  statusRoute = `${base}/dsh-jev-layer/status`;
  settingsRoute = `${base}/dsh-jev-layer/settings`;
  probeRoute = `${base}/dsh-jev-layer/probe`;
}

let server = null;
/** Markers are held back until the teardown has run, so the last line is a marker. */
const passed = [];

/** One CLI invocation, from the repository root. */
function dsh(args, { timeout = 300_000 } = {}) {
  const run = spawnSync('dsh', args, { cwd: ROOT, encoding: 'utf8', timeout, env: CHILD_ENV });
  return { code: run.status, out: `${run.stdout ?? ''}${run.stderr ?? ''}` };
}

/** A content fingerprint of a directory's files, so a silent edit cannot pass. */
function fingerprint(dir) {
  if (!existsSync(dir)) return 'missing';
  const hash = createHash('sha256');
  for (const name of readdirSync(dir).sort()) {
    if (name === 'node_modules') continue;
    try {
      hash.update(name).update(readFileSync(join(dir, name)));
    } catch {
      hash.update(`${name}:unreadable`);
    }
  }
  const modules = join(dir, 'node_modules');
  if (existsSync(modules)) {
    hash.update('node_modules:').update(readdirSync(modules).sort().join('\n'));
  }
  return hash.digest('hex');
}

const webBefore = fingerprint(WEB_PROFILE);

/** Poll the status route until `predicate` holds, or give up. */
async function waitForStatus(predicate, { timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(statusRoute);
      if (response.ok) {
        last = await response.json();
        if (predicate(last)) return last;
      }
    } catch {
      /* the server may still be coming up */
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  return last;
}

async function startServer() {
  const logPath = join(LOG_DIR, `${profileName}.log`);
  const logFd = openSync(logPath, 'a');
  const child = spawn(
    'dsh',
    ['--profile', profileName, '--port', String(livePort), '--host', '127.0.0.1', '--no-open'],
    { cwd: ROOT, stdio: ['ignore', logFd, logFd], env: CHILD_ENV },
  );
  // The child owns its copy of the descriptor; the parent closes its own.
  closeSync(logFd);
  child.log = () => {
    try {
      return readFileSync(logPath, 'utf8');
    } catch {
      return '';
    }
  };

  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the harness exited ${child.exitCode}: ${child.log().slice(-800)}`);
    try {
      const response = await fetch(statusRoute);
      if (response.status === 200 || response.status === 404) return child;
    } catch {
      /* not listening yet */
    }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(
    `the harness did not answer on ${base} within ${BOOT_TIMEOUT_MS} ms: ${child.log().slice(-800)}`,
  );
}

async function stopServer(child) {
  if (child === null || child.exitCode !== null) return;
  child.kill('SIGTERM');
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && child.exitCode === null) {
    await new Promise((done) => setTimeout(done, 200));
  }
  if (child.exitCode === null) child.kill('SIGKILL');
}

// ── setup: a profile of our own, with the plugin installed ───────────────

function setup() {
  rmSync(profileDir, { recursive: true, force: true });
  const created = dsh(['--profile', profileName, '--from-default-profile', 'web', '--dump-config']);
  assert.equal(created.code, 0, `the profile must be created: ${created.out.slice(-400)}`);

  const added = dsh(['plugin', '--profile', profileName, 'add', `file:${PLUGIN}`]);
  assert.equal(added.code, 0, `the plugin must install from a file: path: ${added.out.slice(-600)}`);

  const dumped = dsh(['--profile', profileName, '--dump-config']);
  assert.equal(dumped.code, 0, `--dump-config must exit 0: ${dumped.out.slice(-400)}`);
  const skipped = dumped.out.split('\n').filter((line) => line.includes('skipping profile bundle'));
  assert.deepEqual(skipped, [], 'zero bundles are skipped');
  assert.match(dumped.out, /dsh-jev-layer/, 'the plugin row is present in the composed config');
}

// ── the checks ───────────────────────────────────────────────────────────

async function checkActive() {
  const response = await fetch(statusRoute);
  assert.equal(response.status, 200, 'the status route answers');
  const body = await response.json();
  assert.equal(body.id, 'dsh-jev-layer');
  assert.equal(body.namespace, 'dsh-jev-layer');
  // Every shipped module is loaded. On a fresh install every one is off.
  assert.deepEqual(
    body.modules.map((module) => module.id).sort(),
    [
      'admit.output',
      'admit.terminal',
      'answer.questions',
      'approve.workspace',
      'gate.completion',
      'guide.instructions',
      'guide.shared',
      'nag.nogoal',
      'notify.decline',
      'rank.files',
      'remind.drift',
      'route.interjection',
      'screen.fetch',
      'select.skill',
      'supervise.goal',
      'tools.ask',
      'tools.surface',
    ],
  );
  for (const module of body.modules) {
    assert.equal(module.started, false, `${module.id} is off on a fresh install`);
    assert.equal(module.error, null, `${module.id} reported no error`);
  }

  // The credential must resolve on its own after a boot. Nothing here writes
  // settings and nothing calls the probe — those two are exactly what used to be
  // required, because the credentials store mounts after the plugin boots. Without
  // this the judge stays unconfigured, and a module that checks `configured` before
  // asking fails open in silence. Polled rather than read once, so the check is
  // about eventual resolution and not about winning a race.
  const deadline = Date.now() + 15_000;
  let configured = false;
  while (Date.now() < deadline) {
    const state = await (await fetch(statusRoute)).json();
    if (state.judge?.configured === true) {
      configured = true;
      break;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  assert.equal(configured, true, 'the judge resolves its credential after boot, with no settings write');

  passed.push(MARKERS.active);
}

async function checkStatus() {
  const body = await waitForStatus((state) => Array.isArray(state.modules));
  assert.ok(body, 'the status route answers');
  for (const module of body.modules) {
    assert.ok(
      module.seam === null || typeof module.seam === 'string',
      `${module.id} reports its seam, or null when it consumes no harness event`,
    );
    assert.equal(typeof module.enabled, 'boolean', `${module.id} reports its switch`);
    assert.equal(typeof module.started, 'boolean', `${module.id} reports whether it started`);
  }
  assert.ok(body.ledger !== null, 'the status route exposes the ledger');
  assert.equal(typeof body.ledger.size, 'number', 'the ledger reports a size');
  assert.ok(body.ledger.size >= 0);
  assert.ok(Array.isArray(body.started), 'the status route lists the started modules');
  // The credential state is masked: a name and a boolean, never a value.
  assert.ok(body.credential === null || typeof body.credential === 'object');
  assert.ok(
    body.credential === null || !('value' in body.credential),
    'the status route never carries a credential value',
  );
  passed.push(MARKERS.status);
}

async function checkToggle() {
  // Positive control: the detector can see a module that is off.
  const before = await waitForStatus((state) => state.modules !== undefined);
  const off = before.modules.find((module) => module.id === 'select.skill');
  assert.equal(off.started, false, 'select.skill is off before the write');
  assert.equal(off.enabled, false);

  const write = (patch) =>
    fetch(settingsRoute, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch }),
    });

  const on = await write({ 'select.skill': { enabled: true } });
  assert.equal(on.status, 200, `the settings write must be accepted: ${await on.text()}`);

  const started = await waitForStatus(
    (state) => state.modules.some((module) => module.id === 'select.skill' && module.started === true),
  );
  assert.ok(
    started?.modules.some((module) => module.id === 'select.skill' && module.started === true),
    'the module starts without a restart',
  );
  assert.ok(started.started.includes('select.skill'), 'the started list names it');

  // The two tool-providing modules also prove the registry's tools bridge reached
  // the host. Without it each logs that no tools service is reachable, and that
  // line is the detector: its absence means `jev_ask` and `jev_gate` were handed
  // a real `register`.
  const toolsOn = await write({ 'tools.ask': { enabled: true }, 'gate.completion': { enabled: true } });
  assert.equal(toolsOn.status, 200, 'the tool modules can be switched on');
  const tooling = (state) =>
    state.modules.filter(
      (module) => (module.id === 'tools.ask' || module.id === 'gate.completion') && module.started === true,
    );
  const bothStarted = await waitForStatus((state) => tooling(state).length === 2);
  assert.equal(tooling(bothStarted).length, 2, 'both tool modules start');
  assert.doesNotMatch(
    server.log(),
    /no tools service is reachable from the module api/,
    'the registry gave both modules a tools service',
  );

  // The one exclusive seam with two owners. Both must start, and the live log
  // must not carry the registry's intersecting-target refusal: that is CID-18's
  // disjoint-target split observed in a real host, not in a fixture.
  const seamOn = await write({ 'admit.output': { enabled: true }, 'admit.terminal': { enabled: true } });
  assert.equal(seamOn.status, 200, 'both admit owners can be switched on');
  const admits = (state) =>
    state.modules.filter(
      (module) => (module.id === 'admit.output' || module.id === 'admit.terminal') && module.started === true,
    );
  const admitsStarted = await waitForStatus((state) => admits(state).length === 2);
  assert.equal(admits(admitsStarted).length, 2, 'admit.output and admit.terminal coexist on tools/post-execute');
  assert.doesNotMatch(server.log(), /intersecting targets/, 'the live composition raises no seam conflict');

  const offWrite = await write({
    'select.skill': { enabled: false },
    'tools.ask': { enabled: false },
    'gate.completion': { enabled: false },
    'admit.output': { enabled: false },
    'admit.terminal': { enabled: false },
  });
  assert.equal(offWrite.status, 200, 'the settings write back must be accepted');
  const stopped = await waitForStatus(
    (state) => state.modules.some((module) => module.id === 'select.skill' && module.started === false),
  );
  assert.ok(
    stopped?.modules.some((module) => module.id === 'select.skill' && module.started === false),
    'the module stops again without a restart',
  );
  assert.equal(tooling(stopped).length, 0, 'the tool modules stop again without a restart');
  assert.equal(admits(stopped).length, 0, 'the two admit owners stop again without a restart');
  passed.push(MARKERS.toggle);
}

async function checkUninstall() {
  const removed = dsh(['plugin', '--profile', profileName, 'remove', 'dsh-jev-layer']);
  assert.equal(removed.code, 0, `the plugin must remove: ${removed.out.slice(-400)}`);

  const dumped = dsh(['--profile', profileName, '--dump-config']);
  assert.equal(dumped.code, 0, '--dump-config still exits 0 after removal');
  assert.doesNotMatch(dumped.out, /id: dsh-jev-layer/, 'the row is gone from the composed config');

  // A fresh boot of the same profile: the route that answered 200 before the
  // removal is the positive control, and it must now be absent.
  server = await startServer();
  const response = await fetch(statusRoute);
  assert.equal(response.status, 404, 'the plugin route is gone with the plugin');
  await stopServer(server);
  server = null;
  passed.push(MARKERS.uninstall);
}

/**
 * G-T11-5: the judge is really wired in a live host.
 *
 * The order matters. The positive direction runs first, with the credential
 * name that the store holds: it asserts the judge reports configured *and* that
 * one real judgment comes back with a probability. Only then does the absent
 * case run, because that positive result is what proves the probe can tell a
 * configured judge from an unconfigured one at all.
 */
async function checkJudge() {
  selectProfile(JUDGE_PROFILE, JUDGE_PORT);
  setup();
  server = await startServer();

  const write = (patch) =>
    fetch(settingsRoute, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch }),
    });

  /** One probe. The route itself reports whether the core found a credential. */
  const probe = async () => {
    const response = await fetch(probeRoute, { method: 'POST' });
    assert.equal(response.status, 200, `the probe route answers: ${response.status}`);
    return response.json();
  };

  // ── 1. the positive direction ──────────────────────────────────────────
  const configuredWrite = await write({
    endpoint: JUDGE_ENDPOINT,
    model: JUDGE_MODEL,
    apiKeyRef: JUDGE_REF,
  });
  assert.equal(
    configuredWrite.status,
    200,
    `the settings write must be accepted, so the endpoint and the credential name are in force: ${await configuredWrite.text()}`,
  );

  let positive = await probe();
  // One retry: a transport hiccup is not the wiring defect this gate hunts, and
  // a retry still demands a real probability.
  if (positive.ok !== true) positive = await probe();

  assert.equal(
    positive.configured,
    true,
    `the judge reports configured once "${JUDGE_REF}" resolves from the credential store: ${JSON.stringify(positive.credential)}`,
  );
  assert.equal(
    positive.ok,
    true,
    `one real judgment returns a probability (lastError ${JSON.stringify(positive.lastError)}): ${JSON.stringify(positive)}`,
  );
  assert.equal(typeof positive.probability, 'number', 'the probe reports the probability the endpoint returned');
  assert.ok(
    Number.isFinite(positive.probability) && positive.probability >= 0 && positive.probability <= 1,
    `the probability is a real one in [0,1]: ${positive.probability}`,
  );

  // The same fact, through the status surface, in its masked form.
  const status = await (await fetch(statusRoute)).json();
  assert.equal(status.judge?.configured, true, 'the status route reports the judge configured');
  assert.ok(
    status.credential === null || !('value' in status.credential),
    'the status route carries no credential value',
  );

  // Defect 2, observed live: a module api must hand out a usable skills service.
  assert.equal(positive.skills, true, 'the registry hands a module api a usable skills service');

  // ── 2. the positive control for the negative case ──────────────────────
  //
  // A name the store cannot hold. The positive case above is the control that
  // the same probe reports `configured` when the credential *is* there, so a
  // `false` below is a real absence and not a dead detector.
  const absentRef = `JEV_LAYER_GATE_ABSENT_${Date.now().toString(36)}`;
  const absentWrite = await write({ apiKeyRef: absentRef });
  assert.equal(absentWrite.status, 200, 'the settings write to an absent credential name is accepted');

  const negative = await probe();
  assert.equal(
    negative.configured,
    false,
    `the same probe reports unconfigured for the absent credential name "${absentRef}"`,
  );
  assert.equal(negative.ok, false, 'no judgment is claimed without a credential');
  assert.equal(negative.probability, null, 'no probability is invented without a credential');
  assert.equal(negative.lastErrorKind, 'unconfigured', 'the judge names the reason it did not answer');

  // The observation itself, on stderr so the marker stays the last stdout line.
  // No secret appears: a probability, two booleans and the two credential names.
  console.error(
    `judge probe: ref="${JUDGE_REF}" configured=true skills=${positive.skills} probability=${positive.probability}; `
    + `ref="${absentRef}" configured=false kind=${negative.lastErrorKind}`,
  );
  passed.push(MARKERS.judge);
}

// ── run ──────────────────────────────────────────────────────────────────

try {
  if (only !== 'judge') {
    setup();
    server = await startServer();
    if (wanted('active')) await checkActive();
    if (wanted('status')) await checkStatus();
    if (wanted('toggle')) await checkToggle();
    await stopServer(server);
    server = null;
    if (wanted('uninstall')) await checkUninstall();
  }
  if (wanted('judge')) await checkJudge();
} catch (error) {
  // The harness log is the only place a boot failure explains itself.
  if (server !== null && typeof server.log === 'function') {
    process.stderr.write(`--- harness log (tail) ---\n${server.log().slice(-2000)}\n`);
  }
  throw error;
} finally {
  await stopServer(server);
  // Every throwaway profile this run could have made, whichever checks ran.
  for (const name of [PROFILE, JUDGE_PROFILE]) {
    rmSync(join(DSH_HOME, 'profiles', name), { recursive: true, force: true });
    rmSync(join(DSH_HOME, 'profiles', `.plugin-manager-${name}`), { recursive: true, force: true });
  }
  rmSync(LOG_DIR, { recursive: true, force: true });
  const webAfter = fingerprint(WEB_PROFILE);
  if (webAfter !== webBefore) {
    console.error(`the user's web profile changed: ${webBefore} -> ${webAfter}`);
    process.exitCode = 1;
  } else {
    console.error(`the user's web profile is unchanged (${webBefore.slice(0, 12)})`);
    console.error(`throwaway profiles and temp logs removed (${profileName})`);
  }
}

// The markers go last: a gate's final line is its marker, and the profile
// fingerprint is asserted before any of them is printed.
if (process.exitCode !== 1) {
  for (const marker of passed) console.log(marker);
}
