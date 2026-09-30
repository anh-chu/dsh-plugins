#!/usr/bin/env node
// Read-only compatibility verdict for one installed DSH plugin.
//
//   node scripts/compat-verify.mjs <package> [--profile web] [--home ~/.dsh] [--json]
//
// Answers, without changing anything and without a browser:
//   1. is the package installed, and is it composed as a bundle at all?
//   2. does it pass the harness's peer gate — the same semver test the gate runs?
//   3. if not, is an exact-version exemption already recorded?
//   4. does `--dump-config` compose cleanly, or does boot skip the bundle?
//   5. for a client half: does the built bundle register under the module id the
//      loader will ask for? (This is the defect class that shows up only as
//      `loaded without registering "<id>" via __ModuleLoader__.load`.)
//
// What it cannot do: confirm live activation. Only the running server knows that.
// The last section prints the two inspect calls that answer it.
//
// Why the gate is re-derived here instead of trusted: dsh-app-boot's
// evaluatePluginCompatibility only examines peers named `@deepseek-ai/dsh` or
// `@deepseek-ai/dsh-*`, compares with { includePrerelease: true }, and treats a
// `workspace:*`-style range as the runtime version. A caret-bounded prerelease
// range (`^0.1.5-rc.1`) therefore fails against 0.2.x, while a non-dsh peer such
// as `@deepseek-ai/cordis` is never gated at all — a detail that makes a
// naive `npm ls`-style peer check report false failures.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : argv[i + 1]
}
const wantsJson = argv.includes('--json')
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1]?.startsWith('--')))
const pkgName = positional[0]
const profile = flag('profile', 'web')
const dshHome = resolve(flag('home', process.env.DSH_HOME || join(homedir(), '.dsh')))

if (!pkgName) {
  console.error('usage: node scripts/compat-verify.mjs <package> [--profile web] [--home ~/.dsh] [--json]')
  process.exit(2)
}

const rows = []
const record = (label, value, verdict = '') => rows.push({ label, value, verdict })

/** Locate the dsh executable. A login shell (`bash -lc`) often has a stripped
 * PATH, so resolve without one; `--dsh-bin` wins for unusual installs. */
function resolveDshBin() {
  const explicit = flag('dsh-bin', process.env.DSH_BIN)
  if (explicit) return realpathSync(explicit)
  for (const shell of ['bash', 'sh']) {
    try {
      const found = execFileSync(shell, ['-c', 'command -v dsh'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      if (found) return realpathSync(found)
    } catch {}
  }
  for (const dir of (process.env.PATH || '').split(':')) {
    const candidate = join(dir, 'dsh')
    if (dir && existsSync(candidate)) return realpathSync(candidate)
  }
  throw new Error('dsh not found on PATH — pass --dsh-bin /abs/path/to/dsh')
}

const dshBin = resolveDshBin()
const dshPkgDir = dirname(dirname(dshBin))
const dshRequire = createRequire(join(dshPkgDir, 'package.json'))
const semver = dshRequire('semver')
const runtimeVersion = JSON.parse(readFileSync(join(dshPkgDir, 'package.json'), 'utf8')).version

const profileDir = join(dshHome, 'profiles', profile)
const profileManifestPath = join(profileDir, 'package.json')
if (!existsSync(profileManifestPath)) {
  console.error(`no profile at ${profileDir}`)
  process.exit(2)
}
const profileManifest = JSON.parse(readFileSync(profileManifestPath, 'utf8'))
const bundles = profileManifest.dsh?.profile?.bundles ?? []

record('runtime', runtimeVersion)
record('profile', profileDir)

const depSpec = profileManifest.dependencies?.[pkgName]
if (depSpec === undefined) {
  record('installed', 'no', 'NOT INSTALLED in this profile — an install problem, not a compatibility one')
} else {
  record('installed', `yes (${depSpec})`)
  const inBundles = bundles.includes(pkgName)
  record('composed as bundle', inBundles ? 'yes' : 'no',
    inBundles ? '' : 'a dependency is NOT a bundle: without a dsh.profile.bundles entry the plugin never mounts')
}

// Read the installed copy the profile actually resolves, not a global one.
const pkgDir = join(profileDir, 'node_modules', pkgName)
const pkgDirExists = existsSync(join(pkgDir, 'package.json'))
const manifest = pkgDirExists ? JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) : undefined
if (pkgDirExists) {
  record('package version', manifest.version ?? '(none)')
  if (manifest.dsh?.bundle === undefined) {
    record('bundle declaration', 'MISSING dsh.bundle', 'boot throws: "profile bundle ... declares no dsh.bundle"')
  } else {
    record('bundle declaration', 'ok')
  }
} else if (depSpec !== undefined) {
  record('package dir', 'MISSING', `${pkgDir} does not exist — run the profile's install`)
}

// --- peer gate -----------------------------------------------------------------
const mismatched = []
const notGated = []
if (manifest?.peerDependencies) {
  for (const [name, range] of Object.entries(manifest.peerDependencies)) {
    if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) {
      notGated.push(`${name}@${range}`)
      continue
    }
    const requirement = ['workspace:^', 'workspace:~', 'workspace:*'].includes(range) ? runtimeVersion : range
    const ok = requirement.trim() !== '' && semver.satisfies(runtimeVersion, requirement, { includePrerelease: true })
    if (!ok) mismatched.push({ name, range })
  }
}
for (const entry of notGated) record('peer (not gated)', entry)
for (const { name, range } of mismatched) record('peer MISMATCH', `${name}@${range}`, `not satisfied by ${runtimeVersion}`)

// --- exemption -----------------------------------------------------------------
const compatPath = join(profileDir, 'compatibility.json')
const exemptions = existsSync(compatPath) ? JSON.parse(readFileSync(compatPath, 'utf8')) : {}
const key = manifest ? `${pkgName}@${manifest.version}` : undefined
const exempted = key !== undefined && (exemptions[key] ?? []).includes(runtimeVersion)
if (mismatched.length > 0) {
  record('exemption', exempted ? `granted for ${key} on ${runtimeVersion}` : 'none recorded',
    exempted ? '' : 'boot SKIPS this bundle; a fresh install of it is rolled back instead')
}

// --- composition ---------------------------------------------------------------
// Run the resolved binary directly: no shell, no PATH assumptions, and the
// bundle-skip diagnostics arrive on stderr even when the exit code is 0.
let dumpOk = null
let dumpText = ''
try {
  dumpText = execFileSync(dshBin, ['--profile', profile, '--dump-config'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  dumpOk = true
} catch (error) {
  dumpOk = false
  dumpText = `${error.stdout ?? ''}${error.stderr ?? ''}${error.message ?? ''}`
}
if (dumpOk === false && dumpText === '') dumpText = '(no output captured)'
const skipped = dumpText.split('\n').filter((l) => /skipping profile bundle|is incompatible with dsh/i.test(l))
record('--dump-config', dumpOk ? 'exit 0' : 'non-zero', dumpOk ? '' : 'composition or startup failed; read the output')
for (const line of skipped.slice(0, 5)) record('boot skip', line.trim())
if (!dumpOk) {
  // Name the failure rather than leaving a bare non-zero: the first few lines
  // are usually the whole story (missing profile, malformed manifest, bad YAML).
  const detail = dumpText.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 3)
  for (const line of detail) record('dump-config detail', line.slice(0, 160))
}

// --- client half ---------------------------------------------------------------
const clientDecl = manifest?.dsh?.client
if (clientDecl === undefined) {
  record('client half', 'none declared (host-only plugin)')
} else {
  record('client platform', String(clientDecl.platform))
  record('dsh.client.inject packages', JSON.stringify(clientDecl.inject ?? []))

  const clientExport = manifest.exports?.['./client']
  const rel = typeof clientExport === 'string' ? clientExport : clientExport?.default
  const clientFile = rel ? join(pkgDir, rel) : undefined
  if (clientFile === undefined || !existsSync(clientFile)) {
    record('client bundle', 'MISSING', `exports["./client"] = ${JSON.stringify(clientExport)}`)
  } else {
    const source = readFileSync(clientFile, 'utf8')
    const m = source.match(/__ModuleLoader__\.load\(\{\s*id:\s*["']([^"']+)["']/)
    // A bundle is its package's client half: `<id>/client` and the bare package
    // name resolve to the same exports (stripClientSuffix in dsh-client-modules).
    const registered = m ? m[1].replace(/\/client$/, '') : undefined
    const expected = pkgName
    if (registered === undefined) {
      record('client bundle', 'no self-registration found', `expected id: ${expected}`)
    } else {
      record('client registers as', registered,
        registered === expected ? '' : `EXPECTED "${expected}" — the loader will report: loaded without registering "${expected}" via __ModuleLoader__.load`)
    }
    record('client file', clientFile)
  }
}

// --- stale API references ------------------------------------------------------
// Cheap drift detector over the shipped code: a token here means the author wrote
// against an older release. Reported as a hint, never as a verdict — referencing
// a removed name deliberately behind a feature check is a legitimate
// compatibility shim, which is why the wording asks you to confirm the guard.
const STALE_API = [
  { token: 'settingsScope', where: 'client', note: '0.1.x settings service → 0.2 configForms.get(entryId)' },
  { token: 'conversationEvents', where: 'client', note: 'client event-definition API removed in 0.2, no replacement' },
  { token: 'connection.api', where: 'client', note: '→ typed Host Remotes: ctx.remote.<ns>.<method>(); declare remote + remote.<ns> in inject' },
  { token: 'sessions.open', where: 'client', note: 'client sessions.open removed in 0.1.7 → ctx.uiWorkspace.openSession' },
  { token: 'installSettingsSection', where: 'host', note: 'host settings registration face removed; the entry Config is the settings document' },
  { token: 'installSection', where: 'host', note: 'host settings registration face removed in 0.2' },
]
const scanTargets = []
if (manifest) {
  const clientExport = manifest.exports?.['./client']
  const clientRel = typeof clientExport === 'string' ? clientExport : clientExport?.default
  if (clientRel) scanTargets.push({ where: 'client', file: join(pkgDir, clientRel) })
  const mainExport = manifest.exports?.['.']
  const mainRel = typeof mainExport === 'string' ? mainExport : mainExport?.default ?? manifest.main
  if (mainRel) scanTargets.push({ where: 'host', file: join(pkgDir, mainRel) })
}
for (const target of scanTargets) {
  if (!existsSync(target.file)) continue
  const text = readFileSync(target.file, 'utf8')
  for (const { token, where, note } of STALE_API) {
    if (where !== target.where || !text.includes(token)) continue
    record(`${target.where} references ${token}`, 'present', `${note} — confirm it is guarded`)
  }
}

// --- what only the running server can answer ----------------------------------
if (!wantsJson) {
  console.log(`\ncompat-verify — ${pkgName} on dsh ${runtimeVersion}\n`)
  const width = Math.max(...rows.map((r) => r.label.length))
  for (const { label, value, verdict } of rows) {
    console.log(`  ${label.padEnd(width)}  ${value}${verdict ? `\n  ${' '.repeat(width)}  ↳ ${verdict}` : ''}`)
  }
  console.log('\n  Live activation (needs the running server; read-only):')
  console.log('    cordis_inspect_query host/Config listConfigs {"name":"' + pkgName + '"}   → host entry mounted?')
  console.log('    cordis_inspect_query client/Slots listSubTree {"root":"settings.plugins.tab"}  → client card registered?')
  console.log('    (a newly installed client plugin appears only after a page refresh)')
} else {
  console.log(JSON.stringify({ package: pkgName, runtimeVersion, profile, rows }, null, 2))
}
