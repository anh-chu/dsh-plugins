/**
 * patch-integrity.mjs — is every live `patchedDependencies` entry actually
 * applied to its installed package?
 *
 *   node test/patch-integrity.mjs
 *
 * This is the failure the market guard exists to prevent, checked directly:
 * pnpm 11 installs an unpatched package when a patch does not apply, warns,
 * and exits 0 — so "the install succeeded" is not evidence the patch is there.
 * A reverse-apply of the patch against the installed copy is.
 *
 * Stale patch files with no `patchedDependencies` entry are reported as such
 * rather than as failures; they are the harmless half.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

const PROFILE = process.env.DSH_PROFILE_DIR ?? '/home/sil/.dsh/profiles/web'
// The reader under test, read through the PROFILE's installed market — the
// same one the guard uses, so this gate also proves that reader is live.
const LIB = process.env.DSH_MARKET_LIB ?? join(PROFILE, 'node_modules/dshmarket/lib/profile.js')
const { readPatchedDependencies } = await import(LIB)
const patches = readPatchedDependencies('web', PROFILE)

let mismatched = 0
console.log(`live patchedDependencies: ${patches.size}`)
for (const [name, { key, file }] of patches) {
  const dir = join(PROFILE, 'node_modules', name)
  if (!existsSync(dir)) {
    console.log(`  ABSENT     ${key} — not installed`)
    mismatched++
    continue
  }
  try {
    execFileSync('git', ['apply', '--check', '--reverse', '-p1', realpathSync(join(PROFILE, file))], { cwd: dir, stdio: 'ignore' })
    console.log(`  APPLIED    ${key} → ${file}`)
  } catch {
    console.log(`  UNPATCHED  ${key} → ${file}   <-- the fix is NOT in the installed copy`)
    mismatched++
  }
}

console.log(mismatched === 0 ? '\nall live patches are applied' : `\n${mismatched} MISMATCH(ES)`)
process.exit(mismatched === 0 ? 0 : 1)
