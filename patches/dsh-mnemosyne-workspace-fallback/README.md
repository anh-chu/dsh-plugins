# dsh-mnemosyne: unbound directories go dark, and projects don't bind themselves

Upstream: `dsh-mnemosyne` 0.8.1, installed from
`github:rebron1900/dsh-mnemosyne#65f36a6ab57cdf4a7dec93d046a0c1e24006f00c`
Repo: https://github.com/rebron1900/dsh-mnemosyne

Two defects in workspace scope resolution, both of which make memory silently
disappear. They were found the hard way: with `recallMode: workspace` and nothing
bound, memory appeared completely dead — recall worked, the store was healthy, and
nothing was logged. This patch makes workspace mode behave the way a per-project
memory system has to: **a directory inside a project gets that project's namespace
automatically; anywhere else falls back to shared memory instead of going dark.**

## Bug 1 — an unbound target disables memory, everywhere

`resolveTargetUncached` (`src/index.js`) resolved a workspace read/write target to
`{ mode: "unbound" }` whenever the directory had no `.mnemosyne-id` marker. Three
things key off that value:

- `storeAutoMemory` — `if (target?.mode === "unbound") return;` so **auto-capture
  silently skips the write**
- the pre-step prefetch — its unbound branch asks-to-bind or emits a hint **instead
  of injecting memory**
- the bind prompt itself, which then marks the state as asked/declined

Compounding it, the bind flow **refuses to bind `$HOME`** ("Refusing to bind: the
current directory is $HOME or the filesystem root"). So with workspace mode on, a
`$HOME`-rooted session could never have memory at all — no capture, no injection,
no error.

## Bug 2 — identity is marker-only, with no inheritance

`resolveIdentity` → `findMarker` checks **only the exact directory**:

```js
export function findMarker(startDir) {
  return readMarkerAt(resolve(startDir));
}
```

The docstring is explicit — *"a valid `.mnemosyne-id` at that exact directory …
absent → null. Never auto-creates a marker and never degrades to git/path."* So a
marker in `/home/sil/seedwise` does **not** cover `/home/sil/seedwise/app`, every
directory a session might start in needs its own marker, and any directory without
one is dead by Bug 1. The author optimised for "never silently mis-file your data";
the cost is a memory system that silently stops working depending on where the
session started.

## Fix (`dsh-mnemosyne@0.8.1.patch`, two files)

**A. Unbound falls back to the shared pool** (`src/index.js`):

```js
// was: return { mode: "unbound", reason: mctx.reason ?? "unbound" };
return { mode: "default" };
```

One change point fixes both the skipped writes and the declined injection, because
every consumer tests for `"unbound"`. `$HOME` now shares memory instead of having
none, and no marker has to be placed there.

**B. Git repository roots auto-bind** (`src/identity.js`): when no marker exists,
`resolveMemoryContext` falls back to the enclosing git repository
(`findGitRoot`, which walks up and accepts a `.git` file as well as a directory) and
keys the namespace by that repository's **canonical path** — `path:<abs path>`. That
gives each project its own workspace **without writing a marker file into the user's
repository**. An explicit `.mnemosyne-id` still wins, and a directory in no
repository stays unbound (so A's fallback applies).

The filesystem root and `os.tmpdir()` are refused as repository roots. That guard is
not hypothetical: this machine has a stray `/tmp/.git`, which makes every scratch
directory under `/tmp` look like part of a repository — the first version of this
patch bound `/tmp` as a project.

## Test

```sh
node test/fallback-and-autobind.test.mjs
```

13 assertions. It builds real fixtures (a git repo, a nested subdirectory, a
non-repository directory, a marker directory inside a repository) and checks
identity resolution behaviourally, plus two static checks on the fallback. It
**fails 7 of 12 on upstream 0.8.1** and passes 13/13 with the patch.

The test asserts its own precondition that the fixture base is outside any
repository, and uses `$HOME` rather than `/tmp` for that reason. Overrides:
`DSH_MNEMOSYNE_DIR`, and it needs no running harness (`identity.js` is standalone —
that is why the bug is testable at all).

## Behaviour you are accepting

- A directory in a git repository, with no marker, is **auto-bound** to a namespace
  derived from that repository's path on first use. Nothing is written into the
  repository.
- A directory in no repository — `$HOME`, `/tmp`, scratch dirs — uses the **shared
  pool**: captured there, recalled everywhere. It is not isolated.
- An explicit `.mnemosyne-id` always overrides the repository fallback.
- Because the fallback namespace is keyed by **path**, moving a repository gives it
  a new namespace. A `.mnemosyne-id` marker (keyed by UUID) survives a move; the
  automatic binding does not.

## Install (web profile)

```sh
cp patches/dsh-mnemosyne@0.8.1.patch ~/.dsh/profiles/web/patches/
```

then in `~/.dsh/profiles/web/pnpm-workspace.yaml`:

```yaml
patchedDependencies:
  dsh-mnemosyne@0.8.1: patches/dsh-mnemosyne@0.8.1.patch
```

and:

```sh
cd ~/.dsh/profiles/web && pnpm install
```

**A `dsh web` restart is required** — the provider reads its scope resolution at
load time, so installing alone leaves the running process on the old code.
