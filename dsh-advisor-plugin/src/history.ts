/**
 * history —— 组装发给审查模型的消息列表。
 *
 * 结构（对齐 rpiv-advisor）：
 *   [工具清单合成消息] + [session.deriveMessages() 的模型可见面]
 *
 * deriveMessages() 是 compaction 感知的——按执行模型实际看到的样貌转发，
 * 而不是重放压缩前的原始历史；工具清单按名排序、键排序稳定序列化，
 * 让多次 advisor 调用字节级一致。
 * 转发前剔除未配对的 tool call/result，并清理 tool-call id，作为
 * Anthropic 兼容审查路由适配器修复之外的纵深防御。
 * 保留 user 结尾规则（部分 provider 拒绝 assistant 结尾）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import { createUserMessage, ToolCallId, type ContentBlock, type Message, type UserMessage } from '@deepseek-ai/dsh-llm'
import { MSG_USER_TAIL_NUDGE } from './advisor-prompt.js'

// 递归键排序序列化：键序与 V8 插入序无关，同一清单字节级一致
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map(v => (v === undefined ? 'null' : stableStringify(v))).join(',')}]`
  }
  const obj = value as Record<string, unknown>
  const entries: string[] = []
  for (const k of Object.keys(obj).sort()) {
    const v = obj[k]
    if (v === undefined) continue
    entries.push(`${JSON.stringify(k)}:${stableStringify(v)}`)
  }
  return `{${entries.join(',')}}`
}

interface InventoryCache {
  signature?: string
  message?: UserMessage
}

function createUserText(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function getInventoryMessage(ctx: Context, cache: InventoryCache, scope: Agent): UserMessage | undefined {
  // 传 agent 作用域：审查者看到的必须是执行模型实际可见的工具面
  // （黑名单 restrict、agent-scoped 工具都体现在这个 scope 里）
  const schemas = ctx.tools.schemas(scope)
  if (schemas.length === 0) return undefined
  const sorted = [...schemas].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const signature = sorted.map(t => t.name).join('|')
  if (cache.signature === signature && cache.message !== undefined) return cache.message
  const block = sorted
    .map(t => `### ${t.name}\n${t.description}\n\nParameters: ${stableStringify(t.parameters)}`)
    .join('\n\n---\n\n')
  const message = createUserText(`## Available Executor Tools\n\n${block}`)
  cache.signature = signature
  cache.message = message
  return message
}

const LEGAL_TOOL_CALL_ID = /^[A-Za-z0-9_-]+$/

function sanitizeToolCallIds(messages: Message[]): Map<string, string> {
  const ids = new Map<string, string>()
  const used = new Set<string>()
  const originals: string[] = []
  const add = (id: string) => {
    if (ids.has(id)) return
    const base = id.replace(/[^A-Za-z0-9_-]/g, '_') || 'call'
    let sanitized = base
    for (let suffix = 2; used.has(sanitized); suffix += 1) sanitized = `${base}_${suffix}`
    ids.set(id, sanitized)
    used.add(sanitized)
  }

  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const block of message.content) if (block.type === 'tool-call') originals.push(block.id)
    } else if (message.role === 'tool') {
      originals.push(message.toolCallId, message.source.callId)
    }
  }
  // Reserve legal IDs first so sanitizing an illegal ID never renames a valid one.
  for (const id of originals) {
    if (LEGAL_TOOL_CALL_ID.test(id)) {
      ids.set(id, id)
      used.add(id)
    }
  }
  for (const id of originals) add(id)
  return ids
}

/** Remove tool calls without results and results whose calls were not forwarded. */
export function repairToolPairs(messages: Message[]): Message[] {
  const results = new Set(messages.filter((message) => message.role === 'tool').map((message) => message.toolCallId))
  const ids = sanitizeToolCallIds(messages)
  const keptCalls = new Set<string>()
  const repaired: Message[] = []

  for (const message of messages) {
    if (message.role === 'assistant') {
      const hadToolCalls = message.content.some(block => block.type === 'tool-call')
      const content = message.content.flatMap<ContentBlock>((block) => {
        if (block.type !== 'tool-call') return [block]
        if (!results.has(block.id)) return []
        keptCalls.add(block.id)
        const id = ids.get(block.id) ?? block.id
        return [id === block.id ? block : { ...block, id: ToolCallId(id) }]
      })
      if (hadToolCalls && !content.some(block => block.type !== 'reasoning')) continue
      const unchanged = content.length === message.content.length && content.every((block, i) => block === message.content[i])
      repaired.push(unchanged
        ? message
        : { ...message, content, source: { kind: 'model', provider: message.source.provider, model: message.source.model } } as Message)
      continue
    }

    if (message.role === 'tool') {
      if (!results.has(message.toolCallId) || !keptCalls.has(message.toolCallId)) continue
      const toolCallId = ids.get(message.toolCallId) ?? message.toolCallId
      const sourceCallId = ids.get(message.source.callId) ?? message.source.callId
      repaired.push(toolCallId === message.toolCallId && sourceCallId === message.source.callId
        ? message
        : {
            ...message,
            toolCallId: ToolCallId(toolCallId),
            source: { ...message.source, callId: ToolCallId(sourceCallId) },
          })
      continue
    }

    repaired.push(message)
  }

  return repaired
}

// 保证 user 结尾：剥除后尾部可能是 assistant（executor 在调用前输出了思考）
function ensureUserTail(messages: Message[]): Message[] {
  if (messages.length === 0) return messages
  const last = messages[messages.length - 1]
  if (last === undefined || last.role !== 'assistant') return messages
  return [...messages, createUserText(MSG_USER_TAIL_NUDGE)]
}

export function createHistoryBuilder(ctx: Context) {
  // 每个 agent 一份清单缓存（WeakMap 不阻碍临时 agent 回收）：工具可见面
  // 是 per-agent 的，作用域不同清单也不同，不能共用同一份缓存
  const caches = new WeakMap<Agent, InventoryCache>()
  return function buildAdvisorMessages(agent: Agent): Message[] {
    const branch = ensureUserTail(repairToolPairs(agent.session.deriveMessages()))
    let cache = caches.get(agent)
    if (cache === undefined) {
      cache = {}
      caches.set(agent, cache)
    }
    const inventory = getInventoryMessage(ctx, cache, agent)
    return inventory === undefined ? branch : [inventory, ...branch]
  }
}
