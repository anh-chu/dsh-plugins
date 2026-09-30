/**
 * patrol —— 巡逻模式：把 advisor 从"被动求助"升级为"主动监控"。
 *
 * 工作方式：
 *   1. agent/request 每步触发（复用现有 waterfall），按间隔步数 + 最小时间
 *      间隔决定是否发起一次巡逻（不阻塞当前请求，异步执行）；
 *   2. 巡逻 = 把会话快照 + 巡逻问题发给审查模型，要求回
 *      ON-TRACK / CORRECTION: ... / STOP: ... 三选一裁决；
 *   3. 裁决为纠偏/停止时，把干预文本经 `agent.inject()` 以 user 上下文排进
 *      下一步请求——落在对话尾部（新近性最高，实测系统提示段在几百条工具
 *      结果的会话里权重不足，执行模型"读到但不动"）；
 *   4. 侧调用（巡逻自身 + 显式 advisor() 工具）通过 llm-call 的
 *      深度计数排除，避免把自己的请求当成执行请求。
 *
 * 裁决的人类可观测性只走控制台日志（每轮一行，含裁决与耗时）。0.1.x 曾把
 * 裁决写进会话日志以在消息流出 🧭 卡片；0.2 起不再可行，见 COMPAT-0.2.0.md
 * （借用的 hook/invoked 已被 hooks 子系统接管并带强制载荷校验，而插件自有
 * 的外部事件类型不被持久化读取路径接受）。
 *
 * 成本提示：每次巡逻 = 整段会话计费一次审查模型（与显式 advisor()
 * 相同）。patrolEnabled / patrolEverySteps 可在设置页调整或关闭。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Message } from '@deepseek-ai/dsh-llm'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { PATROL_NUDGE, PATROL_SYSTEM_PROMPT, buildInterventionText } from './advisor-prompt.js'
import type { Config, Selection } from './config.js'
import { isExecutorBlocked } from './config.js'
import { callReviewer, stripExecutorEcho } from './llm-call.js'
import { createAdviceDeduper, isContentFreeAdvice, normalizeAdvice } from './emission-guard.js'

/** 两次巡逻之间的最小墙钟间隔（防止快速工具链把审查模型打爆） */
export const MIN_PATROL_INTERVAL_MS = 90_000

/**
 * 注入上下文的来源身份。
 *
 * 0.2 的 `MessageSourceMap` 是 merge-extensible 的，并移除了 0.1.x 的
 * catch-all `plugin` kind——每个生产者声明自己的 kind（同 dsh-skill 的
 * 'skill-invocation'、dsh-session-reference 的 'session-reference'）。
 * `form: 'notice'` 取自 0.2 的语义词表：一次性事件通报、不覆盖任何先前快照，
 * 正是巡逻裁决的定位。0.1.x 上这段声明无副作用（旧宿主不读取 kind 词表，
 * 只把它当不透明来源）。
 */
interface AdvisorPatrolSource {
  readonly kind: 'advisor-patrol'
  readonly form: 'notice'
  readonly summary: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'advisor-patrol': AdvisorPatrolSource
  }
}

/** 巡逻裁决（解析失败归为 unclear——不确定时宁可不打扰执行模型） */
export type PatrolVerdictKind = 'on-track' | 'correction' | 'stop' | 'unclear'

export interface PatrolVerdict {
  kind: PatrolVerdictKind
  detail: string
}

/** 是否该发起一次巡逻（纯函数，可单测） */
export function shouldPatrol(input: {
  armed: boolean
  blocked: boolean
  step: number
  everySteps: number
  now: number
  lastPatrolMs: number
  minIntervalMs: number
  inFlight: boolean
  patrolEnabled: boolean
}): boolean {
  if (!input.patrolEnabled || !input.armed || input.blocked || input.inFlight) return false
  if (input.everySteps < 1) return false
  if (input.step % input.everySteps !== 0) return false
  return input.now - input.lastPatrolMs >= input.minIntervalMs
}

/** 解析审查模型的巡逻裁决（纯函数）：只认首行前缀，其余整段作为细节 */
export function parsePatrolVerdict(text: string): PatrolVerdict {
  const trimmed = text.trim()
  if (trimmed === '') return { kind: 'unclear', detail: '' }
  const firstLineEnd = trimmed.indexOf('\n')
  const firstLine = (firstLineEnd === -1 ? trimmed : trimmed.slice(0, firstLineEnd)).trim()
  const rest = firstLineEnd === -1 ? '' : trimmed.slice(firstLineEnd + 1).trim()
  const upper = firstLine.toUpperCase()
  if (upper.startsWith('ON-TRACK')) return { kind: 'on-track', detail: rest }
  if (upper.startsWith('CORRECTION:') || upper.startsWith('CORRECTION')) {
    const inline = firstLine.slice(firstLine.indexOf(':') + 1).trim()
    return { kind: 'correction', detail: [inline, rest].filter(s => s !== '').join('\n') }
  }
  if (upper.startsWith('STOP:') || upper.startsWith('STOP')) {
    const inline = firstLine.slice(firstLine.indexOf(':') + 1).trim()
    return { kind: 'stop', detail: [inline, rest].filter(s => s !== '').join('\n') }
  }
  return { kind: 'unclear', detail: trimmed }
}

function createUserText(text: string): Message {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

export interface PatrolDeps {
  getConfig: () => Config
  getSelection: () => Selection | undefined
  buildMessages: (agent: Agent) => Message[]
}

export function registerPatrol(ctx: Context, deps: PatrolDeps): () => void {
  const stepCounts = new Map<Agent, number>()
  /** 每 agent 的建议去重器（防噪闸之一：会话内精确去重） */
  const dedupers = new Map<Agent, (normalized: string) => boolean>()
  /** 每 agent 的纠偏冷却终点（步数）：一次注入后 N 个请求内 concern 降级 */
  const immuneUntilStep = new Map<Agent, number>()
  let lastPatrolMs = 0
  let inFlight = false

  const runPatrol = async (agent: Agent) => {
    const selection = deps.getSelection()
    if (selection === undefined) return
    inFlight = true
    const startedAt = Date.now()
    try {
      // 快照末尾挂巡逻问题（与显式咨询共用消息组装，含工具清单前缀与尾部规则）
      const messages = [...deps.buildMessages(agent), createUserText(PATROL_NUDGE)]
      // 调查授权：审查模型可先在工作区内只读核实再裁决（cwd 缺省时不启用）
      const investigate = deps.getConfig().investigate !== false ? agent.session.header.cwd : undefined
      const outcome = await callReviewer(ctx, selection, PATROL_SYSTEM_PROMPT, messages, undefined, investigate, agent.session.id)
      if (!outcome.ok) {
        console.log(`[dsh-advisor][patrol] 巡逻调用失败（已跳过本轮）：${outcome.errorMessage}`)
        return
      }
      const verdict = parsePatrolVerdict(stripExecutorEcho(outcome.text, messages))
      const elapsed = Math.round(Date.now() - startedAt)
      if (verdict.kind === 'on-track') {
        console.log(`[dsh-advisor][patrol] ON-TRACK（${elapsed}ms）——执行方向正常`)
        return
      }
      if (verdict.kind === 'unclear') {
        // 解析失败不打扰执行模型（不是"检查通过"也不是"需要干预"，只留日志）
        console.log(`[dsh-advisor][patrol] 裁决不可解析（${elapsed}ms），不打扰执行模型。原文前 200 字：${outcome.text.slice(0, 200)}`)
        return
      }
      console.log(`[dsh-advisor][patrol] ${verdict.kind === 'stop' ? 'STOP' : 'CORRECTION'}（${elapsed}ms）：${verdict.detail.slice(0, 200)}`)
      // 防噪闸 ①：内容空短语——只给结论不给理由的建议没有信息量，按不打扰处理
      const normalized = normalizeAdvice(verdict.detail)
      if (isContentFreeAdvice(normalized)) {
        console.log(`[dsh-advisor][patrol] 裁决内容空（归一化后无实质信息），不打扰执行模型：${normalized.slice(0, 60)}`)
        return
      }
      const deduper = dedupers.get(agent) ?? createAdviceDeduper()
      dedupers.set(agent, deduper)
      // 冷却降级：一次注入后 N 个请求内，correction 只记日志不注入（stop 豁免）
      const step = stepCounts.get(agent) ?? 0
      const downgraded = verdict.kind === 'correction' && step < (immuneUntilStep.get(agent) ?? -1)
      // 防噪闸 ②：会话内精确去重——与已注入过的建议重复则丢弃（只记日志）
      if (!downgraded && !deduper(normalized)) {
        console.log('[dsh-advisor][patrol] 与此前已注入的纠偏重复，丢弃本次注入')
        return
      }
      if (downgraded) {
        console.log(`[dsh-advisor][patrol] 纠偏冷却期内（第 ${step} 步 < ${immuneUntilStep.get(agent)}），本次只记日志不注入`)
        return
      }
      // 模型面投递：agent.inject() 把干预排成下一步请求的尾部 user 上下文。
      // 实测教训：系统提示动态段在几百条工具结果的会话里新近性不足，执行
      // 模型"读到但不动"；尾部上下文是文件变更通知/skill 内容同款官方通道，
      // 位置就是模型注意力最集中的对话末尾，且 UI 会渲染成上下文行。
      try {
        const immuneTurns = deps.getConfig().patrolImmuneTurns ?? 3
        if (verdict.kind === 'correction' && immuneTurns > 0) {
          immuneUntilStep.set(agent, step + immuneTurns)
        }
        agent.inject(createUserMessage({
          content: [{ type: 'text', text: buildInterventionText(verdict.kind, verdict.detail) }],
          source: {
            kind: 'advisor-patrol',
            form: 'notice',
            summary: boundContextSummary(`${verdict.kind === 'stop' ? '巡逻叫停' : '巡逻纠偏'}：${verdict.detail}`),
          },
        }))
        console.log(`[dsh-advisor][patrol] 已将${verdict.kind === 'stop' ? '停止' : '纠偏'}干预排入下一步请求（尾部上下文）`)
      } catch (error) {
        // 注入失败不影响巡逻本身
        console.warn('[dsh-advisor][patrol] 干预注入失败：', error)
      }
    } finally {
      inFlight = false
    }
  }

  const disposeRequest = ctx.on('agent/request', async (payload, next) => {
    const config = await next()
    try {
      const agent = payload.agent
      const step = (stepCounts.get(agent) ?? 0) + 1
      stepCounts.set(agent, step)
      const pluginConfig = deps.getConfig()
      const blocked = isExecutorBlocked(pluginConfig, config.provider, config.model, config.reasoningEffort)
      if (!shouldPatrol({
        armed: deps.getSelection() !== undefined,
        blocked,
        step,
        everySteps: pluginConfig.patrolEverySteps ?? 6,
        now: Date.now(),
        lastPatrolMs,
        minIntervalMs: MIN_PATROL_INTERVAL_MS,
        inFlight,
        patrolEnabled: pluginConfig.patrolEnabled !== false,
      })) return config
      lastPatrolMs = Date.now()
      void runPatrol(agent)
    } catch (error) {
      // 巡逻绝不破坏用户的 turn
      console.error('[dsh-advisor][patrol] 调度失败：', error)
    }
    return config
  })

  return () => {
    disposeRequest()
    stepCounts.clear()
    dedupers.clear()
    immuneUntilStep.clear()
  }
}
