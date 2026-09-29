# DSH 0.1.7 compatibility fix (local fork)

Vendored snapshot of `dsh-plugin-message-edit` **1.1.0** from
[SpookySandwich/dsh-plugin-message-edit](https://github.com/SpookySandwich/dsh-plugin-message-edit)
(MIT), with two local fixes so the browser half boots on **DeepSeek Harness 0.1.7-rc.2**.
Everything else is the upstream npm artifact, unmodified.

## Symptoms

Web boot fails with a bare entry name and no detail:

```
web boot: 1 entry did not activate
dsh-plugin-message-edit: failed
```

(Before fix 1 the console additionally showed
`[dsh-plugin-message-edit] Missing DSH session navigation service. Check client dependencies and restart DSH.`)

## Fix 1 — `sessions.open` no longer exists

The client half hard-required `sessions.open`:

```js
if (!sessions || typeof sessions.open !== 'function') throw new Error('...Missing DSH session navigation service...');
```

DSH 0.1.7 removed `open` from the client `sessions` service (it now exposes
`retain`/`using`/`retainInfo`/`refreshProjections`/`search`/`fork`/`scope`/`binding`
plus the `list` snapshot store). Session navigation is now
**`ctx.uiWorkspace.openSession(sessionId)`**. In `apply()`, when `sessions.open` is
missing it is polyfilled from `uiWorkspace`, so the three existing `sessions.open(id)`
call sites stay untouched; the pre-0.1.7 shape still wins when present, and the
original error still fires when neither service exists.

## Fix 2 — the service must be declared in `inject` (this is the one that produced the bare "failed")

The 0.1.7 client runtime restricts each client plugin to the services it declares:

```js
{ inject: ['slots', 'sessions', 'locale'], apply(ctx) { ... } }
```

Reading a service outside that list makes the entry **fail activation** after a
completely successful `apply()` — no exception reaches the plugin, no message is
logged, and the boot screen only prints `<name>: failed`. Fix 1 therefore also
required:

```js
inject: ['slots', 'sessions', 'locale', 'uiWorkspace'],
```

Diagnosis note, for the next time this shape appears: instrumented checkpoints in a
throwaway profile showed the whole `apply()` body and all three slot callbacks running
to completion (`PROBE_0/A/B/C/D`, `PROBE_S1`, `PROBE_V1`) while the entry still
reported `failed`; replacing the client half with a minimal stub booted cleanly; adding
`uiWorkspace` to `inject` fixed it. If a future upstream/service change makes the
plugin need another service, it must be declared there too.

## Change

Both shipped client builds (`lib/client.js` and `plugin.client.js`) carry the same two
edits. `0.1.7-nav-compat.patch` holds them as a unified diff against upstream 1.1.0 for
re-applying to a future release.

## Install (web profile)

```sh
dsh plugin --profile web add file:/home/sil/dsh-plugins/dsh-plugin-message-edit
```

Do **not** install upstream `dsh-plugin-message-edit` from npm into this profile: both
defects come back. pnpm hard-links `file:` dependencies, so the profile's copy shares
inodes with this folder — editing the repo copy in place changes the installed copy too,
and `git checkout` here would rewrite the installed file. Re-run the add command after a
`git pull` to be safe.

## How it was verified

- `node test/compat-0.1.7.cjs` — 9 assertions, no dependencies: the face declares
  `uiWorkspace`; `apply()` survives the 0.1.7 `sessions` shape; the polyfill routes to
  `uiWorkspace.openSession`; `sessions.list` is subscribed; `conversation.view` is
  injected; the 0.1.5 shape still wins; the original error still fires when neither
  service exists.
- Real browser boot in a throwaway profile (`dsh --profile tmp-mtx`, Chrome via CDP):
  with the fix the shell renders and the boot card is gone; without fix 2 the card reads
  `web boot: 1 entry did not activate / dsh-plugin-message-edit: failed`.

## Drop this fork when

Upstream ships a release that navigates via `uiWorkspace.openSession` **and** declares
`uiWorkspace` in its client `inject`. Then install upstream again and delete this folder.
