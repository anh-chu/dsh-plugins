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

    function rpcOf(ctx) {
      const rpc = ctx.get("connection")?.rpc;
      return typeof rpc?.call === "function" ? rpc.call.bind(rpc) : undefined;
    }

    function ViewerBody(ctx) {
      return function Body({ useTabInfo, sessionId }) {
        const { tab } = useTabInfo();
        const [attempt, setAttempt] = React.useState(0);
        const [state, setState] = React.useState({ loading: true, src: "", error: "" });
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
        return React.createElement("iframe", {
          title: tab.title,
          src: state.src,
          style: { width: "100%", height: "100%", border: "0" },
          referrerPolicy: "no-referrer"
        });
      };
    }

    function ViewerTitle({ useTabInfo }) {
      return React.createElement(React.Fragment, null, useTabInfo().tab.title);
    }

    function FileAction(ctx) {
      return function Action({ tab, dismiss }) {
        if (typeof tab?.contentId !== "string" || !tab.contentId.startsWith("dsh-resource://file/session/")) return null;
        return React.createElement("button", {
          type: "button",
          onClick: () => {
            ctx.get("sidebarRight")?.openResource(tab.contentId, { kind: FILE_KIND });
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

        own(tabs.register({
          id: BROWSER_ID,
          kind: BROWSER_KIND,
          title: () => "Wiki Viewer",
          guide: [{ order: 20, title: () => "Wiki Viewer", description: () => "Browse this Session workspace" }]
        }));
        own(tabs.register({ id: FILE_ID, kind: FILE_KIND, title: () => "Wiki Viewer" }));
        own(slots.inject("sidebar.right.pane.tab", () => slots.register({ name: "sidebar.right.pane.tab", key: BROWSER_ID }, Body)));
        own(slots.inject("sidebar.right.pane.tab", () => slots.register({ name: "sidebar.right.pane.tab", key: FILE_ID }, Body)));
        own(slots.inject("sidebar.right.pane.tab.title", () => slots.register({ name: "sidebar.right.pane.tab.title", key: BROWSER_ID }, ViewerTitle)));
        own(slots.inject("sidebar.right.pane.tab.title", () => slots.register({ name: "sidebar.right.pane.tab.title", key: FILE_ID }, ViewerTitle)));
        own(slots.inject("sidebar.right.tab.menu.item", () => slots.register({ name: "sidebar.right.tab.menu.item", id: "dsh-wiki-viewer/open", order: 20, label: "Open in Wiki Viewer" }, FileAction(ctx))));
        return () => { for (const dispose of disposers.reverse()) dispose(); };
      });
      ctx.effect(() => () => handle?.dispose?.(), "dsh-wiki-viewer: sidebar injection");
    }

    module.exports = { apply, inject: ["slots"], name: "dsh-wiki-viewer" };
    return module.exports;
  }
});
