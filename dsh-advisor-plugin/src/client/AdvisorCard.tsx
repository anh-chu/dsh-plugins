/**
 * AdvisorCard —— 设置页“插件”栏里的 Advisor 卡片（浏览器半）。
 *
 * 交互：总开关 + 可折叠的模型/档位区块与巡逻区块；数据与动作全部由
 * controller 通过 slot inject 面注入；本组件纯渲染，样式内联。
 */

import { useState, type ReactNode } from 'react'
import type { AdvisorCardFace, AdvisorCardState } from './controller.js'
import type { LocaleKey } from './locales.js'

/** 组件收到的 props：face 里的 hooks 被渲染器绑定成 use 选择器 hook */
export type AdvisorCardProps = Omit<AdvisorCardFace, 'hooks'> & {
  useAdvisorCard: <S>(selector: (s: AdvisorCardState) => S) => S
  t: (key: LocaleKey) => string
}

/** 通用开关 */
function ToggleSwitch(props: {
  checked: boolean
  disabled?: boolean
  label: string
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={props.onToggle}
      style={{
        ...style.button,
        width: 40, height: 22, borderRadius: 11, padding: 0, position: 'relative',
        background: props.checked ? '#16a34a' : 'rgba(128,128,128,.4)', border: 'none',
      }}
    >
      <span style={{
        position: 'absolute', top: 2, left: props.checked ? 20 : 2,
        width: 18, height: 18, borderRadius: 9, background: '#fff', transition: 'left .15s',
      }} />
    </button>
  )
}

/** 可折叠区块：点击标题行展开/收起 */
function Section(props: {
  t: (key: LocaleKey) => string
  title: string
  subtitle?: string
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(props.defaultOpen ?? false)
  return (
    <div style={style.section}>
      <button
        type="button"
        style={style.sectionHead}
        aria-expanded={open}
        onClick={() => setOpen(v => !v)}
      >
        <span style={style.sectionTitle}>{props.title}</span>
        {props.subtitle === undefined ? null : <span style={style.sectionSubtitle}>{props.subtitle}</span>}
        <span style={style.sectionState}>{open ? props.t('sectionCollapse') : props.t('sectionExpand')}</span>
      </button>
      {open ? <div style={style.sectionBody}>{props.children}</div> : null}
    </div>
  )
}

/** 巡逻模式区块（自动检测跑偏） */
function PatrolSection(props: AdvisorCardProps & {
  enabled: boolean
  everySteps: number
  immuneTurns: number
  investigate: boolean
  disabled: boolean
}) {
  const { t } = props
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <p style={style.description}>{t('patrolDescription')}</p>
      <div style={style.effortRow}>
        <span>{t('patrolToggle')}</span>
        <ToggleSwitch
          checked={props.enabled}
          disabled={props.disabled}
          label={t('patrolToggle')}
          onToggle={props.togglePatrol}
        />
      </div>
      {props.enabled
        ? (
          <div>
            <div style={style.effortRow}>
              <label htmlFor="advisor-patrol-steps">{t('patrolEverySteps')}</label>
              <input
                id="advisor-patrol-steps"
                type="number"
                min={2}
                max={500}
                value={props.everySteps}
                disabled={props.disabled}
                onChange={(event) => { props.setPatrolEverySteps(Number(event.target.value)) }}
                style={{ width: 64 }}
              />
            </div>
            <div style={style.effortRow}>
              <label htmlFor="advisor-patrol-immune">{t('patrolImmuneTurns')}</label>
              <input
                id="advisor-patrol-immune"
                type="number"
                min={0}
                max={20}
                value={props.immuneTurns}
                disabled={props.disabled}
                onChange={(event) => { props.setPatrolImmuneTurns(Number(event.target.value)) }}
                style={{ width: 64 }}
              />
            </div>
            <div style={{ ...style.effortRow, marginTop: 8 }}>
              <span>{t('investigateToggle')}</span>
              <ToggleSwitch
                checked={props.investigate}
                disabled={props.disabled}
                label={t('investigateToggle')}
                onToggle={props.toggleInvestigate}
              />
            </div>
            <p style={{ ...style.notice, marginTop: -2 }}>{t('investigateHint')}</p>
          </div>
        )
        : null}
      <p style={{ ...style.notice, marginTop: -2 }}>{t('patrolEveryStepsHint')}</p>
    </div>
  )
}

const EFFORT_OPTIONS = ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

// 内联样式（跟随设置页朴素风格，避免 css module 构建依赖）
const style = {
  card: { border: '1px solid rgba(128,128,128,.35)', borderRadius: 8, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 } as const,
  title: { fontSize: 14, fontWeight: 600, margin: 0 } as const,
  description: { fontSize: 12, opacity: 0.75, margin: 0, lineHeight: 1.6 } as const,
  current: { fontSize: 12, margin: 0 } as const,
  groupTitle: { fontSize: 12, fontWeight: 600, opacity: 0.85, margin: '8px 0 2px' } as const,
  row: { display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', fontSize: 13 } as const,
  modelName: { display: 'flex', flexDirection: 'column' } as const,
  route: { fontSize: 11, opacity: 0.65 } as const,
  badge: { fontSize: 11, color: '#b45309' } as const,
  notice: { fontSize: 12, opacity: 0.7, margin: 0 } as const,
  error: { fontSize: 12, color: '#b91c1c', display: 'flex', gap: 8, alignItems: 'center' } as const,
  effortRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginTop: 6 } as const,
  actions: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 } as const,
  button: { fontSize: 13, padding: '4px 14px', borderRadius: 6, cursor: 'pointer' } as const,
  primary: { background: '#2563eb', color: '#fff', border: 'none' } as const,
  secondary: { background: 'transparent', border: '1px solid rgba(128,128,128,.5)' } as const,
  status: { fontSize: 12 } as const,
  list: { maxHeight: 260, overflowY: 'auto', border: '1px solid rgba(128,128,128,.25)', borderRadius: 6, padding: '4px 10px' } as const,
  switchRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginTop: 2 } as const,
  switchLabel: { fontWeight: 600 } as const,
  section: { border: '1px solid rgba(128,128,128,.25)', borderRadius: 8, overflow: 'hidden' } as const,
  sectionHead: { display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 10px', background: 'rgba(128,128,128,.06)', border: 'none', font: 'inherit', textAlign: 'left', cursor: 'pointer' } as const,
  sectionTitle: { fontSize: 13, fontWeight: 600 } as const,
  sectionSubtitle: { fontSize: 11, opacity: 0.65, flex: 1 } as const,
  sectionState: { fontSize: 11, opacity: 0.65, marginLeft: 'auto' } as const,
  sectionBody: { padding: 10, display: 'flex', flexDirection: 'column', gap: 8 } as const,
}

export function AdvisorCard(props: AdvisorCardProps) {
  const state = props.useAdvisorCard(s => s)
  const enabled = state.enabled
  // 档位选项：目录声明了支持面 → 只列支持的；未声明 → 全档位（host 自动降级兜底）
  const effortOptions: readonly string[] = state.efforts.known
    ? ['', ...state.efforts.levels]
    : EFFORT_OPTIONS
  const disabled = !state.writable || state.saving
  const armed = enabled && state.effective.provider !== '' && state.effective.model !== ''

  return (
    <div style={style.card}>
      <h3 style={style.title}>{props.t('title')}</h3>
      <p style={style.description}>{props.t('description')}</p>

      <div style={style.switchRow}>
        <span style={style.switchLabel}>{props.t('enabledToggle')}</span>
        <ToggleSwitch
          checked={enabled}
          disabled={disabled}
          label={props.t('enabledToggle')}
          onToggle={props.toggleEnabled}
        />
      </div>
      <p style={style.notice}>{enabled ? props.t('enabledHintOn') : props.t('enabledHintOff')}</p>

      <p style={style.current}>
        {props.t('armed')}：
        {armed
          ? <strong>{`${state.effective.provider}/${state.effective.model}${state.effective.effort === '' ? '' : ` (${state.effective.effort})`}`}</strong>
          : props.t('offCurrent')}
      </p>

      {!state.writable ? <p style={style.notice}>{props.t('readonly')}</p> : null}

      <Section
        t={props.t}
        title={props.t('modelSection')}
        subtitle={props.t('modelSectionHint')}
        defaultOpen
      >
        {state.catalogStatus === 'loading' ? <p style={style.notice}>{props.t('loading')}</p> : null}
        {state.catalogStatus === 'error'
          ? (
            <div style={style.error}>
              <span>{props.t('loadFailed')}</span>
              <button type="button" style={{ ...style.button, ...style.secondary }} disabled={disabled} onClick={props.retryCatalog}>
                {props.t('retry')}
              </button>
            </div>
          )
          : null}
        {state.catalogPartial ? <p style={style.notice}>{props.t('partial')}</p> : null}

        {state.groups.length > 0
          ? (
            <div>
              <p style={style.notice}>{props.t('choose')}</p>
              <div style={style.list}>
                {state.groups.map(group => (
                  <div key={group.id}>
                    <div style={style.groupTitle}>{group.name}</div>
                    {group.candidates.map(candidate => (
                      <label key={candidate.key} style={style.row}>
                        <input
                          type="radio"
                          name="advisor-route"
                          checked={candidate.selected}
                          disabled={disabled}
                          onChange={() => { props.pickRoute(candidate.key) }}
                        />
                        <span style={style.modelName}>
                          <span>{candidate.modelName}</span>
                          <span style={style.route}>{`${candidate.provider}/${candidate.model}`}</span>
                        </span>
                        {!candidate.available ? <span style={style.badge}>{props.t('unavailable')}</span> : null}
                      </label>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )
          : state.catalogStatus === 'ready' ? <p style={style.notice}>{props.t('empty')}</p> : null}

        <div style={style.effortRow}>
          <label htmlFor="advisor-effort">{props.t('effort')}</label>
          <select
            id="advisor-effort"
            value={state.effective.effort}
            disabled={disabled}
            onChange={(event) => { props.setEffort(event.target.value) }}
          >
            {/* 已声明支持面的模型只列支持的档位；未声明的列全档位（host 侧自动降级兜底） */}
            {effortOptions.map(option => (
              <option key={option} value={option}>
                {option === '' ? props.t('effortDefault') : option}
              </option>
            ))}
          </select>
        </div>
        <p style={{ ...style.notice, marginTop: -4 }}>
          {state.efforts.known ? props.t('effortHintKnown') : props.t('effortHint')}
        </p>
      </Section>

      <Section t={props.t} title={props.t('patrolTitle')} defaultOpen={false}>
        <PatrolSection
          {...props}
          enabled={state.patrol.enabled}
          everySteps={state.patrol.everySteps}
          immuneTurns={state.patrol.immuneTurns}
          investigate={state.patrol.investigate}
          disabled={disabled}
        />
      </Section>

      <div style={style.actions}>
        <button
          type="button"
          style={{ ...style.button, ...style.primary }}
          disabled={disabled || !state.dirty}
          onClick={props.save}
        >
          {props.t('save')}
        </button>
        <button
          type="button"
          style={{ ...style.button, ...style.secondary }}
          disabled={disabled || !state.dirty}
          onClick={props.discard}
        >
          {props.t('discard')}
        </button>
        {state.saving ? <span style={style.status}>{props.t('saving')}</span> : null}
        {state.failed ? <span style={{ ...style.status, color: '#b91c1c' }}>{props.t('saveFailed')}</span> : null}
      </div>
    </div>
  )
}
