/**
 * AdvisorToolRow —— `advisor` 工具在会话消息流里的专属行（keyed
 * `tool.call.toolview` 槽，官方给插件自有工具预留的定制点）。
 *
 * 折叠态：🧭 标题 + 进行中/完成/失败状态 + 审查模型路由；
 * 展开态：审查建议全文（或错误说明）——用户点开即见"真的调了
 * advisor、建议是什么"。
 */

import { useState } from 'react'
import type { LocaleKey } from './locales.js'

/** 会话工具块的最小结构（RunningToolCall / settled result 的并集子集） */
interface AdvisorBlock {
  kind?: unknown
  callId?: unknown
  call?: { argsRaw?: unknown } | undefined
  argsRaw?: unknown
  content?: readonly { type?: unknown, text?: unknown }[] | undefined
  isError?: boolean | undefined
  error?: { name?: unknown, code?: unknown, message?: unknown } | undefined
}

export type AdvisorToolRowProps = {
  callId?: string
  toolName?: string
  block?: AdvisorBlock
  cwd?: string
  home?: string
  openFile?: (path: string) => void
  inspect?: () => void
  t?: (key: LocaleKey) => string
}

const style = {
  row: { display: 'flex', flexDirection: 'column', gap: 4, margin: '6px 0', border: '1px solid rgba(37,99,235,.35)', borderRadius: 8, overflow: 'hidden' } as const,
  head: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', cursor: 'pointer', background: 'rgba(37,99,235,.08)', border: 'none', font: 'inherit', textAlign: 'left', width: '100%' } as const,
  title: { fontWeight: 600, fontSize: 13, color: '#1d4ed8' } as const,
  state: { fontSize: 12, opacity: 0.75 } as const,
  badge: { fontSize: 11, padding: '1px 8px', borderRadius: 8, flex: 'none' } as const,
  badgeRun: { background: 'rgba(37,99,235,.15)', color: '#1d4ed8' } as const,
  badgeOk: { background: 'rgba(22,163,74,.15)', color: '#15803d' } as const,
  badgeErr: { background: 'rgba(185,28,28,.12)', color: '#b91c1c' } as const,
  body: { padding: '8px 12px', fontSize: 13, lineHeight: 1.65, whiteSpace: 'pre-wrap', borderTop: '1px solid rgba(37,99,235,.2)', maxHeight: 320, overflowY: 'auto' } as const,
}

function blockOutput(block: AdvisorBlock | undefined): { text: string, isError: boolean } {
  if (block === undefined) return { text: '', isError: false }
  const parts: string[] = []
  for (const b of block.content ?? []) {
    if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    else if (b !== undefined && b !== null) parts.push(JSON.stringify(b, null, 2))
  }
  if (parts.length === 0 && block.error !== undefined) {
    const e = block.error
    parts.push(`${typeof e.name === 'string' ? e.name : 'Error'}: ${typeof e.code === 'string' ? e.code : ''} ${typeof e.message === 'string' ? e.message : ''}`.trim())
  }
  return { text: parts.join('\n').trim(), isError: block.isError === true }
}

export function AdvisorToolRow(props: AdvisorToolRowProps) {
  const t = props.t ?? ((key: LocaleKey) => key)
  const [expanded, setExpanded] = useState(false)
  const block = props.block ?? {}
  const done = block.kind !== undefined
  const { text, isError } = done ? blockOutput(block) : { text: '', isError: false }
  const badge = !done
    ? { label: t('toolRunning'), css: style.badgeRun }
    : isError
      ? { label: t('toolFailed'), css: style.badgeErr }
      : { label: t('toolDone'), css: style.badgeOk }
  const canExpand = done && text !== ''
  return (
    <div style={style.row}>
      <button type="button" style={style.head} onClick={() => { if (canExpand) setExpanded(v => !v) }}>
        <span style={style.title}>🧭 Advisor {t('toolTitle')}</span>
        <span style={{ ...style.badge, ...badge.css }}>{badge.label}</span>
        <span style={style.state}>{!done ? t('toolConsulting') : canExpand ? (expanded ? t('toolCollapse') : t('toolExpand')) : ''}</span>
      </button>
      {expanded && canExpand ? <div style={style.body}>{text}</div> : null}
    </div>
  )
}
