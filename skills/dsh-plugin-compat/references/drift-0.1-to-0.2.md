# Drift catalog: DSH 0.1.x → 0.2.0-rc.2

A lookup table for "the plugin was written for an older harness". Every entry
names the file in the installed tree that proves it, so you can re-verify rather
than trust this document — versions move, and a claim here is only as good as
the release it was checked against (0.2.0-rc.2, `~/.dsh/profiles/web`).

Paths below are relative to the **install**:
`$(dirname $(dirname $(realpath $(command -v dsh))))/node_modules/@deepseek-ai/`
— call it `$PKGS`. Everything under it is the harness the profile actually runs.

## Contents

1. [The version gate](#1-the-version-gate)
2. [Client services](#2-client-services)
3. [Slots](#3-slots)
4. [Client module contract](#4-client-module-contract)
5. [Session events](#5-session-events)
6. [Message model](#6-message-model)
7. [Settings and CLI](#7-settings-and-cli)
8. [Detectors that find drift for free](#8-detectors-that-find-drift-for-free)

## 1. The version gate

`$PKGS/dsh-app-boot/lib/index.js` — `evaluatePluginCompatibility`.

- Only peers named `@deepseek-ai/dsh` or starting with `@deepseek-ai/dsh-` are
  gated. `@deepseek-ai/cordis`, `schemastery`, `react` and friends are ignored,
  so a "peer mismatch" there is noise.
- Ranges are tested with `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`;
  `workspace:^` / `~` / `*` are replaced by the runtime version itself.
- A caret range on a 0.x prerelease stops below the next minor:
  `^0.1.5-rc.1` does **not** satisfy `0.2.0-rc.2`. This is the single most common
  false-alarm-free failure, and the fix is an open-ended `>=0.1.5-rc.1`.
- `loadProfileDirectory` throws for an unexempted mismatch, the bundle lands in
  `skippedBundles`, and `reportSkippedBundles` prints
  `skipping profile bundle "<pkg>": …` at startup.

## 2. Client services

The client runtime is closed over an `inject` list, and **both directions fail**:

| Direction | Symptom |
|---|---|
| Service used but not declared | Activation fails *after* a successful `apply()`; no message |
| Service declared but not provided | Entry parks in `pending`; `apply()` never runs, so any in-plugin guard for that service is unreachable dead code |

Removed between 0.1.x and 0.2 (grep the whole install for the name; zero hits in
all 288 packages means it is gone):

| 0.1.x | 0.2 | Evidence |
|---|---|---|
| `settingsScope.bind({ namespace })` | `configForms.get(entryId)` | `$PKGS/dsh-client-ui-settings/lib/types/client/config-form.d.ts`; `$PKGS/dsh-settings/lib/index.js` (`ns: entry.options.id`) |
| `conversationEvents.register(definition)` | *no replacement* | `$PKGS/dsh-api-session-controller/lib/client.js` (`KNOWN_SESSION_EVENT_TYPES`) |

Still present, so do not "fix" them: `connection` (`$PKGS/dsh-client-connection`
provides it), `slots`, `locale`, `sessions`, `theme`, `layout`, `timer`,
`uiWorkspace`, `workspaces`, `resources`, `configForms`.

**The Inspect Service catalog is curated, not exhaustive.** It answered
`no catalogued Service named "connection"` for a service that exists and is used
by working plugins. Never read that answer as absence — grep the install for the
name, or read the provider's `lib/types/*.d.ts`.

Config forms are keyed by the **loader entry id** — for a plugin installed as
`dsh-advisor-plugin`, `configForms.get('dsh-advisor-plugin')`. This reverses the
0.1.x model, where a plugin registered *itself* under a namespace it chose:
0.2's settings document is **each profile entry's own `Config`**, and the host
derives the key from the entry (`$PKGS/dsh-settings/lib/index.js`:
`ns: entry.options.id`, and `update`/`mutate` resolve `entries().find(row =>
row.options.id === ns)`).

Two consequences that make this easy to get wrong:

- 0.2 removed **both** host-side namespace registration faces
  (`settings.installSection`, `settings.register`). The 0.2 service surface is
  `configure` / `prepareDocument` / `describe` / `update` / `replace` / `mutate`
  (`$PKGS/dsh-settings/lib/types/index.d.ts`). A plugin that still calls them
  registers nothing, and its config reaches `apply()` from the loader instead.
- `configForms.get(key)` **fabricates a form for any key**, so a returned form
  proves nothing. Decide by the snapshot's `status`: `unavailable` means that key
  is not served. Probe the entry id first and keep the old namespace only as a
  fallback for older hosts.

Do not be misled by `ConfigFormSpec.namespace` in
`$PKGS/dsh-client-ui-settings/lib/types/client/config-form.d.ts` — that field
describes what the *providing* plugin passes to build a form, whereas the
consumer-facing `get(entryId)` is documented one line as "one Host plugin
entry" / "@param entryId Unique Host plugin entry id".

`ConfigFormSnapshot` is `{ status, value, base, user, revision, writable, mode }`,
`value` is that entry's own section, and `set(field)` takes a bare scalar field
name inside the section.

### Host Remotes replaced `connection.api.*`

| 0.1.x | 0.2 |
|---|---|
| `ctx.connection.api.<ns>.<method>(payload)` returning `{ result: { ok, value } }` | `ctx.remote.<ns>.<method>(payload)` with `ok` at the **top level** of the `RemoteResult` |

`$PKGS/dsh-api-remotes/lib/types/client/*.d.ts` declares `interface Context {
remote: ClientRemote }` as "Generated Remote namespaces selected by this Client
assembly", and the same file notes the mount's own `inject` list. A Remote
**namespace is an inject token**: a plugin calling `ctx.remote.session.modelCatalog()`
must declare `remote` and `remote.session` in its client `inject`, or the entry
parks in `pending`. The model catalog an author might expect from
`connection.api.llm.models` lives there — `modelCatalog` is declared in
`$PKGS/dsh-api-session-controller/lib/types/index.d.ts`, and it is the same
source the composer's model selector reads.

## 3. Slots

Check the live tree, not the README: `Slots.listSubTree` with the **exact** key
returns `available`, plus `occupants` for the live registrations.

| 0.1.x | 0.2 |
|---|---|
| `settings.plugin.item` (keyed by namespace) | `settings.plugins.tab` (list; `id` / `order` / `label`) |

`conversation.chat.node` became a **fixed** key domain — its `keyDomain` reads
"fixed by the owner's key table { [Kind in ChatNodeKind] … }", so a plugin cannot
register its own node kind. Spectator-style UI that used to materialize through a
custom kind needs an open slot instead (`conversation.chat.turnTail`,
`conversation.chat.assistant-actions`, and friends are lists with open domains).

Registration options differ by kind: a list slot takes `id`, a keyed slot takes
`key`. Passing both is the pragmatic cross-version move; `slots.inject` waits for
the slot to exist, so registering into a slot this host does not declare is a
silent no-op rather than an error — which is exactly the graceful degradation you
want for an optional card.

## 4. Client module contract

`$PKGS/dsh-client-modules/lib/client.js`.

- A bundle self-registers: `window.__ModuleLoader__.load({ id, factory })`.
- **`id` must be the package name.** `stripClientSuffix` also accepts
  `<package>/client`, and both normalize to the same exports — anything else
  does not resolve. Working plugins are the calibration: `dshmarket`,
  `@michengai/dsh-skills-manager`, `@opencode2dsh/dsh-plugin` all register under
  their own package names.
- The failure is loud *if* you capture the console:
  `client-modules: could not load "<id>": <url>: loaded without registering "<id>" via __ModuleLoader__.load`
  (or `already executed without registering "<id>"`). The id in that message is
  the id the loader wanted — which is why hardcoding it to the host half's
  `export const name` is a trap.
- The expected ids are in the page's boot wire: `window.__DSH_BOOT__` is
  `{ rev, entries: [{ id, url, rev }], batches: [{ phase, entries, url }] }`.
- The loader owns "fiber lifecycle, **inject waiting**, update/refresh", so an
  entry's own `try/catch` cannot rescue an unsatisfiable `inject`.
- A new client plugin needs a **page refresh** before its slots have occupants;
  an Inspect query taken before the refresh shows nothing.

## 5. Session events

`$PKGS/dsh-session/lib/types/known-event-types.d.ts` and
`$PKGS/dsh-session-persistence-jsonl/lib/worker.cjs`.

- `KNOWN_SESSION_EVENT_TYPES` is **generated** from `SessionEventMap` members
  "declared in this repository". "Downstream (out-of-repo) plugin events are
  outside this list by construction." The read path refuses a log containing an
  unlisted type unless the event carries the envelope's `ignorable` marker —
  deliberately, because silently skipping a required event would reconstruct a
  wrong session.
- `Session.append<T>(type, data, ...opts)` exposes **no** `ignorable` option
  (`ignorable?: true` exists only on the `SessionEvent` envelope). So a plugin
  cannot set the one marker its own event type would need.
- The client is closed the same way: `dsh-api-session-controller` holds a fixed
  `KNOWN_SESSION_EVENT_TYPES`, and the same file records that event-name
  registration "was rejected because it does not classify omission safety and
  would make reads composition-dependent".
- **Borrowing an unclaimed type is a time bomb.** 0.1.x plugins used
  `hook/invoked` because it was known-but-unowned. 0.2 ships `dsh-hooks-codex`
  and `dsh-hooks-claude-code`, which own it, and the payload validator enforces
  `disposition(["turn", "point", "dialect", "handlerId"], ["matcher"])` with
  `dialect` a literal `{"claude-code", "codex"}`. A custom payload on that type
  is now invalid — on an *owned* type, which is worse than an unknown one.

Consequence: on 0.2 there is no supported way for a profile-installed plugin to
persist its own event type, and no way to materialize UI from one. Client-visible
plugin state goes through the resource model instead
(`ctx.resources.register` + the global `useResource` hook, addresses
`dsh-resource://<protocol>/…`), which is fed by host RPC.

## 6. Message model

`$PKGS/dsh-llm/lib/types/message.d.ts`.

| 0.1.x | 0.2 |
|---|---|
| tool results were `tool-result` content blocks inside a user message | first-class `ToolResultMessage` with `role: 'tool'` |
| a catch-all `kind: 'plugin'` message source | `MessageSourceMap` is merge-extensible; each producer declares its own kind |

- `MessageRoleMap` is closed: `system | developer | user | assistant | tool`.
  Code that pattern-matches content blocks for tool results silently stops
  matching, which breaks pairing-safe truncation (a retained `tool` message whose
  `tool-call` was dropped is rejected wholesale by providers).
- Declare a source kind the way the shipped plugins do — `dsh-skill`'s
  `'skill-invocation'` (`form: 'instructions'`), `dsh-session-reference`'s
  `'session-reference'` (`form: 'recall'`) — by augmenting
  `declare module '@deepseek-ai/dsh-llm' { interface MessageSourceMap { … } }`.
  `MessageSource.kind` answers who produced it; `ContextForm` answers what it is:
  `instructions | catalog | snapshot | notice | relay | recall`.
- Producer summaries are bounded by `boundContextSummary` /
  `CONTEXT_SUMMARY_MAX_CHARS` (120), exported from `@deepseek-ai/dsh-llm`.

## 7. Settings and CLI

```sh
dsh plugin --profile <p> version-exemptions                     # read-only listing
dsh plugin --profile <p> allow-version <pkg>@<ver> \
  --dsh-version <exact-runtime> --accept-risk                   # grant
dsh plugin --profile <p> revoke-version <pkg>@<ver> --dsh-version <exact>
dsh plugin --profile <p> <pnpm-args...>                         # everything else is pnpm
```

- `allow-version` must be the first argument after `plugin`; `--accept-risk` is
  required or the grant is rejected. Exemptions are profile-scoped, stored in
  `<profile>/compatibility.json`, and keyed `"<pkg>@<version>": ["<runtime>"]`.
  The `plugin_manager` tool needs `acceptRisk: true` for the same reason.
- `$PKGS/dsh-plugin-manager/lib/types/operations.js`: after a pnpm run, any
  installed dependency declaring `dsh.bundle` is auto-added to
  `dsh.profile.bundles`. A **newly installed** incompatible package is rolled
  back (`installation rejected` + restore of `package.json`, the lockfile and
  `node_modules`); a package that was already installed untouched merely "stays
  installed but profile startup denies it". So an exemption must exist *before*
  the install, not after.
- Composition is `dsh.profile.bundles` order, then the profile's
  `cordis.patch.yml`, then `--patch` overlays. Being in `dependencies` is not
  enough.

## 8. Detectors that find drift for free

- **Run the plugin's own build against the installed types.** `tsc` against 0.2
  found two real API drifts in code a README claimed worked. It needs the
  install's `@deepseek-ai` packages linked into the plugin's `node_modules` —
  upstream helpers often hardcode a machine-specific path, so resolve it from
  `realpath $(command -v dsh)`.
- **`dsh --profile <p> --dump-config`** — exit code plus a grep for
  `skipping profile bundle` catches gate and composition failures with no server
  running.
- **Clean `lib/` before verifying a rebuild.** `tsc` only adds: deleting a source
  leaves its compiled output shipping, so a removed code path (a writer, a
  handler) is still live in `lib/`. `rm -rf lib && npm run build`.
- **`node scripts/compat-verify.mjs <pkg>`** (this skill) runs the gate,
  the composition check, the exemption lookup and the module-id comparison in one
  read-only pass.
