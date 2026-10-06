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

On DSH 0.2 the card registers in `settings.plugins.tab` as well as the legacy `settings.plugin.item` slot, because the 0.1 key is now a silent no-op rather than an error — the card simply never appeared. When the managed root turns out to be a source checkout with no production build, both the open error and the card name the real remedy (`pnpm install && pnpm build` in the checkout) instead of pointing at an installer that deliberately refuses to overwrite a `.git` tree.

The bundle has no dependencies of its own, so it links into the profile without a `node_modules` of its own; the 0.1-era host-side `settings.register` (which was the only reason for a `@deepseek-ai/schemastery` dependency) is gone, since 0.2 removed that face and the client's slot registration is what serves the card.

The proxy also lets the wiki's `/api/assets/_p/<token>/…` preview-asset paths past the harness Host/Origin fence and this plugin's grant gate. A sandboxed HTML preview has a transient origin, so a nested frame or a scripted `fetch` from it carries no session cookie and no grant, and the harness fence rejects exactly those markers (`sec-fetch-site: cross-site`, `Origin: null`) with `403 forbidden` before the wiki is consulted. The wiki's own short-lived, directory-scoped token authorizes those reads, so the gates step aside for that path only and the wiki answers `403` for anything invalid. These requests carry no grant to look a port up from, so the handler proxies them to the viewer captured at the last `prepare`.

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
Linear tab for the DSH right sidebar, written from scratch for 0.2 rather than forked from [Uddoo/dsh-dashboard](https://github.com/Uddoo/dsh-dashboard): that project pins every `@deepseek-ai/dsh*` peer to `>=0.1.0-rc.5 <0.2.0`, so the version gate rejects it outright, and porting its six-provider orchestrator across the 0.1→0.2 client-service, slot, remote and settings drift costs far more than building the Linear-only view. The Host half registers one same-origin route, `/dsh-linear`, that proxies Linear's GraphQL API with the personal API key read from the `linear` CLI's `~/.config/linear/credentials.toml` (`LINEAR_API_KEY` / `LINEAR_CREDENTIALS_FILE` override it); the key never reaches the browser, and the handler refuses non-POST, cross-origin and oversized bodies. The Client half registers a tab type through `ctx.betterSidebar.registerTab` (dsh-better-sidebar's public service, so the panel lives in the right sidebar's `+` menu): issue list with team filter, search through the live `searchIssues(term:)` endpoint plus a fuzzy pass (substring + subsequence) over server hits and the 50 most recent team-filtered issues, and a detail pane whose status/priority/assignee/comment actions call `issueUpdate` / `commentCreate` and patch both panes from the returned payload. Sub-issue structure is visible: the browse list filters `parent: { null: true }` so children nest under their parent instead of appearing as peers, list rows carry a `done/total` sub-issue badge, and the detail pane shows a clickable parent breadcrumb above the title plus a Sub-issues section whose rows open in place — search stays flat, so a sub-issue is still findable by name. Descriptions and comments render a markdown subset — headings, fenced code, quotes, lists with `- [ ]` checkboxes, links, images, bare-URL autolinks and `SEE-123` keys linked through `organization.urlKey` — always as React elements, so no HTML string is ever injected and only `http(s)` hrefs survive. Everything styles through `--dsw-alias-*` theme tokens; no Harness Client package is imported. Three framework-free runnable gates: `node check.mjs` (8 — module id vs package name, patch row, client inject packages, syntax), `node live-check.mjs` (16 — every query and mutation signature against the real API; mutations fire only at a well-formed non-existent id, so nothing is written), `node md-test.mjs` (28 — loads the shipped `client.js` under a stub module loader and asserts the renderer's element tree plus the fuzzy scorer). Install this folder, not an npm package. Two limits are deliberate and commented in the source: the fuzzy pass sees only server hits and the 50 most recent issues, and the markdown renderer has no nested lists or tables (upgrade path is a real markdown library declared in `dsh.client.external`). Live-install caveat: pnpm links this folder, so edits reach the installed copy, but reinstalling the bundle while the previously loaded host module generation is still cached makes activation fail with `webserver: duplicate exact route "/dsh-linear"` — the route keeps serving from the loaded generation, and a harness restart clears the failed row.

### dsh-prompt-english (`./dsh-prompt-english`, package `@local/dsh-prompt-english` v1.0.0)
Host-only plugin that keeps model-facing system-prompt sections in English. It hooks the `system-prompt/assemble` waterfall — the last point before a prompt is sent — rewrites the text of the sections named in a small table (`genui:fence` → `genui-section.md`), and logs any *other* section still carrying CJK to `~/.dsh/logs/prompt-english.log`, deduped per process, so the next plugin that ships a Chinese prompt section is caught rather than quietly priming Chinese replies. Written because `@changfenhuang/dsh-genui` injects a mixed Chinese/English section (3,503 chars, 663 CJK) into every assembled system prompt and ships no language option, with nothing newer than 0.11.3 on npm. Matching by section **name** rather than by content is what survives an upstream rewrite of the wording; if upstream ever renames the section the swap silently stops applying and the Chinese returns — nothing is dropped either way. The plugin removes no context: `check.mjs` asserts the section count, names and order are unchanged and that `contexts`, `tools` and `variables` pass through untouched, that the output is byte-identical across five assemblies (a section that varied per turn would invalidate the provider's cached prefix every turn instead of once), and that the replacement contains no `{{variable}}` references, which the harness interpolates *after* this waterfall and throws on when unknown. Failure-isolated in both directions: an unreadable replacement file logs and leaves the section as-is, and a failed audit write is swallowed, so prompt assembly cannot break. Net prompt effect is +2,023 characters and roughly +8 tokens — Chinese costs about one token per character, so a CJK-heavy section is expensive per character and the English one is not. Run `node check.mjs`; activating it needs a `dsh web` restart, confirmed from the harness's own state with `plugin_manager list_plugins` (`include:prompt-english`, `fiberPhase: active`). Installed in this profile as `"@local/dsh-prompt-english": "link:/home/sil/dsh-plugins/dsh-prompt-english"`, so repo edits reach the installed copy directly.

### dsh-notepad (`./dsh-notepad`, package `dsh-notepad` v0.1.1)

Fork snapshot of [ICCuse/dsh-notepad](https://github.com/ICCuse/dsh-notepad) 0.1.1 (MIT) with three deliberate divergences. First, a **full English translation** of every comment, tool description, model-facing output string, UI label and README line; behaviour is unchanged and the only edited lines are comments and string literals. Second, a **system-prompt section** (`notepad:session`, order 1010) — upstream nudges the model in no way at all: the tools exist in the catalog but nothing says what the notepad is for or when to use it. The section states the use case, nudges both directions (write with `notepad_write` in append mode; read with `notepad_read` / `notepad_search` before answering anything about earlier work in the session), draws the boundary against long-term memory so it cannot contradict mnemosyne's own write nudge, and renders the current session page itself so what was recorded returns to context every turn without a read call. Only the newest `SECTION_MAX_BYTES` (2000) bytes are rendered, the trim is announced in the block, stored text cannot close the block early, and an agent-less assembly contributes nothing. Third, **the open Session is resolved for the frame-wide panel**: the panel sits in the root-scope `shell.overlay` seat, which receives no `sessionId`, and the 0.2 session-list snapshot has no `current` field, so upstream's `useSessions((s) => s.current)` always returned undefined and left the panel on the global page with its Session tab disabled while `notepad_write` wrote to the session page. A zero-render occupant of `conversation.input.left` (session scope) now publishes `props.sessionId` into a store the overlay panel subscribes to, and the panel opens on the session page. Fourth, **read-only inheritance for forked children** — a session carrying `session.header.parentSession` (set by `subagent_fork` and by session forks; a plain `subagent` spawn has no lineage and inherits nothing) also renders its parent's page in a separate `<parent-notepad readonly>` block, capped at `PARENT_SECTION_MAX_BYTES` (1200). The parent's session id is deliberately not disclosed, so the tools cannot address that page, and `notepad_write` refuses it as a target regardless (`parentWriteRefusal`); only one level of ancestry is visible, since reaching the grandparent would need a session lookup. Fifth, **`notepad_write` gained `mode=remove`** (delete every line containing `match`) with a standing instruction in the prompt block to prune finished notes, because `mode=replace` cannot prune safely while the injected block shows only the newest 2000 bytes of the page. The section registers through `ctx.inject(["systemPrompt"], …)` rather than a declarative dependency, so a host without that service still gets the tools. The runtime reads lineage as `session.header.parentSession` (the harness's own accessor, `dsh-api-session-controller/lib/index.js:128`) with the declared `session.meta` accepted as a fallback. Installed in this profile as `"dsh-notepad": "link:/home/sil/dsh-plugins/dsh-notepad"` — `link:` rather than `file:` because this fork is edited in place. Do not reinstall by npm name: `dsh plugin --profile web add dsh-notepad` would restore the upstream package and drop all three changes. Check: `node tests/section.test.mjs`.

### dsh-jev-opencode (`./dsh-jev-opencode` v0.1.0)

**Retained experiment — not mounted, and known not to be trustworthy.** This wrapper was mounted in the `standard-jev` preset and reverted on 2026-09-28. It works mechanically, but the judge is unstable: eight consecutive calls for the *same* question returned `noul` 1, 0.5, 0.5, 0.9, 1, 0.5, 1, so the verdict flips the pruning decision at random and does so silently — a wrong verdict is indistinguishable from a right one. The wrapper and its pilot are kept here for a future calibrated attempt, not because they are usable. `standard-jev` currently mounts plain `dsh-jev-prune` instead, which is itself inert on this machine because its `JevClient` needs a `TYPESAFE_API_KEY` that is not present, so it logs `未配置 TYPESAFE_API_KEY —— 插件已加载但不介入裁剪` and falls back to the size-based `tool-result-pruner`. Do not mount this expecting the semantic layers to work until the stability problem is solved.

Mounts [`dsh-jev-prune`](https://github.com/yangyu666/dsh-jev-prune) with an OpenCode Go model as its judge backend, so the semantic pruning layers work without a TypeSafe key. A wrapper is needed because `dsh-jev-prune` reads its verdicts from a `JevClient` whose replacement points — `deps.judge` (`index.js:568`) and `fetchImpl` (`jev.js:148`) — are function parameters, not config keys, and Cordis only ever calls `(ctx, config)`; nothing in `cordis.yml` can select a different backend. This package re-exports the plugin's own `Config` and forwards an OpenCode-backed judge into `deps.judge`, leaving the pruning logic untouched. `judge.mjs` handles two things the raw endpoint requires or gets wrong: OpenCode Go answers `400 MissingSessionID` without an `x-opencode-session` header, so a process-stable UUID is sent; and these models sometimes answer with a count (a `400` for a 400-line file) where a probability is expected, which `dsh-jev-prune` would accept because it tests only `Number.isFinite` (`jev.js:274`) and would then mis-rank pruning, so values are clamped to `(0,1)` here. `max_tokens` is 4000 because `deepseek-v4-flash` bills a long `reasoning_content` against the same budget and at 400 the budget was spent before `content` was written, returning an empty string. The **free Zen tier cannot be used**: `https://opencode.ai/zen/v1` answers `403 FreeTierError: OpenCode's free tier can only be used from within OpenCode`, so only the Go route serves external clients and the free models in the profile's `opencode` provider are not usable as a judge. Verification is `node check.mjs` (unit checks over clamping, parsing and transport against a fake fetch, no key needed) plus `node pilot.mjs` (5 live runs × 5 questions); the pilot saw 25/25 values in range with none at a boundary, max run-to-run spread 0.20, and semantically correct ordering (the test-failure result scored 0.02–0.05 and must not prune, the duplicated read 0.95–0.99) — but that pilot measured *range* and *ordering across distinct questions*, not *repeatability*, and repeatability is what failed (see the status note above). A pilot is not a calibration study: `keepThreshold: 0.5` is only as good as the probabilities behind it, and these probabilities are not yet stable enough to rank on. Install with `dsh plugin --profile web add file:/home/sil/dsh-plugins/dsh-jev-opencode`, then mount it **in place of** `dsh-jev-prune` in `~/.dsh/.agent-presets/standard-jev/agent.cordis.yml` inside the existing `compaction` isolate group (`- id: jev-prune`, `name: dsh-jev-opencode`), and restart the DSH host; confirm with the `jev_prune_status` tool and the host log's `[jev-opencode] judging via …` line. There is deliberately no `cordis.patch.yml` — the patch row it supersedes is already disabled. `package.json` records `testedAgainst: @deepseek-ai/dsh@0.1.5-rc.2`; it has not been re-verified on 0.2.0-rc.2.

### dsh-slack-readonly-preset (`./dsh-slack-readonly-preset`, package `@local/dsh-slack-readonly-preset` v1.0.1)

Agent preset `slack-readonly` plus the guard plugin that makes it true, written for a `dsh-im` Slack bot that answers team questions and must not change anything. The preset registers reads only — `persona` (states the limits and the answering discipline), `tool-fs`, `tool-fs-search`, `tool-ask-user`, `tool-web` with `fetch: false`, and the standard `compaction` group — and then `slack-readonly-guard` closes the hole a preset's plugin list cannot close: tools that HOST plugins register (`notepad_write`, `mnemosyne_remember`, `schedule_create`, `plugin_manager`, the MCP broker, ...) reach every preset, so the guard calls `tools.restrict({ allow })` to hide the non-allowlisted global ones and `tools.guard(...)` to deny at dispatch, both from the preset's own scope. `tool-fs` is kept deliberately: it registers `read` together with `write` and `edit` as one suite with no config to split them, and the guard denies the two mutating tools, which buys whole-file reads for a question-answering bot at the cost of showing the model two schemas it can never call. Neither a preset-level `sandbox-policy` row nor `tools.restrict` can be the enforcement path — `permission-presets` writes the profile default (`danger-full-access` here) into every new session as a session override, and a preset row's policy is only the fallback beneath it, while `restrict` is best-effort because it rejects a name that is scope-local or absent. The guard is what holds, and `check.mjs` asserts exactly that by driving `apply()` with a fake context whose `restrict` throws. `web_fetch` is withheld on purpose: on this Host it reaches unauthenticated loopback endpoints, and a Slack user drives the bot. Ceiling: every `mcp_*` tool is allowed, so a second MCP server would be reachable too; narrow `MCP_PREFIX` to `mcp__slack__` if that matters.

**A preset's plugin list must reference a package subpath, never a relative path.** The first version used `./slack-readonly-guard.mjs`, anchored beside the bundle's patch file, and the row died as `read-only-guard (./slack-readonly-guard.mjs): never started`: the agent-preset registry re-mounts a preset with the declaring context's `baseUrl`, so a bundle-relative path does not carry over. One dead row is enough, because `mountPreset` audits its subtree and marks the whole preset `broken`, and callers that drop broken presets then hide it entirely — which is how this preset first appeared to be missing from the `dsh-im` Agent Preset dropdown, where only the four shipped presets were listed. The registry does log a warning when the mount throws, and there was none to find, because this failure happened in the audit rather than in the mount. Diagnose that class of failure by adding the bundle to a throwaway profile and logging `await ctx.agentPresets.list()` from a probe plugin: the returned rows carry the `broken` text no other surface shows. The guard is now `@local/dsh-slack-readonly-preset/guard`, declared in `exports`.

Run `node check.mjs`. Activating it needs the usual `dsh web` restart, then select **Slack read-only** in the bot card. Installed in this profile as `"@local/dsh-slack-readonly-preset": "link:/home/sil/dsh-plugins/dsh-slack-readonly-preset"`, so repo edits reach the installed copy directly.

## Install

Each subfolder is an independent bundle. In `~/.dsh/profiles/web/package.json`, the plugins that
are installed from this repo:

```json
{
  "dependencies": {
    "dsh-advisor-plugin": "file:/path/to/dsh-plugins/dsh-advisor-plugin",
    "dsh-bridge": "file:/path/to/dsh-plugins/dsh-bridge",
    "dsh-claude-billing-header": "file:/path/to/dsh-plugins/dsh-claude-billing-header",
    "dsh-mobile-harden": "file:/path/to/dsh-plugins/dsh-mobile-harden",
    "dsh-notepad": "link:/path/to/dsh-plugins/dsh-notepad",
    "dsh-plugin-message-edit": "file:/path/to/dsh-plugins/dsh-plugin-message-edit",
    "@local/dsh-linear": "link:/path/to/dsh-plugins/dsh-linear-panel",
    "@local/dsh-prompt-english": "link:/path/to/dsh-plugins/dsh-prompt-english",
    "@local/dsh-slack-readonly-preset": "link:/path/to/dsh-plugins/dsh-slack-readonly-preset"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "dsh-advisor-plugin",
        "dsh-bridge",
        "dsh-claude-billing-header",
        "dsh-mobile-harden",
        "dsh-notepad",
        "dsh-plugin-message-edit",
        "@local/dsh-linear",
        "@local/dsh-prompt-english",
        "@local/dsh-slack-readonly-preset"
      ]
    }
  }
}
```

`file:` copies the folder into the profile — pnpm hard-links the files, so an edit that rewrites a
file breaks the link and leaves the installed copy stale with no signal, which is the deployment
caveat called out per-plugin above. `link:` symlinks the folder instead, so edits here are live;
the two `@local/*` packages use it for exactly that reason. Prefer `link:` for a folder you author
in this repo and `file:` for a fork you vendor.

### Installed, but not from this repo

Verified against the live profile on 2026-10-03:

| Package | Live specifier | Note |
| --- | --- | --- |
| `dsh-session-model-badge` | `file:/home/sil/dsh-session-model-badge` | duplicate copy outside the repo; the repo copy is byte-identical (`diff -rq`) |
| `dsh-wiki-viewer` | `file:/home/sil/guppi/dsh-wiki-viewer` | duplicate copy outside the repo; the repo copy is byte-identical |
| `@opencode2dsh/dsh-plugin` | `file:~/.dsh/dsh-plugins/opencode2dsh-dsh-plugin-0.3.3-pr25-fix5.tgz` | packed tarball, not the `dsh-opencode2dsh/` folder |
| `dsh-wenlan` | not a dependency | documented below and present in this repo, but not installed in this profile |

The two duplicate paths predate the monorepo and are the ones the profile actually loads. Pointing
them at the repo copies would make this repo the single source of truth, but it is a live-profile
change: it needs `pnpm install` (never mid-turn — it rewrites hoisted `node_modules` and can break
lazy imports until a restart) and then a `dsh web` restart.

Note: if you do install `dsh-wenlan`, its `cordis.patch.yml` contains absolute local paths (`/home/sil/...`). Adjust `command` and `args` to your machine before use.

## Patches (third-party fixes, pnpm `patchedDependencies` pattern)

### `patches/dsh-better-sidebar-relative-path/`
Fixes inline tool file preview 400s in `dsh-better-sidebar` 0.19.1 (still broken
in 0.21.1): `/sidebar/file` rejected workspace-relative paths with
`"..." is not an absolute path` even though `cwd` rode along in the query.
`ensureWorkspacePath` now resolves relative targets against `cwd`; the
realpath + `isWithin` fence still blocks escapes (403). See the folder README
for install. Already applied to the live web profile.

### `patches/dsh-opencode-session-unsupported-params/`
Fixes `dsh-opencode-session` 0.1.1 sessions failing with `400 unsupported_parameter` on
`prompt_cache_retention` for OpenCode Go models such as `glm-5.3-flash`, while DeepSeek models accept
it. The fetch wrapper learns per-model quirks: on a 400 naming an unsupported body field it drops the
field, retries, and remembers `(model, field)` in `~/.dsh/opencode-quirks.json` (no expiry). No
model names are hard-coded; optional `bodyRules` add static drop/keep rules. `node
test/unsupported-params.test.mjs` prints `all ok`. See the folder README. **Needs a `dsh web` restart.**

### `patches/dsh-mnemosyne-memoria-counts/`
Fixes `dsh-mnemosyne` 0.8.1 rendering its whole MEMORIA dashboard section as zeros:
Overview, Facts, Timelines, Instructions, KG and Preferences all report 0 and every tab plus Top
Sessions says "no data", however much the database holds (71 `memoria_facts` / 35 `memoria_instructions`
on the machine where this was found). The adapter's table allow-list omits all six `memoria_*` tables,
and its readers return 0/empty for anything outside the set — `count_rows()` is literally
`... if table in TABLES else 0`. One-line fix, no client changes needed. `node
test/memoria-counts.test.mjs` fails 11 of 17 assertions on unpatched 0.8.1 and passes with the patch.
See the folder README for install — **it needs a `dsh web` restart to take effect.**

### `patches/dsh-mnemosyne-workspace-fallback/`
Makes `dsh-mnemosyne` 0.8.1 workspace mode usable. Two scope-resolution defects made memory silently
disappear: an unbound target (`{mode:"unbound"}`) skips auto-capture writes and makes the pre-step
prefetch decline to inject, with nothing logged, and the bind flow refuses to bind `$HOME`, so a
`$HOME`-rooted session could never have memory at all; and identity was marker-only with no
inheritance, so every directory needed its own `.mnemosyne-id` and any directory without one was dead.
The patch makes unbound fall back to the shared pool, and auto-binds the enclosing **git repository**
keyed by its canonical path, so a project isolates itself without the plugin writing a marker into the
user's repo (an explicit marker still wins; the filesystem root and `os.tmpdir()` are refused, because a
stray `/tmp/.git` otherwise makes every scratch directory look like a project).
It also fixes the scope guidance: the system prompt told agents to use `scope=global` for anything that
must survive a session, so a project-only rule landed in the pool every project's recall injects. The
prompt and the tool description now key on who needs the fact (`workspace` for the current project,
`global` only for facts true everywhere), and `workspace` scope now works where no project is bound.
`node test/fallback-and-autobind.test.mjs` fails 12 of 17 assertions on upstream and passes 18 with the
patch. See the folder README for install — **it needs a `dsh web` restart to take effect.**

## Ops

### `ops/mnemosyne/`
A self-maintaining memory for `dsh-mnemosyne`. A daily systemd job backs up the store, consolidates
aged captures into model-written summaries (one per topic, not one per session), checks each summary
by rule, and hides redundant rows; a health check alarms when the job stops, a row count falls, or a
person's own message is hidden from recall; a monthly job re-asks a fixed question set and alarms on
a drop; any failure sends a phone alert through Home Assistant. **It adds, hides and demotes, and
never deletes.** The folder README has the install steps and the known limits; `docs/` has the
measurements and the faults found, with the engine source lines behind each decision.

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
