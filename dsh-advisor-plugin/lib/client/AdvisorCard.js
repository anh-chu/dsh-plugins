import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * AdvisorCard —— 设置页“插件”栏里的 Advisor 卡片（浏览器半）。
 *
 * 交互：总开关 + 可折叠的模型/档位区块与巡逻区块；数据与动作全部由
 * controller 通过 slot inject 面注入；本组件纯渲染，样式内联。
 */
import { useState } from 'react';
/** 通用开关 */
function ToggleSwitch(props) {
    return (_jsx("button", { type: "button", role: "switch", "aria-checked": props.checked, "aria-label": props.label, disabled: props.disabled, onClick: props.onToggle, style: {
            ...style.button,
            width: 40, height: 22, borderRadius: 11, padding: 0, position: 'relative',
            background: props.checked ? '#16a34a' : 'rgba(128,128,128,.4)', border: 'none',
        }, children: _jsx("span", { style: {
                position: 'absolute', top: 2, left: props.checked ? 20 : 2,
                width: 18, height: 18, borderRadius: 9, background: '#fff', transition: 'left .15s',
            } }) }));
}
/** 可折叠区块：点击标题行展开/收起 */
function Section(props) {
    const [open, setOpen] = useState(props.defaultOpen ?? false);
    return (_jsxs("div", { style: style.section, children: [_jsxs("button", { type: "button", style: style.sectionHead, "aria-expanded": open, onClick: () => setOpen(v => !v), children: [_jsx("span", { style: style.sectionTitle, children: props.title }), props.subtitle === undefined ? null : _jsx("span", { style: style.sectionSubtitle, children: props.subtitle }), _jsx("span", { style: style.sectionState, children: open ? props.t('sectionCollapse') : props.t('sectionExpand') })] }), open ? _jsx("div", { style: style.sectionBody, children: props.children }) : null] }));
}
/** 巡逻模式区块（自动检测跑偏） */
function PatrolSection(props) {
    const { t } = props;
    return (_jsxs("div", { style: { display: 'flex', flexDirection: 'column', gap: 10 }, children: [_jsx("p", { style: style.description, children: t('patrolDescription') }), _jsxs("div", { style: style.effortRow, children: [_jsx("span", { children: t('patrolToggle') }), _jsx(ToggleSwitch, { checked: props.enabled, disabled: props.disabled, label: t('patrolToggle'), onToggle: props.togglePatrol })] }), props.enabled
                ? (_jsxs("div", { children: [_jsxs("div", { style: style.effortRow, children: [_jsx("label", { htmlFor: "advisor-patrol-steps", children: t('patrolEverySteps') }), _jsx("input", { id: "advisor-patrol-steps", type: "number", min: 2, max: 500, value: props.everySteps, disabled: props.disabled, onChange: (event) => { props.setPatrolEverySteps(Number(event.target.value)); }, style: { width: 64 } })] }), _jsxs("div", { style: style.effortRow, children: [_jsx("label", { htmlFor: "advisor-patrol-immune", children: t('patrolImmuneTurns') }), _jsx("input", { id: "advisor-patrol-immune", type: "number", min: 0, max: 20, value: props.immuneTurns, disabled: props.disabled, onChange: (event) => { props.setPatrolImmuneTurns(Number(event.target.value)); }, style: { width: 64 } })] }), _jsxs("div", { style: { ...style.effortRow, marginTop: 8 }, children: [_jsx("span", { children: t('investigateToggle') }), _jsx(ToggleSwitch, { checked: props.investigate, disabled: props.disabled, label: t('investigateToggle'), onToggle: props.toggleInvestigate })] }), _jsx("p", { style: { ...style.notice, marginTop: -2 }, children: t('investigateHint') })] }))
                : null, _jsx("p", { style: { ...style.notice, marginTop: -2 }, children: t('patrolEveryStepsHint') })] }));
}
const EFFORT_OPTIONS = ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
// 内联样式（跟随设置页朴素风格，避免 css module 构建依赖）
const style = {
    card: { border: '1px solid rgba(128,128,128,.35)', borderRadius: 8, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 },
    title: { fontSize: 14, fontWeight: 600, margin: 0 },
    description: { fontSize: 12, opacity: 0.75, margin: 0, lineHeight: 1.6 },
    current: { fontSize: 12, margin: 0 },
    groupTitle: { fontSize: 12, fontWeight: 600, opacity: 0.85, margin: '8px 0 2px' },
    row: { display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', fontSize: 13 },
    modelName: { display: 'flex', flexDirection: 'column' },
    route: { fontSize: 11, opacity: 0.65 },
    badge: { fontSize: 11, color: '#b45309' },
    notice: { fontSize: 12, opacity: 0.7, margin: 0 },
    error: { fontSize: 12, color: '#b91c1c', display: 'flex', gap: 8, alignItems: 'center' },
    effortRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginTop: 6 },
    actions: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 },
    button: { fontSize: 13, padding: '4px 14px', borderRadius: 6, cursor: 'pointer' },
    primary: { background: '#2563eb', color: '#fff', border: 'none' },
    secondary: { background: 'transparent', border: '1px solid rgba(128,128,128,.5)' },
    status: { fontSize: 12 },
    list: { maxHeight: 260, overflowY: 'auto', border: '1px solid rgba(128,128,128,.25)', borderRadius: 6, padding: '4px 10px' },
    switchRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginTop: 2 },
    switchLabel: { fontWeight: 600 },
    section: { border: '1px solid rgba(128,128,128,.25)', borderRadius: 8, overflow: 'hidden' },
    sectionHead: { display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 10px', background: 'rgba(128,128,128,.06)', border: 'none', font: 'inherit', textAlign: 'left', cursor: 'pointer' },
    sectionTitle: { fontSize: 13, fontWeight: 600 },
    sectionSubtitle: { fontSize: 11, opacity: 0.65, flex: 1 },
    sectionState: { fontSize: 11, opacity: 0.65, marginLeft: 'auto' },
    sectionBody: { padding: 10, display: 'flex', flexDirection: 'column', gap: 8 },
};
export function AdvisorCard(props) {
    const state = props.useAdvisorCard(s => s);
    const enabled = state.enabled;
    // 档位选项：目录声明了支持面 → 只列支持的；未声明 → 全档位（host 自动降级兜底）
    const effortOptions = state.efforts.known
        ? ['', ...state.efforts.levels]
        : EFFORT_OPTIONS;
    const disabled = !state.writable || state.saving;
    const armed = enabled && state.effective.provider !== '' && state.effective.model !== '';
    return (_jsxs("div", { style: style.card, children: [_jsx("h3", { style: style.title, children: props.t('title') }), _jsx("p", { style: style.description, children: props.t('description') }), _jsxs("div", { style: style.switchRow, children: [_jsx("span", { style: style.switchLabel, children: props.t('enabledToggle') }), _jsx(ToggleSwitch, { checked: enabled, disabled: disabled, label: props.t('enabledToggle'), onToggle: props.toggleEnabled })] }), _jsx("p", { style: style.notice, children: enabled ? props.t('enabledHintOn') : props.t('enabledHintOff') }), _jsxs("p", { style: style.current, children: [props.t('armed'), "\uFF1A", armed
                        ? _jsx("strong", { children: `${state.effective.provider}/${state.effective.model}${state.effective.effort === '' ? '' : ` (${state.effective.effort})`}` })
                        : props.t('offCurrent')] }), !state.writable ? _jsx("p", { style: style.notice, children: props.t('readonly') }) : null, _jsxs(Section, { t: props.t, title: props.t('modelSection'), subtitle: props.t('modelSectionHint'), defaultOpen: true, children: [state.catalogStatus === 'loading' ? _jsx("p", { style: style.notice, children: props.t('loading') }) : null, state.catalogStatus === 'error'
                        ? (_jsxs("div", { style: style.error, children: [_jsx("span", { children: props.t('loadFailed') }), _jsx("button", { type: "button", style: { ...style.button, ...style.secondary }, disabled: disabled, onClick: props.retryCatalog, children: props.t('retry') })] }))
                        : null, state.catalogPartial ? _jsx("p", { style: style.notice, children: props.t('partial') }) : null, state.groups.length > 0
                        ? (_jsxs("div", { children: [_jsx("p", { style: style.notice, children: props.t('choose') }), _jsx("div", { style: style.list, children: state.groups.map(group => (_jsxs("div", { children: [_jsx("div", { style: style.groupTitle, children: group.name }), group.candidates.map(candidate => (_jsxs("label", { style: style.row, children: [_jsx("input", { type: "radio", name: "advisor-route", checked: candidate.selected, disabled: disabled, onChange: () => { props.pickRoute(candidate.key); } }), _jsxs("span", { style: style.modelName, children: [_jsx("span", { children: candidate.modelName }), _jsx("span", { style: style.route, children: `${candidate.provider}/${candidate.model}` })] }), !candidate.available ? _jsx("span", { style: style.badge, children: props.t('unavailable') }) : null] }, candidate.key)))] }, group.id))) })] }))
                        : state.catalogStatus === 'ready' ? _jsx("p", { style: style.notice, children: props.t('empty') }) : null, _jsxs("div", { style: style.effortRow, children: [_jsx("label", { htmlFor: "advisor-effort", children: props.t('effort') }), _jsx("select", { id: "advisor-effort", value: state.effective.effort, disabled: disabled, onChange: (event) => { props.setEffort(event.target.value); }, children: effortOptions.map(option => (_jsx("option", { value: option, children: option === '' ? props.t('effortDefault') : option }, option))) })] }), _jsx("p", { style: { ...style.notice, marginTop: -4 }, children: state.efforts.known ? props.t('effortHintKnown') : props.t('effortHint') })] }), _jsx(Section, { t: props.t, title: props.t('patrolTitle'), defaultOpen: false, children: _jsx(PatrolSection, { ...props, enabled: state.patrol.enabled, everySteps: state.patrol.everySteps, immuneTurns: state.patrol.immuneTurns, investigate: state.patrol.investigate, disabled: disabled }) }), _jsxs("div", { style: style.actions, children: [_jsx("button", { type: "button", style: { ...style.button, ...style.primary }, disabled: disabled || !state.dirty, onClick: props.save, children: props.t('save') }), _jsx("button", { type: "button", style: { ...style.button, ...style.secondary }, disabled: disabled || !state.dirty, onClick: props.discard, children: props.t('discard') }), state.saving ? _jsx("span", { style: style.status, children: props.t('saving') }) : null, state.failed ? _jsx("span", { style: { ...style.status, color: '#b91c1c' }, children: props.t('saveFailed') }) : null] })] }));
}
