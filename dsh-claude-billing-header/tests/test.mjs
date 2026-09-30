import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  BILLING_PREFIX,
  CLAUDE_CODE_TOOL_NAMES,
  buildBillingHeader,
  dropToolsFromBody,
  ensureBillingHeader,
  firstUserText,
  FETCH_PATCH_TAG,
  compareVersions,
  fromWireToolName,
  isOAuthMessagesRequest,
  isVersionPinned,
  messageText,
  apply,
  patchFetch,
  renameBodyTools,
  normalizeBodyToolIds,
  requiredClaudeCodeVersion,
  resolveConfig,
  setBillingHeaderVersion,
  stripOwnPatchLayers,
  toWireToolName,
  unwireChunkToolName,
} from "../lib/index.js";

const PREFIX = "mcp__dsh__";

/** How many of this plugin's fetch patches are chained right now. */
function countOurLayers() {
  let layers = 0;
  let current = globalThis.fetch;
  while (typeof current === "function" && current[FETCH_PATCH_TAG] !== undefined) {
    layers += 1;
    current = current[FETCH_PATCH_TAG];
  }
  return layers;
}

const MESSAGES_URL = "https://api.anthropic.com/v1/messages?beta=true";

function requestBody() {
  return {
    model: "m",
    system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }],
    messages: [{ role: "user", content: "hello there, version gate" }],
    tools: [{ name: "bash" }],
  };
}

/** The rejection Anthropic returns when the header's version is below a new model's floor. */
function versionGateResponse(required = "2.1.299") {
  return new Response(
    JSON.stringify({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: `Claude Code 2.1.260 does not support this model; version ${required} or newer is required.`,
        details: { error_code: "claude_code_version_too_old" },
      },
    }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
}

/**
 * Install the plugin over a stubbed fetch, issue `requests` messages calls,
 * and return the bodies that actually went out (one entry per attempt).
 */
async function runThroughPatch(responder, config = {}, requests = 1) {
  const realFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (input, init) => {
    bodies.push(JSON.parse(init.body));
    return responder(bodies.length);
  };
  try {
    apply(
      {
        logger: { info() {}, warn() {} },
        effect(fn) {
          fn();
          return () => {};
        },
        on() {
          return () => {};
        },
      },
      config,
    );
    for (let i = 0; i < requests; i += 1) {
      await globalThis.fetch(MESSAGES_URL, {
        method: "POST",
        headers: { authorization: "Bearer sk-ant-oat01-x" },
        body: JSON.stringify(requestBody()),
      });
    }
    return bodies;
  } finally {
    globalThis.fetch = realFetch;
  }
}

const billingVersion = (body) => body.system[0].text.match(/cc_version=([\d.]+)\./)?.[1];
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
    assert.equal(countOurLayers(), 1, "the reload stacked a second patch");
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

// 21. A reload gives the plugin a FRESH module instance, so the unwind cannot
// rely on module state: the new install must find the old layer through the
// tag on the function itself. Simulated by leaving a tagged layer installed,
// which is exactly the shape the previous module instance left behind.
{
  const realFetch = globalThis.fetch;
  const base = async () => new Response("{}", { status: 200 });
  globalThis.fetch = patchFetch(base, resolveConfig({}), undefined);
  try {
    assert.equal(countOurLayers(), 1, "the simulated stale layer was not installed");
    apply(
      {
        logger: { info() {}, warn() {} },
        effect(fn) {
          fn();
          return () => {};
        },
        on() {
          return () => {};
        },
      },
      {},
    );
    assert.equal(countOurLayers(), 1, "the stale layer was not unwound");
    assert.equal(stripOwnPatchLayers(globalThis.fetch), base, "did not land back on the base fetch");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// 22. The version gate is recognised, and nothing else is mistaken for it.
{
  assert.equal(requiredClaudeCodeVersion(await versionGateResponse("2.1.280").json()), "2.1.280");
  assert.equal(
    requiredClaudeCodeVersion({
      error: {
        message:
          "Claude Code 2.1.260 does not support this model; version 2.1.300 or newer is required.",
      },
    }),
    "2.1.300",
  );
  // The code without a version names nothing to adopt.
  assert.equal(
    requiredClaudeCodeVersion({ error: { details: { error_code: "claude_code_version_too_old" } } }),
    undefined,
  );
  assert.equal(
    requiredClaudeCodeVersion({ error: { message: "You're out of extra usage." } }),
    undefined,
  );
  assert.equal(requiredClaudeCodeVersion(undefined), undefined);
  assert.equal(compareVersions("2.1.299", "2.1.285"), 1);
  assert.equal(compareVersions("2.1.285", "2.1.299"), -1);
  assert.equal(compareVersions("2.1.285", "2.1.285"), 0);
}

// 23. Setting the version rewrites the header block in place and leaves the
// rest of the body — including cache_control — by value.
{
  const body = {
    model: "m",
    system: [
      {
        type: "text",
        text: "x-anthropic-billing-header: cc_version=2.1.260.abc; cc_entrypoint=cli; cch=12345;",
      },
      {
        type: "text",
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: "hello there" }],
  };
  const out = setBillingHeaderVersion(body, "2.1.280", "cli");
  assert.match(
    out.system[0].text,
    /^x-anthropic-billing-header: cc_version=2\.1\.280\.[0-9a-f]{3}; cc_entrypoint=cli; cch=[0-9a-f]{5};$/,
  );
  assert.equal(out.system.length, 2);
  assert.deepEqual(out.system[1], body.system[1]);
  assert.equal(body.system[0].text.includes("2.1.260"), true, "input body must not be mutated");
  assert.equal(setBillingHeaderVersion(out, "2.1.280", "cli"), null, "same version must be a no-op");
  assert.equal(setBillingHeaderVersion({ model: "m" }, "2.1.280", "cli"), null);
  assert.equal(
    setBillingHeaderVersion(
      { model: "m", system: [{ type: "text", text: "no header here" }] },
      "2.1.280",
      "cli",
    ),
    null,
  );
}

// 24. A 400 that is not the version gate is returned untouched.
{
  const bodies = await runThroughPatch(
    () =>
      new Response(JSON.stringify({ error: { message: "You're out of extra usage." } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
  );
  assert.equal(bodies.length, 1, "an unrelated 400 must not be retried");
}

// 25. An explicit version is absolute: it disables recovery.
{
  const bodies = await runThroughPatch(() => versionGateResponse(), { version: "2.1.260" });
  assert.equal(bodies.length, 1, "a pinned version must not be replaced");
  assert.equal(billingVersion(bodies[0]), "2.1.260");
  assert.equal(isVersionPinned({ version: "2.1.260" }), true);
}

// 26. Request-local ids are paired, collision-free and deterministic; legal
// ids, cache controls and the caller's body stay unchanged.
{
  const foreign = "call_01a0|fc_01a0";
  const other = "call_01a0!fc_01a0";
  const reserved = `call_${createHash("sha256").update(foreign).digest("hex").slice(0, 40)}`;
  const body = {
    system: [{ type: "text", text: "already billed", cache_control: { type: "ephemeral" } }],
    tools: [{ name: "memory_get" }],
    messages: [
      { role: "assistant", content: [
        { type: "tool_use", id: foreign, name: "memory_get", input: {}, cache_control: { type: "ephemeral" } },
        { type: "tool_use", id: other, name: "memory_get", input: {} },
        { type: "tool_use", id: reserved, name: "memory_get", input: {} },
        { type: "tool_use", id: "legal_9", name: "memory_get", input: {} },
      ] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: foreign, content: "first" },
        { type: "tool_result", tool_use_id: other, content: "second" },
        { type: "tool_result", tool_use_id: reserved, content: "third" },
        { type: "tool_result", tool_use_id: "legal_9", content: "fourth" },
      ] },
    ],
  };
  const before = structuredClone(body);
  const normalized = normalizeBodyToolIds(body);
  const uses = normalized.messages[0].content;
  const results = normalized.messages[1].content;
  assert.deepEqual(normalized, normalizeBodyToolIds(body), "replayed history must emit identical ids");
  assert.deepEqual(body, before, "the stored input must remain untouched");
  for (let i = 0; i < uses.length; i += 1) {
    assert.match(uses[i].id, /^[a-zA-Z0-9_-]+$/);
    assert.equal(uses[i].id, results[i].tool_use_id);
  }
  assert.notEqual(uses[0].id, uses[1].id);
  assert.notEqual(uses[0].id, reserved, "reserve even legal ids encountered later");
  assert.equal(uses[2].id, reserved);
  assert.equal(uses[3].id, "legal_9");
  assert.deepEqual(uses[0].cache_control, before.messages[0].content[0].cache_control);
  assert.deepEqual(normalized.system, before.system);
  assert.equal(normalizeBodyToolIds({ ...body, messages: before.messages.map((message) => ({
    ...message,
    content: message.content.slice(2),
  })) }), null, "no rewrite when every id is legal");
  const renamed = renameBodyTools(normalized, PREFIX);
  assert.equal(renamed.body.messages[0].content[0].id, uses[0].id);
  assert.equal(renamed.body.messages[0].content[0].name, "mcp__dsh__memory_get");

  const sent = [];
  const fetch = patchFetch(async (input, init) => {
    sent.push(init.body);
    return new Response("{}", { status: 200 });
  }, resolveConfig({}), undefined);
  const wire = { ...body, system: [{ type: "text", text: "You are Claude Code" }] };
  const original = JSON.stringify(wire);
  await fetch(MESSAGES_URL, {
    method: "POST",
    headers: { authorization: "Bearer sk-ant-oat01-x" },
    body: original,
  });
  assert.equal(JSON.stringify(wire), original);
  const transmitted = JSON.parse(sent[0]);
  assert.equal(transmitted.messages[0].content[0].id, transmitted.messages[1].content[0].tool_use_id);
  assert.match(transmitted.messages[0].content[0].id, /^[a-zA-Z0-9_-]+$/);
  assert.equal(transmitted.messages[0].content[0].name, "mcp__dsh__memory_get");
  const apiKey = { authorization: "Bearer sk-ant-api01-x" };
  await fetch(MESSAGES_URL, { method: "POST", headers: apiKey, body: original });
  await fetch("https://api.anthropic.com/v1/models", {
    method: "POST", headers: { authorization: "Bearer sk-ant-oat01-x" }, body: original,
  });
  assert.equal(sent[1], original, "non-OAuth body must pass through verbatim");
  assert.equal(sent[2], original, "non-messages body must pass through verbatim");
}

// 27. The gate is recovered: adopt the version the error names, send once
// more, and remember it so later requests skip the rejected attempt.
// Runs last — it leaves the learned version in module state on purpose.
{
  const bodies = await runThroughPatch(
    (n) => (n === 1 ? versionGateResponse() : new Response("{}", { status: 200 })),
    {},
    2,
  );
  assert.equal(bodies.length, 3, "expected: rejected attempt, retry, then one direct request");
  assert.equal(billingVersion(bodies[0]), "2.1.285", "first attempt reports the detected version");
  assert.equal(billingVersion(bodies[1]), "2.1.299", "the retry adopts the version the error named");
  assert.equal(billingVersion(bodies[2]), "2.1.299", "the learned version is remembered");
  assert.equal(bodies[2].tools[0].name, "Bash", "the retry keeps the rest of the rewrite");
}

console.log("dsh-claude-billing-header: 27 tests passed");
