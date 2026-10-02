# dsh-plugins

Personal DeepSeek Harness plugins by [anh-chu](https://github.com/anh-chu).

Monorepo of locally-authored DSH web-profile plugins. Each subfolder is an independent DSH bundle installable via `file:` dependency.

## Plugins

### dsh-advisor-plugin (`./dsh-advisor-plugin`, package `dsh-advisor-plugin` v0.2.6-local.1)
Fork snapshot of [leeyoung1/dsh-advisor-plugin](https://github.com/leeyoung1/dsh-advisor-plugin) 0.2.6 (MIT, tag `v0.2.6`) ported to DSH 0.2.0-rc.2. Upstream targets 0.1.5-rc.x, and on 0.2 its browser half can never activate for two independent reasons: the client `inject` lists `settingsScope` and `conversationEvents`, both removed in 0.2, and an unsatisfiable `inject` parks the whole entry in `pending`; and the client bundle hardcodes its module id to the host half's internal name `dsh-advisor` where the loader resolves by package name `dsh-advisor-plugin`, so the module cannot be materialized. Either one alone produces the bare `web boot: 1 entry did not activate` with no plugin error that a page reload showed. Fixes: `inject` narrowed to `['slots','locale','connection']`; the module id derived from `package.json` instead of hardcoded; the settings card moved from `settingsScope.bind({namespace})` + `settings.plugin.item` to `configForms.get('advisor')` + `settings.plugins.tab` (resolved through a swappable scope, since either service may arrive after `apply()`); every registration contained so a mismatch costs one card; the patrol conversation card dropped (0.2 has no event-based transport — `conversationEvents` is gone, `KNOWN_SESSION_EVENT_TYPES` excludes plugin events by construction, and `append` cannot set the `ignorable` marker its own type would need); the model catalog moved from `connection.api.llm.models({})` to the 0.2 Host Remote `ctx.remote.session.modelCatalog()` (the same source the composer's model selector reads); every Config field is marked `.volatile()`, which 0.2's settings document requires before it will accept a write (upstream had none, so every card Save was refused), with `resolveConfig()` unwrapping the `.get()` references volatile fields parse into and a `settings/document-updated` subscription so saving re-arms without a restart; the host half stopped writing `hook/invoked`, which 0.2's hooks subsystem now owns with a mandatory payload schema (`turn`/`point`/`dialect`/`handlerId`); and two further host drifts `tsc` surfaced — tool results are now a `role: 'tool'` message rather than a `tool-result` content block, and user-context sources must self-declare their `kind` instead of the removed catch-all `'plugin'`. Peer ranges widened to `>=0.1.5-rc.1`, so no version exemption is needed. and the reviewer payload is repaired before it is sent — unanswered tool-call blocks are cut at a settled boundary, tool-call ids are sanitized to Anthropic's `[a-zA-Z0-9_-]` charset as defense-in-depth behind the adapter-level fix, and a failed reviewer call is now marked `isError` instead of returning as a successful result. `src/` + `tests/` included; rebuild with `bash scripts/link-deps.sh && npm run build`. Rebuilding `lib/` does NOT update the installed copy — pnpm's hard links break on any rewrite — so diff `lib/` against `~/.dsh/profiles/web/node_modules/dsh-advisor-plugin/lib/` and copy it over before restarting `dsh web`. See [COMPAT-0.2.0.md](./dsh-advisor-plugin/COMPAT-0.2.0.md) and `node test/compat-0.2.cjs` (18 assertions).

### dsh-wenlan (`./dsh-wenlan` v0.1.0-local.1)
Local Wenlan MCP integration bundle. Connects DSH to the running Wenlan MCP server over stdio, exposing `mcp__wenlan__*` tools plus `/capture`, `/recall`, `/brief`, `/distill`, `/pages`, `/lint`, `/curate` commands. Does not replace `dsh-mneme`.

Also configures MCP server `wenlan` via `@deepseek-ai/dsh-mcp-client` (stdio `node mcp-readonly-proxy.js`).

### dsh-session-model-badge (`./dsh-session-model-badge` v0.1.0)
Shows the model(s) used in the current session (main or subagent) in the conversation header.

### dsh-wiki-viewer (`./dsh-wiki-viewer` v0.1.0)
Minimal DSH Web Sidebar wiki viewer integration. Its Settings → Plugins card shows the installed vs latest wiki-viewer release with an update button.

### dsh-claude-billing-header (`./dsh-claude-billing-header` v0.1.0)
Host fetch patch replicating the routing-critical part of `pi-claude-oauth-adapter`: prepends `x-anthropic-billing-header` as `system[0]` on Anthropic OAuth messages calls so subscription usage bills to the plan quota instead of metered extra usage. No-op for API-key calls and when the header is already present.

### dsh-mobile-harden (`./dsh-mobile-harden` v0.1.0)
Mobile hardening for the DSH web UI (touch layouts only, desktop untouched): Enter inserts a newline in the composer instead of sending; viewport pinned to `maximum-scale=1, user-scalable=no` plus `touch-action: manipulation` kills tap/focus/double-tap zoom; text selection and long-press callout blocked on app chrome but kept in messages and fields; composer autofocus on session switch is dropped so the keyboard stays away; tapping a session closes the narrow overlay sidebar. Requires `inject: ["webServer"]` on the Host half — without it the row can apply before the service exists and the viewport tap silently never registers.

### dsh-opencode2dsh (`./dsh-opencode2dsh`, package `@opencode2dsh/dsh-plugin` v0.3.3)
Fork snapshot of [FishBottle7/opencode2dsh](https://github.com/FishBottle7/opencode2dsh) (codeOct PR #25 branch) with local fixes for DSH 0.1.7: client calls `ctx.slots.inject` as a method with a plain callback (the detached generator call failed web boot); `muse-spark-*` requests use nested `reasoning: { effort }` and omit the field when Off; Zen bearer key resolves from `zenApiKey` config → `OPENCODE_ZEN_API_KEY` env → the OpenCode CLI login (`~/.local/share/opencode/auth.json`) → anonymous `public`, so metered use bills to the account quota instead of the shared per-IP bucket. `src/` + `test/` included; rebuild with `pnpm install && pnpm build && pnpm build:client`.

### dsh-plugin-message-edit (`./dsh-plugin-message-edit`, package `dsh-plugin-message-edit` v1.1.0-local.1)
Fork snapshot of [SpookySandwich/dsh-plugin-message-edit](https://github.com/SpookySandwich/dsh-plugin-message-edit) 1.1.0 (MIT) with two fixes so the browser half boots on DSH 0.1.7-rc.2: (1) the client's hard `sessions.open` requirement is polyfilled from `ctx.uiWorkspace.openSession` (0.1.7 dropped `open` from the client `sessions` service), and (2) `uiWorkspace` is declared in the plugin's client `inject` list — the 0.1.7 client runtime fails an entry that touches an undeclared service, which is what produced the bare `web boot: 1 entry did not activate / dsh-plugin-message-edit: failed` with no console message. Install this folder, not the npm package. Deployment caveat: pnpm hard-links files at install time, so untouched files share an inode with the installed copy, but any edit that rewrites a file — and especially an `rm -rf lib && npm run build` — breaks that link and silently leaves `~/.dsh/profiles/web/node_modules/dsh-plugin-message-edit/` stale. Diff the two copies and deploy explicitly; do not rely on the link. See [COMPAT-0.1.7.md](./dsh-plugin-message-edit/COMPAT-0.1.7.md) and `node test/compat-0.1.7.cjs` (9 assertions).

### dsh-bridge (`./dsh-bridge`, package `dsh-bridge` v0.1.0-rc.17-local.1)
Fork snapshot of [baixianger/dsh-bridge](https://github.com/baixianger/dsh-bridge) 0.1.0-rc.17 (MIT, tag `v0.1.0-rc.17`) with two fixes. First, its `session_send` delivered `source: { kind: "plugin", plugin: name, form: "relay" }`, and DSH 0.2's session format v4 refuses the removed catch-all kind outright — `assertV4MessageSources` in `dsh-session-format-v3-to-v4` throws `format v4 message requires a producer-owned source kind` on the admission path, so every delivery failed to append and the target session could not be saved or exported (upstream [issue #4](https://github.com/baixianger/dsh-bridge/issues/4), still open). `session_list` and `session_messages` kept working, which is why the breakage looked like a silent no-op on send. The fix declares the plugin's own kind (`kind: name`) and drops the legacy `plugin` field. Second, the `session_send` description now says it is "Not for communication between a parent session and its subagents, in either direction; use send_message for that". That failure was observed: a spawned reviewer holding both tools, with no reporting channel named in its prompt, chose `session_send` to answer its parent, the delivery was accepted, and the parent's turn died on the same admission check — the report never entered the conversation while the sender saw success. The wording steers the choice; it blocks nothing. Keeps the same three tools — `session_list` / `session_send` / `session_messages` — and remains host-only. Peer ranges already admitted 0.2 (`>=0.1.0-rc.5`), so no version exemption is needed. Install this folder, not the npm package. pnpm hard-links at install time — untouched files here still share an inode with the installed copy — but an edit that rewrites a file breaks that link, so `lib/index.js` here and in `~/.dsh/profiles/web/node_modules/dsh-bridge/` can be separate inodes with link count 1. Apply a change to both copies and `diff` them; do not rely on the link. Quick check: `bash scripts/link-deps.sh && node test/compat-0.2.cjs` (5 assertions; the third is a negative control proving the host validator still rejects the old shape, and `node --test test/bridge.test.mjs` keeps upstream's 19 green). Drop the fork when upstream closes #4.

### dsh-linear-panel (`./dsh-linear-panel`, package `@local/dsh-linear` v1.0.1)
Linear tab for the DSH right sidebar, written from scratch for 0.2 rather than forked from [Uddoo/dsh-dashboard](https://github.com/Uddoo/dsh-dashboard): that project pins every `@deepseek-ai/dsh*` peer to `>=0.1.0-rc.5 <0.2.0`, so the version gate rejects it outright, and porting its six-provider orchestrator across the 0.1→0.2 client-service, slot, remote and settings drift costs far more than building the Linear-only view. The Host half registers one same-origin route, `/dsh-linear`, that proxies Linear's GraphQL API with the personal API key read from the `linear` CLI's `~/.config/linear/credentials.toml` (`LINEAR_API_KEY` / `LINEAR_CREDENTIALS_FILE` override it); the key never reaches the browser, and the handler refuses non-POST, cross-origin and oversized bodies. The Client half registers a tab type through `ctx.betterSidebar.registerTab` (dsh-better-sidebar's public service, so the panel lives in the right sidebar's `+` menu): issue list with team filter, search through the live `searchIssues(term:)` endpoint plus a fuzzy pass (substring + subsequence) over server hits and the 50 most recent team-filtered issues, and a detail pane whose status/priority/assignee/comment actions call `issueUpdate` / `commentCreate` and patch both panes from the returned payload. Descriptions and comments render a markdown subset — headings, fenced code, quotes, lists with `- [ ]` checkboxes, links, images, bare-URL autolinks and `SEE-123` keys linked through `organization.urlKey` — always as React elements, so no HTML string is ever injected and only `http(s)` hrefs survive. Everything styles through `--dsw-alias-*` theme tokens; no Harness Client package is imported. Three framework-free runnable gates: `node check.mjs` (8 — module id vs package name, patch row, client inject packages, syntax), `node live-check.mjs` (16 — every query and mutation signature against the real API; mutations fire only at a well-formed non-existent id, so nothing is written), `node md-test.mjs` (28 — loads the shipped `client.js` under a stub module loader and asserts the renderer's element tree plus the fuzzy scorer). Install this folder, not an npm package. Two limits are deliberate and commented in the source: the fuzzy pass sees only server hits and the 50 most recent issues, and the markdown renderer has no nested lists or tables (upgrade path is a real markdown library declared in `dsh.client.external`). Live-install caveat: pnpm links this folder, so edits reach the installed copy, but reinstalling the bundle while the previously loaded host module generation is still cached makes activation fail with `webserver: duplicate exact route "/dsh-linear"` — the route keeps serving from the loaded generation, and a harness restart clears the failed row.

## Install

In `~/.dsh/profiles/web/package.json`:

```json
{
  "dependencies": {
    "dsh-wenlan": "file:/path/to/dsh-plugins/dsh-wenlan",
    "dsh-session-model-badge": "file:/path/to/dsh-plugins/dsh-session-model-badge",
    "dsh-wiki-viewer": "file:/path/to/dsh-plugins/dsh-wiki-viewer",
    "dsh-plugin-message-edit": "file:/path/to/dsh-plugins/dsh-plugin-message-edit",
    "@local/dsh-linear": "file:/path/to/dsh-plugins/dsh-linear-panel"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "dsh-wenlan",
        "dsh-session-model-badge",
        "dsh-wiki-viewer",
        "dsh-plugin-message-edit",
        "@local/dsh-linear"
      ]
    }
  }
}
```

Note: `dsh-wenlan/cordis.patch.yml` contains absolute local paths (`/home/sil/...`). Adjust `command` and `args` to your machine before use.

## Patches (third-party fixes, pnpm `patchedDependencies` pattern)

### `patches/dsh-better-sidebar-relative-path/`
Fixes inline tool file preview 400s in `dsh-better-sidebar` 0.19.1 (still broken
in 0.21.1): `/sidebar/file` rejected workspace-relative paths with
`"..." is not an absolute path` even though `cwd` rode along in the query.
`ensureWorkspacePath` now resolves relative targets against `cwd`; the
realpath + `isWithin` fence still blocks escapes (403). See the folder README
for install. Already applied to the live web profile.

## Skills

Global agent skills that belong with the plugins they explain. DSH loads them from
`~/.dsh/skills/`, so link the repo copy in and keep this repo the single source of truth:

```sh
ln -s /home/sil/dsh-plugins/skills/dsh-plugin-compat ~/.dsh/skills/dsh-plugin-compat
```

### `skills/dsh-plugin-compat`
Triage skill for a DSH plugin that fails to load or activate: `<package>: failed` on the boot
card, `web boot: N entry did not activate`, a blank or stuck boot screen, a plugin that broke
after a DSH upgrade, or a third-party plugin that needs patching/vendoring. It carries the
causes worth checking first (an undeclared `inject` service, service/API drift, bundle-snapshot
timing), the throwaway-profile + CDP-browser method for capturing the error the frontend never
prints, and `scripts/compat-probe.mjs`, the probe that does it. Written from the 0.1.7
`dsh-plugin-message-edit` debug — see that folder's `COMPAT-0.1.7.md` for the worked example.

## MCP servers

These plugins configure 2 MCP clients (both via `@deepseek-ai/dsh-mcp-client`):

- `wenlan` (from `dsh-wenlan` bundle)
- `mobbin` (user web-profile patch, not in this repo): stdio `mcp-remote https://api.mobbin.com/mcp`

## License

No license specified yet.
