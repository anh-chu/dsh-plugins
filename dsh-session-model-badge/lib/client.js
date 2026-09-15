window.__ModuleLoader__.load({
  id: "dsh-session-model-badge",
  factory: (require) => {
    const module = { exports: {} };
    const React = require("react");

    const CHANNEL = "/dsh-session-model-badge";

    const WRAP_STYLE = { display: "flex", alignItems: "center", gap: 4, maxWidth: "100%", overflow: "hidden" };
    const PILL_STYLE = {
      display: "inline-flex",
      alignItems: "center",
      maxWidth: 220,
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      fontSize: 11,
      lineHeight: 1.5,
      padding: "0 8px",
      borderRadius: 999,
      border: "1px solid var(--dsw-alias-border-l1)",
      background: "var(--dsw-alias-bg-layer-1)",
      color: "var(--dsw-alias-label-secondary)",
    };
    const CURRENT_STYLE = { ...PILL_STYLE, color: "var(--dsw-alias-label-primary)" };
    const PENDING_STYLE = { ...PILL_STYLE, borderStyle: "dashed", opacity: 0.8 };

    function sameSelection(a, b) {
      if (a === b) return true;
      if (a == null || b == null) return false;
      return (
        a.provider === b.provider &&
        a.model === b.model &&
        (a.reasoningEffort || undefined) === (b.reasoningEffort || undefined)
      );
    }

    function labelOf(m) {
      return `${m.provider}/${m.model}`;
    }

    function titleOf(m, pending) {
      let t = `${m.provider}/${m.model}`;
      if (m.reasoningEffort) t += ` (${m.reasoningEffort})`;
      if (pending) t += " \u2014 selected for next request";
      return t;
    }

    function rpcOf(ctx) {
      const rpc = ctx.get("connection")?.rpc;
      return typeof rpc?.call === "function" ? rpc.call.bind(rpc) : undefined;
    }

    function ModelBadge(ctx) {
      return function Badge(props) {
        const sessionId = props.sessionId;
        const address = props.useSession((s) => (s && s.subagent && s.subagent.address) || null);
        const proj = props.useProjection("modelSelection");
        const effectiveId =
          address && typeof address.childSessionId === "string" ? address.childSessionId : sessionId;
        const lastUsed = (proj && proj.lastUsed) || null;
        const next = (proj && proj.next) || null;
        const projJson = JSON.stringify(proj === undefined ? null : proj);
        const [history, setHistory] = React.useState([]);
        React.useEffect(() => {
          let live = true;
          const call = rpcOf(ctx);
          if (!effectiveId || !call) {
            setHistory([]);
            return undefined;
          }
          call(CHANNEL, "get-models", { sessionId: effectiveId }).then(
            (result) => {
              if (!live) return;
              const arr = result && result.ok === true && result.value ? result.value.models : undefined;
              setHistory(Array.isArray(arr) ? arr : []);
            },
            () => {
              if (live) setHistory([]);
            },
          );
          return () => {
            live = false;
          };
        }, [effectiveId, projJson]);

        let items = [];
        if (history.length > 0) {
          items = history.map((m) => ({ value: m, pending: false }));
        } else if (lastUsed !== null) {
          items = [{ value: lastUsed, pending: false }];
        } else if (next !== null) {
          items = [{ value: next, pending: true }];
        }
        if (next !== null && items.length > 0) {
          const last = items[items.length - 1].value;
          if (!sameSelection(last, next)) items.push({ value: next, pending: true });
        }
        if (items.length === 0) return null;

        const pills = items.map((it, i) => {
          const style = it.pending ? PENDING_STYLE : i === items.length - 1 ? CURRENT_STYLE : PILL_STYLE;
          return React.createElement(
            "span",
            { key: String(i), style, title: titleOf(it.value, it.pending) },
            labelOf(it.value),
          );
        });
        const wrapTitle = items.map((it) => titleOf(it.value, it.pending)).join(", ");
        return React.createElement("span", { style: WRAP_STYLE, title: wrapTitle }, pills);
      };
    }

    function apply(ctx) {
      const handle = ctx.inject(["slots"], (raw) => {
        const slots = raw.slots;
        if (slots === undefined) return;
        const disposers = [];
        const own = (value) => {
          if (typeof value === "function") disposers.push(value);
        };
        const Badge = ModelBadge(ctx);
        own(
          slots.inject("conversation.session.header.actions", () =>
            slots.register(
              {
                name: "conversation.session.header.actions",
                id: "session-model-badge",
                order: -100,
                label: "Session models",
              },
              Badge,
            ),
          ),
        );
        return () => {
          for (const dispose of disposers.reverse()) dispose();
        };
      });
      ctx.effect(() => () => handle?.dispose?.(), "dsh-session-model-badge: header badge");
    }

    module.exports = { apply, inject: ["slots"], name: "dsh-session-model-badge" };
    return module.exports;
  },
});
