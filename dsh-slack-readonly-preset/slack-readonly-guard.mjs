/**
 * Read-only enforcement for the `slack-readonly` agent preset.
 *
 * Why this plugin exists: a preset's `plugins` list decides which tools the
 * preset registers, but it cannot remove tools that HOST plugins register
 * (`notepad_write`, `mnemosyne_remember`, `schedule_create`, `plugin_manager`,
 * the MCP broker, ...). Those reach every preset. Two scope-bound calls close
 * that hole:
 *
 *   tools.restrict({ allow }) - hides non-allowlisted GLOBAL tools so the model
 *                              never sees them. Best effort: every name must
 *                              already exist as a global tool, so a name that
 *                              is scope-local or absent throws, and the guard
 *                              below stays the enforcement layer.
 *   tools.guard(check)        - runs before dispatch for calls made by an agent
 *                              in this scope. A returned string denies the call
 *                              and is shown to the model as the reason.
 *
 * Both are issued from the preset's own scope, so they cover agents joined under
 * this preset and leave the rest of the Host untouched.
 *
 * The preset cannot pin the sandbox mode instead: `permission-presets` writes the
 * profile default (`danger-full-access` here) into every new session as a session
 * override, and a preset-level `sandbox-policy` row is only the fallback beneath
 * it. Restricting which tools exist is what actually holds.
 *
 * Ceiling: every `mcp_*` tool is allowed, because MCP tool names depend on which
 * servers are configured and the broker (`mcp_search_tools`, `mcp_execute_tool`)
 * carries them. Add another MCP server and its tools become reachable by this bot
 * too. Narrow MCP_PREFIX to `mcp__slack__` if that matters.
 */

export const name = 'slack-readonly-guard';

export const inject = ['tools'];

/** Tools this preset's agents may call. Everything else is denied. */
const ALLOWED = new Set([
  // Filesystem reads (scope-local, from tool-fs / tool-fs-search).
  'read',
  'read_image',
  'glob',
  'grep',
  // Web search only. web_fetch is deliberately not registered: on this Host it
  // can reach unauthenticated loopback endpoints, and a Slack user drives the bot.
  'web_search',
  // Ask the human.
  'ask_user_question',
  // Read-only session and memory inspection.
  'context_status',
  'compact_now',
  'mnemosyne_recall',
]);

/** MCP tools, including the broker that carries on-demand MCP calls. */
const MCP_PREFIX = 'mcp_';

/** Global tools to keep visible. Every name must exist globally, or `restrict` throws. */
const GLOBAL_ALLOW = [
  'ask_user_question',
  'compact_now',
  'context_status',
  'mnemosyne_recall',
  'mcp_search_tools',
  'mcp_describe_tool',
  'mcp_execute_tool',
];

const DENY_MESSAGE =
  'Denied by the slack-readonly preset: "%s" is not an allowed tool. This bot reads and searches; it must not modify files, run commands, or change Host state. Answer from what you can already see, or tell the user what you cannot do.';

/** True when an agent under this preset may call `tool`. */
export function allowedTool(tool) {
  const name = String(tool);
  return ALLOWED.has(name) || name.startsWith(MCP_PREFIX);
}

/** The reason shown to the model when `tool` is denied. */
export function denyReason(tool) {
  return DENY_MESSAGE.replace('%s', String(tool));
}

export function apply(ctx) {
  // Token hygiene, not enforcement: hide the global tools that are not on the
  // allowlist. `restrict` rejects unknown and scope-local names, so a profile
  // change could make this throw; the guard below is what actually enforces.
  ctx.effect(() => {
    try {
      return ctx.tools.restrict({ allow: GLOBAL_ALLOW });
    } catch (error) {
      ctx.logger?.warn?.(
        '[slack-readonly] tools.restrict was rejected (%s); the guard still enforces the allowlist',
        error?.message ?? String(error),
      );
      return undefined;
    }
  });

  ctx.effect(() =>
    ctx.tools.guard((exec) => (allowedTool(exec?.name ?? '') ? undefined : denyReason(exec?.name ?? ''))),
  );
}
