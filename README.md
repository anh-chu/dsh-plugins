# dsh-plugins

Personal DeepSeek Harness plugins by [anh-chu](https://github.com/anh-chu).

Monorepo of locally-authored DSH web-profile plugins. Each subfolder is an independent DSH bundle installable via `file:` dependency.

## Plugins

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

## Install

In `~/.dsh/profiles/web/package.json`:

```json
{
  "dependencies": {
    "dsh-wenlan": "file:/path/to/dsh-plugins/dsh-wenlan",
    "dsh-session-model-badge": "file:/path/to/dsh-plugins/dsh-session-model-badge",
    "dsh-wiki-viewer": "file:/path/to/dsh-plugins/dsh-wiki-viewer"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "dsh-wenlan",
        "dsh-session-model-badge",
        "dsh-wiki-viewer"
      ]
    }
  }
}
```

Note: `dsh-wenlan/cordis.patch.yml` contains absolute local paths (`/home/sil/...`). Adjust `command` and `args` to your machine before use.

## MCP servers

These plugins configure 2 MCP clients (both via `@deepseek-ai/dsh-mcp-client`):

- `wenlan` (from `dsh-wenlan` bundle)
- `mobbin` (user web-profile patch, not in this repo): stdio `mcp-remote https://api.mobbin.com/mcp`

## License

No license specified yet.
