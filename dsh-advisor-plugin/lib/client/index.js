window.__ModuleLoader__.load({
	id: "dsh-advisor-plugin",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.ts
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);

// src/client/AdvisorCard.tsx
var import_react = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
function ToggleSwitch(props) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    "button",
    {
      type: "button",
      role: "switch",
      "aria-checked": props.checked,
      "aria-label": props.label,
      disabled: props.disabled,
      onClick: props.onToggle,
      style: {
        ...style.button,
        width: 40,
        height: 22,
        borderRadius: 11,
        padding: 0,
        position: "relative",
        background: props.checked ? "#16a34a" : "rgba(128,128,128,.4)",
        border: "none"
      },
      children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: {
        position: "absolute",
        top: 2,
        left: props.checked ? 20 : 2,
        width: 18,
        height: 18,
        borderRadius: 9,
        background: "#fff",
        transition: "left .15s"
      } })
    }
  );
}
function Section(props) {
  const [open, setOpen] = (0, import_react.useState)(props.defaultOpen ?? false);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: style.section, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
      "button",
      {
        type: "button",
        style: style.sectionHead,
        "aria-expanded": open,
        onClick: () => setOpen((v) => !v),
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: style.sectionTitle, children: props.title }),
          props.subtitle === void 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: style.sectionSubtitle, children: props.subtitle }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: style.sectionState, children: open ? props.t("sectionCollapse") : props.t("sectionExpand") })
        ]
      }
    ),
    open ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: style.sectionBody, children: props.children }) : null
  ] });
}
function PatrolSection(props) {
  const { t } = props;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { display: "flex", flexDirection: "column", gap: 10 }, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: style.description, children: t("patrolDescription") }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: style.effortRow, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: t("patrolToggle") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        ToggleSwitch,
        {
          checked: props.enabled,
          disabled: props.disabled,
          label: t("patrolToggle"),
          onToggle: props.togglePatrol
        }
      )
    ] }),
    props.enabled ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: style.effortRow, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", { htmlFor: "advisor-patrol-steps", children: t("patrolEverySteps") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "input",
          {
            id: "advisor-patrol-steps",
            type: "number",
            min: 2,
            max: 500,
            value: props.everySteps,
            disabled: props.disabled,
            onChange: (event) => {
              props.setPatrolEverySteps(Number(event.target.value));
            },
            style: { width: 64 }
          }
        )
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: style.effortRow, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", { htmlFor: "advisor-patrol-immune", children: t("patrolImmuneTurns") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "input",
          {
            id: "advisor-patrol-immune",
            type: "number",
            min: 0,
            max: 20,
            value: props.immuneTurns,
            disabled: props.disabled,
            onChange: (event) => {
              props.setPatrolImmuneTurns(Number(event.target.value));
            },
            style: { width: 64 }
          }
        )
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { ...style.effortRow, marginTop: 8 }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: t("investigateToggle") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          ToggleSwitch,
          {
            checked: props.investigate,
            disabled: props.disabled,
            label: t("investigateToggle"),
            onToggle: props.toggleInvestigate
          }
        )
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: { ...style.notice, marginTop: -2 }, children: t("investigateHint") })
    ] }) : null,
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: { ...style.notice, marginTop: -2 }, children: t("patrolEveryStepsHint") })
  ] });
}
var EFFORT_OPTIONS = ["", "off", "minimal", "low", "medium", "high", "xhigh", "max"];
var style = {
  card: { border: "1px solid rgba(128,128,128,.35)", borderRadius: 8, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 },
  title: { fontSize: 14, fontWeight: 600, margin: 0 },
  description: { fontSize: 12, opacity: 0.75, margin: 0, lineHeight: 1.6 },
  current: { fontSize: 12, margin: 0 },
  groupTitle: { fontSize: 12, fontWeight: 600, opacity: 0.85, margin: "8px 0 2px" },
  row: { display: "flex", alignItems: "center", gap: 8, padding: "3px 0", fontSize: 13 },
  modelName: { display: "flex", flexDirection: "column" },
  route: { fontSize: 11, opacity: 0.65 },
  badge: { fontSize: 11, color: "#b45309" },
  notice: { fontSize: 12, opacity: 0.7, margin: 0 },
  error: { fontSize: 12, color: "#b91c1c", display: "flex", gap: 8, alignItems: "center" },
  effortRow: { display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginTop: 6 },
  actions: { display: "flex", gap: 8, alignItems: "center", marginTop: 4 },
  button: { fontSize: 13, padding: "4px 14px", borderRadius: 6, cursor: "pointer" },
  primary: { background: "#2563eb", color: "#fff", border: "none" },
  secondary: { background: "transparent", border: "1px solid rgba(128,128,128,.5)" },
  status: { fontSize: 12 },
  list: { maxHeight: 260, overflowY: "auto", border: "1px solid rgba(128,128,128,.25)", borderRadius: 6, padding: "4px 10px" },
  switchRow: { display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginTop: 2 },
  switchLabel: { fontWeight: 600 },
  section: { border: "1px solid rgba(128,128,128,.25)", borderRadius: 8, overflow: "hidden" },
  sectionHead: { display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "8px 10px", background: "rgba(128,128,128,.06)", border: "none", font: "inherit", textAlign: "left", cursor: "pointer" },
  sectionTitle: { fontSize: 13, fontWeight: 600 },
  sectionSubtitle: { fontSize: 11, opacity: 0.65, flex: 1 },
  sectionState: { fontSize: 11, opacity: 0.65, marginLeft: "auto" },
  sectionBody: { padding: 10, display: "flex", flexDirection: "column", gap: 8 }
};
function AdvisorCard(props) {
  const state = props.useAdvisorCard((s) => s);
  const enabled = state.enabled;
  const effortOptions = state.efforts.known ? ["", ...state.efforts.levels] : EFFORT_OPTIONS;
  const disabled = !state.writable || state.saving;
  const armed = enabled && state.effective.provider !== "" && state.effective.model !== "";
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: style.card, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { style: style.title, children: props.t("title") }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: style.description, children: props.t("description") }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: style.switchRow, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: style.switchLabel, children: props.t("enabledToggle") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        ToggleSwitch,
        {
          checked: enabled,
          disabled,
          label: props.t("enabledToggle"),
          onToggle: props.toggleEnabled
        }
      )
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: style.notice, children: enabled ? props.t("enabledHintOn") : props.t("enabledHintOff") }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { style: style.current, children: [
      props.t("armed"),
      "\uFF1A",
      armed ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: `${state.effective.provider}/${state.effective.model}${state.effective.effort === "" ? "" : ` (${state.effective.effort})`}` }) : props.t("offCurrent")
    ] }),
    !state.writable ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: style.notice, children: props.t("readonly") }) : null,
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
      Section,
      {
        t: props.t,
        title: props.t("modelSection"),
        subtitle: props.t("modelSectionHint"),
        defaultOpen: true,
        children: [
          state.catalogStatus === "loading" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: style.notice, children: props.t("loading") }) : null,
          state.catalogStatus === "error" ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: style.error, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: props.t("loadFailed") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", style: { ...style.button, ...style.secondary }, disabled, onClick: props.retryCatalog, children: props.t("retry") })
          ] }) : null,
          state.catalogPartial ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: style.notice, children: props.t("partial") }) : null,
          state.groups.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: style.notice, children: props.t("choose") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: style.list, children: state.groups.map((group) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: style.groupTitle, children: group.name }),
              group.candidates.map((candidate) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { style: style.row, children: [
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                  "input",
                  {
                    type: "radio",
                    name: "advisor-route",
                    checked: candidate.selected,
                    disabled,
                    onChange: () => {
                      props.pickRoute(candidate.key);
                    }
                  }
                ),
                /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: style.modelName, children: [
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: candidate.modelName }),
                  /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: style.route, children: `${candidate.provider}/${candidate.model}` })
                ] }),
                !candidate.available ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: style.badge, children: props.t("unavailable") }) : null
              ] }, candidate.key))
            ] }, group.id)) })
          ] }) : state.catalogStatus === "ready" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: style.notice, children: props.t("empty") }) : null,
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: style.effortRow, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("label", { htmlFor: "advisor-effort", children: props.t("effort") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "select",
              {
                id: "advisor-effort",
                value: state.effective.effort,
                disabled,
                onChange: (event) => {
                  props.setEffort(event.target.value);
                },
                children: effortOptions.map((option) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: option, children: option === "" ? props.t("effortDefault") : option }, option))
              }
            )
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { style: { ...style.notice, marginTop: -4 }, children: state.efforts.known ? props.t("effortHintKnown") : props.t("effortHint") })
        ]
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Section, { t: props.t, title: props.t("patrolTitle"), defaultOpen: false, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      PatrolSection,
      {
        ...props,
        enabled: state.patrol.enabled,
        everySteps: state.patrol.everySteps,
        immuneTurns: state.patrol.immuneTurns,
        investigate: state.patrol.investigate,
        disabled
      }
    ) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: style.actions, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "button",
        {
          type: "button",
          style: { ...style.button, ...style.primary },
          disabled: disabled || !state.dirty,
          onClick: props.save,
          children: props.t("save")
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "button",
        {
          type: "button",
          style: { ...style.button, ...style.secondary },
          disabled: disabled || !state.dirty,
          onClick: props.discard,
          children: props.t("discard")
        }
      ),
      state.saving ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: style.status, children: props.t("saving") }) : null,
      state.failed ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { ...style.status, color: "#b91c1c" }, children: props.t("saveFailed") }) : null
    ] })
  ] });
}

// src/client/AdvisorToolRow.tsx
var import_react2 = require("react");
var import_jsx_runtime2 = require("react/jsx-runtime");
var style2 = {
  row: { display: "flex", flexDirection: "column", gap: 4, margin: "6px 0", border: "1px solid rgba(37,99,235,.35)", borderRadius: 8, overflow: "hidden" },
  head: { display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", cursor: "pointer", background: "rgba(37,99,235,.08)", border: "none", font: "inherit", textAlign: "left", width: "100%" },
  title: { fontWeight: 600, fontSize: 13, color: "#1d4ed8" },
  state: { fontSize: 12, opacity: 0.75 },
  badge: { fontSize: 11, padding: "1px 8px", borderRadius: 8, flex: "none" },
  badgeRun: { background: "rgba(37,99,235,.15)", color: "#1d4ed8" },
  badgeOk: { background: "rgba(22,163,74,.15)", color: "#15803d" },
  badgeErr: { background: "rgba(185,28,28,.12)", color: "#b91c1c" },
  body: { padding: "8px 12px", fontSize: 13, lineHeight: 1.65, whiteSpace: "pre-wrap", borderTop: "1px solid rgba(37,99,235,.2)", maxHeight: 320, overflowY: "auto" }
};
function blockOutput(block) {
  if (block === void 0) return { text: "", isError: false };
  const parts = [];
  for (const b of block.content ?? []) {
    if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (b !== void 0 && b !== null) parts.push(JSON.stringify(b, null, 2));
  }
  if (parts.length === 0 && block.error !== void 0) {
    const e = block.error;
    parts.push(`${typeof e.name === "string" ? e.name : "Error"}: ${typeof e.code === "string" ? e.code : ""} ${typeof e.message === "string" ? e.message : ""}`.trim());
  }
  return { text: parts.join("\n").trim(), isError: block.isError === true };
}
function AdvisorToolRow(props) {
  const t = props.t ?? ((key) => key);
  const [expanded, setExpanded] = (0, import_react2.useState)(false);
  const block = props.block ?? {};
  const done = block.kind !== void 0;
  const { text, isError } = done ? blockOutput(block) : { text: "", isError: false };
  const badge = !done ? { label: t("toolRunning"), css: style2.badgeRun } : isError ? { label: t("toolFailed"), css: style2.badgeErr } : { label: t("toolDone"), css: style2.badgeOk };
  const canExpand = done && text !== "";
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { style: style2.row, children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("button", { type: "button", style: style2.head, onClick: () => {
      if (canExpand) setExpanded((v) => !v);
    }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { style: style2.title, children: [
        "\u{1F9ED} Advisor ",
        t("toolTitle")
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: { ...style2.badge, ...badge.css }, children: badge.label }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { style: style2.state, children: !done ? t("toolConsulting") : canExpand ? expanded ? t("toolCollapse") : t("toolExpand") : "" })
    ] }),
    expanded && canExpand ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { style: style2.body, children: text }) : null
  ] });
}

// src/client/store.ts
function createSnapshotStore(initial) {
  let current = initial;
  const listeners = /* @__PURE__ */ new Set();
  return {
    getSnapshot: () => current,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    set: (value) => {
      current = value;
      for (const fn of listeners) fn();
    }
  };
}

// src/client/controller.ts
function routeKey(provider, model) {
  return `${provider}\0${model}`;
}
function buildCandidates(groups, effective) {
  const selectedKey = effective.provider === "" || effective.model === "" ? void 0 : routeKey(effective.provider, effective.model);
  const seen = /* @__PURE__ */ new Set();
  const out = groups.map((group) => ({
    id: group.id,
    name: group.name,
    candidates: group.models.map((model) => {
      const key = routeKey(group.id, model.id);
      seen.add(key);
      const declared = model.reasoning?.efforts;
      return {
        key,
        provider: group.id,
        model: model.id,
        providerName: group.name,
        modelName: model.name,
        available: true,
        selected: key === selectedKey,
        ...declared === void 0 || declared === null ? {} : { effortLevels: declared.map((e) => e.id) }
      };
    })
  }));
  let stale = false;
  if (selectedKey !== void 0 && !seen.has(selectedKey)) {
    stale = true;
    out.push({
      id: effective.provider,
      name: effective.provider,
      candidates: [{
        key: selectedKey,
        provider: effective.provider,
        model: effective.model,
        providerName: effective.provider,
        modelName: effective.model,
        available: false,
        selected: true
      }]
    });
  }
  return { groups: out, stale };
}
function currentEffortSupport(groups, route) {
  if (route.provider === "" || route.model === "") return { known: false, levels: [] };
  const declared = groups.find((g) => g.id === route.provider)?.models.find((m) => m.id === route.model)?.reasoning?.efforts;
  if (declared === void 0 || declared === null) return { known: false, levels: [] };
  return { known: true, levels: declared.map((e) => e.id) };
}
var AdvisorCardController = class {
  constructor(scope, ctx) {
    this.scope = scope;
    this.ctx = ctx;
    this.store = createSnapshotStore(this.projection());
    this.unsubscribe = scope.subscribe(() => {
      if (!this.saving) this.publish();
    });
    if (this.catalogStatus === "idle") void this.loadCatalog();
  }
  scope;
  ctx;
  catalogGroups = [];
  catalogStatus = "idle";
  catalogPartial = false;
  draft;
  saving = false;
  failed = false;
  disposed = false;
  catalogGeneration = 0;
  store;
  unsubscribe;
  dispose() {
    this.disposed = true;
    this.catalogGeneration += 1;
    this.unsubscribe();
  }
  inject() {
    return {
      hooks: { advisorCard: this.store },
      pickRoute: (key) => this.pickRoute(key),
      toggleEnabled: () => this.toggleEnabled(),
      setEffort: (effort) => this.setEffort(effort),
      togglePatrol: () => this.togglePatrol(),
      setPatrolEverySteps: (steps) => this.setPatrolEverySteps(steps),
      setPatrolImmuneTurns: (n) => this.setPatrolImmuneTurns(n),
      toggleInvestigate: () => this.toggleInvestigate(),
      save: () => {
        void this.save();
      },
      discard: () => this.discard(),
      retryCatalog: () => {
        void this.loadCatalog();
      }
    };
  }
  saved() {
    const value = this.scope.getSnapshot().value;
    return {
      enabled: value?.enabled ?? true,
      provider: value?.provider ?? "",
      model: value?.model ?? "",
      effort: value?.effort ?? "",
      patrolEnabled: value?.patrolEnabled ?? true,
      patrolEverySteps: value?.patrolEverySteps ?? 6,
      patrolImmuneTurns: value?.patrolImmuneTurns ?? 3,
      investigate: value?.investigate ?? true
    };
  }
  savedPatrol() {
    const saved = this.saved();
    return { enabled: saved.patrolEnabled !== false, everySteps: saved.patrolEverySteps ?? 6 };
  }
  effective() {
    return this.draft ?? this.saved();
  }
  pickRoute(key) {
    if (!this.scope.getSnapshot().writable || this.saving) return;
    const all = this.catalogGroups.flatMap((g) => g.models.map((m) => ({ provider: g.id, model: m.id })));
    const hit = all.find((r) => routeKey(r.provider, r.model) === key);
    const base = this.effective();
    const currentKey = base.provider === "" || base.model === "" ? void 0 : routeKey(base.provider, base.model);
    if (currentKey === key) {
      this.draft = { ...base, provider: "", model: "" };
    } else if (hit !== void 0) {
      let draft = { ...base, provider: hit.provider, model: hit.model };
      const support = currentEffortSupport(this.catalogGroups, draft);
      if (support.known && draft.effort !== "" && !support.levels.includes(draft.effort)) {
        console.log(`[dsh-advisor] \u6863\u4F4D ${draft.effort} \u4E0D\u88AB ${draft.provider}/${draft.model} \u652F\u6301\uFF0C\u5DF2\u81EA\u52A8\u6E05\u7A7A`);
        draft = { ...draft, effort: "" };
      }
      this.draft = draft;
    }
    this.failed = false;
    this.publish();
  }
  setEffort(effort) {
    if (!this.scope.getSnapshot().writable || this.saving) return;
    const support = currentEffortSupport(this.catalogGroups, this.effective());
    if (support.known && effort !== "" && !support.levels.includes(effort)) return;
    this.draft = { ...this.effective(), effort };
    this.failed = false;
    this.publish();
  }
  toggleEnabled() {
    if (!this.scope.getSnapshot().writable || this.saving) return;
    const current = this.effective();
    this.draft = { ...current, enabled: !(current.enabled ?? true) };
    this.failed = false;
    this.publish();
  }
  togglePatrol() {
    if (!this.scope.getSnapshot().writable || this.saving) return;
    const current = this.effective();
    this.draft = { ...current, patrolEnabled: !(current.patrolEnabled ?? true) };
    this.failed = false;
    this.publish();
  }
  setPatrolEverySteps(steps) {
    if (!this.scope.getSnapshot().writable || this.saving) return;
    const bounded = Number.isFinite(steps) ? Math.min(500, Math.max(2, Math.round(steps))) : 6;
    this.draft = { ...this.effective(), patrolEverySteps: bounded };
    this.failed = false;
    this.publish();
  }
  setPatrolImmuneTurns(n) {
    if (!this.scope.getSnapshot().writable || this.saving) return;
    const bounded = Number.isFinite(n) ? Math.min(20, Math.max(0, Math.round(n))) : 3;
    this.draft = { ...this.effective(), patrolImmuneTurns: bounded };
    this.failed = false;
    this.publish();
  }
  toggleInvestigate() {
    if (!this.scope.getSnapshot().writable || this.saving) return;
    const current = this.effective();
    this.draft = { ...current, investigate: !(current.investigate ?? true) };
    this.failed = false;
    this.publish();
  }
  discard() {
    if (this.saving) return;
    this.draft = void 0;
    this.failed = false;
    this.publish();
  }
  async save() {
    const desired = this.draft;
    if (this.disposed || desired === void 0 || this.saving || !this.scope.getSnapshot().writable) return;
    this.saving = true;
    this.failed = false;
    this.publish();
    try {
      await this.scope.set("enabled", desired.enabled ?? true);
      await this.scope.set("provider", desired.provider);
      await this.scope.set("model", desired.model);
      await this.scope.set("effort", desired.effort);
      await this.scope.set("patrolEnabled", desired.patrolEnabled ?? true);
      await this.scope.set("patrolEverySteps", desired.patrolEverySteps ?? 6);
      await this.scope.set("patrolImmuneTurns", desired.patrolImmuneTurns ?? 3);
      await this.scope.set("investigate", desired.investigate ?? true);
      this.draft = void 0;
    } catch {
      this.failed = true;
    }
    this.saving = false;
    this.publish();
  }
  async loadCatalog() {
    if (this.disposed || this.catalogStatus === "loading") return;
    const generation = this.catalogGeneration;
    this.catalogStatus = "loading";
    this.catalogPartial = false;
    this.publish();
    try {
      const connection = this.ctx.get("connection");
      const response = await connection.api.llm.models({});
      if (generation !== this.catalogGeneration) return;
      if (response.result.ok) {
        this.catalogGroups = response.result.value.groups;
        this.catalogPartial = response.result.value.failures.length > 0;
        this.catalogStatus = "ready";
      } else {
        this.catalogStatus = "error";
      }
    } catch {
      if (generation !== this.catalogGeneration) return;
      this.catalogStatus = "error";
    }
    this.publish();
  }
  projection() {
    const snapshot = this.scope.getSnapshot();
    const effective = this.effective();
    const built = buildCandidates(this.catalogGroups, effective);
    return {
      available: snapshot.status === "ready",
      writable: snapshot.writable,
      saving: this.saving,
      failed: this.failed,
      dirty: this.draft !== void 0,
      catalogStatus: this.catalogStatus,
      catalogPartial: this.catalogPartial,
      enabled: effective.enabled ?? true,
      effective,
      patrol: {
        enabled: effective.patrolEnabled ?? true,
        everySteps: effective.patrolEverySteps ?? 6,
        immuneTurns: effective.patrolImmuneTurns ?? 3,
        investigate: effective.investigate ?? true
      },
      efforts: currentEffortSupport(this.catalogGroups, effective),
      groups: built.groups
    };
  }
  publish() {
    this.store.set(this.projection());
  }
};

// src/client/settings-controller.ts
var LEGACY_SETTINGS_NAMESPACE = "advisor";
var ENTRY_ID = "dsh-advisor-plugin";
var SETTINGS_KEYS = [ENTRY_ID, LEGACY_SETTINGS_NAMESPACE];
var UNAVAILABLE_SNAPSHOT = {
  status: "unavailable",
  value: void 0,
  writable: false
};
function createResolvingScope() {
  const listeners = /* @__PURE__ */ new Set();
  let source;
  let detach;
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  return {
    getSnapshot: () => source?.getSnapshot() ?? UNAVAILABLE_SNAPSHOT,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set: (field, value) => source?.set(field, value) ?? Promise.resolve(),
    attach: (next) => {
      if (next === source) return;
      detach?.();
      source = next;
      detach = next.subscribe(notify);
      notify();
    }
  };
}
function projectConfigForm(form) {
  const write = async (field, value) => {
    if (typeof form.mutate === "function") {
      const accepted = await form.mutate([{ op: "set", path: [field], value }]);
      if (!accepted) throw new Error(`\u8BBE\u7F6E\u5199\u5165\u88AB\u5BBF\u4E3B\u62D2\u7EDD\uFF1A${field}`);
      return;
    }
    if (typeof form.set === "function") {
      const accepted = await form.set(field, value);
      if (!accepted) throw new Error(`\u8BBE\u7F6E\u5199\u5165\u88AB\u5BBF\u4E3B\u62D2\u7EDD\uFF1A${field}`);
      return;
    }
    throw new Error("\u8BBE\u7F6E\u8868\u5355\u65E2\u65E0 set \u4E5F\u65E0 mutate\uFF0C\u65E0\u6CD5\u5199\u5165");
  };
  return {
    getSnapshot: () => form.getSnapshot(),
    subscribe: (listener) => form.subscribe(listener),
    set: (field, value) => write(field, value)
  };
}
function readService(host, name) {
  try {
    if (typeof host.get === "function") {
      const viaGet = host.get(name);
      if (viaGet !== void 0) return viaGet;
    }
  } catch {
  }
  return host[name];
}
function resolveConfigForms(host, keys = SETTINGS_KEYS) {
  try {
    const service = readService(host, "configForms");
    if (service === void 0 || service === null || typeof service.get !== "function") return void 0;
    let fallback;
    for (const key of keys) {
      const form = service.get(key);
      if (form === void 0 || form === null) continue;
      if (typeof form.getSnapshot !== "function" || typeof form.subscribe !== "function") continue;
      fallback ??= form;
      const status = form.getSnapshot().status;
      if (status !== "unavailable") return projectConfigForm(form);
    }
    return fallback === void 0 ? void 0 : projectConfigForm(fallback);
  } catch (error) {
    console.warn("[dsh-advisor] configForms \u8BBE\u7F6E\u6E90\u89E3\u6790\u5931\u8D25\uFF08\u5361\u7247\u5C06\u663E\u793A\u4E3A\u4E0D\u53EF\u7528\uFF09\uFF1A", error);
    return void 0;
  }
}
function resolveLegacySettingsScope(host) {
  try {
    const service = readService(host, "settingsScope");
    if (service === void 0 || service === null || typeof service.bind !== "function") return void 0;
    return service.bind({ namespace: LEGACY_SETTINGS_NAMESPACE });
  } catch (error) {
    console.warn("[dsh-advisor] settingsScope \u8BBE\u7F6E\u6E90\u89E3\u6790\u5931\u8D25\uFF08\u5361\u7247\u5C06\u663E\u793A\u4E3A\u4E0D\u53EF\u7528\uFF09\uFF1A", error);
    return void 0;
  }
}

// src/client/locales.ts
var zh = {
  title: "Advisor \u5BA1\u67E5\u6A21\u578B",
  description: "\u6267\u884C\u6A21\u578B\u5361\u4F4F/\u505A\u91CD\u5927\u51B3\u7B56/\u5BA3\u544A\u5B8C\u6210\u524D\uFF0C\u53EF\u8C03\u7528\u96F6\u53C2\u6570\u7684 advisor() \u5DE5\u5177\u5347\u7EA7\u54A8\u8BE2\u8BE5\u5BA1\u67E5\u6A21\u578B\uFF0C\u62FF\u56DE\u8BA1\u5212\u3001\u7EA0\u6B63\u6216\u505C\u6B62\u4FE1\u53F7\u3002\u6574\u6BB5\u4F1A\u8BDD\u6BCF\u6B21\u8C03\u7528\u90FD\u4F1A\u8F6C\u53D1\u7ED9\u5B83\u2014\u2014\u5347\u7EA7\u4E0D\u514D\u8D39\u3002",
  armed: "\u5F53\u524D\u5BA1\u67E5\u6A21\u578B",
  off: "\u672A\u9009\u62E9\u2014\u2014advisor \u5DE5\u5177\u5BF9\u6A21\u578B\u9690\u85CF\uFF08\u96F6\u63D0\u793A\u8BCD\u6210\u672C\uFF09",
  offCurrent: "\u672A\u9009\u62E9",
  choose: "\u9009\u62E9\u4E00\u4E2A DSH \u5DF2\u914D\u7F6E\u7684\u6A21\u578B\uFF1A",
  loading: "\u6B63\u5728\u52A0\u8F7D\u6A21\u578B\u76EE\u5F55\u2026",
  loadFailed: "\u6A21\u578B\u76EE\u5F55\u52A0\u8F7D\u5931\u8D25",
  retry: "\u91CD\u8BD5",
  partial: "\u90E8\u5206 provider \u7684\u6A21\u578B\u5217\u8868\u83B7\u53D6\u5931\u8D25\uFF0C\u5217\u8868\u53EF\u80FD\u4E0D\u5B8C\u6574\u3002",
  empty: "\u6CA1\u6709\u53EF\u914D\u7F6E\u7684\u6A21\u578B\u2014\u2014\u8BF7\u5148\u5728 \u8BBE\u7F6E \u2192 \u6A21\u578B \u91CC\u914D\u7F6E provider\u3002",
  effort: "\u63A8\u7406\u6863\u4F4D",
  effortDefault: "\uFF08\u6A21\u578B\u9ED8\u8BA4\uFF09",
  effortHint: "\u7559\u7A7A\u8D70\u6A21\u578B\u9ED8\u8BA4\uFF1B\u8BE5\u6A21\u578B\u672A\u58F0\u660E\u652F\u6301\u6863\u4F4D\u2014\u2014\u82E5\u914D\u7F6E\u7684\u6863\u4F4D\u4E0D\u88AB\u652F\u6301\uFF0C\u63D2\u4EF6\u4F1A\u81EA\u52A8\u964D\u7EA7\u4E3A\u9ED8\u8BA4\u6863\uFF08\u65E5\u5FD7\u53EF\u89C1\uFF09\u3002",
  effortHintKnown: "\u53EA\u5217\u51FA\u8BE5\u6A21\u578B\u58F0\u660E\u652F\u6301\u7684\u6863\u4F4D\uFF1B\u7559\u7A7A\u8D70\u6A21\u578B\u9ED8\u8BA4\u3002",
  unavailable: "\uFF08\u5DF2\u914D\u7F6E\u7684\u8DEF\u7531\u4E0D\u5728\u5F53\u524D\u6A21\u578B\u76EE\u5F55\u4E2D\uFF09",
  save: "\u4FDD\u5B58",
  saving: "\u4FDD\u5B58\u4E2D\u2026",
  discard: "\u653E\u5F03\u66F4\u6539",
  saved: "\u5DF2\u4FDD\u5B58",
  saveFailed: "\u4FDD\u5B58\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5",
  readonly: "\u8BBE\u7F6E\u6587\u6863\u53EA\u8BFB\uFF0C\u65E0\u6CD5\u5728\u6B64\u4FEE\u6539\u3002",
  enabledToggle: "\u542F\u7528 Advisor \u63D2\u4EF6",
  enabledHintOn: "\u603B\u5F00\u5173\u5DF2\u6253\u5F00\uFF1A\u914D\u7F6E\u5BA1\u67E5\u6A21\u578B\u540E\uFF0Cadvisor \u5DE5\u5177\u4F1A\u5BF9\u6267\u884C\u6A21\u578B\u53EF\u89C1\u3002",
  enabledHintOff: "\u603B\u5F00\u5173\u5DF2\u5173\u95ED\uFF1Aadvisor \u5DE5\u5177\u4E0E\u5347\u7EA7\u5B88\u5219\u4E0D\u4F1A\u6CE8\u518C\uFF0C\u5DF2\u4FDD\u5B58\u7684\u6A21\u578B\u914D\u7F6E\u4F1A\u4FDD\u7559\u3002",
  modelSection: "\u6A21\u578B\u4E0E\u63A8\u7406\u6863\u4F4D",
  modelSectionHint: "\u9009\u62E9\u5BA1\u67E5\u6A21\u578B\u548C\u63A8\u7406\u6863\u4F4D",
  sectionExpand: "\u5C55\u5F00",
  sectionCollapse: "\u6536\u8D77",
  patrolTitle: "\u5DE1\u903B\u6A21\u5F0F\uFF08\u81EA\u52A8\u68C0\u6D4B\u8DD1\u504F\uFF09",
  patrolDescription: "\u6267\u884C\u8FC7\u7A0B\u4E2D\u6BCF\u9694\u82E5\u5E72\u6B65\u81EA\u52A8\u628A\u4F1A\u8BDD\u5FEB\u7167\u53D1\u7ED9\u5BA1\u67E5\u6A21\u578B\u68C0\u67E5\u65B9\u5411\uFF1B\u53D1\u73B0\u8DD1\u504F\u4F1A\u5728\u4E0B\u4E00\u6B65\u6CE8\u5165\u7EA0\u504F\uFF0CSTOP \u65F6\u8981\u6C42\u6267\u884C\u6A21\u578B\u505C\u4E0B\u5411\u7528\u6237\u62A5\u544A\u3002\u6BCF\u6B21\u5DE1\u903B\u6574\u6BB5\u4F1A\u8BDD\u8BA1\u8D39\u4E00\u6B21\u5BA1\u67E5\u6A21\u578B\u3002",
  patrolToggle: "\u542F\u7528\u5DE1\u903B",
  patrolEverySteps: "\u5DE1\u903B\u95F4\u9694\uFF08\u6B65\u6570\uFF09",
  patrolEveryStepsHint: "\u6BCF N \u4E2A\u6A21\u578B\u8BF7\u6C42\u505A\u4E00\u6B21\u5DE1\u903B\u68C0\u67E5\uFF1B\u4E24\u6B21\u5DE1\u903B\u4E4B\u95F4\u53E6\u6709\u81F3\u5C11 90 \u79D2\u7684\u8282\u6D41\u3002",
  patrolImmuneTurns: "\u7EA0\u504F\u51B7\u5374\uFF08\u8BF7\u6C42\u6570\uFF09",
  investigateToggle: "\u5BA1\u67E5\u8005\u8C03\u67E5\u5DE5\u5177",
  investigateHint: "\u5141\u8BB8\u5BA1\u67E5\u6A21\u578B\u5728\u88C1\u51B3\u524D\u7528\u53EA\u8BFB\u5DE5\u5177\uFF08\u5DE5\u4F5C\u533A\u5185\u641C\u7D22/\u8BFB\u6587\u4EF6\uFF09\u4EB2\u81EA\u6838\u5B9E\u4E8B\u5B9E\uFF1B\u91CD\u590D\u5EFA\u8BAE\u4E0E\u7A7A\u8BDD\u5EFA\u8BAE\u4F1A\u88AB\u81EA\u52A8\u53BB\u91CD/\u4E22\u5F03\u3002",
  toolTitle: "\u54A8\u8BE2",
  toolRunning: "\u8FDB\u884C\u4E2D",
  toolDone: "\u5B8C\u6210",
  toolFailed: "\u5931\u8D25",
  toolConsulting: "\u6B63\u5728\u5411\u5BA1\u67E5\u6A21\u578B\u8F6C\u53D1\u6574\u6BB5\u4F1A\u8BDD\u2026",
  toolExpand: "\u5C55\u5F00\u5EFA\u8BAE\u5168\u6587",
  toolCollapse: "\u6536\u8D77",
  patrolCardTitle: "\u5DE1\u903B\u88C1\u51B3",
  patrolCheckTitle: "\u5DE1\u903B\u68C0\u67E5",
  patrolVerdictOnTrack: "\u6B63\u5E38",
  patrolVerdictCorrection: "\u7EA0\u504F",
  patrolVerdictStop: "\u53EB\u505C",
  patrolCardStepPrefix: "\u7B2C ",
  patrolCardStepSuffix: " \u6B65",
  patrolExpand: "\u5C55\u5F00\u88C1\u51B3\u5168\u6587",
  patrolCollapse: "\u6536\u8D77",
  patrolDowngradedTag: "\u51B7\u5374\u964D\u7EA7\xB7\u672A\u6CE8\u5165"
};
var en = {
  title: "Advisor reviewer model",
  description: "The executor model may call the zero-parameter advisor() tool when stuck, before major decisions, or before declaring done. The whole conversation is forwarded to this reviewer each call \u2014 escalation is not free.",
  armed: "Current reviewer",
  off: "None selected \u2014 the advisor tool is hidden from the model (zero prompt cost)",
  offCurrent: "None selected",
  choose: "Pick one of the models DSH already has configured:",
  loading: "Loading model catalog\u2026",
  loadFailed: "Failed to load the model catalog",
  retry: "Retry",
  partial: "Some providers failed to list models; the catalog may be incomplete.",
  empty: "No configurable models \u2014 configure a provider under Settings \u2192 Models first.",
  effort: "Reasoning effort",
  effortDefault: "(model default)",
  effortHint: "Leave empty for the model default; this model declares no effort support \u2014 an unsupported configured effort falls back to the model default automatically (see logs).",
  effortHintKnown: "Only levels this model declares as supported are listed; empty means the model default.",
  unavailable: "(configured route is not in the current catalog)",
  save: "Save",
  saving: "Saving\u2026",
  discard: "Discard changes",
  saved: "Saved",
  saveFailed: "Save failed, please retry",
  readonly: "The settings document is read-only here.",
  enabledToggle: "Enable advisor plugin",
  enabledHintOn: "Master switch is on: once a reviewer is configured, the advisor tool becomes visible to the executor.",
  enabledHintOff: "Master switch is off: the advisor tool and guideline prompt section are not registered; saved settings are kept.",
  modelSection: "Reviewer model & effort",
  modelSectionHint: "Pick the reviewer model and reasoning effort",
  sectionExpand: "Expand",
  sectionCollapse: "Collapse",
  patrolTitle: "Patrol mode (automatic drift detection)",
  patrolDescription: "Every few steps the conversation snapshot is sent to the reviewer to check direction; on drift a correction is injected into the next request, and STOP asks the executor to halt and report. Each patrol bills the full conversation to the reviewer once.",
  patrolToggle: "Enable patrol",
  patrolEverySteps: "Patrol interval (steps)",
  patrolEveryStepsHint: "One patrol check per N model requests; throttled to at most one patrol per 90 seconds.",
  patrolImmuneTurns: "Correction cooldown (requests)",
  investigateToggle: "Reviewer investigation tools",
  investigateHint: "Let the reviewer verify facts with read-only tools (workspace search / file read) before ruling; duplicate and content-free advice is auto-deduped/dropped.",
  toolTitle: "consultation",
  toolRunning: "running",
  toolDone: "done",
  toolFailed: "failed",
  toolConsulting: "forwarding the whole conversation to the reviewer\u2026",
  toolExpand: "show guidance",
  toolCollapse: "collapse",
  patrolCardTitle: "patrol verdict",
  patrolCheckTitle: "patrol check",
  patrolVerdictOnTrack: "on track",
  patrolVerdictCorrection: "correction",
  patrolVerdictStop: "stop",
  patrolCardStepPrefix: "step ",
  patrolCardStepSuffix: "",
  patrolExpand: "show verdict",
  patrolCollapse: "collapse",
  patrolDowngradedTag: "cooldown\xB7not injected"
};

// src/client/index.ts
var inject = ["slots", "locale", "connection"];
var NS = "dsh-advisor.card";
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-advisor: card dictionaries");
  const scope = createResolvingScope();
  const controller = new AdvisorCardController(scope, ctx);
  ctx.effect(() => () => {
    controller.dispose();
  }, "dsh-advisor: settings card");
  ctx.inject(["configForms"], (formsCtx) => {
    const source = resolveConfigForms(formsCtx);
    if (source !== void 0) scope.attach(source);
  });
  ctx.inject(["settingsScope"], (legacyCtx) => {
    const source = resolveLegacySettingsScope(legacyCtx);
    if (source !== void 0) scope.attach(source);
  });
  const t = () => ctx.locale.bind(NS);
  const contained = (slot, build, component) => {
    try {
      ctx.slots.inject(slot, () => ctx.slots.register(build(), component));
    } catch (error) {
      console.warn(`[dsh-advisor] \u69FD ${slot} \u6CE8\u518C\u5931\u8D25\uFF08\u4E0D\u5F71\u54CD\u5176\u4F59\u529F\u80FD\uFF09\uFF1A`, error);
    }
  };
  contained("settings.plugins.tab", () => ({
    name: "settings.plugins.tab",
    id: "advisor",
    order: 30,
    label: () => t()("title"),
    locale: NS,
    inject: () => ({ ...controller.inject(), t: t() })
  }), AdvisorCard);
  contained("settings.plugin.item", () => ({
    name: "settings.plugin.item",
    key: "advisor",
    id: "advisor",
    order: 30,
    locale: NS,
    inject: () => ({ ...controller.inject(), t: t() })
  }), AdvisorCard);
  contained("tool.call.toolview", () => ({
    name: "tool.call.toolview",
    key: "advisor",
    locale: NS,
    inject: () => ({ t: t() })
  }), AdvisorToolRow);
}

		return module.exports;
	}
});
