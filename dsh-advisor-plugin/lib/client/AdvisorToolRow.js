import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
/**
 * AdvisorToolRow —— `advisor` 工具在会话消息流里的专属行（keyed
 * `tool.call.toolview` 槽，官方给插件自有工具预留的定制点）。
 *
 * 折叠态：🧭 标题 + 进行中/完成/失败状态 + 审查模型路由；
 * 展开态：审查建议全文（或错误说明）——用户点开即见"真的调了
 * advisor、建议是什么"。
 */
import { useState } from 'react';
const style = {
    row: { display: 'flex', flexDirection: 'column', gap: 4, margin: '6px 0', border: '1px solid rgba(37,99,235,.35)', borderRadius: 8, overflow: 'hidden' },
    head: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', cursor: 'pointer', background: 'rgba(37,99,235,.08)', border: 'none', font: 'inherit', textAlign: 'left', width: '100%' },
    title: { fontWeight: 600, fontSize: 13, color: '#1d4ed8' },
    state: { fontSize: 12, opacity: 0.75 },
    badge: { fontSize: 11, padding: '1px 8px', borderRadius: 8, flex: 'none' },
    badgeRun: { background: 'rgba(37,99,235,.15)', color: '#1d4ed8' },
    badgeOk: { background: 'rgba(22,163,74,.15)', color: '#15803d' },
    badgeErr: { background: 'rgba(185,28,28,.12)', color: '#b91c1c' },
    body: { padding: '8px 12px', fontSize: 13, lineHeight: 1.65, whiteSpace: 'pre-wrap', borderTop: '1px solid rgba(37,99,235,.2)', maxHeight: 320, overflowY: 'auto' },
};
function blockOutput(block) {
    if (block === undefined)
        return { text: '', isError: false };
    const parts = [];
    for (const b of block.content ?? []) {
        if (b?.type === 'text' && typeof b.text === 'string')
            parts.push(b.text);
        else if (b !== undefined && b !== null)
            parts.push(JSON.stringify(b, null, 2));
    }
    if (parts.length === 0 && block.error !== undefined) {
        const e = block.error;
        parts.push(`${typeof e.name === 'string' ? e.name : 'Error'}: ${typeof e.code === 'string' ? e.code : ''} ${typeof e.message === 'string' ? e.message : ''}`.trim());
    }
    return { text: parts.join('\n').trim(), isError: block.isError === true };
}
export function AdvisorToolRow(props) {
    const t = props.t ?? ((key) => key);
    const [expanded, setExpanded] = useState(false);
    const block = props.block ?? {};
    const done = block.kind !== undefined;
    const { text, isError } = done ? blockOutput(block) : { text: '', isError: false };
    const badge = !done
        ? { label: t('toolRunning'), css: style.badgeRun }
        : isError
            ? { label: t('toolFailed'), css: style.badgeErr }
            : { label: t('toolDone'), css: style.badgeOk };
    const canExpand = done && text !== '';
    return (_jsxs("div", { style: style.row, children: [_jsxs("button", { type: "button", style: style.head, onClick: () => { if (canExpand)
                    setExpanded(v => !v); }, children: [_jsxs("span", { style: style.title, children: ["\uD83E\uDDED Advisor ", t('toolTitle')] }), _jsx("span", { style: { ...style.badge, ...badge.css }, children: badge.label }), _jsx("span", { style: style.state, children: !done ? t('toolConsulting') : canExpand ? (expanded ? t('toolCollapse') : t('toolExpand')) : '' })] }), expanded && canExpand ? _jsx("div", { style: style.body, children: text }) : null] }));
}
