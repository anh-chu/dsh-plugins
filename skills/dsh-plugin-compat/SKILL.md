---
name: dsh-plugin-compat
description: "Decide whether a DeepSeek Harness (DSH) plugin is compatible with the installed harness, and diagnose or fix one that fails to load or activate — 'web boot: N entry did not activate', a bare '<package>: failed' on the boot card, a blank or stuck boot screen, a UI tab/buttons that never appear, a plugin that worked on an older DSH version but broke after an upgrade, or a third-party plugin that needs patching/vendoring for a new DSH release. Use this proactively whenever the user asks 'is this plugin compatible?', 'will this work on my dsh?', 'can I install this plugin?', or pastes a plugin repo/URL to evaluate, and whenever a DSH plugin misbehaves or must be made compatible — even if the user only says 'this plugin doesn't work', 'the plugin broke after the update', or pastes a boot error."
---

# DSH plugin compatibility

Answers two questions, and they share the same checks:

- **Will this plugin work on the installed harness?** (before installing)
- **Why doesn't it?** (after installing, or after an upgrade)

The expensive tools — a browser, instrumentation, bisection — are only worth
reaching for once the cheap, read-only ones have ruled things out. Two failure
modes cost hours if you guess instead of measuring:

1. **Silent activation failure.** An entry can be composed, enabled and listed
   while its browser half never activates. The boot card shows only
   `<package>: failed` — no exception, no console message. Nothing you "fix" by
   reading the README shows up until you capture that state yourself.
2. **Version drift.** Third-party plugins are written against one harness
   release. Service names, slot options, the module id and `inject` gating all
   change; the README describes the version the author had, not yours.

## Ground rules

- **Never debug inside the profile the user is working in.** Copy the failure
  into a throwaway profile. Installing into their real profile is fine when they
  asked for it; editing files under their `node_modules` is not.
- **Ask the install, not the README, what the API is.** The shipped
  `lib/types/*.d.ts` and the service implementation in the install are the
  contract. `references/drift-0.1-to-0.2.md` is a lookup table of what moved,
  with the file that proves each entry.
- **A curated catalog is not an inventory.** `cordis_inspect_query`'s client
  `Service` catalog is a short curated list, not the set of services the runtime
  provides — it reports `no catalogued Service named "connection"` for a service
  that exists and that working plugins use. Never read that answer as absence;
  grep the install for the name instead.
- **A file grep is not proof** of what the browser was *served*. Prove the served
  artifact or the boot screen, or state the limit explicitly.
- **Clean up what you create**: temp profiles, probe scripts, browser profile
  dirs, logs, background jobs, fixture directories, and any in-place edit.

## Step 0 — one command, read-only

```sh
node scripts/compat-verify.mjs <package> [--profile web]
```

It reports, without changing anything and without a browser: whether the package
is installed *and* composed as a bundle, whether it passes the peer gate (the
same `semver.satisfies(runtime, range, { includePrerelease: true })` test the
harness runs, over `@deepseek-ai/dsh*` peers only), whether an exact-version
exemption is recorded, whether `--dump-config` composes cleanly, and whether the
built client bundle registers under the module id the loader will ask for.

What it cannot answer is live activation — only the running server knows that.
It prints the two inspect calls that do:

```
cordis_inspect_query host/Config   listConfigs {"name":"<pkg>"}              → host entry mounted?
cordis_inspect_query client/Slots  listSubTree {"root":"settings.plugins.tab"} → client card registered?
```

A newly installed client plugin appears in the slot tree **only after a page
refresh**; an empty result before that means "not loaded yet", not "broken".

## Step 1 — read-only state checks (no changes)

| Question | Command |
|---|---|
| Does it pass the version gate? | `node scripts/compat-verify.mjs <pkg>` — or by hand: peers named `@deepseek-ai/dsh*`, `semver.satisfies(runtime, range, {includePrerelease:true})`. A caret range on a 0.x prerelease (`^0.1.5-rc.1`) stops below 0.2.0 and fails against 0.2.x |
| Is an exemption recorded? | `dsh plugin --profile <p> version-exemptions` (profile-scoped, in `<profile>/compatibility.json`) |
| Is the entry composed at all? | `dsh --profile <p> --dump-config` — exit code, plus grep for `skipping profile bundle` |
| Dependency *and* bundle? | `grep -n "<pkg>" ~/.dsh/profiles/<p>/package.json` — needs both the `dependencies` line and the `dsh.profile.bundles` entry. A dependency alone never mounts |
| Is the entry enabled, in which phase? | `plugin_manager list_plugins` (page to the end; third-party entries sit last). `active` = up; `pending` = waiting for a **named** service; `failed` = activation errored; `enabled:false` + `fiberPhase:null` = disabled, not broken |
| Did the host log an error? | `grep -i "<pkg>" ~/.dsh/logs/startup-*.log` — host-half failures appear here with the real error; **client-half failures do not** |
| Which client build is served? | `node -e 'const p=require("<pkg>/package.json");console.log(p.exports["./client"],p.dsh)'` — many plugins ship both `lib/client.js` and `plugin.client.js`; patch the one `exports["./client"]` names |

If the entry is missing entirely, this is an install problem, not a
compatibility problem: check the `dsh plugin --profile <p> add …` output and the
bundles list.

## Step 2 — reproduce outside the user's profile

```sh
dsh --profile tmp-diag --from-default-profile web --dump-config      # throwaway profile
dsh plugin --profile tmp-diag add file:/abs/path/to/plugin           # or the npm name
dsh --profile tmp-diag --no-open --port 3198                         # managed background job
```

- Start long-running servers as **managed background jobs**, not `nohup` inside a
  one-shot call: sandboxed shells reap their children when the call ends, and a
  per-call `/tmp` means files written by one call are invisible to the next.
  Prefer a log path under `$HOME`.
- The server prints `http://127.0.0.1:<port>/?token=…`. Redeem it into a cookie
  jar **after the listener is fully up** (wait ~10 s once the URL appears;
  redeeming too early returns `401` with no `Set-Cookie`). The token is
  single-use.
- `--host` accepts only `127.0.0.1` or `0.0.0.0`, and the launcher refuses
  `0.0.0.0` on purpose. To reach the profile from a browser, run the browser on
  this machine.
- **Do not assume a remote CDP Chrome can reach your loopback.** A profile-proxy
  endpoint may front a browser on another OS/host (check `/json/version`:
  `Windows NT` ≠ this machine), where `127.0.0.1` is not yours. Launch a local
  Playwright chromium instead:

```sh
CHROME=$(ls -d ~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome | tail -1)
"$CHROME" --headless=new --remote-debugging-port=9222 --no-sandbox \
  --disable-dev-shm-usage --user-data-dir="$HOME/.cache/chrome-diag" about:blank &
```

Then use the bundled probe (it creates its own tab, so nothing depends on an
agent-browser session's tab state):

```sh
node scripts/compat-probe.mjs "<token>" <port>          # CDP_BASE defaults to http://127.0.0.1:9222
```

Boot-card text `Failed to load plugins` + `web boot: N entry did not activate` +
`<pkg>: failed` is a **client** activation failure. `pending (waiting for
service: x)` is a different, easier bug: the provider never came up.

## Step 3 — get the real error

The frontend reports only the entry's state. In this order:

1. **Probe hooks.** `scripts/compat-probe.mjs` installs `error` /
   `unhandledrejection` listeners, wraps `console.error` before the app boots,
   and prints the expected module ids from `window.__DSH_BOOT__`. Search its
   output for the two signatures that name a cause outright:
   `loaded without registering "<id>"` (module-id mismatch, see Step 4) and
   `could not load "<id>"`.
2. **Checkpoints in the served copy.** Insert `console.error('PROBE_x …')` at
   each stage of `apply()` (entry, after each service lookup, before each
   registration). Restart so the snapshot re-reads the file. The last checkpoint
   before silence tells you where it died.
3. **Minimal-stub bisection.** Replace the client half with:

```js
window.__ModuleLoader__.load({
  id: '<package-name>',
  factory: (require) => ({ name: '<entry-id>', inject: [], apply(ctx) {} }),
});
```

If the shell boots cleanly, the module contract and entry wiring are fine and the
bug is in the plugin's own code; if it still fails, the problem is entry-level
(manifest, `dsh.client.inject` packages, module id).

4. **Re-add pieces one at a time** — services, then slot registrations, then
   effects.

Instrumentation beats staring: in the case this skill came from, every
checkpoint logged and all three slot callbacks succeeded while the entry still
read `failed` — which pointed straight at the runtime's own gating rather than
the plugin's logic.

## Step 4 — causes worth checking first

Ranked by how often they are the answer, and by how cheap they are to confirm.

- **The module id is not the package name.** A bundle registers itself with
  `window.__ModuleLoader__.load({ id, factory })`, and the loader resolves by
  package name (`<pkg>` or `<pkg>/client`, both normalized). Plugin authors
  sometimes hardcode the host half's `export const name` instead, and nothing
  resolves — the console says
  `client-modules: could not load "<pkg>": <url>: loaded without registering "<pkg>" via __ModuleLoader__.load`.
  Calibrate against working plugins: grep their client bundles for
  `__ModuleLoader__\.load({ id:` and compare with their package names.
- **An `inject` entry the host never provides.** The entry parks in `pending`
  and `apply()` never runs — which also makes any in-plugin "is this service
  present?" guard unreachable. Declare only services the host always provides,
  and reach optional services through `ctx.inject([...])` at runtime instead.
- **An undeclared service that is used.** The mirror image: the runtime fails
  activation *after* an otherwise perfect `apply()`, with no message anywhere.
  Declare it in `inject`, or read it with `ctx.get(name)`.
- **Settings-service and slot renames.** `settingsScope.bind({ namespace })` →
  `configForms.get(entryId)`, keyed by the **loader entry id** (`ns:
  entry.options.id` on the host side) — and 0.2 removed both namespace
  registration faces, so an entry's own `Config` is the settings document.
  `settings.plugin.item` → `settings.plugins.tab` (list: `id`/`order`/`label`).
  `get()` fabricates a form for *any* key, so decide by the snapshot's `status`
  (`unavailable` = not served), never by whether a form came back. Because the
  service may arrive after `apply()`, resolve it into a swappable scope driven by
  `ctx.inject([...])` rather than binding at apply time.
- **`connection.api.*` became typed Host Remotes.** `ctx.remote.<ns>.<method>()`,
  with `ok` at the top level of the `RemoteResult` instead of nested under
  `result`. A Remote namespace is an **inject token**, so calling one without
  declaring `remote` and `remote.<ns>` parks the entry in `pending`.
- **API drift.** Compare the call against the live contract, not the README. Real
  examples: client `sessions.open` removed (navigation moved to
  `ctx.uiWorkspace.openSession`), `ctx.sessionPersistence` lost
  `inspect`/`readFrom`, tool results became `role: 'tool'` messages rather than
  `tool-result` content blocks, and `MessageSourceMap` lost its catch-all
  `'plugin'` kind. See `references/drift-0.1-to-0.2.md`.
- **Slot drift, including closed domains.** Confirm the key still exists *and*
  that its `keyDomain` is open. A slot whose domain is fixed by an owner key
  table (`conversation.chat.node` ← `ChatNodeKind`) cannot take a third-party
  key at all; move to an open list slot.
- **Session-event traps.** A plugin cannot persist its own event type: the
  known-type set is generated from in-repo declarations, the read path refuses
  anything else unless the event carries an `ignorable` marker, and `append`
  cannot set that marker. Borrowing a "known but unclaimed" type is worse than it
  sounds — the type can be *claimed* by a later release with a mandatory payload
  schema (`hook/invoked` is the case in point).
- **`dsh.client.inject` packages.** Every package named there must exist in the
  client module set; a missing one leaves the entry parked or failed.
- **Bundle snapshot timing.** The client bundle is snapshotted when the loader
  entry activates and served from memory. Editing `node_modules/.../client.js`
  and reloading does **nothing**; the change must be on disk before the entry
  activates (install or restart). This is why in-place edits "don't work".

## Step 5 — fix, verify, install

1. Patch the source of truth (a local fork/folder), never the live profile's
   `node_modules`.
2. **Derive, don't hardcode.** If the plugin generates its client bundle, compute
   the module id from `package.json`'s `name`; that class of defect cannot
   silently return.
3. Leave one runnable check behind — an assert-style script, no frameworks — and
   run it. Assert the *specific* thing that broke ("the bundle registers under
   the package name", "the face declares `uiWorkspace` in inject").
4. Clean `lib/` before verifying a rebuild. `tsc` only adds: deleting a source
   leaves its compiled output shipping, so a removed code path is still live.
   `rm -rf lib && npm run build`.
5. Verify the way the browser sees it: boot the throwaway profile and read the
   boot card plus the served bundle, then delete the temp profile.
6. Install into the real profile from the fork: `dsh plugin --profile <p> add
   file:/abs/path/to/fork`, confirm the entry reaches `active`, and only then ask
   the user to refresh. Grant an exact-version exemption **before** the install
   if the gate will reject it — a rejected new install is rolled back, so an
   exemption afterwards leaves you with "installed but startup denies it".
7. Record the removal condition: drop the fork when upstream ships the fix.

## Pitfalls that cost the most time

- **`file:` dependencies are hard-linked.** pnpm links the folder into the
  profile, so the installed copy shares inodes with your source: editing
  `node_modules` edits your repo file, and `git checkout` in the repo rewrites
  the installed copy. Check `git status` in the source repo before declaring
  victory.
- **Never reinstall a patched plugin by its npm name.** `dsh plugin --profile <p>
  add <pkg>` restores the pristine package and the bug with it. Re-add by `file:`
  path.
- **A prerelease caret range is not a lower bound.** `^0.1.5-rc.1` excludes
  0.2.x; widening to `>=0.1.5-rc.1` is what makes a plugin gate-clean across
  releases. Non-`@deepseek-ai/dsh*` peers are never gated — do not "fix" them.
- **Keep the profile scope explicit in every command.** One missing `--profile`
  writes into the default profile, which may be the one the user is using.
- **`cordis_inspect_query` input quirks.** A query that needs `input` may arrive
  as a string and be rejected (`"input" must be an object`); catalog calls with
  no input still work. A client query also fails with a timeout when no page is
  connected — that is a UI condition, not a plugin defect.
- **Cleanup is part of the job**: temp profile, chromium profile dir, probe
  scripts, logs, fixture directories, and every background job you started (a
  leftover server keeps its port bound; a process started inside a sandboxed
  shell may outlive the shell and be invisible to `ps` from a later call, so
  prefer managed jobs you can kill by id).

## Bundled resources

- `scripts/compat-verify.mjs` — read-only verdict for one installed plugin: peer
  gate, bundle composition, exemption, `--dump-config`, and the client module-id
  comparison. `node scripts/compat-verify.mjs <pkg> [--profile web] [--json]`;
  `--dsh-bin` overrides the resolved binary.
- `scripts/compat-probe.mjs` — CDP probe for a DSH web profile. Creates its own
  tab, installs boot-time error hooks, prints page text, the boot card, the
  expected module ids from `window.__DSH_BOOT__` (filter with `MATCH=<substring>`),
  captured errors, and console/exception events.
  `node scripts/compat-probe.mjs <token|''> <port>`; set `CDP_BASE` if the
  browser is not on `127.0.0.1:9222`, `KEEP=1` to leave the tab open, `ALL=1` to
  print every console line rather than the filtered set.
- `references/drift-0.1-to-0.2.md` — what moved between 0.1.x and 0.2.0-rc.2
  (services, slots, module contract, session events, message model, settings/CLI,
  free detectors), each entry naming the file in the install that proves it.
