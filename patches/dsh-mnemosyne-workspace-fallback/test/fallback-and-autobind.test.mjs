#!/usr/bin/env node
/**
 * dsh-mnemosyne: workspace scoping must not leave a directory memory-less, and a
 * git project must bind itself.
 *
 * Two independent defects, both in scope resolution:
 *
 *  A. resolveTargetUncached returned `{ mode: "unbound" }` for any directory
 *     without a `.mnemosyne-id` marker. Everything downstream keys off that:
 *     storeAutoMemory skips the write, the pre-step prefetch declines to inject,
 *     and nothing is logged. The bind flow also refuses to bind $HOME, so a
 *     $HOME-rooted session could never have memory at all. It now falls back to
 *     the shared pool: `{ mode: "default" }`.
 *
 *  B. resolveMemoryContext was marker-only — no inheritance, no git fallback — so
 *     every directory needed its own marker and an unbound one was dead. It now
 *     falls back to the enclosing git repository, keyed by that repository's
 *     canonical path, which binds a project WITHOUT writing a file into the user's
 *     repo. An explicit marker still wins.
 *
 * Usage:  node test/fallback-and-autobind.test.mjs
 * Env:    DSH_MNEMOSYNE_DIR  (default ~/.dsh/profiles/web/node_modules/dsh-mnemosyne)
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const PLUGIN_DIR =
  process.env.DSH_MNEMOSYNE_DIR || join(homedir(), '.dsh/profiles/web/node_modules/dsh-mnemosyne');

let checks = 0;
let failures = 0;
const ok = (m) => { checks += 1; console.log(`  ok    ${m}`); };
const fail = (m) => { failures += 1; console.error(`  FAIL  ${m}`); };
const expect = (cond, m) => (cond ? ok(m) : fail(m));

// NOTE: /tmp must not be used as the fixture base. On this machine /tmp carries a
// stray `.git` directory, which makes every scratch path under it look like part
// of a repository. Pick a base proven to sit outside one, and assert that
// precondition rather than assume it.
function nearestGitRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 32; i += 1) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}
const root = join(homedir(), `.mnab-test-${process.pid}`);
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
if (nearestGitRoot(root)) {
  console.error(`fixture base ${root} sits inside a git repository; needs a repo-free base`);
  rmSync(root, { recursive: true, force: true });
  process.exit(2);
}

const repo = join(root, 'project');
const sub = join(repo, 'src', 'deep');
const plain = join(root, 'not-a-repo');
const markerDir = join(root, 'marker-project');
const dataDir = join(root, 'datadir');
for (const d of [join(repo, '.git'), sub, plain, markerDir, dataDir]) mkdirSync(d, { recursive: true });

// A marker project that is ALSO inside a git repo, to prove the marker wins.
writeFileSync(join(markerDir, '.mnemosyne-id'), 'mnemosyne-workspace-v1:11111111-2222-3333-4444-555555555555\n');

const { resolveMemoryContext } = await import(join(PLUGIN_DIR, 'src/identity.js'));
const cfg = { recallMode: 'workspace' };
const call = (cwd) => resolveMemoryContext({ cwd, sessionId: 's', config: cfg, dataDir });

console.log(`provider : ${PLUGIN_DIR}`);
console.log(`fixtures : ${root}\n`);

// ---------------------------------------------------------------- B: git root
const a = call(repo);
expect(a.bound === true, `a git repository root binds (bound=${a.bound}, source=${a.source})`);
expect(typeof a.namespace === 'string' && a.namespace.startsWith('dsh_v2_workspace_'),
  `it resolves to a workspace namespace (${String(a.namespace).slice(0, 28)}…)`);
expect(a.source === 'git', `the binding is attributed to the repository (source=${a.source})`);

const b = call(sub);
expect(b.bound === true && b.namespace === a.namespace,
  'a nested subdirectory binds to the SAME namespace by walking up');

const c = call(repo);
expect(c.namespace === a.namespace, 'repeated resolution is stable (same namespace)');

const d = call(plain);
expect(d.bound === false && d.reason === 'unbound',
  `a directory in no repository stays unbound (bound=${d.bound}, reason=${d.reason})`);

const m = call(markerDir);
expect(m.source === 'id', `an explicit .mnemosyne-id still wins over the repository (source=${m.source})`);

// the registry must persist, or the namespace would churn on every call
const mapPath = join(dataDir, 'identity.json');
expect(existsSync(mapPath), 'the derived workspace is registered in identity.json');
if (existsSync(mapPath)) {
  const map = JSON.parse(readFileSync(mapPath, 'utf8'));
  const keys = (map.workspaces ?? []).map((w) => w.identityKey);
  expect(keys.includes(`path:${repo}`), `the entry is keyed by the repository path (${keys.join(', ') || 'none'})`);
}

// ------------------------------------------------- A: unbound falls back
const indexSrc = readFileSync(join(PLUGIN_DIR, 'src/index.js'), 'utf8');
const fnStart = indexSrc.indexOf('const resolveTargetUncached');
const fnBody = fnStart === -1 ? '' : indexSrc.slice(fnStart, fnStart + 1400);
expect(fnStart !== -1, 'resolveTargetUncached is present in the provider');
expect(/return \{ mode: "default" \};/.test(fnBody),
  'an unbound read/write target falls back to the shared pool instead of "unbound"');
expect(!/mode: "unbound", reason/.test(fnBody),
  'the provider no longer returns an unbound target (which skipped writes and declined injection)');

// the system temp dir must never be a workspace boundary, however it is laid out
// (this machine has a stray /tmp/.git, which is exactly the trap being guarded)
const tmpProbe = join(tmpdir(), `mnab-probe-${process.pid}`);
mkdirSync(tmpProbe, { recursive: true });
const tp = call(tmpProbe);
expect(tp.bound === false, `a path under the system temp dir is never auto-bound (bound=${tp.bound})`);
rmSync(tmpProbe, { recursive: true, force: true });

rmSync(root, { recursive: true, force: true });

console.log(`\n${failures === 0 ? `PASS — ${checks} assertions` : `FAIL — ${failures} of ${checks + failures} assertions failed`}`);
process.exit(failures === 0 ? 0 : 1);
