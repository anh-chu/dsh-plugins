# dsh-plugins

Personal DeepSeek Harness plugins by [anh-chu](https://github.com/anh-chu).

Monorepo of locally-authored DSH web-profile plugins. Each subfolder is an independent DSH bundle installable via `file:` dependency.

## Plugins

### dsh-advisor-plugin (`./dsh-advisor-plugin`, package `dsh-advisor-plugin` v0.2.6-local.1)
Fork snapshot of [leeyoung1/dsh-advisor-plugin](https://github.com/leeyoung1/dsh-advisor-plugin) 0.2.6 (MIT, tag `v0.2.6`) ported to DSH 0.2.0-rc.2. Upstream targets 0.1.5-rc.x, and on 0.2 its browser half can never activate for two independent reasons: the client `inject` lists `settingsScope` and `conversationEvents`, both removed in 0.2, and an unsatisfiable `inject` parks the whole entry in `pending`; and the client bundle hardcodes its module id to the host half's internal name `dsh-advisor` where the loader resolves by package name `dsh-advisor-plugin`, so the module cannot be materialized. Either one alone produces the bare `web boot: 1 entry did not activate` with no plugin error that a page reload showed. Fixes: `inject` narrowed to `['slots','locale','connection']`; the module id derived from `package.json` instead of hardcoded; the settings card moved from `settingsScope.bind({namespace})` + `settings.plugin.item` to `configForms.get('advisor')` + `settings.plugins.tab` (resolved through a swappable scope, since either service may arrive after `apply()`); every registration contained so a mismatch costs one card; the patrol conversation card dropped (0.2 has no event-based transport — `conversationEvents` is gone, `KNOWN_SESSION_EVENT_TYPES` excludes plugin events by construction, and `append` cannot set the `ignorable` marker its own type would need); the host half stopped writing `hook/invoked`, which 0.2's hooks subsystem now owns with a mandatory payload schema (`turn`/`point`/`dialect`/`handlerId`); and two further host drifts `tsc` surfaced — tool results are now a `role: 'tool'` message rather than a `tool-result` content block, and user-context sources must self-declare their `kind` instead of the removed catch-all `'plugin'`. Peer ranges widened to `>=0.1.5-rc.1`, so no version exemption is needed. `src/` + `tests/` included; rebuild with `bash scripts/link-deps.sh && npm run build`. See [COMPAT-0.2.0.md](./dsh-advisor-plugin/COMPAT-0.2.0.md) and `node test/compat-0.2.cjs` (11 assertions).

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
Fork snapshot of [SpookySandwich/dsh-plugin-message-edit](https://github.com/SpookySandwich/dsh-plugin-message-edit) 1.1.0 (MIT) with two fixes so the browser half boots on DSH 0.1.7-rc.2: (1) the client's hard `sessions.open` requirement is polyfilled from `ctx.uiWorkspace.openSession` (0.1.7 dropped `open` from the client `sessions` service), and (2) `uiWorkspace` is declared in the plugin's client `inject` list — the 0.1.7 client runtime fails an entry that touches an undeclared service, which is what produced the bare `web boot: 1 entry did not activate / dsh-plugin-message-edit: failed` with no console message. Install this folder, not the npm package. pnpm hard-links the folder into the profile, so repo edits and `git checkout` here also change the installed copy. See [COMPAT-0.1.7.md](./dsh-plugin-message-edit/COMPAT-0.1.7.md) and `node test/compat-0.1.7.cjs` (9 assertions).

## Install

In `~/.dsh/profiles/web/package.json`:

```json
{
  "dependencies": {
    "dsh-wenlan": "file:/path/to/dsh-plugins/dsh-wenlan",
    "dsh-session-model-badge": "file:/path/to/dsh-plugins/dsh-session-model-badge",
    "dsh-wiki-viewer": "file:/path/to/dsh-plugins/dsh-wiki-viewer",
    "dsh-plugin-message-edit": "file:/path/to/dsh-plugins/dsh-plugin-message-edit"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "dsh-wenlan",
        "dsh-session-model-badge",
        "dsh-wiki-viewer",
        "dsh-plugin-message-edit"
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

## MCP servers

These plugins configure 2 MCP clients (both via `@deepseek-ai/dsh-mcp-client`):

- `wenlan` (from `dsh-wenlan` bundle)
- `mobbin` (user web-profile patch, not in this repo): stdio `mcp-remote https://api.mobbin.com/mcp`

## License

No license specified yet.
