# DSH 0.1.7 compatibility fix (local fork)

Vendored snapshot of `dsh-plugin-message-edit` **1.1.0** from
[SpookySandwich/dsh-plugin-message-edit](https://github.com/SpookySandwich/dsh-plugin-message-edit)
(MIT), with one local fix so the browser half boots on **DeepSeek Harness 0.1.7-rc.2**.
Everything else is the upstream npm artifact, unmodified.

## Symptom

Web boot fails with:

```
web boot: 1 entry did not activate
dsh-plugin-message-edit: failed
```

and the browser console shows:

```
[dsh-plugin-message-edit] Missing DSH session navigation service.
Check client dependencies and restart DSH.
```

## Root cause

The client half hard-requires `sessions.open`:

```js
const sessions = ctx.get('sessions');
if (!sessions || typeof sessions.open !== 'function') throw new Error('...Missing DSH session navigation service...');
```

DSH 0.1.7 removed `open` from the client `sessions` service (it is now
`retain`/`using`/`retainInfo`/`refreshProjections`/`search`/`fork`/`scope`/`binding`
plus the `list` snapshot store). Session navigation moved to
**`ctx.uiWorkspace.openSession(sessionId)`** — that is what shipped plugins call
(e.g. `@deepseek-ai/dsh-client-ui-chat`). The package declares compatibility with
`>=0.1.5-rc.2 <0.1.6-0`; upstream has no 0.1.7 release yet.

Everything else the client needs is unchanged in 0.1.7: `sessions.list`
(snapshot store with `.byId` / `.subscribe`) and the `conversation.view`,
`conversation.chat.node`, `settings.section` slots.

## Change

In `lib/client.js` **and** `plugin.client.js` (both are shipped client builds),
inside `apply()`, `sessions.open` is polyfilled when missing:

```js
if (typeof sessions.open !== 'function') {
  const uiWorkspace = ctx.get('uiWorkspace');
  if (!uiWorkspace || typeof uiWorkspace.openSession !== 'function') {
    throw new Error('...Missing DSH session navigation service...');
  }
  sessions.open = function (id) { return uiWorkspace.openSession(id); };
}
```

The three original `sessions.open(id)` call sites are untouched, the pre-0.1.7
shape is still honored, and the original error still fires when neither service
exists. `0.1.7-nav-compat.patch` holds the same change as a unified diff against
upstream 1.1.0 for re-applying to a future release.

## Install (web profile)

```sh
dsh plugin --profile web add file:/home/sil/dsh-plugins/dsh-plugin-message-edit
```

Do **not** install upstream `dsh-plugin-message-edit` from npm into this profile:
it reintroduces the boot failure.

## Why a page reload alone is not enough

`@deepseek-ai/dsh-client-modules` snapshots the client bundle at the moment the
loader entry activates (`initialBundleSnapshot` → `readFileSync(clientPath)`),
and serves that snapshot (`bundleResource` reads `this.responses`, not the file).
Editing `node_modules/.../client.js` in place therefore does **not** reach the
browser on refresh: the pristine snapshot keeps being served and the entry keeps
failing. The fix must be on disk **before** the install activates the entry — which
is exactly what installing this folder does. (A DSH restart also re-snapshots.)

## Check

```sh
node test/compat-0.1.7.cjs
```

Runs the real client module in a sandbox against a 0.1.7-shaped `sessions` service
and asserts: `apply()` does not throw, the polyfill routes to
`uiWorkspace.openSession`, `sessions.list` is subscribed, `conversation.view` is
injected, the 0.1.5 shape still wins when present, and the original error still
fires when neither service exists. 8 assertions, no dependencies.

## Drop this fork when

Upstream ships a release that navigates via `uiWorkspace.openSession` (or the
plugin declares 0.1.7 support). Then install upstream again and delete this folder.
