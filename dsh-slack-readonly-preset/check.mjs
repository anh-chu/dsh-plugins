// Runnable check: the read-only allowlist decides reads from writes, `apply`
// registers both layers, and a rejected `restrict` filter cannot drop
// enforcement. No Host and no DSH services are needed — `apply` is driven with
// a fake context that records what it registers.
import assert from "node:assert/strict";
import { apply, allowedTool, denyReason, inject, name } from "./slack-readonly-guard.mjs";

// The Cordis loader contract for a plugin module.
assert.equal(name, "slack-readonly-guard");
assert.deepEqual(inject, ["tools"], "the tools service is the only dependency");

// Reads and searches pass.
for (const tool of [
	"read",
	"read_image",
	"glob",
	"grep",
	"web_search",
	"ask_user_question",
	"context_status",
	"compact_now",
	"mnemosyne_recall",
	"mcp_search_tools",
	"mcp_describe_tool",
	"mcp_execute_tool",
	"mcp__slack__conversations_history",
	"mcp__slack__conversations_replies"
]) {
	assert.ok(allowedTool(tool), `${tool} is allowed`);
}

// Every mutation, Host-state change and escalation path is denied, and the
// denial names the tool so the model can report what it could not do.
for (const tool of [
	"write",
	"edit",
	"str_replace_editor",
	"bash",
	"pwsh",
	"terminal",
	"web_fetch",
	"notepad_write",
	"notepad_read",
	"plugin_manager",
	"schedule_create",
	"schedule_update",
	"schedule_delete",
	"session_send",
	"session_messages",
	"rename_session",
	"create_goal",
	"update_goal",
	"todo_write",
	"present",
	"render_ui",
	"dsh_im_return_file",
	"subagent",
	"subagent_fork",
	"workflow",
	"mnemosyne_remember",
	"mnemosyne_forget",
	"mnemosyne_sleep"
]) {
	assert.ok(!allowedTool(tool), `${tool} is denied`);
	const reason = denyReason(tool);
	assert.ok(reason.includes(tool), `the denial names ${tool}`);
	assert.ok(reason.length > 40, "the denial explains itself instead of failing silently");
}

// An empty or unknown name must not slip through the prefix test.
assert.ok(!allowedTool(""), "an empty name is denied");
assert.ok(!allowedTool(undefined), "a missing name is denied");

function register({ restrictThrows = false } = {}) {
	const calls = { restrict: null, guard: null, effects: 0, warnings: [] };
	const ctx = {
		effect: (callback) => {
			calls.effects += 1;
			return callback();
		},
		logger: { warn: (...args) => calls.warnings.push(args) },
		tools: {
			restrict: (filter) => {
				if (restrictThrows) throw new Error("unknown or scope-local tool name");
				calls.restrict = filter;
				return () => {};
			},
			guard: (check) => {
				calls.guard = check;
				return () => {};
			}
		}
	};
	apply(ctx);
	return calls;
}

const mounted = register();
assert.equal(mounted.effects, 2, "one effect per layer, so both dispose with the preset");
assert.ok(mounted.restrict?.allow, "restrict is registered with an allow filter");
assert.ok(mounted.guard, "guard is registered");
assert.equal(mounted.guard({ name: "read" }), undefined, "the guard allows a read");
assert.equal(mounted.guard({ name: "mcp_execute_tool" }), undefined, "the guard allows the MCP broker");
assert.ok(String(mounted.guard({ name: "notepad_write" })).includes("notepad_write"), "the guard denies a write");

// Invariant: a tool the model can still see must also be callable. Otherwise the
// model would be shown a schema that every call gets denied on.
for (const tool of mounted.restrict.allow) {
	assert.ok(allowedTool(tool), `${tool} is both visible and allowed`);
}
assert.equal(
	new Set(mounted.restrict.allow).size,
	mounted.restrict.allow.length,
	"no duplicate entries in the allow filter"
);

// restrict is declared best-effort. When the Host rejects it (a name that is not
// a global tool, e.g. after a profile change), the guard must still enforce.
const degraded = register({ restrictThrows: true });
assert.equal(degraded.warnings.length, 1, "the rejected filter is logged");
assert.ok(
	String(degraded.guard({ name: "plugin_manager" })).includes("plugin_manager"),
	"the guard still denies after a rejected restrict"
);

console.log("ok: allowlist splits reads from writes, both layers register, a rejected restrict still enforces");
