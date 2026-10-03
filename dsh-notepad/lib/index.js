// dsh-notepad — host half.
//
// Host half of the persistent notepad:
// - Two scopes: global (~/.dsh/notepad/notes.md, shared by all sessions) and
//   session:<id> (~/.dsh/notepad/scopes/session-<id>/, session-isolated)
// - Notes are plain text (UTF-8 BOM, atomic write); per-scope revisions rise independently and monotonically
// - Every overwrite is snapshotted into history/ first (the most recent 20 are kept)
// - GET /api/notepad supports ?since=<revision> slim polling (text is null when unchanged)
// - PUT carries baseRevision for optimistic locking: if changed elsewhere, 409 returns the current content and revision
// - Model tools notepad_read / notepad_write (append dedupes by line), scope-aware reads and writes
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const name = "dsh-notepad";
// Declarative dependency: the loader guarantees webServer and tools are ready before apply,
// avoiding a startup race that leaves ctx.get("tools") empty and tool registration silently failing.
const inject = ["webServer", "tools"];

const HISTORY_LIMIT = 20;
const SCOPE_GLOBAL = "global";
const SCOPE_PREFIX = "session:";

// ---- SSE push ---------------------------------------------------------
const sseClients = new Set();

/** Broadcast one change to every SSE subscriber. */
function notifySse(key, revision) {
  const payload = `data: ${JSON.stringify({ scope: key, revision, at: new Date().toISOString() })}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch {}
  }
}

// ---- Scope paths -----------------------------------------------------
function notepadDir() {
  return join(resolveDshHome(), "notepad");
}

/** Normalize a scope key: global, or session:<sanitized sessionId>. Invalid input falls back to global. */
function scopeKeyOf(scope, sessionId) {
  if (scope === "session" && typeof sessionId === "string" && sessionId !== "") {
    return `${SCOPE_PREFIX}${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  }
  return SCOPE_GLOBAL;
}

function scopeDir(key) {
  // global keeps the legacy path (compatible with existing data and external editors); session pages go under scopes/s-<id>/
  // Note: the colon inside "session:" cannot go into a Windows directory name, so the directory segment uses the "s-" prefix
  if (key === SCOPE_GLOBAL) return notepadDir();
  return join(notepadDir(), "scopes", `s-${key.slice(SCOPE_PREFIX.length)}`);
}
function notesPathFor(key) {
  return join(scopeDir(key), "notes.md");
}
function metaPathFor(key) {
  return join(scopeDir(key), "meta.json");
}
function historyDirFor(key) {
  return join(scopeDir(key), "history");
}

// ---- Metadata / content I/O ------------------------------------------------
function readMeta(key) {
  try {
    return JSON.parse(readFileSync(metaPathFor(key), "utf8"));
  } catch {
    return { revision: 0 };
  }
}

function writeMeta(key, meta) {
  try {
    writeFileSync(metaPathFor(key), JSON.stringify(meta, null, 2), "utf8");
  } catch {
    // A failed meta write is not fatal; a revision falling back to 0 only loosens conflict detection
  }
}

function readNotes(key) {
  const p = notesPathFor(key);
  if (!existsSync(p)) return "";
  const raw = readFileSync(p, "utf8");
  // Tolerate a present or absent UTF-8 BOM: the BOM lets Windows editors detect the encoding correctly and avoids a misread as GBK
  return raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
}

/** Snapshot a scope's current content into its history directory, trimmed to HISTORY_LIMIT entries. */
function snapshot(key) {
  const text = readNotes(key);
  if (text.trim() === "") return;
  try {
    mkdirSync(historyDirFor(key), { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    writeFileSync(join(historyDirFor(key), `notes-${ts}.md`), text, "utf8");
    const files = readdirSync(historyDirFor(key))
      .filter((f) => /^notes-[\dA-Z-]+\.md$/.test(f))
      .sort();
    while (files.length > HISTORY_LIMIT) {
      try { unlinkSync(join(historyDirFor(key), files.shift())); } catch {}
    }
  } catch {}
}

/**
 * Write a scope's notes. baseRevision is the version the client last saw; if the server
 * moved on and force is not set, returns a conflict (current text and revision) without writing. Returns { conflict, revision, text? }.
 */
function writeNotes(text, key, baseRevision, force) {
  const meta = readMeta(key);
  if (baseRevision !== void 0 && baseRevision !== null && force !== true && baseRevision < meta.revision) {
    return { conflict: true, revision: meta.revision, text: readNotes(key) };
  }
  const prev = readNotes(key);
  if (prev !== text) snapshot(key);
  try {
    mkdirSync(scopeDir(key), { recursive: true });
    const tmp = `${notesPathFor(key)}.tmp`;
    const body = text.charCodeAt(0) === 0xFEFF ? text : `\uFEFF${text}`;
    writeFileSync(tmp, body, "utf8");
    renameSync(tmp, notesPathFor(key));
  } catch (error) {
    throw error;
  }
  const revision = meta.revision + 1;
  writeMeta(key, { revision, updatedAt: new Date().toISOString() });
  notifySse(key, revision);
  return { conflict: false, revision };
}

// ---- HTTP helpers --------------------------------------------------------
function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    return null; // invalid JSON
  }
}

function listHistory(key) {
  try {
    if (!existsSync(historyDirFor(key))) return [];
    return readdirSync(historyDirFor(key))
      .filter((f) => /^notes-[\dA-Z-]+\.md$/.test(f))
      .sort()
      .reverse()
      .map((f) => ({ id: f, time: f.replace(/^notes-/, "").replace(/\.md$/, "") }));
  } catch {
    return [];
  }
}

function readHistory(key, id) {
  if (!/^notes-[\dA-Z-]+\.md$/.test(id)) return null;
  const p = join(historyDirFor(key), id);
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, "utf8");
  return raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
}

/** List the session ids of all session-isolated pages (so Agent tools can hint at available scopes). */
function listSessionScopes() {
  try {
    const base = join(notepadDir(), "scopes");
    if (!existsSync(base)) return [];
    return readdirSync(base)
      .filter((d) => d.startsWith("s-"))
      .map((d) => d.slice(2))
      .sort();
  } catch {
    return [];
  }
}

// ---- System-prompt block ------------------------------------------------

// Cap for the block rendered into the system prompt. The whole block is re-sent on every
// request, so this is a per-request token cost, not a storage limit - the file itself is
// unbounded and the tools always see the full page.
const SECTION_MAX_BYTES = 2000;

// Separate, smaller cap for the read-only parent page: it is reference material for a forked
// child, not the surface the child works in.
const PARENT_SECTION_MAX_BYTES = 1200;

/** The session this agent was forked from, if any. A spawned child has no lineage and none. */
function parentSessionIdOf(agent) {
  try {
    const session = agent && agent.session;
    // The runtime Session exposes the durable header as `.header` (the harness reads lineage the
    // same way); `.meta` is the declared name in the type, so accept either.
    const candidates = [
      session && session.header && session.header.parentSession,
      session && session.meta && session.meta.parentSession,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate !== "") return candidate;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Why a write aimed at the forked-from session must be refused, or undefined when allowed. */
function parentWriteRefusal(args, agent) {
  const parent = parentSessionIdOf(agent);
  if (parent === undefined) return undefined;
  const target = args && typeof args.sessionId === "string" ? args.sessionId : undefined;
  if (target !== undefined && target === parent) {
    return "The parent session's notepad is read-only. Record your own findings in your own notepad and report them in your reply.";
  }
  return undefined;
}

/** Keep the tail of `text` within `maxBytes` UTF-8 bytes, without splitting a code point. */
function tailWithinBytes(text, maxBytes) {
  let i = text.length;
  let used = 0;
  while (i > 0) {
    let start = i - 1;
    const code = text.charCodeAt(start);
    // Low surrogate: step back one more so the pair stays intact
    if (code >= 0xDC00 && code <= 0xDFFF && start > 0) start -= 1;
    const char = text.slice(start, i);
    const size = Buffer.byteLength(char, "utf8");
    if (used + size > maxBytes) break;
    used += size;
    i = start;
  }
  return text.slice(i);
}

/**
 * Render the calling agent's session page for the system prompt: what the notepad is for
 * (write nudge + read nudge), then the notes themselves, keeping the newest tail.
 * Returns "" for an assembly with no agent, since the block is about a session's own page.
 */
function renderNotepadSection(context) {
  const session = context && context.agent && context.agent.session;
  const sessionId = session && typeof session.id === "string" && session.id !== "" ? session.id : undefined;
  if (sessionId === undefined) return "";

  const key = scopeKeyOf("session", sessionId);
  const full = readNotes(key);
  const body = tailWithinBytes(full, SECTION_MAX_BYTES);

  const lines = [
    "<notepad>",
    "This session's working scratchpad; re-sent every request, so notes in it survive context compaction.",
    "Record working state you must not lose - the current goal, decisions and why, file paths, commands, ids, open threads - with notepad_write (mode=append). Read it with notepad_read or notepad_search before answering anything about earlier work in this session; do not trust the compacted transcript for those details.",
    "Facts that should outlive this session belong in long-term memory instead, not here.",
  ];
  if (body.trim() === "") {
    lines.push("(the notepad is currently empty)");
  } else {
    if (body.length < full.length) {
      lines.push(`(earlier notes trimmed; ${Buffer.byteLength(full, "utf8")} bytes in total - use notepad_read for the full page)`);
    }
    lines.push("--- notes ---");
    // A stored value must not be able to close the block early and smuggle text outside the frame
    lines.push(body.replaceAll("</notepad>", "<\\/notepad>"));
  }
  lines.push("</notepad>");

  // Read-only inheritance: a forked child starts from the working state of the session it was
  // forked from instead of an empty page. The parent's id is deliberately not disclosed (so the
  // tools cannot address that page), and notepad_write refuses it as a target regardless.
  const parentId = parentSessionIdOf(context && context.agent);
  if (parentId !== undefined) {
    const parentFull = readNotes(scopeKeyOf("session", parentId));
    if (parentFull.trim() !== "") {
      const parentBody = tailWithinBytes(parentFull, PARENT_SECTION_MAX_BYTES);
      const block = [
        "<parent-notepad readonly>",
        "The notepad of the session you were forked from, read-only. You cannot write here - record your own findings in your own notepad and report them in your reply.",
      ];
      if (parentBody.length < parentFull.length) {
        block.push("(earlier notes trimmed; the parent page is not reachable through notepad_read)");
      }
      block.push(parentBody.replaceAll("</parent-notepad>", "<\\/parent-notepad>"));
      block.push("</parent-notepad>");
      lines.push(block.join("\n"));
    }
  }
  return lines.join("\n");
}

// ---- Plugin body ----------------------------------------------------------
function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: "/api/notepad",
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://x");
        const path = url.pathname;
        const qScope = url.searchParams.get("scope");
        const qSession = url.searchParams.get("sessionId");

        // History list / single history entry (scope comes from the query)
        if (path === "/api/notepad/history" && req.method === "GET") {
          const key = scopeKeyOf(qScope, qSession);
          json(res, 200, { ok: true, items: listHistory(key) });
          return;
        }
        const histMatch = /^\/api\/notepad\/history\/([^/]+)$/.exec(path);
        if (histMatch !== null && req.method === "GET") {
          const key = scopeKeyOf(qScope, qSession);
          const id = decodeURIComponent(histMatch[1]);
          const text = readHistory(key, id);
          if (text === null) {
            json(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "history entry not found" } });
            return;
          }
          json(res, 200, { ok: true, id, text });
          return;
        }

        // SSE push stream (changes in every scope are broadcast; clients filter by scope)
        if (path === "/api/notepad/stream" && req.method === "GET") {
          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            connection: "keep-alive"
          });
          res.write("retry: 3000\n\n");
          sseClients.add(res);
          const keepalive = setInterval(() => {
            try { res.write(`: ping ${Date.now()}\n\n`); } catch {}
          }, 25000);
          req.on("close", () => {
            clearInterval(keepalive);
            sseClients.delete(res);
          });
          return;
        }

        if (path !== "/api/notepad") {
          json(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "unknown endpoint" } });
          return;
        }

        if (req.method === "GET") {
          const key = scopeKeyOf(qScope, qSession);
          const sinceRaw = url.searchParams.get("since");
          const since = sinceRaw === null ? NaN : Number(sinceRaw);
          const meta = readMeta(key);
          if (Number.isFinite(since) && since === meta.revision) {
            json(res, 200, { ok: true, text: null, revision: meta.revision });
            return;
          }
          json(res, 200, { ok: true, text: readNotes(key), revision: meta.revision });
          return;
        }

        if (req.method === "PUT") {
          const body = await readBody(req);
          if (body === null) {
            json(res, 400, { ok: false, error: { code: "INVALID", message: "invalid JSON body" } });
            return;
          }
          if (typeof body.text !== "string") {
            json(res, 400, { ok: false, error: { code: "INVALID", message: "text (string) required" } });
            return;
          }
          const key = scopeKeyOf(body.scope, body.sessionId);
          const result = writeNotes(body.text, key, body.baseRevision, body.force === true);
          if (result.conflict) {
            json(res, 409, {
              ok: false,
              error: { code: "VERSION_CONFLICT", message: "notepad changed elsewhere" },
              revision: result.revision,
              text: result.text
            });
            return;
          }
          json(res, 200, { ok: true, revision: result.revision });
          return;
        }

        json(res, 405, { ok: false, error: { code: "METHOD", message: "GET or PUT only" } });
      } catch (error) {
        ctx.logger.error(error);
        json(res, 500, { ok: false, error: { code: "INTERNAL", message: error instanceof Error ? error.message : String(error) } });
      }
    }
  }));

  // --- system-prompt section: make the notepad visible, and nudge both directions ---
  // Without this the notepad is invisible to the model: the tools exist in the catalog, but
  // nothing says what the surface is for or when to use it. Rendering the session page does
  // two jobs at once - it states the use case, and it puts what was already recorded back in
  // front of the model every turn, so notes survive compaction without a read call.
  // Reached through ctx.inject (not a declarative dependency) so a host without systemPrompt
  // still gets the tools.
  ctx.inject(["systemPrompt"], (sctx) => {
    sctx.effect(() => {
      try {
        return sctx.systemPrompt.section({
          name: "notepad:session",
          // Tail order: the block changes only when the page is written, so an accepted write
          // rewrites the prompt tail and leaves the cacheable prefix byte-identical.
          order: 1010,
          text: (context) => renderNotepadSection(context),
        });
      } catch {
        return () => {};
      }
    }, "dsh-notepad: system prompt section");
  });

  const tools = ctx.get("tools");
  if (tools === void 0) return;

  /** Get the current session id from the tool execution context (exec.agent.session). */
  function currentSessionId(exec) {
    try {
      const s = exec && exec.agent && exec.agent.session;
      if (s && typeof s.id === "string" && s.id !== "") return s.id;
    } catch {}
    return void 0;
  }

  /**
  * Tool-side scope resolution:
  * - explicit scope=global → the global page
  * - explicit scope=session → the current session's page (sessionId may be omitted; the current session is used)
  * - no scope given → the current session's page by default (falls back to the global page without session context)
  */
  function resolveToolScope(args, exec) {
    const sessionId = args.sessionId ?? currentSessionId(exec);
    if (args.scope === "session" && (sessionId === void 0 || sessionId === "")) {
      const pages = listSessionScopes();
      const hint = pages.length === 0
        ? "(there are no session-isolated pages yet)"
        : `Existing session pages: ${pages.map((p) => `"${p}"`).join(", ")}`;
      throw new Error(`No session context is available for this execution (cannot determine sessionId). ${hint}`);
    }
    if (args.scope === "session") {
      return `${SCOPE_PREFIX}${String(sessionId).replace(/[^A-Za-z0-9_-]/g, "_")}`;
    }
    if (args.scope === "global") return SCOPE_GLOBAL;
    // Not specified: default to the current session page; fall back to global without session context
    if (sessionId !== void 0 && sessionId !== "") {
      return `${SCOPE_PREFIX}${String(sessionId).replace(/[^A-Za-z0-9_-]/g, "_")}`;
    }
    return SCOPE_GLOBAL;
  }

  tools.register(defineTool({
    name: "notepad_read",
    description: "Read the contents of the persistent notepad pinned to the right side of the dsh Web GUI (user notes, plain text, stored under ~/.dsh/notepad/). By default reads the current session's isolated notepad page; scope=global reads the global page (shared by all sessions); scope=session reads a specific session's page when sessionId is given.",
    parameters: {
      scope: { type: "string", description: "Scope: global (the global page shared by all sessions) or session (a session-isolated page, defaulting to the current session)" },
      sessionId: { type: "string", description: "Optional with scope=session: the target session id; omitted means the current session" }
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args, exec) {
      const key = resolveToolScope(args ?? {}, exec);
      const text = readNotes(key);
      return text.trim() === "" ? `(${key} notepad is empty)` : text;
    }
  }));
  tools.register(defineTool({
    name: "notepad_write",
    description: "Write to or append to the persistent notepad (the sticky note pinned to the right side of the dsh Web GUI, stored under ~/.dsh/notepad/). By default writes to the current session's isolated notepad page (each Agent session keeps its own working memory without interference); scope=global writes to the global page. mode=replace overwrites the whole file; mode=append appends at the end with per-line dedupe. timestamp=true prefixes each line with [MM-DD HH:mm].",
    parameters: {
      text: { type: "string", required: true, description: "The note content to write (may be multiple lines)" },
      mode: { type: "string", description: "replace (default, overwrites the whole file) or append (appends at the end, deduped by line)" },
      timestamp: { type: "string", description: "When true, prefixes each written line with a [MM-DD HH:mm] timestamp (default false)" },
      scope: { type: "string", description: "Scope: session (default, the current session's isolated page) or global (shared by all sessions)" },
      sessionId: { type: "string", description: "Optional with scope=session: the target session id; omitted means the current session" }
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args, exec) {
      const refusal = parentWriteRefusal(args, exec && exec.agent);
      if (refusal !== undefined) throw new Error(refusal);
      const key = resolveToolScope(args, exec);
      const current = readNotes(key);
      let incoming = String(args.text ?? "");
      if (args.timestamp === "true" || args.timestamp === true) {
        const d = new Date();
        const p = (n) => String(n).padStart(2, "0");
        const stamp = `[${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}]`;
        incoming = incoming.split("\n").map((l) => (l.trim() === "" ? l : `${stamp} ${l}`)).join("\n");
      }
      if (args.mode === "append") {
        const lines = incoming.split("\n");
        const existing = new Set(current.split("\n").map((l) => l.trim()));
        const fresh = lines.filter((l) => l.trim() !== "" && !existing.has(l.trim()));
        if (fresh.length === 0) return "The content already exists in the notepad; nothing was appended.";
        const text = current.trim() === "" ? fresh.join("\n") : `${current}\n${fresh.join("\n")}`;
        writeNotes(text, key, void 0, false);
        return `Appended ${fresh.length} line(s), skipped ${lines.length - fresh.length} duplicate line(s) (${key}).`;
      }
      writeNotes(incoming, key, void 0, false);
      return `Wrote to the notepad (${key}).`;
    }
  }));
  tools.register(defineTool({
    name: "notepad_search",
    description: "Search the notepad by keyword (case-insensitive substring match). By default searches the global page plus all session-isolated pages; with scope=session searches only the specified session's page (omitting sessionId uses the current session). Returns matching lines, the page they are on, and line numbers.",
    parameters: {
      query: { type: "string", required: true, description: "Search keyword" },
      scope: { type: "string", description: "Limit the scope: global or session (omitted searches all pages)" },
      sessionId: { type: "string", description: "Optional with scope=session: the target session id; omitted means the current session" },
      limit: { type: "string", description: "Maximum number of lines to return (default 20)" }
    },
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: String(value) }] },
    async execute(args, exec) {
      const q = String(args.query ?? "").trim().toLowerCase();
      if (q === "") return "Search keyword cannot be empty.";
      const limit = Number(args.limit) > 0 ? Number(args.limit) : 20;
      const targets = [];
      if (args.scope === "session" || args.scope === "global") {
        const key = resolveToolScope({ ...args, scope: "session" }, exec);
        targets.push(key);
      } else {
        targets.push(SCOPE_GLOBAL);
        for (const id of listSessionScopes()) targets.push(`${SCOPE_PREFIX}${id}`);
      }
      const hits = [];
      for (const key of targets) {
        const text = readNotes(key);
        if (text.trim() === "") continue;
        text.split("\n").forEach((line, i) => {
          if (line.toLowerCase().includes(q)) hits.push({ key, line: i + 1, text: line.trim() });
        });
      }
      if (hits.length === 0) return `No content containing "${args.query}" was found.`;
      const shown = hits.slice(0, limit);
      const lines = shown.map((hit) => {
        const page = hit.key === SCOPE_GLOBAL ? "global" : `session:${hit.key.slice(SCOPE_PREFIX.length).slice(0, 12)}`;
        return `[${page}] L${hit.line} ${hit.text.slice(0, 120)}`;
      });
      const more = hits.length - shown.length;
      return `${hits.length} match(es):\n${lines.join("\n")}${more > 0 ? `\n(${more} more; increase limit to see them)` : ""}`;
    }
  }));
}

export { apply, inject, name };
