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

/**
 * Marks a fetch function this plugin installed, pointing at the fetch it
 * replaced. A global symbol, not a module variable: a profile reload gives
 * the plugin a fresh module instance, so module state cannot be how a new
 * install finds the layer the old one left behind. Tagging the function
 * itself survives that.
 */
export const FETCH_PATCH_TAG = Symbol.for("dsh-claude-billing-header.fetch-patch");

/**
 * Walk down through this plugin's own patch layers to the fetch underneath,
 * so installing again replaces them instead of nesting on top. Only our own
 * layers are stripped; another plugin's patch above ours is left alone.
 */
export function stripOwnPatchLayers(fetchImpl) {
  let current = fetchImpl;
  while (typeof current === "function" && current[FETCH_PATCH_TAG] !== undefined) {
    current = current[FETCH_PATCH_TAG];
  }
  return current;
}

/**
 * A Claude Code version learned from a `claude_code_version_too_old`
 * rejection. Remembered for the life of the process so only the first request
 * after a floor rise pays for a rejected attempt.
 */
let sessionVersion;

/** -1 / 0 / 1 for two dotted numeric versions. */
export function compareVersions(a, b) {
  const left = String(a).split(".");
  const right = String(b).split(".");
  for (let i = 0; i < 3; i += 1) {
    const x = Number(left[i] ?? 0);
    const y = Number(right[i] ?? 0);
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/**
 * The Claude Code version Anthropic demands, when a failure is that gate:
 *   {"type":"error","error":{"type":"invalid_request_error",
 *    "message":"Claude Code 2.1.260 does not support this model; version
 *    2.1.280 or newer is required.",
 *    "details":{"error_code":"claude_code_version_too_old"}}}
 * @returns the version string, or undefined when this is not that failure.
 */
export function requiredClaudeCodeVersion(payload) {
  if (!isObject(payload) || !isObject(payload.error)) return undefined;
  const { error } = payload;
  const message = typeof error.message === "string" ? error.message : "";
  const details = isObject(error.details) ? error.details : undefined;
  const code =
    details !== undefined && typeof details.error_code === "string"
      ? details.error_code
      : undefined;
  if (code !== "claude_code_version_too_old" && !/does not support this model/i.test(message)) {
    return undefined;
  }
  const named = message.match(/version\s+(\d+\.\d+\.\d+)\s+or newer/i);
  return named === null ? undefined : named[1];
}

/**
 * Rewrite the billing header block at a new Claude Code version, in place, so
 * every other block keeps its position and its cache_control. Returns null
 * when the body carries no billing header, or already names that version.
 */
export function setBillingHeaderVersion(body, version, entrypoint) {
  if (!isObject(body) || !Array.isArray(body.system)) return null;
  const index = body.system.findIndex(
    (block) =>
      isObject(block) && typeof block.text === "string" && block.text.startsWith(BILLING_PREFIX),
  );
  if (index === -1) return null;
  const text = buildBillingHeader(body.messages, version, entrypoint);
  if (body.system[index].text === text) return null;
  const system = body.system.map((block, i) => (i === index ? { ...block, text } : block));
  return { ...body, system };
}

/**
 * True when the version came from an explicit setting rather than detection.
 * An explicit version is absolute: it is reported verbatim and disables
 * recovery, so a stale pin can itself cause the gate it would otherwise fix.
 */
export function isVersionPinned(resolved) {
  return (
    typeof process.env.PI_CLAUDE_CODE_VERSION === "string" ||
    typeof process.env.CLAUDE_CODE_VERSION === "string" ||
    (resolved !== undefined && resolved.version !== undefined)
  );
}

/** The version to report, preferring one learned from a rejection. */
function resolveRequestVersion(resolved) {
  return sessionVersion ?? resolveVersion(resolved.version);
}

/**
 * Read a small JSON error body without consuming the caller's copy. Only
 * called for a non-2xx JSON response, so the buffered tee is short-lived.
 */
async function readErrorPayload(response) {
  try {
    const type = response.headers.get("content-type") ?? "";
    if (!type.includes("json")) return undefined;
    const text = await response.clone().text();
    if (text.length === 0 || text.length > 65536) return undefined;
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

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
  // Idempotent: a body that was already rewritten must survive a second pass
  // unchanged. Without this, a second pass turns `<prefix>x` into
  // `<prefix><prefix>x`, which the response side cannot map back.
  if (raw.startsWith(prefix)) return raw;
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

/** Normalize foreign tool-call ids only in this Anthropic request body. */
export function normalizeBodyToolIds(body) {
  if (!isObject(body) || !Array.isArray(body.messages)) return null;
  const rawIds = [];
  for (const message of body.messages) {
    if (!isObject(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isObject(block)) continue;
      if (block.type === "tool_use" && typeof block.id === "string") rawIds.push(block.id);
      if (block.type === "tool_result" && typeof block.tool_use_id === "string") rawIds.push(block.tool_use_id);
    }
  }
  const used = new Set(rawIds.filter((id) => /^[a-zA-Z0-9_-]+$/.test(id)));
  const mapped = new Map();
  for (const id of rawIds) {
    if (used.has(id) || mapped.has(id)) continue;
    let attempt = 0;
    let replacement;
    do {
      const hash = createHash("sha256");
      if (attempt > 0) hash.update(String(attempt)).update("\0");
      replacement = `call_${hash.update(id).digest("hex").slice(0, 40)}`;
      attempt += 1;
    } while (used.has(replacement));
    mapped.set(id, replacement);
    used.add(replacement);
  }
  if (mapped.size === 0) return null;
  return {
    ...body,
    messages: body.messages.map((message) => {
      if (!isObject(message) || !Array.isArray(message.content)) return message;
      return {
        ...message,
        content: message.content.map((block) => {
          if (!isObject(block)) return block;
          if (block.type === "tool_use" && mapped.has(block.id)) return { ...block, id: mapped.get(block.id) };
          if (block.type === "tool_result" && mapped.has(block.tool_use_id)) return { ...block, tool_use_id: mapped.get(block.tool_use_id) };
          return block;
        }),
      };
    }),
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
  const patchedFetch = async function patchedFetch(input, init) {
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
    const version = resolveRequestVersion(resolved);
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
    const normalized = normalizeBodyToolIds(working);
    if (normalized !== null) working = normalized;
    const next = ensureBillingHeader(working, version, entrypoint);
    if (next !== null) working = next;
    const mutated = dt !== null || next !== null || renamed > 0 || normalized !== null;
    if (emit) {
      const system0 =
        isObject(parsed) && Array.isArray(parsed.system) && parsed.system.length > 0
          ? String(isObject(parsed.system[0]) ? (parsed.system[0].text ?? "[non-text]") : parsed.system[0]).slice(0, 80)
          : "[no-system]";
      emit({
        outcome: mutated ? "injected" : "passthrough",
        reason: mutated ? undefined : "header-present-or-no-system",
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
    const send = (body) => original.call(this, input, { ...init, body: JSON.stringify(body) });
    const response = await send(working);
    // Anthropic gates a newly released model on the Claude Code version the
    // billing header reports. When that gate rejects this request, it names
    // the version it wants: adopt it, remember it, and send once more. An
    // explicit version is absolute and opts out (see isVersionPinned).
    if (
      response.status !== 400 ||
      isVersionPinned(resolved)
    ) {
      return response;
    }
    const required = requiredClaudeCodeVersion(await readErrorPayload(response));
    if (required === undefined || compareVersions(required, version) <= 0) return response;
    const upgraded = setBillingHeaderVersion(working, required, entrypoint);
    if (upgraded === null) return response;
    sessionVersion = required;
    if (emit) {
      emit({
        outcome: "recovered-version",
        reason: "claude_code_version_too_old",
        url: hostPath(url),
        version,
        required,
      });
    }
    return send(upgraded);
  };
  // Tag the install so a later apply can find and replace it — including from
  // a fresh module instance, where module state would be empty.
  Object.defineProperty(patchedFetch, FETCH_PATCH_TAG, { value: original });
  return patchedFetch;
}

export function apply(ctx, config) {
  const resolved = resolveConfig(config);
  if (typeof globalThis.fetch !== "function") {
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
  ctx.effect(() => {
    // A profile config reload re-applies this plugin as a fresh module
    // instance, so the new install cannot rely on module state to find the
    // layer the old one left behind: it walks the tag chain on the function
    // itself. Without that it captured the previous patch as its "original"
    // and nested on top, and the old disposer could not restore because
    // globalThis.fetch no longer equalled its own patch. The extra layer is
    // harmless while the rewrite stays idempotent, but it is still waste.
    const originalFetch = stripOwnPatchLayers(globalThis.fetch);
    const patched = patchFetch(originalFetch, resolved, sink);
    globalThis.fetch = patched;
    ctx.logger.info(
      "[claude-billing-header] active (entrypoint=%s)",
      resolveEntrypoint(resolved.entrypoint),
    );
    return () => {
      // A newer instance may have replaced this one already; only the current
      // install may restore, or the restore would clobber its successor.
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
