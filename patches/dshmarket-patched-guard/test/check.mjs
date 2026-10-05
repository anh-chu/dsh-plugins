/**
 * check.mjs — the patched-plugin reader, against the installed market.
 *
 *   node test/check.mjs
 *
 * Imports `readPatchedDependencies` from the PROFILE's installed dshmarket,
 * not from a copy here, so a failed rebase of the pnpm patch shows up as this
 * check failing rather than as a guard that has quietly stopped existing.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PROFILE = process.env.DSH_PROFILE_DIR ?? '/home/sil/.dsh/profiles/web'
// Override to point at a `pnpm patch` working directory, which is how the
// fixture cases get exercised BEFORE the patch is committed.
const LIB = process.env.DSH_MARKET_LIB ?? join(PROFILE, 'node_modules/dshmarket/lib/profile.js')
const { readPatchedDependencies } = await import(LIB)
const { repoSlug, forkBaseVersion, isUpgrade } = await import(LIB.replace(/profile\.js$/u, 'updates.js'))

function fixture(name, { workspace, manifest }) {
  const dir = mkdtempSync(join(tmpdir(), `dsh-patched-${name}-`))
  if (workspace !== undefined) writeFileSync(join(dir, 'pnpm-workspace.yaml'), workspace)
  if (manifest !== undefined) writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  return dir
}

const dirs = []
const at = (name, files) => (dirs.push(fixture(name, files)), dirs.at(-1))
let passed = 0
const check = (label, fn) => {
  try {
    fn()
    passed++
    console.log(`ok ${passed} - ${label}`)
  } catch (error) {
    console.error(`not ok - ${label}\n  ${error.message}`)
    process.exitCode = 1
  }
}

try {
  // 1. The profile's own shape: a scoped key that must split on the LAST `@`,
  //    plus a plain one. A splitter using the first `@` reads `@scope` as the
  //    package name and never finds the entry.
  check('scoped and plain keys split on the last @', () => {
    const dir = at('scope', {
      workspace: 'packages:\n  - .\npatchedDependencies:\n  \'@norman-else/dsh-claude@0.1.64\': patches/x.patch\n  dsh-fact-check@1.3.0: patches/y.patch\n',
    })
    const map = readPatchedDependencies('web', dir)
    assert.equal(map.get('@norman-else/dsh-claude').version, '0.1.64')
    assert.equal(map.get('@norman-else/dsh-claude').file, 'patches/x.patch')
    assert.equal(map.get('dsh-fact-check').version, '1.3.0')
  })

  // 2. A key with no version patches every version of the package. It must not
  //    be mistaken for a version string.
  check('a key with no version is version: null', () => {
    const dir = at('noversion', {
      workspace: 'patchedDependencies:\n  dsh-vault: patches/vault.patch\n',
    })
    assert.equal(readPatchedDependencies('web', dir).get('dsh-vault').version, null)
  })

  // 3. The manifest spelling pnpm also honours.
  check('package.json pnpm.patchedDependencies is read', () => {
    const dir = at('manifest', {
      manifest: { name: 'p', dependencies: {}, pnpm: { patchedDependencies: { 'dsh-vault@1.10.73': 'patches/v.patch' } } },
    })
    assert.equal(readPatchedDependencies('web', dir).get('dsh-vault').version, '1.10.73')
  })

  // 4. Drift. Two entries for one name means the version already moved on and
  //    the old one was left behind. The key pnpm still honours must win, or a
  //    stale entry masks the live one.
  check('the newest key wins when an older one is left behind', () => {
    const dir = at('drift', {
      workspace: 'patchedDependencies:\n  dsh-better-sidebar@0.19.1: patches/old.patch\n  dsh-better-sidebar@0.24.1: patches/new.patch\n',
    })
    assert.equal(readPatchedDependencies('web', dir).get('dsh-better-sidebar').version, '0.24.1')
  })

  // 5. Trust boundary. This reader feeds the update list; a file it cannot
  //    parse must degrade to "nothing known here", never throw.
  check('a malformed workspace file yields an empty map, not a throw', () => {
    const dir = at('broken', { workspace: 'patchedDependencies:\n  - [unclosed\n   bad: : :\n' })
    assert.equal(readPatchedDependencies('web', dir).size, 0)
  })

  // 6. A non-object value (a list, a scalar) must be ignored, not iterated.
  check('a non-object patchedDependencies is ignored', () => {
    const dir = at('notobject', { workspace: 'patchedDependencies:\n  - dsh-vault@1.0.0\n' })
    assert.equal(readPatchedDependencies('web', dir).size, 0)
  })

  // 7. The real profile, if it is there: every live entry is found and no
  //    unpatched package is reported.
  check('the real web profile reports its patched plugins only', () => {
    let map
    try {
      map = readPatchedDependencies('web', PROFILE)
    } catch {
      console.log('ok - skipped: no dshmarket in', PROFILE)
      return
    }
    if (map.size === 0) {
      console.log('ok - skipped: profile has no patchedDependencies')
      return
    }
    assert.equal(map.get('dsh-mnemosyne').version, '0.8.1')
    assert.equal(map.get('dsh-plugin-mobile-gateway').version, '0.8.1')
    assert.equal(map.get('dsh-better-sidebar').version, '0.24.1')
    assert.equal(map.get('dsh-fact-check').version, '1.3.0')
    assert.equal(map.get('dsh-opencode-session').version, '0.1.1')
    assert.equal(map.get('@norman-else/dsh-claude').version, '0.1.64')
    // dshmarket patches ITSELF, so once the guard patch is committed this
    // entry exists and the guard covers its own next release too.
    assert.equal(map.get('dshmarket').version, '1.66.5')
  })

  // 8. Fork detection. The upstream is named only when both sides declare the
  //    SAME repository — a shared package name is not evidence, or an
  //    unrelated package would be reported as the fork's upstream.
  check('repoSlug reduces every spelling to owner/name', () => {
    assert.equal(repoSlug('git+https://github.com/leeyoung1/dsh-advisor-plugin.git'), 'leeyoung1/dsh-advisor-plugin')
    assert.equal(repoSlug('https://github.com/SpookySandwich/dsh-plugin-message-edit'), 'spookysandwich/dsh-plugin-message-edit')
    assert.equal(repoSlug('git@github.com:baixianger/dsh-bridge.git'), 'baixianger/dsh-bridge')
    // The `github:` shortcut must NOT lose the owner — that was a real bug in
    // the first version of this function.
    assert.equal(repoSlug('github:43456-awa/dsh-notepad'), '43456-awa/dsh-notepad')
    assert.equal(repoSlug('github:bare'), null)
    assert.equal(repoSlug(undefined), null)
    assert.equal(repoSlug('not a url'), null)
  })

  // 9. The local-build suffix. `<upstream>-local.N` is a prerelease by semver,
  //    so without stripping it a fork of a STABLE release reports an upgrade
  //    that does not exist — which is how the market offered to "restore" a
  //    fork that was not behind at all.
  check('a -local.N suffix does not read as an upgrade', () => {
    assert.equal(forkBaseVersion('0.2.6-local.1'), '0.2.6')
    assert.equal(isUpgrade(forkBaseVersion('0.2.6-local.1'), '0.2.6'), false)
    // The raw comparison is what produced the false positive.
    assert.equal(isUpgrade('0.2.6-local.1', '0.2.6'), true)
  })

  check('behind is still reported for a genuinely stale fork', () => {
    assert.equal(isUpgrade(forkBaseVersion('1.1.0-local.1'), '1.2.0'), true)
    assert.equal(isUpgrade(forkBaseVersion('0.3.3'), '0.3.7'), true)
    // A fork of a PRERELEASE base compares normally and stays current.
    assert.equal(isUpgrade(forkBaseVersion('0.1.0-rc.17-local.1'), '0.1.0-rc.17'), false)
    assert.equal(isUpgrade(forkBaseVersion('0.1.1'), '0.1.1'), false)
  })

  // 10. A mismatch is the whole safety property: a different repository means
  //     no upstream is reported, rather than the wrong one.
  check('a repository mismatch yields no upstream', () => {
    const forkRepo = repoSlug('git+https://github.com/leeyoung1/dsh-advisor-plugin.git')
    const npmRepo = repoSlug('git+https://github.com/someone-else/dsh-advisor-plugin.git')
    assert.notEqual(forkRepo, npmRepo)
  })
} finally {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${passed} passed`)
