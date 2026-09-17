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
//   3. Registration is a fiber-scoped ctx effect, so plugin stop / unload
//      restores the original fetch.
//
// What it deliberately does NOT do (unlike the full Pi adapter):
//   - never removes the identity block (required by the subscriptions plugin)
//   - never strips or rewrites the system prompt (no Pi-docs concept in DSH)
//   - never touches headers, beta flags, or user-agent
//   - never touches usage / models / profile / token endpoints
//
// Proven in this setup (debug log, 2026-09-17): the billing header alone is
// NOT sufficient — injected requests still billed to extra usage. So the
// patch additionally rewrites metadata.user_id into the CLI shape
// `user_dshhost_account_<uuid>_session_<id>`, carrying the real account UUID
// from ~/.claude.json and preserving the harness session id as the session
// part. Remaining known gaps, deliberately untouched: anthropic-beta flag
// list (owned by the subscriptions plugin) and system-prompt content.

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

function resolveConfig(config = {}) {
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
    // Tool names withheld from Anthropic OAuth bodies. Default drops
    // memory_get: Anthropic lanes the memory_get + memory_search name pair
    // to extra usage, and memory_search results already carry full content.
    // Set [] to disable.
    dropTools: Array.isArray(config.dropTools)
      ? config.dropTools.map(String)
      : ["memory_get"],
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
    const next = ensureBillingHeader(working, version, entrypoint);
    if (next !== null) working = next;
    const mutated = dt !== null || next !== null;
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
}
