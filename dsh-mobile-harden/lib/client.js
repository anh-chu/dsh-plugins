window.__ModuleLoader__.load({
  id: "dsh-mobile-harden",
  factory: (require) => {
    const module = { exports: {} };

    const CSS =
      "@media (pointer: coarse){" +
      "html,body{touch-action:manipulation;}" +
      "*,*::before,*::after{-webkit-tap-highlight-color:transparent;}" +
      "[role=\"treeitem\"]{cursor:pointer;}" +
      "body{-webkit-touch-callout:none;user-select:none;-webkit-user-select:none;}" +
      "input,textarea,select,[contenteditable=\"true\"]," +
      "[data-chat-flow-kind],[data-chat-turn]," +
      "[data-turn-process-answer],[data-turn-process-tool-calls]," +
      "[data-turn-process-messages],[data-context-text]," +
      "pre,code{-webkit-touch-callout:default;user-select:text;-webkit-user-select:text;}" +
      "}";

    const EDITABLE = 'input,textarea,select,[contenteditable="true"]';
    const CONTENT =
      "[data-chat-flow-kind],[data-chat-turn]," +
      "[data-turn-process-answer],[data-turn-process-tool-calls]," +
      "[data-turn-process-messages],[data-context-text],pre,code";
    const ALLOW = `${EDITABLE},${CONTENT}`;
    const COMPOSER = "[data-composer-input]";

    function inside(el, sel) {
      return !!(el && el.closest && el.closest(sel));
    }

    function apply(ctx) {
      if (
        typeof window === "undefined" ||
        typeof document === "undefined" ||
        !window.matchMedia ||
        !window.matchMedia("(pointer: coarse)").matches
      ) {
        return;
      }

      const cleanups = [];
      const on = (target, type, handler, options) => {
        target.addEventListener(type, handler, options);
        cleanups.push(() => target.removeEventListener(type, handler, options));
      };

      // Touch-action/zoom + selection/callout CSS for touch layouts.
      const style = document.createElement("style");
      style.setAttribute("data-dsh-mobile-harden", "true");
      style.textContent = CSS;
      document.head.appendChild(style);
      cleanups.push(() => style.remove());

      // 1. Bare Enter inserts a newline in the composer; send via the send
      // button (Cmd/Ctrl+Enter still sends).
      on(
        window,
        "keydown",
        (e) => {
          if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
          if (e.isComposing || e.keyCode === 229) return;
          if (!inside(e.target, COMPOSER)) return;
          e.preventDefault();
          e.stopPropagation();
          let done = false;
          try {
            done = document.execCommand("insertLineBreak");
          } catch (err) {}
          if (!done) {
            try {
              document.execCommand("insertText", false, "\n");
            } catch (err2) {}
          }
        },
        true,
      );

      // 2. Pinch-zoom gesture on old iOS.
      on(
        document,
        "gesturestart",
        (e) => {
          e.preventDefault();
        },
        { passive: false },
      );

      // 3+4. No text selection or long-press callout on app chrome; message
      // content and fields stay selectable.
      on(document, "selectstart", (e) => {
        if (inside(e.target, ALLOW)) return;
        e.preventDefault();
      });
      on(document, "contextmenu", (e) => {
        if (inside(e.target, ALLOW)) return;
        e.preventDefault();
      });

      // 5a. No keyboard on session switch: the composer auto-focuses whenever
      // the session changes. Only a direct tap inside it may focus it.
      let composerTapAt = 0;
      on(
        document,
        "pointerdown",
        (e) => {
          if (inside(e.target, COMPOSER)) composerTapAt = Date.now();
        },
        true,
      );
      on(document, "focusin", (e) => {
        if (!inside(e.target, COMPOSER)) return;
        if (Date.now() - composerTapAt < 1500) return;
        try {
          e.target.blur();
        } catch (err) {}
      });

      // 5b. One tap on a session switches AND closes the narrow overlay
      // sidebar. Group rows (aria-expanded) and in-row controls are untouched.
      const findCollapseButton = () => {
        const btns = document.querySelectorAll("button[aria-label]");
        let fallback = null;
        for (const btn of btns) {
          const label = btn.getAttribute("aria-label") || "";
          if (/sidebar|侧边栏/i.test(label)) {
            if (/collaps|收起|close|关闭|hide|隐藏/i.test(label)) return btn;
            if (!fallback) fallback = btn;
          }
        }
        return fallback;
      };
      on(
        document,
        "click",
        (e) => {
          const t = e.target;
          if (!t || !t.closest) return;
          const row = t.closest('[role="treeitem"]:not([aria-expanded])');
          if (!row) return;
          if (
            row.tagName !== "BUTTON" &&
            t.closest('button,[role="menu"],[role="dialog"],input,textarea,select,a')
          ) {
            return;
          }
          const t0 = Date.now();
          let tries = 0;
          const tick = () => {
            tries++;
            try {
              if (document.querySelector("[data-sidebar-collapsed]")) return;
              if (window.innerWidth >= 1024) return;
              const btn = findCollapseButton();
              if (btn) btn.click();
              if (
                !document.querySelector("[data-sidebar-collapsed]") &&
                tries < 6 &&
                Date.now() - t0 < 2000
              ) {
                window.setTimeout(tick, 250);
              }
            } catch (err) {}
          };
          window.setTimeout(tick, 250);
        },
        true,
      );

      ctx.effect(
        () => () => {
          for (const dispose of cleanups.reverse()) {
            try {
              dispose();
            } catch (err) {}
          }
        },
        "dsh-mobile-harden: listeners",
      );
    }

    module.exports = { apply, name: "dsh-mobile-harden" };
    return module.exports;
  },
});
