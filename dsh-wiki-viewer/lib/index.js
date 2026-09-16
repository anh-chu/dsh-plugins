import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import z from "@deepseek-ai/schemastery";

const name = "dsh-wiki-viewer";
const inject = ["webServer", "connection"];
const CHANNEL = "/dsh-wiki-viewer";
const WIKI_ROUTE = "/__dsh/wiki";
// Last-known-good release. Used only when the npm registry cannot be reached;
// otherwise the plugin installs and offers the latest published release.
const WIKI_VERSION = "2.19.0";
const WIKI_PACK = "wiki-viewer";
const NPM_LATEST_URL = "https://registry.npmjs.org/wiki-viewer/latest";
const SETTINGS_NS = "dsh-wiki-viewer";
// Action-only settings card (the update button lives in the client half);
// an empty schema still serves the namespace so the Plugins tab dispatches it.
const SettingsSchema = z.object({});
const DEFAULT_ROOT = join(process.env.DSH_WIKI_VIEWER_ROOT ?? join(process.env.DSH_HOME ?? homedir(), "wiki-viewer"));

function failure(code, message) {
  return { ok: false, error: { code, message, details: {} } };
}

function filePathOf(address, sessionId) {
  if (typeof address !== "string" || address === "") return "";
  const prefix = "dsh-resource://file/session/";
  if (!address.startsWith(prefix)) return "";
  const rest = address.slice(prefix.length);
  const slash = rest.indexOf("/");
  if (slash < 1) return "";
  try {
    if (decodeURIComponent(rest.slice(0, slash)) !== sessionId) return "";
    return rest.slice(slash + 1).split("/").map(decodeURIComponent).join("/");
  } catch {
    return "";
  }
}

function copyHeaders(source, port) {
  const headers = {};
  for (const name of ["accept", "accept-encoding", "accept-language", "cache-control", "content-type", "if-none-match", "if-modified-since", "range", "user-agent"]) {
    if (source[name] !== undefined) headers[name] = source[name];
  }
  if (source.origin) headers.origin = `http://127.0.0.1:${port}`;
  return headers;
}

function grantFromRequest(req, url) {
  const fromQuery = url.searchParams.get("grant");
  if (fromQuery) return fromQuery;
  const cookie = req.headers.cookie ?? "";
  const match = cookie.match(/(?:^|;\s*)dsh_wiki_grant=([^;]+)/);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return "";
  }
}

async function grantStillValid(ctx, entry) {
  const sessions = ctx.get("sessions");
  const fs = ctx.get("fs");
  const session = typeof sessions?.get === "function" ? sessions.get(entry.sessionId) : undefined;
  const cwd = session?.header?.cwd;
  if (typeof cwd !== "string" || typeof fs?.resolve !== "function" || typeof fs?.contains !== "function" || typeof fs?.lstat !== "function") return false;
  const cwdInfo = await fs.lstat(cwd);
  if (cwdInfo?.type !== "directory") return false;
  const root = await fs.resolve(cwd);
  if (fs.processPath(root) !== entry.root) return false;
  if (entry.file === "") return true;
  const target = await fs.resolve(entry.file, { cwd });
  if (!fs.contains(root, target)) return false;
  const info = await fs.lstat(entry.file, { cwd });
  return info?.type === "file";
}

function proxyRequest(req, res, port, root, file, path, grant) {
  const url = new URL(req.url ?? "/", "http://dsh.internal");
  const upstreamPath = path === WIKI_ROUTE ? "/" : path.startsWith(`${WIKI_ROUTE}/`) ? path.slice(WIKI_ROUTE.length) : path;
  const query = new URLSearchParams(url.search);
  query.delete("grant");
  query.set("root", root);
  if (file !== "") query.set("file", file);
  if (path === WIKI_ROUTE) {
    query.set("embed", "1");
    query.set("chrome", "1");
  }
  const upstream = request({
    hostname: "127.0.0.1",
    port,
    method: req.method,
    path: `${upstreamPath}${query.toString() ? `?${query}` : ""}`,
    headers: { ...copyHeaders(req.headers, port), host: `127.0.0.1:${port}` },
  }, (upstreamResponse) => {
    const headers = { ...upstreamResponse.headers };
    delete headers["set-cookie"];
    if (path === WIKI_ROUTE) {
      headers["set-cookie"] = [`dsh_wiki_grant=${encodeURIComponent(grant)}; Path=/; HttpOnly; SameSite=Strict`];
    }
    const location = headers.location;
    if (typeof location === "string" && location.startsWith("/") && !location.startsWith(`${WIKI_ROUTE}/`) && location !== WIKI_ROUTE) {
      headers.location = `${WIKI_ROUTE}${location}`;
    }
    res.writeHead(upstreamResponse.statusCode ?? 502, headers);
    upstreamResponse.pipe(res);
  });
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end("wiki viewer unavailable");
  });
  req.pipe(upstream);
}

function readInstalledVersion(root) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    return typeof pkg.version === "string" && pkg.version !== "" ? pkg.version : null;
  } catch {
    return null;
  }
}

function installComplete(root) {
  return existsSync(join(root, "bin", "wiki-viewer-lite.js")) && existsSync(join(root, ".next", "standalone", "server.js"));
}

// Installed release version, or null when no usable install exists.
// Any complete install counts: the plugin no longer downgrades a newer
// release back to the pinned fallback version.
function installedVersion(root) {
  if (!installComplete(root)) return null;
  return readInstalledVersion(root);
}

function compareVersions(a, b) {
  const na = String(a).split(".").map((part) => parseInt(part, 10) || 0);
  const nb = String(b).split(".").map((part) => parseInt(part, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((na[i] ?? 0) > (nb[i] ?? 0)) return 1;
    if ((na[i] ?? 0) < (nb[i] ?? 0)) return -1;
  }
  return 0;
}

async function fetchLatestVersion() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(NPM_LATEST_URL, {
      headers: { accept: "application/json", "user-agent": "deepseek-harness/dsh-wiki-viewer" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`registry responded with ${response.status}`);
    const data = await response.json();
    if (typeof data?.version !== "string" || data.version === "") throw new Error("registry response has no version");
    return data.version;
  } finally {
    clearTimeout(timer);
  }
}

async function runManaged(ctx, argv, cwd) {
  const subprocess = ctx.get("subprocess");
  if (typeof subprocess?.spawn !== "function") throw new Error("subprocess service unavailable");
  const handle = subprocess.spawn({
    argv,
    cwd,
    stdio: { stdin: "ignore", stdout: "inherit", stderr: "inherit" },
    graceMs: 120000,
  });
  const outcome = await handle.done;
  if (outcome.exitCode !== 0) throw new Error(`${argv[0]} exited with ${outcome.exitCode ?? outcome.signal ?? "failure"}`);
}

async function installViewer(ctx, root, version) {
  mkdirSync(join(root, ".."), { recursive: true });
  const staging = `${root}.new-${process.pid}`;
  const backup = `${root}.old`;
  const temp = mkdtempSync(join(tmpdir(), "dsh-wiki-viewer-"));
  const pack = join(temp, "pack");
  mkdirSync(pack);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    await runManaged(ctx, ["npm", "pack", `${WIKI_PACK}@${version}`, "--pack-destination", pack], pack);
    const tgz = readdirSync(pack).find((entry) => entry.endsWith(".tgz"));
    if (!tgz) throw new Error("npm pack produced no wiki-viewer archive");
    await runManaged(ctx, ["tar", "-xzf", join(pack, tgz), "-C", staging, "--strip-components=1"], staging);
    if (!installComplete(staging) || readInstalledVersion(staging) !== version) {
      throw new Error(`wiki-viewer ${version} is missing its lite build`);
    }
    rmSync(backup, { recursive: true, force: true });
    if (existsSync(root)) renameSync(root, backup);
    renameSync(staging, root);
    rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (!existsSync(root) && existsSync(backup)) renameSync(backup, root);
    throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(temp, { recursive: true, force: true });
  }
}

async function ensureViewer(ctx) {
  const override = process.env.DSH_WIKI_VIEWER_ROOT;
  const root = override ?? DEFAULT_ROOT;
  if (installedVersion(root)) return root;
  if (override) throw new Error(`wiki viewer not found at ${root}`);
  let target = WIKI_VERSION;
  try {
    target = await fetchLatestVersion();
  } catch {
    // Offline: fall back to the last-known-good release.
  }
  await installViewer(ctx, root, target);
  return root;
}

async function startViewer(ctx) {
  const root = await ensureViewer(ctx);
  const bin = process.env.DSH_WIKI_VIEWER_BIN ?? join(root, "bin", "wiki-viewer-lite.js");
  if (!existsSync(bin)) throw new Error(`wiki viewer not found: ${bin}`);
  const subprocess = ctx.get("subprocess");
  if (typeof subprocess?.spawn !== "function") throw new Error("subprocess service unavailable");
  const handle = subprocess.spawn({
    argv: [process.execPath, bin],
    cwd: root,
    stdio: { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    graceMs: 3000,
    env: { WIKI_URL_PREFIX: WIKI_ROUTE },
  });
  let buffer = "";
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("wiki viewer startup timed out")), 20000);
      handle.stdout?.on("data", (chunk) => {
        buffer += chunk.toString();
        const match = buffer.match(/WIKI_LITE_PORT=(\d+)/);
        if (!match) return;
        clearTimeout(timer);
        resolve(Number(match[1]));
      });
      handle.done.catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    return { handle, port, root };
  } catch (error) {
    handle.terminate();
    await handle.waitForExit().catch(() => {});
    throw error;
  }
}

function apply(ctx) {
  const grants = new Map();
  let viewerPromise;
  let updatePromise;

  // Serve the settings namespace so Settings → Plugins → Plugin
  // configuration dispatches this plugin's card (which hosts the update
  // button). Inert when no settings provider is composed.
  ctx.inject(["settings"], (sctx) => {
    sctx.settings.register(SETTINGS_NS, SettingsSchema);
  });

  const prepare = async (payload) => {
    const sessionId = payload?.sessionId;
    const sessions = ctx.get("sessions");
    const session = typeof sessions?.get === "function" ? sessions.get(sessionId) : undefined;
    const cwd = session?.header?.cwd;
    if (typeof sessionId !== "string" || typeof cwd !== "string" || cwd === "") return failure("wiki/no-workspace", "session workspace unavailable");
    const file = filePathOf(payload?.address, sessionId);
    if (payload?.address !== undefined && file === "") return failure("wiki/invalid-file", "file address is not a Session file");
    const fs = ctx.get("fs");
    if (typeof fs?.resolve !== "function" || typeof fs?.contains !== "function" || typeof fs?.lstat !== "function") return failure("wiki/no-filesystem", "filesystem capability unavailable");
    const rootInfo = await fs.lstat(cwd);
    if (rootInfo?.type !== "directory") return failure("wiki/no-workspace", "session workspace is unavailable");
    const root = await fs.resolve(cwd);
    const target = file === "" ? root : await fs.resolve(file, { cwd });
    if (!fs.contains(root, target)) return failure("wiki/outside-workspace", "file is outside the Session workspace");
    const info = await fs.lstat(file === "" ? cwd : file, { cwd });
    if (file !== "" && info?.type !== "file") return failure("wiki/not-file", "target is not a regular file");
    if (!viewerPromise) viewerPromise = startViewer(ctx);
    let viewer;
    try {
      viewer = await viewerPromise;
    } catch (error) {
      viewerPromise = undefined;
      throw error;
    }
    const grant = randomUUID();
    const rootPath = fs.processPath(root);
    grants.set(grant, { sessionId, root: rootPath, file, port: viewer.port, expiresAt: Date.now() + 10 * 60 * 1000 });
    const params = new URLSearchParams({ grant, root: rootPath });
    if (file !== "") params.set("file", file);
    return { ok: true, value: { url: `${WIKI_ROUTE}?${params}` } };
  };

  const describeVersion = async () => {
    const override = process.env.DSH_WIKI_VIEWER_ROOT;
    const root = override ?? DEFAULT_ROOT;
    const installed = installedVersion(root);
    let latest = null;
    let latestError = "";
    try {
      latest = await fetchLatestVersion();
    } catch (error) {
      latestError = error instanceof Error ? error.message : "version check failed";
    }
    return {
      ok: true,
      value: {
        installed,
        latest,
        latestError,
        fallback: WIKI_VERSION,
        root,
        managed: !override,
        updateAvailable: latest !== null && installed !== null && compareVersions(latest, installed) > 0,
      },
    };
  };

  const updateViewer = () => {
    if (updatePromise) return updatePromise;
    updatePromise = (async () => {
      try {
        if (process.env.DSH_WIKI_VIEWER_ROOT) {
          throw new Error("a custom DSH_WIKI_VIEWER_ROOT is set; update that checkout manually");
        }
        const root = DEFAULT_ROOT;
        const latest = await fetchLatestVersion();
        const current = installedVersion(root);
        if (current === latest) return { ok: true, value: { updated: false, version: current } };
        await installViewer(ctx, root, latest);
        if (viewerPromise) {
          try {
            const viewer = await viewerPromise;
            viewer.handle?.terminate();
            await viewer.handle?.waitForExit?.().catch(() => {});
          } catch {}
          viewerPromise = undefined;
        }
        return { ok: true, value: { updated: true, previous: current, version: latest } };
      } catch (error) {
        return failure("wiki/update-failed", error instanceof Error ? error.message : "wiki viewer update failed");
      } finally {
        updatePromise = undefined;
      }
    })();
    return updatePromise;
  };

  const rpcHandle = ctx.connection?.rpc?.handle;
  if (typeof rpcHandle === "function") {
    ctx.effect(() => rpcHandle.call(ctx.connection.rpc, CHANNEL, async (endpoint, payload) => {
      try {
        if (endpoint === "prepare") return await prepare(payload);
        if (endpoint === "version") return await describeVersion();
        if (endpoint === "update") return await updateViewer();
        return failure("wiki/unknown-endpoint", "unknown endpoint");
      } catch (error) {
        return failure("wiki/unavailable", error instanceof Error ? error.message : "wiki viewer unavailable");
      }
    }), "dsh-wiki-viewer: rpc");
  }

  ctx.effect(() => {
    const handler = async (req, res) => {
      const rejection = ctx.connection.requestRejection(req);
      if (rejection !== void 0) {
        res.writeHead(rejection);
        res.end(rejection === 401 ? "unauthorized" : "forbidden");
        return;
      }
      const url = new URL(req.url ?? "/", "http://dsh.internal");
      const grant = grantFromRequest(req, url);
      const entry = grant ? grants.get(grant) : undefined;
      if (entry && entry.expiresAt <= Date.now()) {
        grants.delete(grant);
      }
      if (!entry || entry.expiresAt <= Date.now()) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end("wiki grant required");
        return;
      }
      try {
        if (!(await grantStillValid(ctx, entry))) {
          grants.delete(grant);
          res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
          res.end("wiki grant is no longer valid");
          return;
        }
      } catch {
        res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
        res.end("wiki workspace unavailable");
        return;
      }
      proxyRequest(req, res, entry.port, entry.root, entry.file, url.pathname, grant);
    };
    const disposeWiki = ctx.webServer.register({ kind: "prefix", path: WIKI_ROUTE, handler });
    const disposeAssets = ctx.webServer.register({ kind: "prefix", path: "/_next", handler });
    return () => {
      disposeAssets();
      disposeWiki();
    };
  }, "dsh-wiki-viewer: proxy");

  ctx.effect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      for (const [grant, entry] of grants) {
        if (entry.expiresAt <= now) grants.delete(grant);
      }
    }, 60_000);
    return () => clearInterval(timer);
  }, "dsh-wiki-viewer: grant cleanup");

  ctx.effect(() => async () => {
    for (const grant of grants.keys()) grants.delete(grant);
    if (!viewerPromise) return;
    try {
      const viewer = await viewerPromise;
      if (!viewer.handle) return;
      viewer.handle.terminate();
      await viewer.handle.waitForExit();
    } catch {}
  }, "dsh-wiki-viewer: teardown");
}

export { apply, inject, name };
