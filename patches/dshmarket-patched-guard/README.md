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

4. **`client/client.js`** — two filters plus the visible half:
   - `batchUpdatableNames` excludes patched rows, matching the existing
     `restoreRequired` filter. Patched packages stay **visible** in the row list
     and in the "N updates available" notice; only the batch action skips them.
   - A **"local changes" panel at the top of the Installed tab**: every patched
     package and every fork in one ranked list — patch-will-be-lost first, then
     fork-behind-upstream, then the ones that are merely local. The header turns
     warn-coloured when anything in it needs action.
   - A **`N local changes` chip in the market header**, which persists across
     tabs. The market opens on Discover, so without it the panel is one
     navigation away and invisible from where the user actually lands. The chip
     switches to Installed, and is primary-coloured only when something needs
     action.
   - The at-risk list is read from `updates` directly, not from
     `updatableNames` — that list already drops `selfName`, which would hide
     dshmarket's own update.
   - The earlier per-row chips (`patched 0.8.1`, `upstream v1.2.1`) remain, but
     they are not the primary surface: a chip on each of ~50 rows makes the user
     hunt for the handful that matter, which is what the panel exists to fix.
   - The **Update button on a patched row** becomes a `metaTag` reading
     `v0.9.0 waiting · rebase patch first` instead of an active button. A
     disabled `<button>` shows no tooltip in most browsers, so the hint has to
     live in a span.
   - The **header self-update button** is suppressed for a patched dshmarket,
     which is active right now for 1.66.5 → 1.66.9 and would be refused.

   Nine new locale keys, added to **both** the zh and en dictionaries (the
   `patched*` three and the `localChange*` six). Section 5 adds two more, for
   a total of eleven.

5. **Fork upstream awareness** — a second post-pass in `lib/updates.js`, over
   `file:` **and** `link:` installs, attaching `upstream: { repo, latest,
   behind }`. Three defects fixed together, because they share one cause (the
   market never looked at a local install's own metadata):

   - **`link:` installs were skipped outright** as development checkouts, so
     every fork installed that way was permanently invisible.
   - **The `-local.N` false positive.** The fork convention here is
     `<upstream>-local.N`, and semver reads that suffix as a prerelease — while
     a stable release outranks a prerelease of the same core. So
     `0.2.6-local.1` vs upstream `0.2.6` reported an update that did not
     exist, and offered a Restore that would have replaced the fork.
     `forkBaseVersion()` strips the suffix before comparing. A fork of a
     *prerelease* base was never affected, which is why only some forks showed it.
   - **The upstream is named only when the installed package's `repository`
     matches npm's `repository` for the same name** (`repoSlug()` handles every
     spelling: `git+https`, scp, bare https, `github:`). A shared package name
     is not evidence. A plugin the user wrote declares no repository at all,
     so it is simply absent rather than special-cased by name.

   In the client, a behind fork gets an `upstream v1.2.0` chip, and its
   **Restore button is not rendered** — restoring replaces the checkout with
   the published package, which is the wrong action for a fork the user intends
   to keep. Two more locale keys in both dictionaries.

### Known gap

The Settings card's own self-update button (the `setSelfUpdate` row) is **not**
covered. Clicking it on a patched dshmarket still gets the 409 with the full
bilingual explanation rather than a disabled control. The server guard is what
makes that safe; only the affordance is missing.

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
