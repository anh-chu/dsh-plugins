// Host half of dsh-session-model-badge: answers Client model-history reads
// over the connection RPC channel using the live sessionQuery service.

const name = "dsh-session-model-badge";
const inject = ["connection"];
const CHANNEL = "/dsh-session-model-badge";

function failure(code, message) {
  return { ok: false, error: { code, message, details: {} } };
}

async function readModels(ctx, sessionId) {
  const sessionQuery = ctx.get("sessionQuery");
  if (!sessionQuery || typeof sessionQuery.readSession !== "function") {
    return { ok: true, value: { models: [] } };
  }
  try {
    const snap = await sessionQuery.readSession(sessionId);
    const events = (snap && snap.events) || [];
    const seen = [];
    const keys = new Set();
    for (const ev of events) {
      if (!ev || ev.type !== "request/header") continue;
      const cfg = ev.data && ev.data.header && ev.data.header.config;
      if (!cfg || typeof cfg.provider !== "string" || typeof cfg.model !== "string") continue;
      const effort = typeof cfg.reasoningEffort === "string" ? cfg.reasoningEffort : undefined;
      const key = `${cfg.provider}\n${cfg.model}\n${effort || ""}`;
      if (keys.has(key)) continue;
      keys.add(key);
      const m = { provider: cfg.provider, model: cfg.model };
      if (effort !== undefined) m.reasoningEffort = effort;
      seen.push(m);
    }
    return { ok: true, value: { models: seen } };
  } catch (error) {
    return { ok: true, value: { models: [], error: error instanceof Error ? error.message : String(error) } };
  }
}

function apply(ctx) {
  const rpcHandle = ctx.connection?.rpc?.handle;
  if (typeof rpcHandle === "function") {
    ctx.effect(
      () =>
        rpcHandle.call(ctx.connection.rpc, CHANNEL, async (endpoint, payload) => {
          if (endpoint !== "get-models") return failure("badge/unknown-endpoint", "unknown endpoint");
          const sessionId = payload?.sessionId;
          if (typeof sessionId !== "string" || sessionId === "") return { ok: true, value: { models: [] } };
          return readModels(ctx, sessionId);
        }),
      "dsh-session-model-badge: rpc",
    );
  }
}

export { apply, inject, name };
