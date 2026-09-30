# DSH 0.2 compatibility fix (local fork)

Snapshot of `dsh-advisor-plugin` **0.2.6** from
[leeyoung1/dsh-advisor-plugin](https://github.com/leeyoung1/dsh-advisor-plugin)
(MIT, tag `v0.2.6`, commit `c229997`), with local fixes so both halves run on
**DeepSeek Harness 0.2.0-rc.2**. Upstream targets `0.1.5-rc.1` / `0.1.5-rc.2`
(its README says so, and its last commit predates the 0.2 upgrade), so the fork
is a port, not a build fix.

Version is `0.2.6-local.1`. Peer ranges were widened from
`^0.1.5-rc.1 || ^0.1.5-rc.2` to `>=0.1.5-rc.1`, so **no version exemption is
needed** (upstream 0.2.6 is blocked by DSH's peer gate on 0.2.0-rc.2 and boots
only as a skipped bundle).

```bash
dsh plugin --profile web add file:/home/sil/dsh-plugins/dsh-advisor-plugin
```

## Symptoms

Page reload after installing upstream 0.2.6:

```
web boot: 1 entry did not activate
```

The host half mounts fine — the live loader shows the entry with its projected
Config schema — but nothing of the browser half ever appears, and no plugin
exception is logged, because `apply()` was never called. Two independent
defects produce this symptom: the unsatisfiable `inject` list (Fix 1) and the
unresolvable module id (Fix 1b). Both are fatal to the browser half on their
own, so both had to be fixed.

## Fix 1 — `inject` named two services 0.2 does not provide (this is the one that parked the entry)

The client half declared:

```js
export const inject = ['slots', 'locale', 'connection', 'settingsScope', 'conversationEvents']
```

A cordis entry waits for every name in `inject` before applying, so an
unsatisfiable name parks the **whole** entry in `pending`. In 0.2 both
`settingsScope` and `conversationEvents` are gone: neither string occurs
anywhere in the 288 `@deepseek-ai` packages of the installation, and no profile
plugin provides them. Upstream's own guard (`if (events !== undefined) … else
console.warn`) is unreachable for exactly this reason — it sits inside an
`apply()` that never runs.

`inject` is now `['slots', 'locale', 'connection']` — only services every
supported host provides. The settings source is resolved at runtime instead
(see Fix 2), and a missing source costs only the card.

## Fix 1b — the client bundle registered under the wrong module id

`scripts/build-client.mjs` hardcoded the self-registration id to the host
half's `export const name`, `'dsh-advisor'`:

```js
window.__ModuleLoader__.load({ id: "dsh-advisor", factory: (require) => { … } })
```

The loader resolves a plugin's browser module by **package name** — every
working plugin in this profile registers under its own package name
(`dshmarket`, `@michengai/dsh-skills-manager`, `@opencode2dsh/dsh-plugin`) —
and `dsh-advisor` matches nothing. An unresolvable id falls into the module
system's `anything else → throw` branch, so the entry cannot materialize even
with a correct `inject` list. This alone would have kept the browser half dead
on 0.2 after a page refresh.

The id is now derived from `package.json`'s `name` instead of being written by
hand, so it cannot drift again. A missing `name` fails the build loudly.

## Fix 2 — the settings service and the plugin-page slot were both renamed

| | ≤ 0.1.6 | 0.2 |
|---|---|---|
| settings service | `settingsScope.bind({ namespace })` | `configForms.get(namespace)` |
| plugin-page slot | `settings.plugin.item` | `settings.plugins.tab` (list: `id`/`order`/`label`) |

`src/client/settings-controller.ts` resolves the service across releases:
`configForms` first, `settingsScope` as fallback, `undefined` when neither
exists. Two details that matter:

- The `configForms` key is the **loader entry id**, not the old namespace.
  0.2's host-side `describe()` emits `ns: entry.options.id`, and the client's
  `get(entryId)` is documented as "one Host plugin entry" — the settings
  document moved from *namespaces a plugin registers itself* to *each profile
  entry's own `Config`*. The key is therefore `dsh-advisor-plugin` (this
  plugin's patch id, from its own `cordis.patch.yml`), with `advisor` kept as a
  fallback probe for hosts where the namespace form is the served one. Since
  `get()` fabricates a form for any key, the probe decides by snapshot
  `status` (`unavailable` = not served) rather than by whether a form exists.
- 0.2 also removed both host-side namespace registration faces
  (`settings.installSection` and `settings.register`), so the host half no
  longer registers a namespace at all. That is harmless: the loader still hands
  the entry's `Config` to `apply()`, so the configuration is live and editable
  through the card (or by editing the entry's `config:` in the profile patch).
  `wireSettings` now reports this shape instead of "settings service
  unavailable".
- Resolution is deferred through `ctx.inject([...])` onto a swappable scope
  (`createResolvingScope`), because either service may arrive after this
  plugin's `apply()`. Before a source attaches, the card renders its existing
  `unavailable` read-only state.

The projection is an identity pass-through: 0.2's `ConfigFormSnapshot`
(`{ status, value, base, user, revision, writable, mode }`) already carries the
namespace section in `value` and is documented as reference-stable between
changes, which is what `useSyncExternalStore` needs. Writes use the bare field
name (`set`) or the `[field]` path (`mutate`), and a refused write **throws** so
the card's failure state is visible instead of silently looking saved.

Each slot registration is wrapped so a contract mismatch costs one card, never
the entry. Registrations use plain callbacks rather than generators — the
generator form is what broke `dsh-opencode2dsh`'s web boot in this repo.

## Fix 3 — the patrol conversation card cannot exist on 0.2 (dropped)

The card was a `conversationEvents` Definition that materialized a chat node of
kind `advisor-patrol`. On 0.2 there is no replacement API:

- `conversationEvents` is gone, and `dsh-api-session-controller` holds a fixed
  `KNOWN_SESSION_EVENT_TYPES` set stating plugin events are "outside this list
  by construction".
- `dsh-session/lib/types/known-event-types.d.ts` is explicit that
  `KNOWN_SESSION_EVENT_TYPES` is generated from `SessionEventMap` members
  "declared in this repository" and that the persistence read path **refuses**
  a log containing any other type unless the event carries the `ignorable`
  marker — which `Session.append(type, data, ...opts)` cannot set.
- `conversation.chat.node` became a **fixed** key domain (`ChatNodeKind`), so a
  plugin cannot register its own node kind either.

So the card was removed rather than re-seated: `src/client/patrol-chat.ts`,
`src/client/PatrolNodeView.tsx` and their slot registration are gone. Patrol
verdicts remain visible as one console line per round (`[dsh-advisor][patrol] …`),
and the model-facing behaviour — the `agent.inject()` correction on the next
request — is untouched. A future card needs the resource model
(`ctx.resources.register` + the global `useResource` hook), which requires a
host RPC endpoint; that is a feature port, not a re-seat.

## Fix 4 — host half: stop writing `hook/invoked` (data integrity)

Upstream persisted each verdict as a `hook/invoked` session event, chosen in the
0.1.x era because that type was known-but-unclaimed. **0.2 claims it**:
`dsh-hooks-codex` and `dsh-hooks-claude-code` ship and own it, and the
persistence format validates its payload:

```
"hook/invoked": disposition(["turn", "point", "dialect", "handlerId"], ["matcher"])
  dialect: literalValue ∈ {"claude-code", "codex"}
```

Upstream's payload (`{plugin, point, verdict, detail, step, reviewer, patrolMs,
usage?}`) satisfies none of the required members and has no legal `dialect`.
Whether that surfaces as a refused append or an unreadable log was not
reproduced (patrol never ran upstream, since the plugin was unarmed), but the
asymmetry decides it: the write is gone. `src/patrol-event.ts` and its spec were
deleted.

## Fix 5 — host 0.2 API drift (`tsc` surfaced two more)

The first clean `tsc` run against 0.2 reported two errors in code the port had
to touch anyway. Both are real drift, not type noise:

- **Tool results became a first-class message role.** 0.2 has
  `ToolResultMessage` (`role: 'tool'`); 0.1.x used a `tool-result` content block
  inside a user message. `isToolResultMessage` now recognises both, which is
  what keeps overflow truncation pairing-safe — on 0.2 a retained `tool` message
  whose `tool-call` was dropped is rejected wholesale by the provider.
- **User-context sources must declare their own `kind`.** 0.2 removed the
  catch-all `'plugin'` kind; `MessageSourceMap` is merge-extensible and each
  producer declares its own, like `dsh-skill`'s `'skill-invocation'`. The
  injected patrol correction now declares `kind: 'advisor-patrol'` with
  `form: 'notice'` and a `boundContextSummary`-bounded summary.

## Fix 6 — the model catalog moved to a Host Remote (the card showed "Failed to load the model catalog")

The card's model list came from `ctx.connection.api.llm.models({})`, whose
`{ result: { ok, value } }` envelope wrapped `{ groups, failures }`. That call
does not exist on 0.2: the whole `connection.api.*` surface was replaced by
typed Host Remotes, and the catalog now lives on `ctx.remote.session`:

```ts
const response = await ctx.remote.session.modelCatalog()
// RemoteResult<ModelCatalog>, ok is at the TOP level:
//   { ok: true,  value: { default, routableProviders, groups, failures } }
//   { ok: false, error: { code, message } }
```

`groups` is `[{ id, name, models: [{ id, name, description?, reasoning? }] }]`
and `reasoning` is `{ efforts: [{ id, name, description? }], defaultEffort? }` —
the same provider-grouped shape the card already consumed, so only the call and
the envelope changed. This is the same source the composer's model selector
reads (`dsh-client-ui-model-selection`'s `ModelCatalogDirectory` calls
`ctx.remote.session.modelCatalog()`), so the card now offers exactly the routes
DSH considers routable.

`remote` and `remote.session` are named in the client `inject` list: in 0.2 a
Remote namespace is an inject token, and several installed plugins declare
`remote.session` the same way. A missing catalog is now surfaced with its
`code: message` in the console instead of a bare failure.

## Fix 7 — the settings document only writes `.volatile()` fields (this is what "Save failed" was)

0.2's settings write path rejects every non-volatile path:

```js
const form = volatileForm(schema);
if (form === void 0) throw new Error(`Plugin entry "${ns}" has no volatile fields`);
for (const path of paths) if (!isVolatilePath(schema, path)) throw new Error(`Config field "${path.join('.')}" is not volatile`);
```

Upstream's Config used plain `z.boolean().default(true).description(...)` fields with
no `.volatile()` anywhere, so `volatileForm` returned `undefined` and **every** card
write was refused. Working plugins declare it — `dsh-free-search` uses
`z.string().default("bing").volatile()` and notes that `.volatile()` needs the scoped
`@deepseek-ai/schemastery` (>= 3.18.2, satisfied here at 3.18.4).

All ten fields are now `.volatile()`. That changes the runtime contract: schemastery
parses a volatile field into "a stable reference read with `.get()`" (defaults stay
ordinary data), so `apply` receives references, not values. Two consequences, both
handled:

- **Reads** go through `resolveConfig()`, which unwraps anything with a `.get()`
  and passes plain defaults through, called on every read (`current()`) rather than
  once — a cached snapshot would pin the old values.
- **Commits** are in-place and do **not** remount the plugin, so arming has to track
  them: the host half now subscribes to `settings/document-updated`, recomputes
  `resolveSelection`, and re-registers the tool + prompt section only when the
  resolved config actually changed. Without this, saving a reviewer would not arm
  the advisor until a restart.

Note the asymmetry when testing: the client half is read from disk per request, so a
page refresh picks up changes — but the **host half is loaded into the node process at
boot**, so host-side changes need a `dsh web` restart. The live Config projection tells
you which one you have: a volatile node carries `x-cordis.volatile: true`.

## Fix 8 — repair forwarded tool history and mark reviewer failures as errors

The advisor forwards the model-visible conversation to a different provider. Before
forwarding, it now removes tool calls without matching results and results whose
calls are absent; it also drops assistant messages left with reasoning alone. This
prevents an invalid partial tool exchange from reaching the reviewer adapter.

Tool-call IDs must match Anthropic's `[A-Za-z0-9_-]+` constraint. The history
sanitizer maps illegal IDs deterministically, reserving legal IDs first so existing
legal IDs are never renamed. It applies the same mapping to the assistant call ID,
`toolCallId`, and `source.callId`. When repair changes an assistant message, it also
drops `source.replayState`, so provider-native replay cannot restore the original
calls or IDs instead of the repaired content.

Failed reviewer calls still return their original readable feedback. A root-level
`tools/post-execute` listener returns `{ kind: 'block', feedback }`, which makes the
tool result an error without adding an `Error: ` prefix or changing the displayed
text. This history sanitizer is defense-in-depth alongside the adapter-level
`dsh-plugin-subscriptions` v0.9.6 `toAnthropicMessages` fix.

## Verification

```bash
bash scripts/link-deps.sh   # after any npm install; resolves the dsh path dynamically
npm run build               # tsc (host) + esbuild (client bundle)
npx vitest run              # 53 upstream tests
node test/compat-0.2.cjs    # 18 fork assertions: inject, remote catalog, slots, module id,
                            # source kind, dead files, scope, form projection
```

`scripts/link-deps.sh` was changed to derive the official package directory from
`readlink -f "$(command -v dsh)"` instead of the hardcoded Homebrew path, and to
link `dsh-client-ui-slots` locally when the CLI ships it (0.2 does) instead of
always pulling it from npm.

Known gap: `npm run build` also runs `tsc -p tsconfig.build.json`, which needs
the `@deepseek-ai` types linked; run `link-deps.sh` first (and again after any
`npm install`, which clears the links).
