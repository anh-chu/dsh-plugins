window.__ModuleLoader__.load({
  id: "dsh-wiki-viewer",
  factory: (require) => {
    const module = { exports: {} };
    const React = require("react");

    const BROWSER_ID = "dsh-wiki-viewer/browser";
    const FILE_ID = "dsh-wiki-viewer/file";
    const BROWSER_KIND = "dsh-wiki-browser";
    const FILE_KIND = "dsh-wiki-file";
    const CHANNEL = "/dsh-wiki-viewer";

    const FILE_PREFIX = "dsh-resource://file/session/";

    // The Session-relative path inside a file address, or undefined when the
    // address is not this Session's file resource. Mirrors the host's parser;
    // only its presence matters here (the host re-validates and resolves it).
    function filePathIn(address) {
      if (typeof address !== "string" || !address.startsWith(FILE_PREFIX)) return undefined;
      const rest = address.slice(FILE_PREFIX.length);
      const slash = rest.indexOf("/");
      return slash < 1 ? undefined : rest.slice(slash + 1);
    }

    function rpcOf(ctx) {
      const rpc = ctx.get("connection")?.rpc;
      return typeof rpc?.call === "function" ? rpc.call.bind(rpc) : undefined;
    }

    // Plain-text bodies the proxy host half answers with when the frame's
    // grant is missing, expired, or the viewer is down. The frame is
    // same-origin, so the panel can read its own frame and turn these into a
    // Retry (fresh prepare) instead of a dead page.
    const FRAME_ERRORS = [
      "wiki grant required",
      "wiki grant is no longer valid",
      "wiki workspace unavailable",
      "wiki viewer unavailable",
    ];

    // The grant cookie is not a reliable transport (browsers can refuse to
    // store it while the page itself loads fine via ?grant=). The frame is
    // same-origin, so the panel staples the grant it already holds onto the
    // frame's own fetch calls instead of depending on the cookie. The grant
    // travels in the query string exactly like the initial page load, and the
    // proxy strips it before proxying upstream, so the viewer never sees it.
    function wrapFrameFetch(frame, grant, route) {
      if (!grant || !route) return;
      let win;
      try {
        win = frame.contentWindow;
        if (!win || typeof win.fetch !== "function") return;
        if (win.fetch.__dshWikiGrant === grant) return;
      } catch {
        return;
      }
      const innerFetch = win.fetch.bind(win);
      const wrapped = (input, init) => {
        try {
          const url = new URL(
            typeof input === "string" || input instanceof URL ? input : input.url,
            win.location.href,
          );
          if (url.origin === win.location.origin &&
            (url.pathname === route || url.pathname.startsWith(`${route}/`)) &&
            !url.searchParams.has("grant")) {
            url.searchParams.set("grant", grant);
            if (typeof input === "string" || input instanceof URL) input = url.toString();
            else if (typeof win.Request === "function") input = new win.Request(url.toString(), input);
          }
        } catch {
          // Leave the request untouched when it cannot be parsed.
        }
        return innerFetch(input, init);
      };
      wrapped.__dshWikiGrant = grant;
      try {
        win.fetch = wrapped;
      } catch {
        // Cross-origin or frozen: fall back to cookie transport.
      }
    }

    function ViewerBody(ctx) {
      return function Body({ useTabInfo, sessionId }) {
        const { tab } = useTabInfo();
        const [attempt, setAttempt] = React.useState(0);
        const [state, setState] = React.useState({ loading: true, src: "", error: "" });
        const frameRef = React.useRef(null);
        // Latest grant/route for the fetch wrapper. Refreshed every render so
        // a Retry (new grant) takes effect without remounting the frame.
        const grantRef = React.useRef({ grant: "", route: "" });
        try {
          const srcUrl = new URL(state.src, "http://dsh.internal");
          grantRef.current = {
            grant: srcUrl.searchParams.get("grant") ?? "",
            route: srcUrl.pathname,
          };
        } catch {
          grantRef.current = { grant: "", route: "" };
        }
        // Re-patch the frame's fetch on a tick: viewer boot fetches can fire
        // before the frame's load event, and in-frame navigations swap the
        // window the patch lives on. Each tick is a no-op when already patched.
        React.useEffect(() => {
          const applyWrap = () => {
            const frame = frameRef.current;
            if (frame) wrapFrameFetch(frame, grantRef.current.grant, grantRef.current.route);
          };
          applyWrap();
          const timer = setInterval(applyWrap, 100);
          return () => clearInterval(timer);
        }, []);
        React.useEffect(() => {
          const call = rpcOf(ctx);
          if (!call) {
            setState({ loading: false, src: "", error: "Connection unavailable." });
            return undefined;
          }
          let live = true;
          const address = tab.kind === FILE_KIND ? tab.contentId : undefined;
          setState({ loading: true, src: "", error: "" });
          call(CHANNEL, "prepare", { sessionId, address }).then((result) => {
            if (!live) return;
            if (result?.ok !== true || typeof result.value?.url !== "string") {
              setState({ loading: false, src: "", error: result?.error?.message ?? "Wiki Viewer unavailable." });
              return;
            }
            setState({ loading: false, src: result.value.url, error: "" });
          }).catch((error) => {
            if (live) setState({ loading: false, src: "", error: error instanceof Error ? error.message : "Wiki Viewer unavailable." });
          });
          return () => { live = false; };
        }, [sessionId, tab.contentId, tab.kind, attempt]);

        if (state.loading) return React.createElement("p", { style: { padding: "1rem" } }, "Starting Wiki Viewer…");
        if (state.error) return React.createElement("div", { style: { padding: "1rem", color: "var(--dsh-color-danger, #b42318)" } },
          React.createElement("p", null, state.error),
          React.createElement("button", { type: "button", onClick: () => setAttempt((value) => value + 1) }, "Retry")
        );
        const checkFrame = () => {
          let text = "";
          try {
            text = String(frameRef.current?.contentDocument?.body?.innerText ?? "").trim();
          } catch {
            return;
          }
          if (text !== "" && FRAME_ERRORS.some((marker) => text.startsWith(marker))) {
            setState((prev) => prev.error !== "" ? prev : { loading: false, src: "", error: `Wiki session expired (${text}). Retry to reconnect.` });
          }
        };
        return React.createElement("iframe", {
          title: tab.title,
          src: state.src,
          ref: frameRef,
          style: { width: "100%", height: "100%", border: "0" },
          referrerPolicy: "no-referrer",
          onLoad: () => {
            const frame = frameRef.current;
            if (frame) wrapFrameFetch(frame, grantRef.current.grant, grantRef.current.route);
            checkFrame();
            setTimeout(checkFrame, 2000);
          }
        });
      };
    }

    function ViewerTitle({ useTabInfo }) {
      return React.createElement(React.Fragment, null, useTabInfo().tab.title);
    }

    function SettingsCard(ctx) {
      return function Card() {
        const [open, setOpen] = React.useState(false);
        const [state, setState] = React.useState({ status: "loading" });
        const [updating, setUpdating] = React.useState(false);
        const [message, setMessage] = React.useState("");
        const load = React.useCallback(() => {
          const call = rpcOf(ctx);
          if (!call) {
            setState({ status: "error", error: "Connection unavailable." });
            return;
          }
          setState({ status: "loading" });
          setMessage("");
          call(CHANNEL, "version", {}).then((result) => {
            if (result?.ok === true) setState({ status: "ready", info: result.value });
            else setState({ status: "error", error: result?.error?.message ?? "Version check failed." });
          }).catch((error) => {
            setState({ status: "error", error: error instanceof Error ? error.message : "Version check failed." });
          });
        }, []);
        React.useEffect(() => { load(); }, [load]);
        const onUpdate = () => {
          const call = rpcOf(ctx);
          if (!call || updating) return;
          setUpdating(true);
          setMessage("");
          call(CHANNEL, "update", {}).then((result) => {
            setUpdating(false);
            if (result?.ok === true) {
              setMessage(result.value.updated
                ? `Updated to wiki-viewer ${result.value.version}.`
                : `Already on the latest release (${result.value.version ?? "unknown"}).`);
              load();
            } else {
              setMessage(result?.error?.message ?? "Update failed.");
            }
          }).catch((error) => {
            setUpdating(false);
            setMessage(error instanceof Error ? error.message : "Update failed.");
          });
        };

        const info = state.status === "ready" ? state.info : null;
        const buttonLabel = updating
          ? "Updating…"
          : info === null ? "Update"
          : info.installed === null ? "Install wiki-viewer"
          : info.latest === null ? "Retry version check"
          : info.installed === info.latest ? "Up to date"
          : `Update to ${info.latest}`;
        const row = { display: "flex", justifyContent: "space-between", gap: "0.5rem", padding: "0.15rem 0" };
        return React.createElement("li", {
          style: { listStyle: "none", border: "1px solid var(--dsh-color-border, #e2e2e2)", borderRadius: "8px", marginBottom: "0.75rem", overflow: "hidden" }
        },
          React.createElement("button", {
            type: "button",
            "aria-expanded": open,
            onClick: () => setOpen((value) => !value),
            style: { display: "flex", width: "100%", alignItems: "center", justifyContent: "space-between", gap: "0.5rem", padding: "0.75rem 1rem", background: "transparent", border: "0", cursor: "pointer", textAlign: "left" }
          },
            React.createElement("span", null,
              React.createElement("span", { style: { display: "block", fontWeight: "600" } }, "Wiki Viewer"),
              React.createElement("span", { style: { display: "block", fontSize: "0.85em", opacity: "0.7" } }, "Local wiki-viewer release")
            ),
            React.createElement("span", { style: { opacity: "0.6" } }, open ? "▾" : "▸")
          ),
          open ? React.createElement("div", { style: { padding: "0 1rem 1rem" } },
            state.status === "loading" ? React.createElement("p", null, "Checking versions…") : null,
            state.status === "error" ? React.createElement("div", null,
              React.createElement("p", { style: { color: "var(--dsh-color-danger, #b42318)" } }, state.error),
              React.createElement("button", { type: "button", onClick: load }, "Retry")
            ) : null,
            info !== null ? React.createElement("div", null,
              React.createElement("div", { style: row },
                React.createElement("span", null, "Installed"),
                React.createElement("code", null, info.installed ?? "not installed")
              ),
              React.createElement("div", { style: row },
                React.createElement("span", null, "Latest release"),
                React.createElement("code", null, info.latest ?? (info.latestError !== "" ? `check failed (${info.latestError})` : "checking…"))
              ),
              info.managed ? null : React.createElement("p", { style: { fontSize: "0.85em", opacity: "0.75" } },
                "A custom DSH_WIKI_VIEWER_ROOT is set; update that checkout manually."
              ),
              React.createElement("div", { style: { display: "flex", gap: "0.5rem", marginTop: "0.5rem", alignItems: "center" } },
                React.createElement("button", {
                  type: "button",
                  disabled: updating || (info.managed && info.latest !== null && info.installed === info.latest),
                  onClick: info.latest === null ? load : onUpdate
                }, buttonLabel),
                message !== "" ? React.createElement("span", { style: { fontSize: "0.85em" } }, message) : null
              )
            ) : null
          ) : null
        );
      };
    }

    function FileAction(ctx) {
      return function Action({ tab, dismiss }) {
        if (filePathIn(tab?.contentId) === undefined) return null;
        return React.createElement("button", {
          type: "button",
          onClick: () => {
            // openResource takes the address alone; the type claiming it wins.
            ctx.get("sidebarRight")?.openResource(tab.contentId);
            dismiss();
          }
        }, "Open in Wiki Viewer");
      };
    }

    function apply(ctx) {
      const handle = ctx.inject(["sidebarRightTabs"], (raw) => {
        const tabs = raw.sidebarRightTabs;
        const slots = raw.slots;
        if (tabs === undefined || slots === undefined) return;
        const disposers = [];
        const own = (value) => { if (typeof value === "function") disposers.push(value); };
        const Body = ViewerBody(ctx);
        const Card = SettingsCard(ctx);

        own(tabs.register({
          id: BROWSER_ID,
          kind: BROWSER_KIND,
          title: () => "Wiki Viewer",
          guide: [{ order: 20, title: () => "Wiki Viewer", description: () => "Browse this Session workspace" }]
        }));
        // A file-backed tab must CLAIM file addresses: routing sends an address to
        // the types whose patterns match it, and a type with no patterns
        // recognizes no address at all, so without this the sidebar can never
        // route a file (or "Open in Wiki Viewer") into this tab.
        own(tabs.register({
          id: FILE_ID,
          kind: FILE_KIND,
          patterns: ["dsh-resource://file/**"],
          canOpen: (address) => filePathIn(address) !== undefined,
          title: () => "Wiki Viewer"
        }));
        own(slots.inject("sidebar.right.pane.tab", () => slots.register({ name: "sidebar.right.pane.tab", key: BROWSER_ID }, Body)));
        own(slots.inject("sidebar.right.pane.tab", () => slots.register({ name: "sidebar.right.pane.tab", key: FILE_ID }, Body)));
        own(slots.inject("sidebar.right.pane.tab.title", () => slots.register({ name: "sidebar.right.pane.tab.title", key: BROWSER_ID }, ViewerTitle)));
        own(slots.inject("sidebar.right.pane.tab.title", () => slots.register({ name: "sidebar.right.pane.tab.title", key: FILE_ID }, ViewerTitle)));
        own(slots.inject("sidebar.right.tab.menu.item", () => slots.register({ name: "sidebar.right.tab.menu.item", id: "dsh-wiki-viewer/open", order: 20, label: "Open in Wiki Viewer" }, FileAction(ctx))));
        own(slots.inject("settings.plugin.item", () => slots.register({
          name: "settings.plugin.item",
          key: "dsh-wiki-viewer",
          id: "dsh-wiki-viewer",
          order: 130,
          inject: () => ({})
        }, Card)));
        return () => { for (const dispose of disposers.reverse()) dispose(); };
      });
      ctx.effect(() => () => handle?.dispose?.(), "dsh-wiki-viewer: sidebar injection");
    }

    module.exports = { apply, inject: ["slots"], name: "dsh-wiki-viewer" };
    return module.exports;
  }
});
