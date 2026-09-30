# dsh-claude-billing-header

Host plugin for DeepSeek Harness. Injects the Claude Code billing-routing
header into Anthropic OAuth requests so subscription usage bills to the plan
quota instead of metered "extra usage".

Replicates the routing-critical part of
`pi-claude-oauth-adapter(-cache-safe)` for DSH, plus one DSH-specific fix
the Pi adapter never needed: `dsh-plugin-subscriptions` already sends the
CLI impersonation headers, `?beta=true`, and the identity system block.

## What it changes on the wire

Two changes, both scoped to `POST https://api.anthropic.com/v1/messages*`
with `Authorization: Bearer sk-ant-oat*`:

1. Prepends `system[0]` billing header (see format below). No-op when
   already present.
2. Withholds the flagging tool names from `tools` (configurable via
   `dropTools`, default `memory_get`, `mcp_describe_tool`,
   `mcp_execute_tool`, `mcp_search_tools`). Proven by wire bisection
   2026-09-30 against a captured 60-tool DSH agent body: Anthropic lanes a
   request to metered extra usage based on the tool NAMES it carries, not
   its size (renaming every tool, schemas untouched, stays in the plan
   lane). Two name families trip it and BOTH must be cleared — any one of
   the `mcp_*` meta-tools plus at least one `memory_*` tool. Dropping only
   `memory_get` (the previous default) is no longer sufficient because the
   `mcp_*` meta-tools arrived with DSH's MCP support. Set `dropTools: []`
   to disable.

```
x-anthropic-billing-header: cc_version=2.1.236.abc; cc_entrypoint=cli; cch=12345;
```

- Only `POST https://api.anthropic.com/v1/messages*` with
  `Authorization: Bearer sk-ant-oat*`.
- No-op when the header is already present, when there is no `system[]`,
  or for API-key / usage / models / token endpoints.
- Preserves every existing block and `cache_control` by value.
- `cc_version` defaults to live `claude --version` output (fallback
  `2.1.263`, same as the subscriptions plugin UA). Env
  `PI_CLAUDE_CODE_VERSION` / `CLAUDE_CODE_VERSION` overrides it.
- `cc_entrypoint` defaults to `cli`. Env `PI_CLAUDE_CODE_ENTRYPOINT` /
  `CLAUDE_CODE_ENTRYPOINT` overrides it.

Deliberately not replicated from Pi: identity-block removal (required here),
docs stripping (no Pi-docs concept in DSH), metadata/user-agent/beta edits.

## Install (web profile)

```json
// ~/.dsh/profiles/web/package.json
{
  "dependencies": {
    "dsh-claude-billing-header": "file:/home/sil/dsh-plugins/dsh-claude-billing-header"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "dsh-claude-billing-header"
      ]
    }
  }
}
```

Then reinstall and restart the profile so the host picks up the fetch patch.

## Verify

```bash
node tests/test.mjs
```

```bash
node -e "import('./lib/index.js').then(m => console.log(m.buildBillingHeader([{role:'user',content:'hello world, this is a test'}],'2.1.236','cli')))"
```

## Vetting other plugins (`vet-lane.mjs`)

The lane rule is name-based and Anthropic-side, so any plugin's tools can
trip it the same way mneme's pair did. The Pi adapter never handled this:
it only edits `system[]` and never touches `tools`, and Pi's own small
tool surface never registers a flagged pair.

If a Claude turn flips to extra usage again after installing a new plugin:

1. Set `captureFile: /home/sil/.dsh/claude-last-body.json` on the
   `claude-billing-header` row, restart, retry the failing turn.
2. Run `node vet-lane.mjs` (defaults to that capture). It replays the
   exact body with the header applied and ddmin-searches the tool list
   for the minimal flipping subset. Validated 2026-09-17: converged on
   `memory_get` + `memory_search` in 54 requests.
3. Add the offending name(s) to the row's `dropTools` list.
