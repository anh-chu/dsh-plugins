// dsh-claude-billing-header
//
// Host plugin: inject the Claude Code billing-routing header into Anthropic
// OAuth (`sk-ant-oat*`) requests so they bill to the subscription quota
// instead of metered "extra usage".
//
// Background: Anthropic classifies OAuth requests by client fingerprint
// (user-agent, beta flags, `?beta=true`, system identity block, billing
// header, metadata). dsh-plugin-subscriptions already sends the CLI
// impersonation headers plus the `You are Claude Code...` identity system
// block, but no `x-anthropic-billing-header` system block. The Pi adapter
// (pi-claude-oauth-adapter) proved the header alone restores subscription
// routing, computing it as:
//
//   x-anthropic-billing-header: cc_version=<ver>.<3hex>; cc_entrypoint=<ep>; cch=<5hex>;
//
// where the 3hex suffix is sha256(salt + chars[4,7,20] of first user text +
// version) and cch is sha256(first user text). Newer Claude Code computes
// cch as xxHash64 over the serialized body in native code, but the sha256
// approximation is what Pi ships and suffices for billing routing (it does
// not gate fast-mode features).
//
// How it works:
//   1. `globalThis.fetch` is patched once (same pattern as
//      dsh-opencode-session). The patch only touches POSTs to
//      `api.anthropic.com/v1/messages` carrying an OAuth bearer token.
//   2. When the JSON body's `system[]` has no billing-header text block, the
//      header is unshifted to position 0. Everything else (identity block,
//      system prompt, cache_control, tools, messages, key order) is
//      preserved. When the header is already present, or the request is not
//      an Anthropic OAuth messages call, the request passes through
//      untouched (no body rewrite, cache-safe).
//   3. Every tool name is renamed to something the classifier accepts: a
//      Claude Code tool name where one matches, `mcp__dsh__<name>` otherwise.
//      Both the `tools[]` definitions and the `tool_use` blocks in
//      `messages[]` are rewritten together so the model sees one consistent
//      name per tool. An `llm/stream` listener maps wire names back to the
//      harness names on the way out of the adapter.
//   4. Registration is a fiber-scoped ctx effect, so plugin stop / unload
//      restores the original fetch and drops the listener.
//
// What it deliberately does NOT do (unlike the full Pi adapter):
//   - never removes the identity block (required by the subscriptions plugin)
//   - never strips or rewrites the system prompt (no Pi-docs concept in DSH)
//   - never touches headers, beta flags, or user-agent
//   - never touches usage / models / profile / token endpoints
//
// Proven in this setup (wire bisection, 2026-09-30): the billing header plus
// the CLI identity block is enough to stay in the plan lane for a request
// that carries no tool definitions. What flips a request to metered extra
// usage is the tool NAMES: with an otherwise byte-identical 60-tool body,
// renaming every tool keeps it in the plan lane, dropping only the names that
// tripped it also worked but cost the agent those tools. Anthropic rejects
// names outside Claude Code's own tool set; see `renameTools` below.
//
// NOT a factor (each tested against a real failing body, all still 400):
// metadata.user_id shape, the anthropic-beta flag list, max_tokens, the
// system prompt, the message content, and total request size. An earlier
// revision of this comment claimed metadata.user_id moves the lane; that
// was never implemented and the measurement does not support it.
//
// Remaining known gap, deliberately untouched: anthropic-beta flag list
// (owned by the subscriptions plugin).

import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appendFile, writeFile } from "node:fs/promises";

export const name = "claude-billing-header";

export const BILLING_PREFIX = "x-anthropic-billing-header:";
// Same salt Pi uses for the cc_version suffix (Claude Code 2.1.x series).
export const BILLING_SALT = "59cf53e54c78";
// Same fallback the subscriptions plugin uses for its Claude CLI user-agent.
const VERSION_FALLBACK = "2.1.263";
const MESSAGES_PATH = "api.anthropic.com/v1/messages";

export function resolveConfig(config = {}) {
  const entrypoint =
    typeof config.entrypoint === "string" && config.entrypoint.length > 0
      ? config.entrypoint
      : "cli";
  return {
    entrypoint,
    version: typeof config.version === "string" ? config.version : undefined,
    debug: config.debug === true,
    debugFile:
      typeof config.debugFile === "string" && config.debugFile.length > 0
        ? config.debugFile
        : undefined,
    // Tool names withheld from Anthropic OAuth bodies. Superseded by
    // `renameTools`: renaming keeps the tool usable, dropping does not.
    // Retained as a blunt fallback if a future classifier rejects a name that
    // renaming cannot hide. Verified by wire bisection 2026-09-30 against a
    // captured 60-tool DSH agent body:
    //   drop nothing                       -> 400 extra usage
    //   drop 3 mcp_* only                  -> 400
    //   drop memory_* only                 -> 400
    //   drop 3 mcp_* + any one memory_*    -> 200
    //   rename EVERY tool (same schemas)   -> 200   (names, not size)
    dropTools: Array.isArray(config.dropTools)
      ? config.dropTools.map(String)
      : [],
    // Tool-name shaping. Anthropic's OAuth classifier rejects tool
    // definitions whose names fall outside Claude Code's own tool set, which
    // is what a 400 "You're out of extra usage" means. Renaming instead of
    // dropping keeps every tool usable: the name becomes a Claude Code tool
    // name when one matches, and `<mcpPrefix><name>` otherwise — the
    // `mcp__<server>__<tool>` shape Claude Code itself uses for MCP tools.
    // The response side maps the wire name back before the harness sees it.
    renameTools: config.renameTools !== false,
    mcpPrefix:
      typeof config.mcpPrefix === "string" && config.mcpPrefix.length > 0
        ? config.mcpPrefix
        : "mcp__dsh__",
    // Routes whose streams get the reverse mapping. The fetch patch keys on
    // the OAuth bearer token; the `llm/stream` listener only sees
    // GenerateOptions, so the route has to be named here.
    oauthProviders: Array.isArray(config.oauthProviders)
      ? config.oauthProviders.map(String)
      : ["claude"],
    // Temporary diagnostic: when set, the pre-rewrite OAuth messages body is
    // written here (overwrite) so an exact failing request can be replayed
    // outside the DSH stack. Local file only; contains system prompt + tools.
    captureFile:
      typeof config.captureFile === "string" && config.captureFile.length > 0
        ? config.captureFile
        : undefined,
  };
}

let cachedCliVersion;
function detectCliVersion() {
  if (cachedCliVersion !== undefined) return cachedCliVersion;
  const probes =
    process.platform === "win32"
      ? [
          ["claude", ["--version"]],
          ["claude.cmd", ["--version"]],
        ]
      : [["claude", ["--version"]]];
  for (const [command, args] of probes) {
    try {
      const match = execFileSync(command, args, {
        timeout: 10_000,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).match(/(\d+\.\d+\.\d+)/);
      if (match) {
        cachedCliVersion = match[1];
        return cachedCliVersion;
      }
    } catch {
      // Try the next probe, then fall back.
    }
  }
  cachedCliVersion = VERSION_FALLBACK;
  return cachedCliVersion;
}

export function resolveVersion(configVersion) {
  return (
    process.env.PI_CLAUDE_CODE_VERSION ??
    process.env.CLAUDE_CODE_VERSION ??
    configVersion ??
    detectCliVersion()
  );
}

export function resolveEntrypoint(configEntrypoint) {
  return (
    process.env.PI_CLAUDE_CODE_ENTRYPOINT ??
    process.env.CLAUDE_CODE_ENTRYPOINT ??
    configEntrypoint ??
    "cli"
  );
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isObject(value) {
  return typeof value === "object" && value !== null;
}

/** Extract readable text from a messages-style content field. */
export function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block) =>
        isObject(block) && block.type === "text" && typeof block.text === "string",
    )
    .map((block) => String(block.text))
    .join("\n");
}

/** First user message text in an Anthropic messages array. */
export function firstUserText(messages) {
  if (!Array.isArray(messages)) return "";
  for (const message of messages) {
    if (isObject(message) && message.role === "user") {
      return messageText(message.content);
    }
  }
  return "";
}

export function buildBillingHeader(messages, version, entrypoint) {
  const text = firstUserText(messages);
  const sampled = [4, 7, 20].map((index) => text[index] ?? "0").join("");
  const versionHash = sha256Hex(`${BILLING_SALT}${sampled}${version}`).slice(0, 3);
  const cch = sha256Hex(text).slice(0, 5);
  return `${BILLING_PREFIX} cc_version=${version}.${versionHash}; cc_entrypoint=${entrypoint}; cch=${cch};`;
}

function hasBillingHeader(blocks) {
  return blocks.some(
    (block) =>
      isObject(block) &&
      block.type === "text" &&
      typeof block.text === "string" &&
      block.text.startsWith(BILLING_PREFIX),
  );
}

/**
 * Return a body object with the billing header ensured as system[0], or
 * null when no mutation is needed (header present, or no system array).
 * Never drops or rewrites existing blocks; shallow-clones text blocks so
 * cache_control objects survive by value.
 */
export function ensureBillingHeader(body, version, entrypoint) {
  if (!isObject(body) || !Array.isArray(body.system)) return null;
  if (hasBillingHeader(body.system)) return null;
  const header = buildBillingHeader(body.messages, version, entrypoint);
  const system = body.system.map((block) =>
    isObject(block)
      ? block.cache_control !== undefined && isObject(block.cache_control)
        ? { ...block, cache_control: { ...block.cache_control } }
        : { ...block }
      : block,
  );
  system.unshift({ type: "text", text: header });
  return { ...body, system };
}

/**
 * Remove lane-flagged tools from an Anthropic body. Anthropic routes OAuth
 * requests carrying the mneme `memory_get` + `memory_search` name pair to
 * the metered extra-usage lane (proven by wire bisection, 2026-09-17:
 * either tool alone passes, the pair flips). memory_search results already
 * carry full entry content, so withholding memory_get on subscription routes
 * is near-lossless. Returns { body, dropped } or null when nothing matches.
 */
export function dropToolsFromBody(body, names) {
  if (!isObject(body) || !Array.isArray(body.tools)) return null;
  if (!Array.isArray(names) || names.length === 0) return null;
  const drop = new Set(names.map(String));
  const dropped = [];
  const tools = body.tools.filter((tool) => {
    if (isObject(tool) && drop.has(String(tool.name))) {
      dropped.push(String(tool.name));
      return false;
    }
    return true;
  });
  if (dropped.length === 0) return null;
  return { body: { ...body, tools }, dropped };
}

/**
 * Claude Code's own tool names. Anthropic's OAuth classifier accepts tool
 * definitions named after these, and rejects names outside the set.
 * Source of the set: pi-anthropic-oauth src/convert.ts (`claudeCodeTools`),
 * which documents the classifier rule directly.
 */
export const CLAUDE_CODE_TOOL_NAMES = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Grep",
  "Glob",
  "AskUserQuestion",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
];

const CLAUDE_CODE_BY_LOWER = new Map(
  CLAUDE_CODE_TOOL_NAMES.map((toolName) => [nameKey(toolName), toolName]),
);

/**
 * Comparison key for a tool name: lowercase, separators removed. Claude Code
 * spells its own tools in camel case (`WebFetch`), a harness tends to use
 * snake case (`web_fetch`); both reduce to `webfetch`.
 */
export function nameKey(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Real harness tool name -> the name Anthropic will accept on the wire. */
export function toWireToolName(name, prefix) {
  const raw = String(name);
  return CLAUDE_CODE_BY_LOWER.get(nameKey(raw)) ?? `${prefix}${raw}`;
}

/**
 * Wire name -> the harness tool name it stands for. `names` is the tool list
 * of the request that produced the wire name; it is the authority, so a name
 * that collides with a Claude Code tool still resolves to the real tool.
 */
export function fromWireToolName(wireName, names, prefix) {
  const wire = String(wireName);
  if (wire.startsWith(prefix)) {
    const stripped = wire.slice(prefix.length);
    return names.includes(stripped) ? stripped : stripped;
  }
  const key = nameKey(wire);
  return names.find((candidate) => nameKey(candidate) === key) ?? wire;
}

/**
 * Rewrite every tool name in an Anthropic messages body: the `tools[]`
 * definitions and the `tool_use` blocks already in `messages[]`. History must
 * be renamed too — the model has to see one consistent name per tool across
 * the definitions and every earlier call it is shown.
 * @returns { body, renamed } or null when nothing needed rewriting.
 */
export function renameBodyTools(body, prefix) {
  if (!isObject(body)) return null;
  let renamed = 0;
  const rename = (name) => {
    const wire = toWireToolName(name, prefix);
    if (wire !== name) renamed += 1;
    return wire;
  };

  const tools = Array.isArray(body.tools)
    ? body.tools.map((tool) =>
        isObject(tool) && typeof tool.name === "string"
          ? { ...tool, name: rename(tool.name) }
          : tool,
      )
    : undefined;

  const messages = Array.isArray(body.messages)
    ? body.messages.map((message) => {
        if (!isObject(message) || !Array.isArray(message.content)) return message;
        const content = message.content.map((block) =>
          isObject(block) && block.type === "tool_use" && typeof block.name === "string"
            ? { ...block, name: rename(block.name) }
            : block,
        );
        return { ...message, content };
      })
    : undefined;

  if (renamed === 0) return null;
  return {
    body: {
      ...body,
      ...(tools === undefined ? {} : { tools }),
      ...(messages === undefined ? {} : { messages }),
    },
    renamed,
  };
}

/**
 * Map one StreamChunk's tool name back from the wire name. The claude
 * adapter names the tool in `tool-call-delta` (on open and on every
 * input_json_delta) and again in the closing `tool-call` block.
 */
export function unwireChunkToolName(chunk, names, prefix) {
  if (!isObject(chunk)) return chunk;
  if (chunk.type === "tool-call-delta" && typeof chunk.name === "string") {
    return { ...chunk, name: fromWireToolName(chunk.name, names, prefix) };
  }
  if (
    chunk.type === "block-end" &&
    isObject(chunk.block) &&
    chunk.block.type === "tool-call" &&
    typeof chunk.block.name === "string"
  ) {
    return { ...chunk, block: { ...chunk.block, name: fromWireToolName(chunk.block.name, names, prefix) } };
  }
  return chunk;
}

/** True for Anthropic OAuth messages POSTs (not API-key, not aux endpoints). */
export function isOAuthMessagesRequest(url, headers) {
  if (typeof url !== "string" || !url.includes(MESSAGES_PATH)) return false;
  const auth = headers.get("authorization") ?? "";
  return auth.startsWith("Bearer sk-ant-oat");
}

function recordDebug(ctx, file, entry) {
  appendFile(file, `${JSON.stringify(entry)}\n`, "utf8").catch((error) => {
    ctx.logger.warn(
      "[claude-billing-header] debugFile write failed: %s",
      error?.message ?? String(error),
    );
  });
}

function hostPath(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return typeof url === "string" ? url.slice(0, 120) : "non-string-url";
  }
}

export function patchFetch(original, resolved, onEvent) {
  const emit = typeof onEvent === "function" ? onEvent : undefined;
  return function patchedFetch(input, init) {
    const url = typeof input === "string" ? input : input?.url;
    // Observe only Anthropic traffic; everything else passes silently.
    const watched = typeof url === "string" && url.includes("anthropic");
    const rawHeaders =
      init?.headers ??
      (typeof Request !== "undefined" && input instanceof Request
        ? input.headers
        : undefined);
    let headers;
    try {
      headers = new Headers(rawHeaders);
    } catch {
      return original.apply(this, arguments);
    }
    if (!isOAuthMessagesRequest(url, headers)) {
      if (watched && emit) {
        const auth = headers.get("authorization") ?? headers.get("x-api-key") ?? "";
        emit({
          outcome: "passthrough",
          reason: typeof url !== "string" || !url.includes(MESSAGES_PATH)
            ? "non-messages-path"
            : auth === ""
              ? "no-auth"
              : "non-oauth-auth",
          url: hostPath(url),
        });
      }
      return original.apply(this, arguments);
    }
    if (typeof init?.body !== "string") {
      // The subscriptions plugin always sends a JSON string body; anything
      // else (e.g. a Request instance) passes through untouched.
      if (emit) {
        emit({ outcome: "passthrough", reason: "non-string-body", url: hostPath(url) });
      }
      return original.apply(this, arguments);
    }
    let parsed;
    try {
      parsed = JSON.parse(init.body);
    } catch {
      if (emit) {
        emit({ outcome: "passthrough", reason: "non-json-body", url: hostPath(url) });
      }
      return original.apply(this, arguments);
    }
    const version = resolveVersion(resolved.version);
    const entrypoint = resolveEntrypoint(resolved.entrypoint);
    let working = parsed;
    let dropped = [];
    const dt = dropToolsFromBody(parsed, resolved.dropTools);
    if (dt !== null) {
      working = dt.body;
      dropped = dt.dropped;
    }
    let renamed = 0;
    if (resolved.renameTools) {
      const rt = renameBodyTools(working, resolved.mcpPrefix);
      if (rt !== null) {
        working = rt.body;
        renamed = rt.renamed;
      }
    }
    const next = ensureBillingHeader(working, version, entrypoint);
    if (next !== null) working = next;
    const mutated = dt !== null || next !== null || renamed > 0;
    if (emit) {
      const system0 =
        isObject(parsed) && Array.isArray(parsed.system) && parsed.system.length > 0
          ? String(isObject(parsed.system[0]) ? (parsed.system[0].text ?? "[non-text]") : parsed.system[0]).slice(0, 80)
          : "[no-system]";
      emit({
        outcome: next === null && dt === null ? "passthrough" : "injected",
        reason: !mutated ? "header-present-or-no-system" : undefined,
        url: hostPath(url),
        model: isObject(parsed) && typeof parsed.model === "string" ? parsed.model : undefined,
        version,
        entrypoint,
        system0,
        systemLen: isObject(parsed) && Array.isArray(parsed.system) ? parsed.system.length : 0,
        toolCount: isObject(parsed) && Array.isArray(parsed.tools) ? parsed.tools.length : 0,
        dropped,
        renamed,
      });
    }
    if (resolved.captureFile !== undefined && isObject(parsed)) {
      // Best-effort exact-body capture for offline replay diagnosis.
      // Fire-and-forget; a failure must never break the request path.
      writeFile(resolved.captureFile, JSON.stringify(parsed), "utf8").catch(() => {});
    }
    if (!mutated) return original.apply(this, arguments);
    return original.call(this, input, { ...init, body: JSON.stringify(working) });
  };
}

export function apply(ctx, config) {
  const resolved = resolveConfig(config);
  const originalFetch = globalThis.fetch;
  if (typeof originalFetch !== "function") {
    ctx.logger.warn(
      "[claude-billing-header] globalThis.fetch is unavailable; cannot inject billing header",
    );
    return;
  }
  // Observability is fully gated: without debug/debugFile configured, no
  // event objects are built and no writes happen — the patch is strictly
  // match-and-rewrite, so normal use incurs no storage or heap overhead.
  const sink =
    resolved.debug || resolved.debugFile !== undefined
      ? (entry) => {
          const record = { ts: new Date().toISOString(), ...entry };
          if (resolved.debug) {
            ctx.logger.info("[claude-billing-header] %s", JSON.stringify(record));
          }
          if (resolved.debugFile !== undefined) {
            recordDebug(ctx, resolved.debugFile, record);
          }
        }
      : undefined;
  const patched = patchFetch(originalFetch, resolved, sink);

  ctx.effect(() => {
    globalThis.fetch = patched;
    ctx.logger.info(
      "[claude-billing-header] active (entrypoint=%s)",
      resolveEntrypoint(resolved.entrypoint),
    );
    return () => {
      if (globalThis.fetch === patched) globalThis.fetch = originalFetch;
    };
  }, "claude-billing-header.fetch-patch");

  // Reverse half of the tool rename. The request side renames at the fetch
  // seam (the only place that sees the built body); the response side maps
  // back here, on typed StreamChunks, so no SSE text is parsed. The request
  // could not be rewritten here even if we wanted to: a loop-built
  // GenerateOptions arrives deep-frozen.
  if (resolved.renameTools) {
    ctx.on("llm/stream", (options, next) => {
      if (!isObject(options)) return next();
      if (!resolved.oauthProviders.includes(String(options.provider))) return next();
      const downstream = next();
      if (downstream === undefined || downstream === null) return downstream;
      const names = Array.isArray(options.tools)
        ? options.tools
            .map((tool) => (isObject(tool) ? String(tool.name) : ""))
            .filter((toolName) => toolName !== "")
        : [];
      return (async function* unwireToolNames() {
        for await (const chunk of downstream) {
          yield unwireChunkToolName(chunk, names, resolved.mcpPrefix);
        }
      })();
    });
  }
}
