import assert from "node:assert/strict";
import {
  BILLING_PREFIX,
  CLAUDE_CODE_TOOL_NAMES,
  buildBillingHeader,
  dropToolsFromBody,
  ensureBillingHeader,
  firstUserText,
  fromWireToolName,
  isOAuthMessagesRequest,
  messageText,
  apply,
  patchFetch,
  renameBodyTools,
  resolveConfig,
  toWireToolName,
  unwireChunkToolName,
} from "../lib/index.js";

const PREFIX = "mcp__dsh__";
// The tool names a real DSH agent turn carried when this was measured.
const ALL_TOOL_NAMES = [
  "advanced_search", "ask_user_question", "bash", "cordis_inspect_list",
  "cordis_inspect_query", "create_goal", "create_skill", "edit",
  "exit_plan_mode", "find_dsh_plugin", "free_search_test", "get_goal", "glob",
  "grep", "interrupt_agent", "jev_ask", "jev_gate", "job_kill", "job_list",
  "job_output", "list_agents", "list_subagent_models", "mcp_describe_tool",
  "mcp_execute_tool", "mcp_search_tools", "memory_archive", "memory_delete",
  "memory_forget", "memory_get", "memory_list", "memory_register_document",
  "memory_runtime", "memory_save", "memory_search", "memory_update",
  "multi_search", "platform_search", "plugin_manager", "present", "read",
  "read_image", "send_message", "session_event_read", "session_event_search",
  "session_event_trace", "session_list", "session_messages", "session_search",
  "session_send", "session_trace", "sidebar_open", "skill", "subagent",
  "subagent_fork", "todo_write", "update_goal", "web_fetch", "web_search",
  "workflow", "write",
];

// 1. Header format matches the Pi adapter shape.
{
  const header = buildBillingHeader(
    [{ role: "user", content: "hello world, this is a test message!" }],
    "2.1.236",
    "cli",
  );
  assert.match(
    header,
    /^x-anthropic-billing-header: cc_version=2\.1\.236\.[0-9a-f]{3}; cc_entrypoint=cli; cch=[0-9a-f]{5};$/,
  );
}

// 2. Deterministic: same input, same header.
{
  const messages = [{ role: "user", content: [{ type: "text", text: "Reply with exactly: OK" }] }];
  assert.equal(buildBillingHeader(messages, "2.1.236", "cli"), buildBillingHeader(messages, "2.1.236", "cli"));
}

// 3. ensureBillingHeader unshifts exactly one block and preserves the rest.
{
  const body = {
    model: "claude-sonnet-4-6",
    system: [
      { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
      { type: "text", text: "DSH system prompt", cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: "hi there, testing billing routing" }],
  };
  const next = ensureBillingHeader(body, "2.1.236", "cli");
  assert.ok(next !== null);
  assert.equal(next.system.length, 3);
  assert.ok(next.system[0].text.startsWith(BILLING_PREFIX));
  assert.equal(next.system[1].text, body.system[0].text);
  assert.deepEqual(next.system[2].cache_control, { type: "ephemeral" });
  // Input untouched.
  assert.equal(body.system.length, 2);
}

// 4. No-op when the header is already present (cache-safe, no rewrite).
{
  const body = {
    model: "claude-sonnet-4-6",
    system: [{ type: "text", text: `${BILLING_PREFIX} cc_version=2.1.236.abc; cc_entrypoint=cli; cch=12345;` }],
    messages: [{ role: "user", content: "hi" }],
  };
  assert.equal(ensureBillingHeader(body, "2.1.236", "cli"), null);
}

// 5. No-op without a system array.
{
  assert.equal(ensureBillingHeader({ model: "x", messages: [] }, "2.1.236", "cli"), null);
}

// 6. Non-text / unknown system blocks pass through unchanged.
{
  const imageBlock = { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } };
  const body = { system: [imageBlock], messages: [{ role: "user", content: "hi there" }] };
  const next = ensureBillingHeader(body, "2.1.236", "cli");
  assert.ok(next !== null);
  assert.deepEqual(next.system[1], imageBlock);
}

// 7. Request matcher: OAuth messages only.
{
  const oauth = new Headers({ authorization: "Bearer sk-ant-oat01-abc" });
  const apiKey = new Headers({ "x-api-key": "sk-ant-api03-abc" });
  assert.equal(isOAuthMessagesRequest("https://api.anthropic.com/v1/messages?beta=true", oauth), true);
  assert.equal(isOAuthMessagesRequest("https://api.anthropic.com/v1/messages?beta=true", apiKey), false);
  assert.equal(isOAuthMessagesRequest("https://api.anthropic.com/api/oauth/usage", oauth), false);
}

// 8. Text extraction handles string, array, and non-text content.
{
  assert.equal(messageText("plain"), "plain");
  assert.equal(
    firstUserText([
      { role: "assistant", content: "skip me" },
      { role: "user", content: [{ type: "text", text: "a" }, { type: "image", source: {} }, { type: "text", text: "b" }] },
    ]),
    "a\nb",
  );
  assert.equal(firstUserText([]), "");
}

// 9. patchFetch emits injection events for OAuth messages calls and stays
// silent for non-Anthropic traffic.
{
  const seen = [];
  const calls = [];
  const fake = async (input, init) => {
    calls.push({ input, init });
    return "ok";
  };
  const patched = patchFetch(fake, { entrypoint: "cli", version: "2.1.236" }, (e) => seen.push(e));
  const sys = [{ type: "text", text: "prompt" }];
  const msgs = [{ role: "user", content: "hello world, this is a test" }];

  await patched("https://api.anthropic.com/v1/messages?beta=true", {
    method: "POST",
    headers: { authorization: "Bearer sk-ant-oat01-x" },
    body: JSON.stringify({ model: "m", system: sys, messages: msgs }),
  });
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].init.body).system[0].text.startsWith(BILLING_PREFIX), true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].outcome, "injected");
  assert.equal(seen[0].model, "m");

  // Non-Anthropic traffic: passthrough, no event.
  calls.length = 0;
  seen.length = 0;
  await patched("https://example.com/v1/chat", { method: "POST", headers: {}, body: "{}" });
  assert.equal(calls.length, 1);
  assert.equal(seen.length, 0);

  // Anthropic usage endpoint: passthrough with reason, no body rewrite.
  const usageBody = "{}";
  await patched("https://api.anthropic.com/api/oauth/usage", {
    method: "GET",
    headers: { authorization: "Bearer sk-ant-oat01-x" },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].outcome, "passthrough");
  assert.equal(seen[0].reason, "non-messages-path");
}

// 10. dropToolsFromBody withholds named tools, preserves order, null when clean.
{
  const body = {
    model: "m",
    tools: [{ name: "a" }, { name: "memory_get" }, { name: "b" }, { name: "memory_search" }],
  };
  const out = dropToolsFromBody(body, ["memory_get"]);
  assert.ok(out !== null);
  assert.deepEqual(out.dropped, ["memory_get"]);
  assert.deepEqual(out.body.tools.map((t) => t.name), ["a", "b", "memory_search"]);
  assert.equal(body.tools.length, 4);
  assert.equal(dropToolsFromBody(body, ["nope"]), null);
  assert.equal(dropToolsFromBody(body, []), null);
  assert.equal(dropToolsFromBody({ model: "m" }, ["memory_get"]), null);
}

// 11. patchFetch drops lane-flagged tools and still injects the header,
// reporting both in the event.
{
  const seen = [];
  const calls = [];
  const fake = async (input, init) => {
    calls.push({ input, init });
    return "ok";
  };
  const patched = patchFetch(
    fake,
    { entrypoint: "cli", version: "2.1.236", dropTools: ["memory_get"] },
    (e) => seen.push(e),
  );
  await patched("https://api.anthropic.com/v1/messages?beta=true", {
    method: "POST",
    headers: { authorization: "Bearer sk-ant-oat01-x" },
    body: JSON.stringify({
      model: "m",
      system: [{ type: "text", text: "prompt" }],
      messages: [{ role: "user", content: "hi there" }],
      tools: [{ name: "memory_get" }, { name: "memory_search" }],
    }),
  });
  const sent = JSON.parse(calls[0].init.body);
  assert.deepEqual(sent.tools.map((t) => t.name), ["memory_search"]);
  assert.equal(sent.system[0].text.startsWith(BILLING_PREFIX), true);
  assert.deepEqual(seen[0].dropped, ["memory_get"]);
  assert.equal(seen[0].outcome, "injected");
}

// 12. Gated-off (no sink): rewrite still applies, zero events built.
{
  const calls = [];
  const fake = async (input, init) => {
    calls.push({ input, init });
    return "ok";
  };
  const patched = patchFetch(fake, { entrypoint: "cli", version: "2.1.236", dropTools: ["memory_get"] }, undefined);
  await patched("https://api.anthropic.com/v1/messages?beta=true", {
    method: "POST",
    headers: { authorization: "Bearer sk-ant-oat01-x" },
    body: JSON.stringify({
      model: "m",
      system: [{ type: "text", text: "prompt" }],
      messages: [{ role: "user", content: "hi there" }],
      tools: [{ name: "memory_get" }, { name: "memory_search" }],
    }),
  });
  const sent = JSON.parse(calls[0].init.body);
  assert.deepEqual(sent.tools.map((t) => t.name), ["memory_search"]);
  assert.equal(sent.system[0].text.startsWith(BILLING_PREFIX), true);
}

// 13. Defaults: renaming is on, nothing is dropped.
{
  const resolved = resolveConfig({});
  assert.deepEqual(resolved.dropTools, []);
  assert.equal(resolved.renameTools, true);
  assert.equal(resolved.mcpPrefix, "mcp__dsh__");
  assert.deepEqual(resolved.oauthProviders, ["claude"]);
  assert.deepEqual(resolveConfig({ dropTools: ["x"] }).dropTools, ["x"]);
  assert.equal(resolveConfig({ renameTools: false }).renameTools, false);
}

// 14. Wire name: Claude Code names pass through canonically, everything else
// is namespaced the way Claude Code namespaces MCP tools.
{
  assert.equal(toWireToolName("bash", PREFIX), "Bash");
  assert.equal(toWireToolName("Bash", PREFIX), "Bash");
  assert.equal(toWireToolName("web_fetch", PREFIX), "WebFetch");
  assert.equal(toWireToolName("memory_get", PREFIX), "mcp__dsh__memory_get");
  assert.equal(toWireToolName("mcp_describe_tool", PREFIX), "mcp__dsh__mcp_describe_tool");
  // Idempotent: a second pass must not re-prefix.
  assert.equal(toWireToolName("mcp__dsh__memory_get", PREFIX), "mcp__dsh__memory_get");
}

// 15. Every name round-trips, and no wire name escapes the two allowed shapes.
{
  const names = ALL_TOOL_NAMES;
  for (const name of names) {
    const wire = toWireToolName(name, PREFIX);
    assert.equal(fromWireToolName(wire, names, PREFIX), name, `round trip ${name}`);
    assert.ok(
      CLAUDE_CODE_TOOL_NAMES.includes(wire) || wire.startsWith(PREFIX),
      `wire name escaped both shapes: ${wire}`,
    );
  }
}

// 16. A wire name that collides with a Claude Code tool resolves to the real
// tool, and an unknown wire name is passed through rather than guessed.
{
  assert.equal(fromWireToolName("Bash", ["bash"], PREFIX), "bash");
  assert.equal(fromWireToolName("mcp__dsh__memory_get", ["memory_get"], PREFIX), "memory_get");
  assert.equal(fromWireToolName("Terraform", ["bash"], PREFIX), "Terraform");
}

// 17. The body rewrite covers tool definitions AND tool_use blocks already in
// history, leaves everything else alone, and reports null when there is
// nothing to rename.
{
  const body = {
    model: "m",
    system: [{ type: "text", text: "p" }],
    tools: [
      { name: "bash", description: "d" },
      { name: "memory_get", description: "d" },
    ],
    messages: [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "ok" },
          { type: "tool_use", id: "t1", name: "memory_get", input: {} },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }] },
    ],
  };
  const out = renameBodyTools(body, PREFIX);
  assert.equal(out.renamed, 3);
  assert.deepEqual(out.body.tools.map((t) => t.name), ["Bash", "mcp__dsh__memory_get"]);
  assert.equal(out.body.messages[1].content[1].name, "mcp__dsh__memory_get");
  assert.equal(out.body.messages[1].content[1].id, "t1");
  assert.equal(out.body.messages[1].content[0].text, "ok");
  assert.equal(out.body.messages[2].content[0].tool_use_id, "t1");
  assert.deepEqual(out.body.system, body.system);
  assert.equal(out.body.model, "m");
  assert.equal(renameBodyTools({ model: "m" }, PREFIX), null);
  assert.equal(renameBodyTools({ model: "m", tools: [{ name: "bash" }] }, PREFIX).renamed, 1);
}

// 18. Response chunks: the name is mapped back on both shapes the claude
// adapter emits, and unrelated chunks are returned untouched.
{
  const names = ["bash", "memory_get"];
  const delta = unwireChunkToolName(
    { type: "tool-call-delta", index: 1, id: "t1", name: "mcp__dsh__memory_get", argumentsDelta: "" },
    names,
    PREFIX,
  );
  assert.equal(delta.name, "memory_get");
  const end = unwireChunkToolName(
    { type: "block-end", index: 1, block: { type: "tool-call", id: "t1", name: "Bash", arguments: "{}" } },
    names,
    PREFIX,
  );
  assert.equal(end.block.name, "bash");
  assert.equal(end.block.arguments, "{}");
  const text = { type: "text-delta", index: 0, text: "hello" };
  assert.equal(unwireChunkToolName(text, names, PREFIX), text);
}

// 19. End-to-end wiring through apply(): the fetch patch renames what it puts
// on the wire, and the registered llm/stream listener maps the wire name back
// before the harness sees it. This exercises the real registrations rather
// than the helpers in isolation.
{
  const listeners = [];
  const disposers = [];
  let installed;
  const ctx = {
    logger: { info() {}, warn() {} },
    effect(fn) {
      disposers.push(fn());
      return () => {};
    },
    on(event, handler) {
      listeners.push([event, handler]);
      return () => {};
    },
  };
  const sentBody = [];
  const fakeFetch = async (input, init) => {
    sentBody.push(init?.body);
    return new Response("{}", { status: 200 });
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    apply(ctx, {});
    assert.equal(typeof globalThis.fetch, "function");
    await globalThis.fetch("https://api.anthropic.com/v1/messages?beta=true", {
      method: "POST",
      headers: { authorization: "Bearer sk-ant-oat01-x" },
      body: JSON.stringify({
        model: "m",
        system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }],
        messages: [
          { role: "user", content: "hi there, rename me" },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }],
          },
        ],
        tools: [{ name: "bash" }, { name: "mcp_describe_tool" }],
      }),
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  const sent = JSON.parse(sentBody[0]);
  assert.deepEqual(sent.tools.map((t) => t.name), ["Bash", "mcp__dsh__mcp_describe_tool"]);
  assert.equal(sent.messages[1].content[0].name, "Bash");
  assert.equal(sent.system[0].text.startsWith(BILLING_PREFIX), true);

  const entry = listeners.find(([event]) => event === "llm/stream");
  assert.ok(entry, "llm/stream listener was not registered");
  const [, streamListener] = entry;
  const options = { provider: "claude", tools: [{ name: "bash" }, { name: "mcp_describe_tool" }] };
  const chunks = [
    { type: "block-start", index: 0, blockType: "tool-call" },
    { type: "tool-call-delta", index: 0, id: "t1", name: "mcp__dsh__mcp_describe_tool", argumentsDelta: "" },
    {
      type: "block-end",
      index: 0,
      block: { type: "tool-call", id: "t1", name: "Bash", arguments: "{}" },
    },
    { type: "finish", reason: { kind: "stop" } },
  ];
  const out = [];
  for await (const chunk of streamListener(options, () => chunks[Symbol.iterator]())) out.push(chunk);
  assert.equal(out[1].name, "mcp_describe_tool");
  assert.equal(out[1].argumentsDelta, "");
  assert.equal(out[2].block.name, "bash");
  assert.equal(out[3], chunks[3]);

  // A different provider's stream is handed back untouched.
  const other = streamListener({ provider: "codex", tools: options.tools }, () => chunks[Symbol.iterator]());
  const otherOut = [];
  for await (const chunk of other) otherOut.push(chunk);
  assert.equal(otherOut[1], chunks[1]);
}

// 20. Re-applying the plugin must REPLACE the fetch patch, not stack a second
// one. A profile config reload does exactly this, and the stacked patch
// double-prefixed every name (`mcp__dsh__mcp__dsh__memory_get`), which the
// response side could not map back — DSH then saw an unknown tool.
{
  const bodies = [];
  const realFetch = globalThis.fetch;
  const fakeFetch = async (input, init) => {
    bodies.push(init?.body);
    return new Response("{}", { status: 200 });
  };
  globalThis.fetch = fakeFetch;
  try {
    const mkctx = () => ({
      logger: { info() {}, warn() {} },
      effect(fn) {
        fn();
        return () => {};
      },
      on() {
        return () => {};
      },
    });
    apply(mkctx(), {});
    apply(mkctx(), {}); // the reload
    await globalThis.fetch("https://api.anthropic.com/v1/messages?beta=true", {
      method: "POST",
      headers: { authorization: "Bearer sk-ant-oat01-x" },
      body: JSON.stringify({
        model: "m",
        system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }],
        messages: [{ role: "user", content: "hi there" }],
        tools: [{ name: "memory_get" }, { name: "bash" }],
      }),
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(bodies.length, 1, "the patch ran more than once per request");
  const sent = JSON.parse(bodies[0]);
  assert.deepEqual(sent.tools.map((t) => t.name), ["mcp__dsh__memory_get", "Bash"]);
}

console.log("dsh-claude-billing-header: 20 tests passed");
