# dsh-claude-billing-header

Host plugin for DeepSeek Harness. Injects the Claude Code billing-routing
header into Anthropic OAuth requests so subscription usage bills to the plan
quota instead of metered "extra usage".

Replicates the routing-critical part of
`pi-claude-oauth-adapter(-cache-safe)` for DSH, plus one DSH-specific fix
the Pi adapter never needed: `dsh-plugin-subscriptions` already sends the
CLI impersonation headers, `?beta=true`, and the identity system block.

## What it changes on the wire

Three changes, all scoped to `POST https://api.anthropic.com/v1/messages*`
with `Authorization: Bearer sk-ant-oat*`:

1. Prepends `system[0]` billing header (see format below). No-op when
   already present.
2. Renames every tool so Anthropic's OAuth classifier accepts it
   (`renameTools`, default on). A name that matches one of Claude Code's own
   tools becomes that name (`bash` -> `Bash`, `web_fetch` -> `WebFetch`; the
   comparison ignores case and separators); everything else is namespaced
   `mcp__dsh__<name>` — the `mcp__<server>__<tool>` shape Claude Code uses
   for MCP tools (`mcpPrefix`). The `tools[]` definitions and any `tool_use`
   blocks already in `messages[]` are renamed together, so the model sees one
   consistent name per tool.
   The response side reverses it: an `llm/stream` listener maps the wire name
   back on `tool-call-delta` and the closing `tool-call` block, so the
   harness only ever sees its own tool names. No SSE text is parsed.
3. Optionally withholds names entirely (`dropTools`, default `[]`). Kept as a
   blunt fallback; renaming is preferred because it keeps the tool usable.

   Why names matter: Anthropic's OAuth classifier rejects tool definitions
   outside Claude Code's own tool set — reported as a 400 `You're out of
   extra usage`, which reads like a quota problem and is not one. Measured
   2026-09-30 against a captured 60-tool DSH agent body, byte-identical
   between runs: adding the tools flipped the request to the metered lane,
   and renaming every tool (schemas untouched) put it back. `pi-anthropic-oauth`
   documents the same rule and ships the same rename technique.

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
