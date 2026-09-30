---
name: dsh-plugin-compat
description: "Diagnose and fix a DeepSeek Harness (DSH) plugin that fails to load or activate — 'web boot: N entry did not activate', a bare '<package>: failed' on the boot card, a blank or stuck boot screen, a UI tab/buttons that never appear, a plugin that worked on an older DSH version but broke after an upgrade, or a third-party plugin that needs patching/vendoring for a new DSH release. Use this whenever a DSH plugin misbehaves or must be made compatible with the installed harness, even if the user only says 'this plugin doesn't work', 'the plugin broke after the update', or pastes a boot error."
---

# DSH plugin compatibility triage

Two failure modes cost hours if you guess instead of measuring:

1. **Silent client activation failure.** A client (browser-half) plugin can pass a fully successful `apply()` and still be marked failed by the runtime. The boot card then shows only `<package>: failed` — no exception, no console message. Nothing you "fix" by reading the README will show up until you capture that state yourself.
2. **Version drift.** Third-party plugins are written against one harness release. Service names, method signatures, slot options and `inject` gating change between releases; a plugin can be composed, enabled, listed, and still not activate.

Everything below is ordered cheapest-first, because the expensive steps (browser, instrumentation, bisection) are only worth it once the cheap ones rule things out.

## Ground rules

- **Never debug inside the profile the user is actively working in.** Copy the failure into a throwaway profile. Touching their profile changes their running UI and destroys their trust; if you must, say exactly what you will change and get a yes first.
- **Ask the profile, not the README, what the API is.** The live service contract is discoverable (`cordis_inspect_query`, shipped `lib/types/*.d.ts`); the README describes the version the author had.
- **A file grep is not proof.** "The patched line is in `node_modules`" says nothing about what the browser was served. Prove the served artifact or the boot screen, or state the limit explicitly.
- **Clean up what you create**: temp profiles, probe scripts, browser profile dirs, logs, background jobs, and any in-place edit that leaked.

## Step 1 — read-only state checks (no changes)

| Question | Command |
|---|---|
| Is the entry composed at all? | `dsh --profile <p> --dump-config \| grep -A1 "<entry-id>"` |
| Is the package a dependency *and* a bundle? | `grep -n "<pkg>" ~/.dsh/profiles/<p>/package.json` (needs both the `dependencies` line and the `dsh.profile.bundles` entry) |
| Is the entry enabled, and in which phase? | `plugin_manager list_plugins` (page to the end; third-party entries sit last). `active` = up; `pending` = waiting for a **named** service (the message says which); `failed` = activation errored; `enabled:false` + `fiberPhase:null` = disabled, not broken |
| Did the host log an error? | `grep -i "<pkg>" ~/.dsh/logs/startup-*.log` — host-half activation failures appear here with the real error; **client-half failures do not** |
| Which client build is served? | `node -e 'const p=require("<pkg>/package.json");console.log(p.exports["."],p.exports["./client"],p.dsh)'` — many plugins ship both `lib/client.js` and `plugin.client.js`; patch the one `exports["./client"]` names, and both if unsure |

If the entry is missing entirely, this is an install problem, not a compatibility problem: check `dsh plugin --profile <p> add …` output and the bundles list.

## Step 2 — reproduce outside the user's profile

```sh
dsh --profile tmp-diag --from-default-profile web --dump-config      # create a throwaway profile
dsh plugin --profile tmp-diag add file:/abs/path/to/plugin           # or the npm name
dsh --profile tmp-diag --no-open --port 3198                         # start as a managed background job
```

- Start long-running servers as **managed background jobs**, not `nohup` inside a one-shot call: sandboxed shells reap their children when the call ends, and a per-call `/tmp` means files written by one call are invisible to the next. Prefer a log path under `$HOME`.
- The server prints `http://127.0.0.1:<port>/?token=…`. Redeem it into a cookie jar **after the listener is fully up** (wait ~10 s once the URL appears; redeeming too early returns `401` with no `Set-Cookie`). Treat the token as single-use.
- `--host` accepts only `127.0.0.1` or `0.0.0.0`, and the launcher refuses `0.0.0.0` on purpose. To reach the profile from a browser, run the browser on this machine.
- **Do not assume a remote CDP Chrome can reach your loopback.** A profile-proxy endpoint may front a browser on another OS/host (check `/json/version`: `Windows NT` ≠ this machine), where `127.0.0.1` is not yours; reverse SSH tunnels to the proxy host will not help. Launch a local Playwright chromium instead:

```sh
CHROME=$(ls -d ~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome | tail -1)
"$CHROME" --headless=new --remote-debugging-port=9222 --no-sandbox \
  --disable-dev-shm-usage --user-data-dir="$HOME/.cache/chrome-diag" about:blank &
```

Then use the bundled probe (it creates its own tab, so nothing depends on an agent-browser session's tab state):

```sh
node scripts/compat-probe.mjs "<token>" <port>          # CDP_BASE defaults to http://127.0.0.1:9222
```

Boot-card text `Failed to load plugins` + `web boot: N entry did not activate` + `<pkg>: failed` is a **client** activation failure. `pending (waiting for service: x)` is a different, easier bug: the provider never came up.

## Step 3 — get the real error

The frontend reports only the entry's state. In this order:

1. **Probe hooks.** `scripts/compat-probe.mjs` installs `error`/`unhandledrejection` listeners and wraps `console.error` before the app boots. Sometimes this is all you need.
2. **Checkpoints in the served copy.** Insert `console.error('PROBE_x …')` at each stage of `apply()` (entry, after each service lookup, before each registration). Restart the profile so the snapshot re-reads the file, then re-read the page console. The last checkpoint before silence tells you where it died.
3. **Minimal-stub bisection.** Replace the plugin's client half with:

```js
window.__ModuleLoader__.load({
  id: '<package-name>',
  factory: (require) => ({ name: '<entry-id>', inject: [], apply(ctx) {} }),
});
```

If the shell boots cleanly, the module contract and entry wiring are fine and the bug is in the plugin's own code; if it still fails, the problem is entry-level (package manifest, `dsh.client.inject` packages, entry id collision).
4. **Re-add pieces one at a time** — services, then slot registrations, then effects.

Instrumentation beats staring: in the case this skill came from, every checkpoint logged and all three slot callbacks succeeded while the entry still read `failed` — which pointed straight at the runtime's own gating rather than the plugin's logic.

## Step 4 — causes worth checking first

- **Undeclared service (silent).** The client runtime only lets a plugin touch services named in its `inject` list. Reading one that is not declared fails entry activation *after* an otherwise perfect `apply()`, with no message anywhere. Fix: declare it — `inject: ['slots', 'sessions', 'locale', 'uiWorkspace']`. This is the highest-value check in this file.
- **API drift.** Compare the call against the live contract, not the README. Real examples across 0.1.5 → 0.1.7: client `sessions.open` removed (navigation moved to `ctx.uiWorkspace.openSession`), `ctx.sessionPersistence` lost `inspect`/`readFrom` (left `create/open/flush/stat/list`), `@deepseek-ai/dsh-settings` dropped `installSettingsSection`/`settingsNamespace`.
- **Slot/UI drift.** Confirm the slot key still exists and that the registration options match the live slot tree (list vs keyed, which props are actually accepted).
- **`dsh.client.inject` packages.** Every package named there must exist in the client module set; a missing one leaves the entry parked or failed.
- **Bundle snapshot timing.** The client bundle is snapshotted when the loader entry activates and served from memory. Editing `node_modules/.../client.js` and reloading the page does **nothing**; the patch must be on disk *before* the entry activates (install or restart). This is why in-place edits appear to "not work".

## Step 5 — fix, verify, install

1. Patch the source of truth (a local fork/folder), never the live profile's `node_modules`.
2. Leave one runnable check behind — an assert-style script, no frameworks — and run it. Assert the *specific* thing that broke (e.g. "the face declares uiWorkspace in inject"), so the same regression cannot return silently.
3. Verify the way the browser sees it: boot the throwaway profile and read the boot card plus the served bundle. Then delete the temp profile.
4. Install into the real profile from the fork: `dsh plugin --profile <p> add file:/abs/path/to/fork`, confirm the entry reaches `active`, and only then ask the user to reload.
5. Record the removal condition: drop the fork when upstream ships the fix.

## Pitfalls that cost the most time

- **`file:` dependencies are hard-linked.** pnpm links the folder into the profile, so the installed copy shares inodes with your source: editing `node_modules` edits your repo file, and `git checkout` in the repo rewrites the installed copy. Debugging in place then leaves surprising diffs — check `git status` in the source repo before declaring victory.
- **Never reinstall a patched plugin by its npm name.** `dsh plugin --profile <p> add <pkg>` restores the pristine package and the bug with it. Re-add by `file:` path.
- **Keep the profile scope explicit in every command.** One missing `--profile` writes into the default profile, which may be the one the user is using.
- **`cordis_inspect_query` input quirks.** A query that needs `input` may arrive as a string and be rejected (`"input" must be an object`); catalog calls with no input still work. Fall back to reading the shipped `lib/types/*.d.ts` or the service implementation.
- **Cleanup is part of the job**: temp profile, chromium profile dir, probe scripts, logs, and every background job you started (a leftover server keeps its port bound; a process started inside a sandboxed shell may outlive the shell and be invisible to `ps` from a later call, so prefer managed jobs you can kill by id).

## Bundled resources

- `scripts/compat-probe.mjs` — CDP probe for a DSH web profile. Creates its own tab, installs boot-time error hooks, then prints page text, captured probe errors, and console/exception events. `node scripts/compat-probe.mjs <token|''> <port>`; set `CDP_BASE` if the browser is not on `127.0.0.1:9222`, and `KEEP=1` to leave the tab open for follow-up evaluation.
