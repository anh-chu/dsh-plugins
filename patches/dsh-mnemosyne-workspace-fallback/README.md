# dsh-mnemosyne: unbound directories go dark, projects don't bind themselves, and agents file project facts globally

Upstream: `dsh-mnemosyne` 0.8.1, installed from
`github:rebron1900/dsh-mnemosyne#65f36a6ab57cdf4a7dec93d046a0c1e24006f00c`
Repo: https://github.com/rebron1900/dsh-mnemosyne

Two defects in workspace scope resolution (plus one in the scope guidance), all of which make memory silently
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

**C. Agents are told to put project facts in the project's scope** (`src/index.js`,
three edits). The system prompt every session receives said *"use scope=global for
facts that should survive a new session"*. A rule about one project's procedure does
need to survive a session, so an agent following that sentence wrote it to the shared
pool, where every project's recall injects it. This happened: a Seedwise-only rule
(Expo web view, 393×852 viewport, host `devvm`) was stored `scope=global`, importance
1.0. The prompt never mentioned workspace scope, so the agent had no better option.
Now:

- the prompt keys the choice on **who needs the fact** — `scope=workspace` for anything
  about the current project, `scope=global` only for facts true in every project — and
  says that a fact naming a project path or ticket is workspace *even when it must
  survive a new session*;
- the `mnemosyne_remember` parameter description says the same, and notes the
  fallback;
- the **skill text** the plugin serves (`Session-scoped memories are isolated…`, inside
  `src/index.js`) still carried the old sentence — *"Use `scope="global"` for facts that
  should survive a new session"*. A session that loads the skill and never reads the tool
  description got the rule that files project facts in the shared pool, so the skill text
  now says what the prompt says. Found live, after the prompt fix was already loaded: a
  Seedwise session wrote *"Seedwise app (/home/sil/seedwise/app) … use the live Expo web
  view"* to `scope=global` at 22:58, with the corrected prompt in force;
- a `scope=global` write from a session inside a **bound workspace** still stores the row
  exactly as asked, and now returns a note naming that workspace and pointing at
  `scope=workspace`. Wording alone did not stop it — that same session chose global twice
  with the corrected prompt loaded — so this is the behaviour guard. It is limited to
  bound workspaces: an unbound `$HOME` session, where the shared pool is the designed
  fallback, gets no note. Nothing is misrouted, because the agent's choice is still
  honoured;
- the tool's `workspace` branch passed `target.sid` straight to the helper. After
  fix A an unbound directory resolves to `{mode:"default"}`, which has **no** `sid`, so
  `workspace` scope in `$HOME` would have spawned the helper with an undefined session
  id. It now writes to the shared pool as a global row in that case. Without this the
  new advice would break in exactly the directory that has no project.

## Test

```sh
node test/fallback-and-autobind.test.mjs
```

24 assertions. It builds real fixtures (a git repo, a nested subdirectory, a
non-repository directory, a marker directory inside a repository) and checks
identity resolution behaviourally, plus static checks on the fallback and on the
scope guidance (the prompt wording, the parameter description, the skill text, the note
on a global write inside a bound workspace, and the unbound `workspace` fallback). It
**passes 6 and fails 17 of 23 on upstream 0.8.1** (one more assertion runs once binding
succeeds) and passes 24/24 with the patch.

Five assertions fail on a build that carries every other fix — three on the skill text,
two on the note: that is the point of them. Run `DSH_MNEMOSYNE_DIR=<pre-fix copy> node test/…` to see it.

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

### Composing it with `dsh-mnemosyne-memoria-counts`

pnpm keys a patch by `package@version`, so two fixes for `dsh-mnemosyne@0.8.1` cannot be
installed as two files — the profile's `patches/dsh-mnemosyne@0.8.1.patch` has to be the
composition of both. `dsh-mnemosyne@0.8.1.combined.patch` in this folder is that
composition, and it is what the live web profile installs.

Generate it from **pristine** upstream. Composing from an already-patched copy is the trap:
the first patch rejects as already-applied, `patch(1)` leaves a `src/index.js.rej` behind,
and the diff you then take is missing that fix:

```sh
# a = pristine upstream (reverse the installed patch out of a copy of the live source)
mkdir -p /tmp/c/a /tmp/c/b
cp -r ~/.dsh/profiles/web/node_modules/dsh-mnemosyne/src /tmp/c/a/src
(cd /tmp/c/a && git apply -R -p1 .../dsh-mnemosyne-memoria-counts/dsh-mnemosyne@0.8.1.patch)

# b = pristine + both fixes
cp -r /tmp/c/a/src /tmp/c/b/src
(cd /tmp/c/b && git apply -p1 .../dsh-mnemosyne-memoria-counts/dsh-mnemosyne@0.8.1.patch)
(cd /tmp/c/b && git apply -p1 .../dsh-mnemosyne-workspace-fallback/dsh-mnemosyne@0.8.1.patch)

# the directories are named a/ and b/, so --no-prefix yields the a/… b/… headers pnpm wants
cd /tmp/c && git diff --no-index --no-prefix a b > combined.patch
```

Verified: the composition applies cleanly to pristine upstream, and that build passes both
suites — 17 assertions for the dashboard fix, 24 for this one.
