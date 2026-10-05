// dsh-notepad — browser half.
//
// Persistent notepad pinned to the dsh Web GUI (draggable, pinnable):
// - Two scopes: the global page + this session's isolated page; switchable (single) or split view
// - Debounced autosave + optimistic-lock conflicts (merge/overwrite); failed saves retry in a queue;
//   unsaved local content found after a refresh prompts "restore/discard"
// - SSE live push (/api/notepad/stream) + 30s polling fallback
// - Markdown preview (safe rendering, checkboxes clickable to toggle); completion-rate stats; timestamp insertion;
//   full-text search (jump to line); history snapshot restore; copy/download export
// - Shortcuts: Ctrl+Enter saves immediately, Esc collapses
// Styling uses only --dsw-* theme tokens and follows the light/dark theme.

window.__ModuleLoader__.load({
	id: "dsh-notepad",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let react = require("react");
		const { useState, useEffect, useRef, useCallback } = react;
		const h = react.createElement;

		const API_PATH = "/api/notepad";
		const LS_OPEN_KEY = "dsh-notepad:open";
		const LS_WIDTH_KEY = "dsh-notepad:width";
		const LS_PIN_KEY = "dsh-notepad:pin";
		const SCOPE_PREFIX = "session:";
		const SAVE_DEBOUNCE_MS = 800;
		const POLL_FALLBACK_MS = 30000;
		const MIN_WIDTH = 220;
		const MAX_WIDTH = 480;
		const NARROW_MQ = "(max-width: 1199px)";

		// ---- current-session store ------------------------------------------
		// The panel lives in `shell.overlay`, a root-scope seat, and root-scope seats are given no
		// Session identity: the harness hands `sessionId` only to session-scope seats, and the
		// session-list snapshot carries no current selection. So a zero-render occupant of a
		// session-scope seat publishes the open Session id here, and the overlay panel reads it.
		// Upstream read `useSessions((s) => s.current)`, a field that no longer exists, which left
		// the panel permanently on the global page with its Session tab disabled.
		const sessionIdStore = { current: null, listeners: new Set() };
		function publishSessionId(id) {
			const next = typeof id === "string" && id !== "" ? id : null;
			if (sessionIdStore.current === next) return;
			sessionIdStore.current = next;
			for (const listener of Array.from(sessionIdStore.listeners)) {
				try { listener(); } catch {}
			}
		}
		function useCurrentSessionId() {
			const [sessionId, setSessionId] = useState(sessionIdStore.current);
			useEffect(() => {
				const listener = () => setSessionId(sessionIdStore.current);
				sessionIdStore.listeners.add(listener);
				listener();
				return () => { sessionIdStore.listeners.delete(listener); };
			}, []);
			return sessionId;
		}
		/** Publishes the seat's `sessionId` and renders nothing; cleared only by its own unmount. */
		function SessionIdProbe(props) {
			const id = props ? props.sessionId : void 0;
			useEffect(() => {
				publishSessionId(id);
				return () => { if (sessionIdStore.current === id) publishSessionId(null); };
			}, [id]);
			return null;
		}

		// ---- Utilities ---------------------------------------------------
		function cacheKey(key) {
			return `dsh-notepad:cache:${key}`;
		}
		function pendingKey(key) {
			return `dsh-notepad:pending:${key}`;
		}
		function panelHeight() {
			return Math.max(240, Math.round(window.innerHeight * 0.56));
		}
		function clamp(v, min, max) {
			return Math.min(max, Math.max(min, v));
		}
		function fmtShort(d) {
			const p = (n) => String(n).padStart(2, "0");
			return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
		}
		function formatTime(d) {
			const p = (n) => String(n).padStart(2, "0");
			return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
		}

		/** Position is stored anchored by "distance to the edge": resizing follows the anchored edge and returns to place after enlarging. */
		function absToAnchor(x, y, width) {
			const ph = panelHeight();
			const rightOff = window.innerWidth - x - width;
			const leftOff = x;
			const hk = rightOff < leftOff ? "right" : "left";
			const ho = hk === "right" ? rightOff : leftOff;
			const bottomOff = window.innerHeight - y - ph;
			const topOff = y;
			const vk = bottomOff < topOff ? "bottom" : "top";
			const vo = vk === "bottom" ? bottomOff : topOff;
			return { h: hk, ho, v: vk, vo };
		}
		function anchorToAbs(anchor, width) {
			const ph = panelHeight();
			const x = anchor.h === "right" ? window.innerWidth - width - anchor.ho : anchor.ho;
			const y = anchor.v === "bottom" ? window.innerHeight - ph - anchor.vo : anchor.vo;
			return { x, y };
		}
		function renderOrigin(pin, width) {
			const abs = anchorToAbs(pin.anchor, width);
			return {
				left: clamp(abs.x, 0, Math.max(0, window.innerWidth - width)),
				top: clamp(abs.y, 0, Math.max(0, window.innerHeight - panelHeight()))
			};
		}

		/** Append scope parameters to a URL. */
		function queryUrl(base, key) {
			const sep = base.includes("?") ? "&" : "?";
			if (key === "global") return `${base}${sep}scope=global`;
			return `${base}${sep}scope=session&sessionId=${encodeURIComponent(key.slice(SCOPE_PREFIX.length))}`;
		}

		/** Core PUT (scope-aware, optimistic locking). */
		async function apiPut(value, key, baseRev, force) {
			const payload = { text: value, baseRevision: baseRev, force: force === true, scope: "global" };
			if (key !== "global") {
				payload.scope = "session";
				payload.sessionId = key.slice(SCOPE_PREFIX.length);
			}
			const res = await fetch(API_PATH, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload)
			});
			let body = null;
			try { body = await res.json(); } catch {}
			if (res.status === 409 && body && body.ok === false) {
				return { conflict: true, serverText: body.text ?? "", serverRevision: body.revision ?? null };
			}
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return { conflict: false, revision: body && typeof body.revision === "number" ? body.revision : null };
		}

		/** Line-level union merge: keep every server line, append the lines new to the draft (deduped). */
		function mergeTexts(serverText, draftText) {
			const serverLines = String(serverText).split("\n");
			const seen = new Set(serverLines);
			const extra = [];
			for (const line of String(draftText).split("\n")) {
				if (!seen.has(line)) {
					seen.add(line);
					extra.push(line);
				}
			}
			return [...serverLines, ...extra].join("\n");
		}

		/** History id → local time "MM-DD HH:mm" */
		function parseHistoryTime(id) {
			const t = String(id).replace(/^notes-/, "").replace(/\.md$/, "");
			const parts = t.split("T");
			if (parts.length < 2) return t;
			const [hh, mm, ss, msZ] = parts[1].split("-");
			if (!msZ) return t;
			const d = new Date(`${parts[0]}T${hh}:${mm}:${ss}.${msZ}`);
			if (Number.isNaN(d.getTime())) return t;
			return fmtShort(d);
		}

		/** Checkbox stats: { done, total } (matches "- [x]" / "- [ ]" lines). */
		function checkboxStats(text) {
			let done = 0;
			let total = 0;
			for (const line of String(text).split("\n")) {
				const m = /^[-*]\s+\[( |x|X)\]/.exec(line);
				if (m) {
					total += 1;
					if (m[1] !== " ") done += 1;
				}
			}
			return { done, total };
		}

		// ---- Safe Markdown rendering (all content goes through createTextNode to prevent XSS) ----
		const codeStyle = {
			fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
			fontSize: 12,
			background: "var(--dsw-alias-interactive-bg-hover)",
			borderRadius: 4,
			padding: "0 3px"
		};
		const linkStyle = { color: "var(--dsw-alias-brand-primary, #4f8cff)", textDecoration: "none" };
		const preStyle = {
			margin: "4px 0",
			padding: "8px 10px",
			background: "var(--dsw-alias-interactive-bg-hover)",
			borderRadius: 8,
			overflowX: "auto"
		};

		function mdInline(text) {
			const out = [];
			const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
			let last = 0;
			let m;
			const pushText = (s) => { if (s) out.push(s); };
			while ((m = re.exec(text)) !== null) {
				pushText(text.slice(last, m.index));
				const tok = m[0];
				if (tok.startsWith("**")) out.push(h("strong", { key: m.index }, tok.slice(2, -2)));
				else if (tok.startsWith("`")) out.push(h("code", { key: m.index, style: codeStyle }, tok.slice(1, -1)));
				else {
					const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
					if (mm) out.push(h("a", { key: m.index, href: mm[2], target: "_blank", rel: "noreferrer", style: linkStyle }, mm[1]));
					else pushText(tok);
				}
			}
			pushText(text.slice(last));
			return out;
		}

		function cbBoxStyle(checked) {
			return {
				flex: "none",
				width: 13,
				height: 13,
				marginTop: 3,
				borderRadius: 3,
				boxSizing: "border-box",
				border: "1.5px solid var(--dsw-alias-label-secondary)",
				background: checked ? "var(--dsw-alias-state-success-primary)" : "transparent",
				color: "var(--dsw-alias-bg-overlay)",
				fontSize: 10,
				lineHeight: "10px",
				textAlign: "center",
				cursor: "pointer",
				userSelect: "none",
				display: "inline-flex",
				alignItems: "center",
				justifyContent: "center"
			};
		}

		function renderMarkdown(text, onToggleCheck) {
			const lines = String(text).split("\n");
			const els = [];
			let inCode = false;
			let codeBuf = [];
			const flushCode = () => {
				if (codeBuf.length > 0) {
					els.push(h("pre", { key: `pre-${els.length}`, style: preStyle },
						h("code", { style: { ...codeStyle, background: "transparent", padding: 0 } }, codeBuf.join("\n"))));
					codeBuf = [];
				}
			};
			lines.forEach((line, i) => {
				const t = line.trim();
				if (t.startsWith("```")) {
					if (inCode) { inCode = false; flushCode(); }
					else { flushCode(); inCode = true; }
					return;
				}
				if (inCode) { codeBuf.push(line); return; }
				if (!t) { els.push(h("div", { key: i, style: { height: 8 } })); return; }
				const heading = /^(#{1,6})\s+(.*)$/.exec(line);
				if (heading) {
					const lvl = heading[1].length;
					const size = lvl === 1 ? 16 : lvl === 2 ? 14 : 13;
					els.push(h(`h${lvl}`, { key: i, style: { margin: "6px 0 2px", fontSize: size, fontWeight: 700 } },
						...mdInline(heading[2])));
					return;
				}
				if (/^-{3,}$/.test(t)) { els.push(h("hr", { key: i, style: { border: 0, borderTop: "1px solid var(--dsw-alias-border-l1)", margin: "6px 0" } })); return; }
				if (t.startsWith("> ")) {
					els.push(h("blockquote", { key: i, style: { margin: "2px 0", padding: "2px 8px", borderLeft: "3px solid var(--dsw-alias-border-l2)", color: "var(--dsw-alias-label-secondary)" } },
						...mdInline(line.replace(/^>\s*/, ""))));
					return;
				}
				const cb = /^[-*]\s+\[( |x|X)\]\s+(.*)$/.exec(line);
				if (cb) {
					const checked = cb[1] !== " ";
					els.push(h("div", { key: i, style: { display: "flex", gap: 6, padding: "1px 0" } },
						h("span", {
							role: "checkbox",
							"aria-checked": checked,
							tabIndex: 0,
							title: "Click to toggle the checkbox and save",
							style: cbBoxStyle(checked),
							onClick: () => onToggleCheck(i),
							onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggleCheck(i); } }
						}, checked ? "✓" : ""),
						h("span", { style: checked ? { textDecoration: "line-through", color: "var(--dsw-alias-label-secondary)" } : void 0 },
							...mdInline(cb[2]))));
					return;
				}
				if (/^[-*]\s+/.test(line)) {
					els.push(h("div", { key: i, style: { display: "flex", gap: 6, padding: "1px 0" } },
						h("span", { style: { flex: "none", color: "var(--dsw-alias-label-secondary)" } }, "•"),
						h("span", null, ...mdInline(line.replace(/^[-*]\s+/, "")))));
					return;
				}
				els.push(h("p", { key: i, style: { margin: "2px 0" } }, ...mdInline(line)));
			});
			flushCode();
			return els;
		}

		// ---- Styles -------------------------------------------------------
		const panel = {
			position: "absolute",
			zIndex: 20,
			boxSizing: "border-box",
			height: "56vh",
			minHeight: 240,
			display: "flex",
			flexDirection: "column",
			borderRadius: 12,
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-alias-bg-overlay)",
			boxShadow: "0 8px 32px rgba(0, 0, 0, 0.18)",
			color: "var(--dsw-alias-label-primary)",
			fontSize: 12,
			lineHeight: "18px",
			overflow: "visible",
			pointerEvents: "auto"
		};

		const header = {
			display: "flex",
			alignItems: "center",
			gap: 4,
			padding: "8px 10px",
			borderBottom: "1px solid var(--dsw-alias-border-l1)",
			flex: "none"
		};

		const iconBtn = {
			flex: "none",
			display: "inline-flex",
			alignItems: "center",
			justifyContent: "center",
			width: 22,
			height: 22,
			border: 0,
			borderRadius: 6,
			padding: 0,
			background: "transparent",
			color: "var(--dsw-alias-label-secondary)",
			cursor: "pointer"
		};

		const modeBtn = {
			flex: "none",
			display: "inline-flex",
			alignItems: "center",
			justifyContent: "center",
			height: 20,
			border: 0,
			borderRadius: 6,
			padding: "0 6px",
			background: "transparent",
			color: "var(--dsw-alias-label-secondary)",
			cursor: "pointer",
			fontSize: 11
		};

		const modeActive = {
			background: "var(--dsw-alias-interactive-bg-hover)",
			color: "var(--dsw-alias-label-primary)"
		};

		const textarea = {
			flex: 1,
			minHeight: 0,
			boxSizing: "border-box",
			width: "100%",
			padding: "8px 12px",
			border: 0,
			outline: "none",
			resize: "none",
			background: "transparent",
			color: "var(--dsw-alias-label-primary)",
			fontFamily: "inherit",
			fontSize: 13,
			lineHeight: "20px"
		};

		const preview = {
			flex: 1,
			minHeight: 0,
			overflowY: "auto",
			padding: "8px 12px 12px",
			fontSize: 13,
			lineHeight: "20px",
			wordBreak: "break-word"
		};

		const paneFooter = {
			display: "flex",
			alignItems: "center",
			gap: 6,
			padding: "3px 10px",
			borderTop: "1px solid var(--dsw-alias-border-l1)",
			color: "var(--dsw-alias-label-secondary)",
			fontSize: 10,
			lineHeight: "14px",
			flex: "none"
		};

		const paneSpacer = { flex: 1 };

		const paneLabel = {
			flex: "none",
			padding: "2px 10px",
			fontSize: 10,
			lineHeight: "14px",
			color: "var(--dsw-alias-label-secondary)",
			borderBottom: "1px solid var(--dsw-alias-border-l1)",
			cursor: "pointer",
			userSelect: "none"
		};

		const conflictRow = {
			display: "flex",
			alignItems: "center",
			gap: 6,
			padding: "5px 10px",
			borderTop: "1px solid var(--dsw-alias-state-warning-primary, #d97706)",
			background: "color-mix(in srgb, var(--dsw-alias-state-warning-primary, #d97706) 10%, transparent)",
			color: "var(--dsw-alias-state-warning-primary, #d97706)",
			fontSize: 11,
			lineHeight: "16px",
			flex: "none"
		};

		const conflictBtn = {
			flex: "none",
			border: 0,
			borderRadius: 6,
			padding: "2px 8px",
			cursor: "pointer",
			fontSize: 11,
			lineHeight: "16px",
			background: "var(--dsw-alias-interactive-bg-hover)",
			color: "var(--dsw-alias-label-primary)"
		};

		const restoreBar = {
			display: "flex",
			alignItems: "center",
			gap: 6,
			padding: "5px 10px",
			borderTop: "1px solid var(--dsw-alias-border-l1)",
			background: "color-mix(in srgb, var(--dsw-alias-state-info-primary, #4f8cff) 8%, transparent)",
			color: "var(--dsw-alias-label-primary)",
			fontSize: 11,
			lineHeight: "16px",
			flex: "none"
		};

		const tab = {
			position: "absolute",
			right: 0,
			top: "50%",
			transform: "translateY(-50%)",
			zIndex: 20,
			writingMode: "vertical-rl",
			textOrientation: "mixed",
			boxSizing: "border-box",
			padding: "10px 6px",
			borderRadius: "10px 0 0 10px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRight: "none",
			background: "var(--dsw-alias-bg-overlay)",
			color: "var(--dsw-alias-label-secondary)",
			fontSize: 12,
			fontWeight: 600,
			letterSpacing: 2,
			cursor: "pointer",
			userSelect: "none",
			pointerEvents: "auto"
		};

		const dragHandle = {
			position: "absolute",
			left: -5,
			top: 0,
			bottom: 0,
			width: 10,
			cursor: "ew-resize",
			zIndex: 5
		};

		const pop = {
			position: "absolute",
			top: 34,
			left: 0,
			right: 0,
			zIndex: 30,
			maxHeight: "55%",
			overflowY: "auto",
			borderRadius: "0 0 10px 10px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderTop: "none",
			background: "var(--dsw-alias-bg-overlay)",
			boxShadow: "0 8px 24px rgba(0, 0, 0, 0.18)"
		};

		const popItem = {
			display: "flex",
			alignItems: "center",
			gap: 6,
			width: "100%",
			border: 0,
			background: "transparent",
			color: "var(--dsw-alias-label-primary)",
			padding: "6px 12px",
			cursor: "pointer",
			fontSize: 11,
			textAlign: "left"
		};

		const searchInput = {
			flex: 1,
			boxSizing: "border-box",
			width: "100%",
			padding: "6px 10px",
			border: 0,
			outline: "none",
			background: "var(--dsw-alias-interactive-bg-hover)",
			color: "var(--dsw-alias-label-primary)",
			borderRadius: 6,
			fontSize: 12,
			fontFamily: "inherit"
		};

		const divider = {
			flex: "none",
			height: 1,
			background: "var(--dsw-alias-border-l1)"
		};

		// ---- Editor pane (single scope) -------------------------------------
		function EditorPane(props) {
			const { scopeKey, style, placeholder, previewMode, label, onActivate, apiRef } = props;

			const [text, setText] = useState("");
			const [loaded, setLoaded] = useState(false);
			const [phase, setPhase] = useState("idle"); // idle | saving | saved | error | conflict | draft
			const [savedAt, setSavedAt] = useState(null);
			const [conflict, setConflict] = useState(null); // { serverText, serverRevision }
			const [restoreOffer, setRestoreOffer] = useState(false);

			const dirty = useRef(false);
			const textRef = useRef("");
			const revisionRef = useRef(0);
			const timer = useRef(null);
			const pendingRef = useRef(null); // content whose save failed and is awaiting retry
			const taRef = useRef(null);
			const keyRef = useRef(scopeKey);
			useEffect(() => { keyRef.current = scopeKey; }, [scopeKey]);
			useEffect(() => { textRef.current = text; }, [text]);

			// Load
			useEffect(() => {
				let cancelled = false;
				const key = scopeKey;
				(async () => {
					let text0 = null;
					let fromCache = false;
					try {
						const res = await fetch(queryUrl(API_PATH, key), { cache: "no-store" });
						const body = await res.json();
						if (body && body.ok === true && typeof body.text === "string") {
							text0 = body.text;
							revisionRef.current = body.revision ?? 0;
						}
					} catch {}
					if (cancelled) return;
					if (text0 === null) {
						fromCache = true;
						try { text0 = localStorage.getItem(cacheKey(key)) ?? ""; } catch { text0 = ""; }
					}
					setText(text0);
					setLoaded(true);
					let pend = false;
					try { pend = localStorage.getItem(pendingKey(key)) === "1"; } catch {}
					if (pend && !fromCache) setRestoreOffer(true);
					setPhase(fromCache ? "error" : "idle");
				})();
				return () => { cancelled = true; };
			}, [scopeKey]);

			const saveNow = useCallback(async (value) => {
				const key = keyRef.current;
				setPhase("saving");
				try {
					const result = await apiPut(value, key, revisionRef.current ?? 0, false);
					if (result.conflict) {
						setConflict({ serverText: result.serverText, serverRevision: result.serverRevision });
						setPhase("conflict");
						return;
					}
					dirty.current = false;
					pendingRef.current = null;
					try { localStorage.removeItem(pendingKey(key)); } catch {}
					if (result.revision !== null) revisionRef.current = result.revision;
					setPhase("saved");
					setSavedAt(new Date());
				} catch (error) {
					// Offline: hold it and wait for the automatic retry
					pendingRef.current = value;
					try { localStorage.setItem(pendingKey(key), "1"); } catch {}
					setPhase("error");
				}
			}, []);

			const refreshFromServer = useCallback(async () => {
				const key = keyRef.current;
				if (dirty.current || pendingRef.current !== null) return;
				try {
					const res = await fetch(queryUrl(API_PATH, key), { cache: "no-store" });
					const body = await res.json();
					if (!body || body.ok !== true || typeof body.text !== "string") return;
					revisionRef.current = body.revision ?? revisionRef.current;
					if (body.text !== textRef.current) {
						textRef.current = body.text;
						setText(body.text);
						try { localStorage.setItem(cacheKey(key), body.text); } catch {}
						setPhase("saved");
						setSavedAt(new Date());
					}
				} catch {}
			}, []);

			// SSE live push (filtered by scope)
			useEffect(() => {
				let closed = false;
				let es = null;
				try {
					es = new EventSource(`${API_PATH}/stream`);
					es.onmessage = (ev) => {
						if (closed) return;
						let m = null;
						try { m = JSON.parse(ev.data); } catch {}
						if (!m || typeof m.scope !== "string" || m.scope !== scopeKey) return;
						if (typeof m.revision === "number" && m.revision > (revisionRef.current ?? -1)) refreshFromServer();
					};
				} catch {}
				return () => { closed = true; if (es) es.close(); };
			}, [scopeKey, refreshFromServer]);

			// Polling fallback (30s) + automatic retry of unsaved content
			useEffect(() => {
				let cancelled = false;
				const key = scopeKey;
				const tick = async () => {
					if (cancelled) return;
					if (pendingRef.current !== null) {
						await saveNow(pendingRef.current);
						return;
					}
					if (dirty.current) return;
					try {
						const since = revisionRef.current ?? 0;
						const res = await fetch(queryUrl(`${API_PATH}?since=${since}`, key), { cache: "no-store" });
						const body = await res.json();
						if (cancelled || !body || body.ok !== true) return;
						if (body.text === null) return;
						if (typeof body.text !== "string") return;
						revisionRef.current = body.revision ?? revisionRef.current;
						if (body.text !== textRef.current) {
							textRef.current = body.text;
							setText(body.text);
							try { localStorage.setItem(cacheKey(key), body.text); } catch {}
							setPhase("saved");
							setSavedAt(new Date());
						}
					} catch {}
				};
				const timerId = setInterval(tick, POLL_FALLBACK_MS);
				return () => { cancelled = true; clearInterval(timerId); };
			}, [scopeKey, saveNow]);

			const handleChange = (value) => {
				const key = keyRef.current;
				setText(value);
				try { localStorage.setItem(cacheKey(key), value); } catch {}
				dirty.current = true;
				setPhase("idle");
				if (timer.current !== null) clearTimeout(timer.current);
				timer.current = setTimeout(() => {
					if (dirty.current) saveNow(value);
				}, SAVE_DEBOUNCE_MS);
			};

			const resolveConflict = async (mode) => {
				if (!conflict) return;
				const key = keyRef.current;
				const draft = textRef.current;
				let value = draft;
				let force = false;
				if (mode === "merge") {
					value = mergeTexts(conflict.serverText, draft);
					setText(value);
					try { localStorage.setItem(cacheKey(key), value); } catch {}
				} else {
					force = true;
				}
				setConflict(null);
				setPhase("saving");
				try {
					const result = await apiPut(value, key, conflict.serverRevision, force);
					if (result.conflict) {
						setConflict({ serverText: result.serverText, serverRevision: result.serverRevision });
						setPhase("conflict");
						return;
					}
					dirty.current = false;
					pendingRef.current = null;
					try { localStorage.removeItem(pendingKey(key)); } catch {}
					if (result.revision !== null) revisionRef.current = result.revision;
					setPhase("saved");
					setSavedAt(new Date());
				} catch {
					setPhase("error");
				}
			};

			const acceptRestore = () => {
				try {
					const c = localStorage.getItem(cacheKey(keyRef.current));
					if (c !== null) {
						setText(c);
						dirty.current = true;
						pendingRef.current = c;
						saveNow(c);
					}
				} catch {}
				setRestoreOffer(false);
			};

			const discardRestore = () => {
				try {
					localStorage.removeItem(pendingKey(keyRef.current));
					localStorage.removeItem(cacheKey(keyRef.current));
				} catch {}
				pendingRef.current = null;
				setRestoreOffer(false);
				setPhase("idle");
			};

			const toggleCheck = (lineIndex) => {
				const lines = textRef.current.split("\n");
				if (lineIndex < 0 || lineIndex >= lines.length) return;
				const line = lines[lineIndex];
				const m = /^(\s*[-*]\s+\[)( |x|X)(\]\s*.*)$/.exec(line);
				if (!m) return;
				const checked = m[2] !== " ";
				lines[lineIndex] = `${m[1]}${checked ? " " : "x"}${m[3]}`;
				handleChange(lines.join("\n"));
			};

			// Exposed to the outer panel (timestamp / force save / jump to line / get text / load history)
			useEffect(() => {
				if (apiRef) {
					apiRef.current = {
						scopeKey,
						getText: () => textRef.current,
						insertTimestamp: () => {
							const ta = taRef.current;
							if (!ta) return;
							const stamp = `[${fmtShort(new Date())}] `;
							const start = ta.selectionStart ?? textRef.current.length;
							const end = ta.selectionEnd ?? start;
							const next = textRef.current.slice(0, start) + stamp + textRef.current.slice(end);
							handleChange(next);
							requestAnimationFrame(() => {
								try { ta.focus(); ta.setSelectionRange(start + stamp.length, start + stamp.length); } catch {}
							});
						},
						forceSave: () => {
							if (timer.current !== null) clearTimeout(timer.current);
							if (dirty.current || pendingRef.current !== null) saveNow(textRef.current);
						},
						clearAll: () => {
							if (timer.current !== null) clearTimeout(timer.current);
							dirty.current = true;
							handleChange("");
							saveNow("");
						},
						applyHistory: (value) => {
							setText(value);
							setPhase("draft");
						},
						scrollToLine: (lineIdx) => {
							const ta = taRef.current;
							if (!ta) return;
							const lines = textRef.current.split("\n");
							const start = lines.slice(0, lineIdx).join("\n").length + (lineIdx > 0 ? 1 : 0);
							const end = start + (lines[lineIdx] ?? "").length;
							const total = textRef.current.length || 1;
							ta.scrollTop = (start / total) * (ta.scrollHeight - ta.clientHeight);
							ta.setSelectionRange(start, end);
							ta.focus();
						}
					};
				}
			});

			const stats = checkboxStats(text);
			const statusText =
				phase === "saving" ? "Saving…" :
				phase === "saved" && savedAt ? `Saved ${formatTime(savedAt)}` :
				phase === "error" ? "Save failed, retrying…" :
				phase === "conflict" ? "External change detected" :
				phase === "draft" ? "History version loaded (unsaved)" :
				loaded ? "Typing…" : "Loading…";

			return h("div", { style: { display: "flex", flexDirection: "column", minHeight: 0, flex: 1, ...style } },
				label ? h("div", { style: paneLabel, onClick: onActivate, title: "Click to switch to this page" }, label) : null,
				previewMode
					? h("div", { style: preview }, renderMarkdown(text, toggleCheck))
					: h("textarea", {
						ref: taRef,
						style: textarea,
						placeholder,
						value: text,
						onChange: (e) => handleChange(e.target.value),
						spellCheck: false
					}),
				restoreOffer ? h("div", { style: restoreBar },
					h("span", { style: { flex: 1 } }, "📥 Unsaved local content detected"),
					h("button", { type: "button", style: conflictBtn, onClick: acceptRestore }, "Restore"),
					h("button", { type: "button", style: conflictBtn, onClick: discardRestore }, "Discard")
				) : null,
				phase === "conflict" ? h("div", { style: conflictRow },
					h("span", { style: { flex: 1 } }, "⚠ Modified by another window/Agent"),
					h("button", { type: "button", style: conflictBtn, title: "Keep both sides' content (deduped by line)", onClick: () => resolveConflict("merge") }, "Merge"),
					h("button", { type: "button", style: conflictBtn, onClick: () => resolveConflict("overwrite") }, "Overwrite")
				) : null,
				h("div", { style: paneFooter },
					h("span", null, statusText),
					h("span", { style: paneSpacer }),
					stats.total > 0 ? h("span", null, `☑ ${stats.done}/${stats.total}`) : null,
					h("span", null, `${text.length} chars`)
				)
			);
		}

		// ---- Outer panel ---------------------------------------------------
		function NotepadPanel(props) {
			const useSessions = props && typeof props.useSessions === "function" ? props.useSessions : void 0;
			// Kept as a fallback for a host whose session-list snapshot still carries a selection
			// (upstream's assumption); in 0.2 it has none, so the probe below is the live source.
			const snapshotSelection = useSessions ? useSessions((s) => s && s.current) : void 0;
			const probedSessionId = useCurrentSessionId();
			const currentSessionId = typeof probedSessionId === "string" && probedSessionId !== ""
				? probedSessionId
				: (typeof snapshotSelection === "string" && snapshotSelection !== "" ? snapshotSelection : void 0);

			const [scope, setScope] = useState("session"); // global | session
			const [viewMode, setViewMode] = useState("single"); // single | split
			const [open, setOpen] = useState(true);
			const [width, setWidth] = useState(280);
			const [editMode, setEditMode] = useState(true);
			const [searchOpen, setSearchOpen] = useState(false);
			const [searchQuery, setSearchQuery] = useState("");
			const [exportOpen, setExportOpen] = useState(false);
			const [copied, setCopied] = useState(false);

			const sessionKey = typeof currentSessionId === "string" && currentSessionId !== "" ? `${SCOPE_PREFIX}${currentSessionId}` : null;
			const scopeKey = scope === "session" && sessionKey !== null ? sessionKey : "global";
			const activeKey = scopeKey;

			const apiA = useRef(null); // global page api
			const apiB = useRef(null); // session page api
			const activeApiRef = viewMode === "split" ? (activeKey === "global" ? apiA : apiB) : apiA;
			const activeKeyRef = useRef(activeKey);
			useEffect(() => { activeKeyRef.current = activeKey; }, [activeKey]);

			const openRef = useRef(true);
			const prevOpenRef = useRef(true);
			const moveRef = useRef(null);
			const dragRef = useRef(null);

			const [pin, setPin] = useState(() => {
				try {
					const raw = localStorage.getItem(LS_PIN_KEY);
					if (raw) {
						const p = JSON.parse(raw);
						if (p && (p.mode === "pinned" || p.mode === "float")) {
							if (p.anchor && typeof p.anchor.ho === "number" && typeof p.anchor.vo === "number") {
								return { mode: "pinned", anchor: p.anchor };
							}
							if (typeof p.x === "number" && typeof p.y === "number") {
								return { mode: p.mode, anchor: absToAnchor(p.x, p.y, 280) };
							}
						}
					}
				} catch {}
				return {
					mode: "pinned",
					anchor: { h: "right", ho: 0, v: "top", vo: Math.max(0, (window.innerHeight - panelHeight()) / 2) }
				};
			});

			useEffect(() => { openRef.current = open; }, [open]);

			// Remember: collapsed state / width
			useEffect(() => {
				try {
					if (localStorage.getItem(LS_OPEN_KEY) === "0") { setOpen(false); openRef.current = false; prevOpenRef.current = false; }
					const w = Number(localStorage.getItem(LS_WIDTH_KEY));
					if (Number.isFinite(w) && w >= MIN_WIDTH && w <= MAX_WIDTH) setWidth(w);
				} catch {}
			}, []);

			// Auto-collapse on narrow screens
			useEffect(() => {
				const mq = window.matchMedia(NARROW_MQ);
				const onChange = (e) => {
					if (e.matches) {
						if (openRef.current) { prevOpenRef.current = true; setOpen(false); }
					} else if (prevOpenRef.current) {
						setOpen(true);
					}
				};
				if (mq.matches && openRef.current) { prevOpenRef.current = true; setOpen(false); }
				mq.addEventListener("change", onChange);
				return () => mq.removeEventListener("change", onChange);
			}, []);

			// Shortcuts: Ctrl+Enter saves immediately; Esc collapses
			useEffect(() => {
				const onKey = (e) => {
					if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
						e.preventDefault();
						const api = activeApiRef.current;
						if (api && typeof api.forceSave === "function") api.forceSave();
						return;
					}
					if (e.key === "Escape") {
						if (searchOpen) { setSearchOpen(false); return; }
						if (openRef.current) setOpen(false);
					}
				};
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [searchOpen]);

			// Header drag (only while floating)
			const onHeaderDown = (e) => {
				if (pin.mode === "pinned") return;
				if (e.target.closest("button")) return;
				const origin = renderOrigin(pin, width);
				const startAnchor = pin.anchor;
				moveRef.current = { mx: e.clientX, my: e.clientY, x: origin.left, y: origin.top, anchor: startAnchor, lastX: origin.left, lastY: origin.top };
				const onMove = (ev) => {
					const m = moveRef.current;
					if (!m) return;
					const ph = panelHeight();
					const x = clamp(m.x + ev.clientX - m.mx, 0, Math.max(0, window.innerWidth - width));
					const y = clamp(m.y + ev.clientY - m.my, 0, Math.max(0, window.innerHeight - ph));
					m.lastX = x;
					m.lastY = y;
					const a = m.anchor;
					const ho = a.h === "right" ? window.innerWidth - x - width : x;
					const vo = a.v === "bottom" ? window.innerHeight - y - ph : y;
					setPin((p) => ({ ...p, mode: "float", anchor: { h: a.h, ho, v: a.v, vo } }));
				};
				const onUp = () => {
					const m = moveRef.current;
					if (m) {
						const next = { mode: "float", anchor: absToAnchor(m.lastX, m.lastY, width) };
						try { localStorage.setItem(LS_PIN_KEY, JSON.stringify(next)); } catch {}
					}
					moveRef.current = null;
					window.removeEventListener("mousemove", onMove);
					window.removeEventListener("mouseup", onUp);
				};
				window.addEventListener("mousemove", onMove);
				window.addEventListener("mouseup", onUp);
				e.preventDefault();
			};

			const togglePin = () => {
				setPin((p) => {
					const next = { mode: p.mode === "pinned" ? "float" : "pinned", anchor: p.anchor };
					try { localStorage.setItem(LS_PIN_KEY, JSON.stringify(next)); } catch {}
					return next;
				});
			};

			const toggleOpen = () => {
				setOpen((v) => {
					const next = !v;
					prevOpenRef.current = next;
					try { localStorage.setItem(LS_OPEN_KEY, next ? "1" : "0"); } catch {}
					return next;
				});
			};

			const onDragStart = (e) => {
				dragRef.current = { startX: e.clientX, startW: width };
				const onMove = (ev) => {
					if (!dragRef.current) return;
					const w = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, dragRef.current.startW + (dragRef.current.startX - ev.clientX)));
					setWidth(w);
				};
				const onUp = () => {
					dragRef.current = null;
					window.removeEventListener("mousemove", onMove);
					window.removeEventListener("mouseup", onUp);
					try { localStorage.setItem(LS_WIDTH_KEY, String(width)); } catch {}
				};
				window.addEventListener("mousemove", onMove);
				window.addEventListener("mouseup", onUp);
				e.preventDefault();
			};

			const activeApi = () => activeApiRef.current;

			const insertTimestamp = () => { const api = activeApi(); if (api) api.insertTimestamp(); };

			const clearAll = () => { const api = activeApi(); if (api) api.clearAll(); };

			const toggleHist = async () => {
				if (histOpen) { setHistOpen(false); return; }
				setHistOpen(true);
				try {
					const res = await fetch(queryUrl(`${API_PATH}/history`, activeKeyRef.current), { cache: "no-store" });
					const body = await res.json();
					setHistItems(body && Array.isArray(body.items) ? body.items : []);
				} catch {
					setHistItems([]);
				}
			};

			const loadHistory = async (id) => {
				setHistOpen(false);
				try {
					const res = await fetch(queryUrl(`${API_PATH}/history/${encodeURIComponent(id)}`, activeKeyRef.current), { cache: "no-store" });
					const body = await res.json();
					if (body && body.ok === true && typeof body.text === "string") {
						const api = activeApi();
						if (api && typeof api.applyHistory === "function") api.applyHistory(body.text);
					}
				} catch {}
			};

			const doExport = async (kind) => {
				const api = activeApi();
				if (!api) return;
				const text = api.getText();
				if (kind === "copy") {
					try {
						await navigator.clipboard.writeText(text);
						setCopied(true);
						setTimeout(() => setCopied(false), 1500);
					} catch {}
					return;
				}
				// Download
				const safe = activeKeyRef.current.replace(/[^A-Za-z0-9_-]/g, "_");
				const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
				const a = document.createElement("a");
				a.href = URL.createObjectURL(blob);
				a.download = `dsh-notepad-${safe}-${new Date().toISOString().slice(0, 10)}.md`;
				a.click();
				setTimeout(() => URL.revokeObjectURL(a.href), 5000);
			};

			// Search: applies to the currently active page
			const searchResults = (() => {
				if (!searchOpen) return [];
				const q = searchQuery.trim().toLowerCase();
				if (!q) return [];
				const api = activeApi();
				if (!api) return [];
				const lines = String(api.getText()).split("\n");
				const out = [];
				lines.forEach((line, i) => {
					if (line.toLowerCase().includes(q)) out.push({ line: i, text: line.trim() });
				});
				return out.slice(0, 50);
			})();

			const [histOpen, setHistOpen] = useState(false);
			const [histItems, setHistItems] = useState([]);

			const origin = renderOrigin(pin, width);
			const isSessionScope = activeKey !== "global";
			const splitReady = sessionKey !== null;

			if (!open) {
				return h("div", {
					role: "button",
					tabIndex: 0,
					"data-plugin": "dsh-notepad",
					title: "Expand notepad",
					"aria-label": "Expand notepad",
					style: tab,
					onClick: toggleOpen,
					onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") toggleOpen(); }
				}, "Notepad");
			}

			const splitMode = viewMode === "split" && splitReady;

			return h("div", {
				"data-plugin": "dsh-notepad",
				role: "complementary",
				"aria-label": "Notepad",
				style: { ...panel, width, left: origin.left, top: origin.top }
			},
				h("div", { style: dragHandle, title: "Drag to resize width", onMouseDown: onDragStart }),
				h("div", {
					style: { ...header, cursor: pin.mode === "pinned" ? "default" : "move" },
					onMouseDown: onHeaderDown,
					title: pin.mode === "pinned" ? "Pinned (dragging disabled) · click 📌 to unpin" : "Drag to move the window · click 📌 to pin"
				},
					h("div", { style: { display: "flex", alignItems: "center", gap: 2, flex: 1, minWidth: 0 } },
						h("button", {
							type: "button",
							style: { ...modeBtn, ...(scope === "global" ? modeActive : {}) },
							title: "Global notepad (shared by all sessions)",
							onClick: () => setScope("global")
						}, "Global"),
						h("button", {
							type: "button",
							style: { ...modeBtn, ...(scope === "session" ? modeActive : {}), ...(!splitReady ? { opacity: 0.4, cursor: "not-allowed" } : {}) },
							title: splitReady ? "This session's isolated notepad" : "Enter a session first",
							disabled: !splitReady,
							onClick: () => setScope("session")
						}, "Session")),
					h("button", {
						type: "button",
						style: { ...iconBtn, ...(splitMode ? modeActive : {}) },
						title: splitMode ? "Split view · click to return to a single page" : "View the global page and this session side by side",
						disabled: !splitReady,
						onClick: () => setViewMode((v) => (v === "single" ? "split" : "single"))
					}, "⇔"),
					h("button", {
						type: "button",
						style: { ...iconBtn, ...(pin.mode === "pinned" ? { color: "var(--dsw-alias-state-success-primary)" } : {}) },
						title: pin.mode === "pinned" ? "Pinned in this position · click to unpin" : "Click to pin in this position",
						onClick: togglePin
					}, pin.mode === "pinned" ? "📍" : "📌"),
					h("button", { type: "button", style: iconBtn, title: "Insert timestamp [MM-DD HH:mm]", onClick: insertTimestamp }, "🕓"),
					h("button", { type: "button", style: { ...iconBtn, ...(searchOpen ? modeActive : {}) }, title: "Search", onClick: () => setSearchOpen((v) => !v) }, "🔍"),
					h("button", { type: "button", style: { ...iconBtn, ...(histOpen ? modeActive : {}) }, title: "Version history", onClick: toggleHist }, "⏱"),
					h("button", { type: "button", style: { ...iconBtn, ...(exportOpen ? modeActive : {}) }, title: "Export", onClick: () => setExportOpen((v) => !v) }, "⤓"),
					h("button", { type: "button", style: iconBtn, title: "Clear", onClick: clearAll }, "✕"),
					h("button", { type: "button", style: iconBtn, title: "Collapse", onClick: toggleOpen }, "»")
				),
				splitMode
					? h("div", { style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" } },
						h(EditorPane, {
							scopeKey: "global",
							style: { flex: 1, minHeight: 0 },
							placeholder: "Global notepad (shared by all sessions)…",
							previewMode: false,
							label: "🌐 Global",
							onActivate: () => setScope("global"),
							apiRef: apiA
						}),
						h("div", { style: divider }),
						h(EditorPane, {
							scopeKey: sessionKey,
							style: { flex: 1, minHeight: 0 },
							placeholder: "This session's own notepad…",
							previewMode: false,
							label: `💬 Session ${currentSessionId.slice(0, 8)}…`,
							onActivate: () => setScope("session"),
							apiRef: apiB
						})
					)
					: h(EditorPane, {
						scopeKey: activeKey,
						style: { flex: 1, minHeight: 0 },
						placeholder: isSessionScope ? "This session's own notepad (invisible to other sessions)…" : "Jot something down… (shared by all sessions, saved automatically)",
						previewMode: !editMode,
						label: null,
						onActivate: null,
						apiRef: apiA
					}),
				searchOpen ? h("div", { style: { ...pop, top: 36 } },
					h("div", { style: { display: "flex", gap: 6, padding: "8px 10px" } },
						h("input", {
							style: searchInput,
							placeholder: "Search the current page… (Enter jumps to the first match)",
							value: searchQuery,
							onChange: (e) => setSearchQuery(e.target.value),
							onKeyDown: (e) => {
								if (e.key === "Enter" && searchResults.length > 0) {
									const api = activeApi();
									if (api && typeof api.scrollToLine === "function") api.scrollToLine(searchResults[0].line);
								}
							}
						})),
					searchResults.length === 0
						? h("div", { style: { padding: "6px 12px", color: "var(--dsw-alias-label-secondary)", fontSize: 11 } },
							searchQuery.trim() ? "No matches" : "Type a keyword to search the current page")
						: h("div", { style: { padding: "2px 0 6px" } },
							h("div", { style: { padding: "2px 12px", color: "var(--dsw-alias-label-secondary)", fontSize: 10 } }, `${searchResults.length} matches`),
							searchResults.map((r) => h("button", {
								key: r.line,
								type: "button",
								style: popItem,
								title: `Jump to line ${r.line + 1}`,
								onClick: () => {
									const api = activeApi();
									if (api && typeof api.scrollToLine === "function") api.scrollToLine(r.line);
								}
							}, h("span", { style: { flex: "none", color: "var(--dsw-alias-label-secondary)" } }, `L${r.line + 1}`),
								h("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, r.text))))
				) : null,
				histOpen ? h("div", { style: pop },
					histItems.length === 0
						? h("div", { style: { padding: "8px 12px", color: "var(--dsw-alias-label-secondary)", fontSize: 11 } }, "No history snapshots yet (the version before each save is archived automatically)")
						: histItems.map((item) => h("button", {
							key: item.id,
							type: "button",
							style: popItem,
							title: "Load this version",
							onClick: () => loadHistory(item.id)
						}, `🕓 ${parseHistoryTime(item.id)}`))
				) : null,
				exportOpen ? h("div", { style: pop },
					h("button", { type: "button", style: popItem, onClick: () => doExport("copy") }, copied ? "✅ Copied" : "📋 Copy all"),
					h("button", { type: "button", style: popItem, onClick: () => doExport("download") }, "⬇ Download .md")
				) : null,
				editMode && !splitMode ? h("div", { style: { display: "flex", alignItems: "center", gap: 4, padding: "2px 10px 4px", flex: "none" } },
					h("button", {
						type: "button",
						style: modeBtn,
						title: "Preview the rendered result (checkboxes are clickable)",
						onClick: () => setEditMode(false)
					}, "Preview")
				) : null,
				!editMode && !splitMode ? h("div", { style: { display: "flex", alignItems: "center", gap: 4, padding: "2px 10px 4px", flex: "none" } },
					h("button", { type: "button", style: modeBtn, title: "Back to editing", onClick: () => setEditMode(true) }, "Edit")
				) : null
			);
		}

		// ---- client plugin body -----------------------------------------
		const inject = ["slots"];

		function apply(ctx) {
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "dsh-notepad",
				order: 50,
				label: "Notepad"
			}, NotepadPanel));
			// Session-scope seat used only to learn which Session is open; renders nothing.
			ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
				name: "conversation.input.left",
				id: "dsh-notepad-session-probe",
				order: 1000
			}, SessionIdProbe));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
