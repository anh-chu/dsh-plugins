import assert from "node:assert/strict";
import {
  BILLING_PREFIX,
  buildBillingHeader,
  dropToolsFromBody,
  ensureBillingHeader,
  firstUserText,
  isOAuthMessagesRequest,
  messageText,
  patchFetch,
} from "../lib/index.js";

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

console.log("dsh-claude-billing-header: 12 tests passed");
