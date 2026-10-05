# dshmarket patched-plugin guard

A pnpm patch on **dshmarket@1.66.5** so the market can see the patches this
profile carries, instead of only discovering them after an install has already
gone wrong.

## Why

The market's update check (`lib/updates.js`, `checkUpdates`) builds every
verdict from `package.json` dependency specs alone. Nothing in the update path
reads `patchedDependencies`, so a locally patched package is indistinguishable
from a pristine one and is offered an ordinary update.

That is not cosmetic on pnpm 11. `patchedDependencies` keys on
`name@exactVersion`, and pnpm 11's behaviour on a stale key is to **warn,
install anyway, and exit 0**. The update succeeds, the package is installed
unpatched, and nothing on screen says so. The market already knows the failure
— `lib/pnpm-compat.js` carries two hand-written diagnoses for it
(`ERR_PNPM_PATCH_FAILED` #222, `ERR_PNPM_UNUSED_PATCH` #740) — but both only
run on pnpm's exit code after the fact.

Two live cases in this profile:

| package | patch key | why an update is offered |
| --- | --- | --- |
| `dsh-plugin-mobile-gateway` | `0.8.1` | npm `latest` is `0.9.0` |
| `dsh-mnemosyne` | `0.8.1` | installed from a pinned GitHub SHA, so **any** new HEAD commit reads as an update, and one that bumps the version breaks the key |

## What the patch does

Three edits, all to files that actually load (`src/*.ts` ships for reading
only and is left untouched to keep the diff small):

1. **`lib/profile.js`** — new `readPatchedDependencies(profile, explicitDir)`.
   Reads `patchedDependencies` from `pnpm-workspace.yaml` **and**
   `pnpm.patchedDependencies` from the profile manifest, merged into one map
   keyed by package name. Keys split on the **last** `@`, so a scoped name
   (`@norman-else/dsh-claude@0.1.64`) is not read as the name `@norman-else`.
   A key with no version is `version: null`. Any read or parse failure returns
   an empty map — it feeds the update list, and a malformed yaml must degrade
   the answer, never break it.

2. **`lib/updates.js`** — `checkUpdates` attaches `patched: { key, file,
   version, versionDrifted }` to every row, in one pass after the loop, so the
   answer is identical across all source branches including the catch.

3. **`lib/routes.js`** — the `/dsh-market/update` handler refuses, with 409 and
   a bilingual message naming the patch key and file, when the package carries
   a local patch. It uses a **new `patchOverride` body flag**, not the existing
   `force`: `force` already rides along on other refusal dialogs, and reusing
   it would let those bypass the guard without anyone choosing to. The guard
   sits before the busy-agent check, and it covers `dshmarket` itself — so the
   next dshmarket release is refused rather than silently unpatched.

4. **`client/client.js`** — one filter change at the `batchUpdatableNames`
   line: patched rows join `restoreRequired` rows in being excluded from
   update-all and from its button count. Patched packages stay **visible** in
   the row list and in the "N updates available" notice; only the batch action
   skips them. The per-row button still works and still hits the server guard.

## Ceiling — read this before trusting it

**This patch is keyed to dshmarket 1.66.5 and must be rebased on every dshmarket
release.** That is the same staleness the guard exists to prevent, applied to
the guard itself: when 1.67 lands, pnpm 11 warns, installs the market
unpatched, and the protection is simply gone. Nothing announces it.

`dshmarket` is in `patchedDependencies` precisely so the guard covers its own
next release — the refusal fires and names the rebase. But that only helps if
you read it. To rebase: `pnpm patch dshmarket@<new version>`, re-apply these
four edits to the extracted tree, `pnpm patch-commit`, copy the new `.patch`
here, and update this README's table.

## Checks

```bash
node test/check.mjs            # the reader: scoped keys, no-version keys,
                               # manifest spelling, version drift, malformed yaml
node test/patch-integrity.mjs  # every live patchedDependencies entry is
                               # reverse-appliable against its installed copy
```

`check.mjs` imports from the **profile's installed** `dshmarket/lib/profile.js`,
not from a copy here, so a missed rebase shows up as this failing rather than
as a guard that quietly stopped existing. Before a rebase, point it at a
`pnpm patch` working directory instead:

```bash
DSH_MARKET_LIB=~/.dsh/profiles/web/node_modules/.pnpm_patches/dshmarket@<ver>/lib/profile.js \
DSH_PROFILE_DIR=/nonexistent node test/check.mjs
```

`patch-integrity.mjs` is the direct check for the failure mode above: pnpm 11
installing an unpatched package and exiting 0. A reverse-apply of each patch
against the installed copy is the evidence that "the install succeeded" does
not actually mean.

## Origin

Upstream: [dsh-market/dsh-market](https://github.com/dsh-market/dsh-market).
This is a local patch, not a fork. The change is generic and belongs upstream
next to #222 and #740 — a PR carrying these four edits would remove the rebase
obligation entirely.
