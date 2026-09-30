/**
 * llm-call —— 审查模型侧调用，走 ctx.llm.stream（复用 DSH 已注册的
 * provider 路由与凭据——审查模型就是"DSH 已经配置好的模型"之一）。
 *
 * 聚合 text-delta、捕获 usage、把 finish 分块路由成类型化结果；
 * 正常停止但无正文时恰好重试一次（aborted / error 短路不重试）。
 *
 * 调查工具（对照 oh-my-pi：advisor 默认授予 read/grep/glob，建议前先
 * 亲自查证）：传入 investigateRoot 时走 agentic 循环——审查模型可用
 * 两个只读工具（工作区内正则搜索 / 读文件）核实事实后再出最终裁决。
 * 工具在本地用 node:fs 实现（只读、锁定在会话工作区子树内、结果截断），
 * 不经过宿主工具运行时（无审批/沙箱副作用，代价是只有这两个只读原语）。
 */

import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  FinishReason,
  GenerateOptions,
  Message,
  ReasoningEffortId,
  ToolCallBlock,
  ToolSchema,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Selection } from './config.js'

export type AdvisorOutcome =
  | { ok: true, text: string, usage: TokenUsage | undefined, finishKind: string }
  | { ok: false, errorMessage: string }

// 侧调用深度计数：巡逻的 llm/stream 注入据此排除审查模型自己的请求
// （巡逻侧调用与显式 advisor() 工具调用都不该被注入干预）
let reviewerCallDepth = 0

export function isReviewerCallActive(): boolean {
  return reviewerCallDepth > 0
}

interface AttemptResult {
  finish: FinishReason
  text: string
  usage: TokenUsage | undefined
  /** 本轮的完整内容块（block-end 顺序）——调查循环用它重建 assistant 消息 */
  blocks: ContentBlock[]
}

async function runAttempt(
  ctx: Context,
  selection: Selection,
  systemPrompt: string,
  messages: Message[],
  signal: AbortSignal | undefined,
  tools?: readonly ToolSchema[],
  sessionId?: SessionId,
): Promise<AttemptResult> {
  let text = ''
  let usage: TokenUsage | undefined
  let finish: FinishReason | undefined
  const blocks: ContentBlock[] = []
  const options: GenerateOptions = {
    provider: selection.provider,
    model: selection.model,
    messages,
    system: systemPrompt,
    ...(signal === undefined ? {} : { signal }),
    ...(tools === undefined ? {} : { tools: [...tools] }),
    // 侧调用也要带上主会话 id：部分适配器（example-provider 等）依赖它做请求路由
    ...(sessionId === undefined ? {} : { sessionId }),
  }
  if (selection.effort !== undefined) options.reasoningEffort = selection.effort as ReasoningEffortId
  for await (const chunk of ctx.llm.stream(options)) {
    if (chunk.type === 'text-delta') {
      text += chunk.text
    } else if (chunk.type === 'usage') {
      usage = chunk.usage
    } else if (chunk.type === 'block-end') {
      blocks.push(chunk.block)
    } else if (chunk.type === 'finish') {
      finish = chunk.reason
    }
  }
  if (finish === undefined) {
    return {
      finish: { kind: 'error', failure: { message: 'stream ended without a finish chunk', code: 'ADVISOR_NO_FINISH' } },
      text,
      usage,
      blocks,
    }
  }
  return { finish, text, usage, blocks }
}

function terminal(finish: FinishReason): Extract<AdvisorOutcome, { ok: false }> | undefined {
  if (finish.kind === 'aborted') {
    return { ok: false, errorMessage: `Advisor 调用在完成前被取消（${finish.failure.message}）` }
  }
  if (finish.kind === 'error') {
    return { ok: false, errorMessage: `Advisor 调用失败：${finish.failure.code}: ${finish.failure.message}` }
  }
  return undefined
}

/**
 * 剥离审查模型对执行模型"最后一句话"的回显。实测部分审查模型（经由
 * 代理网关）会在正式建议前先复读执行模型调用 advisor 前的可见文本
 * （如"好的，马上调用 advisor 咨询！"）——对执行模型毫无信息量。
 * 仅当 guidance 的首个非空行与转发消息里最后一条 assistant 文本完全
 * 一致时剥掉该行，误伤面最小。
 */
export function stripExecutorEcho(guidance: string, messages: readonly Message[]): string {
  let lastAssistantText: string | undefined
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]
    if (msg?.role !== 'assistant') continue
    for (let j = msg.content.length - 1; j >= 0; j -= 1) {
      const block = msg.content[j]
      if (block?.type === 'text' && block.text.trim() !== '') {
        lastAssistantText = block.text.trim()
        break
      }
    }
    break
  }
  if (lastAssistantText === undefined) return guidance
  const trimmed = guidance.trimStart()
  if (!trimmed.startsWith(lastAssistantText)) return guidance
  const rest = trimmed.slice(lastAssistantText.length)
  return rest.replace(/^\s*\n+/, '').trimStart() === '' ? guidance.trim() : rest.replace(/^\s*\n+/, '').trimStart()
}

/** 内部一轮调用的结果：公开的 AdvisorOutcome 字段 + 本轮块与工具调用 */
interface InnerOutcome {
  ok: true
  text: string
  usage: TokenUsage | undefined
  finishKind: string
  blocks: ContentBlock[]
  toolCalls: ToolCallBlock[]
}

/**
 * 审查侧调用入口。
 * @param investigateRoot 提供时启用调查循环：审查模型可用只读工具在工作区
 * 内核实后再出最终裁决（对照 oh-my-pi 的 advisor 调查授权）
 */
export async function callReviewer(
  ctx: Context,
  selection: Selection,
  systemPrompt: string,
  messages: Message[],
  signal: AbortSignal | undefined,
  investigateRoot?: string,
  sessionId?: SessionId,
): Promise<AdvisorOutcome> {
  reviewerCallDepth += 1
  try {
    const system = investigateRoot === undefined ? systemPrompt : systemPrompt + INVESTIGATE_NOTE
    if (investigateRoot === undefined) {
      const outcome = await attemptWithDegradation(ctx, selection, system, messages, signal, undefined, sessionId)
      if (outcome.ok === false) return outcome
      return { ok: true, text: outcome.text, usage: outcome.usage, finishKind: outcome.finishKind }
    }
    return await investigateLoop(ctx, selection, system, messages, signal, investigateRoot, sessionId)
  } finally {
    reviewerCallDepth -= 1
  }
}

/** 单轮调用 + 双降级（档位不支持 → 默认档；上下文溢出 → 配对安全截断） */
async function attemptWithDegradation(
  ctx: Context,
  selection: Selection,
  systemPrompt: string,
  messages: Message[],
  signal: AbortSignal | undefined,
  tools: readonly ToolSchema[] | undefined,
  sessionId?: SessionId,
): Promise<InnerOutcome | { ok: false, errorMessage: string }> {
  let outcome = await callReviewerInner(ctx, selection, systemPrompt, messages, signal, tools, sessionId)
  // 思考强度降级：配置的 effort 档位不被该模型支持时（实测 example-model+max 全军
  // 覆没的场景），剥掉 reasoningEffort 重试一次——宁可走模型默认档，不可静默失败
  if (outcome.ok === false && selection.effort !== undefined && isUnsupportedEffortError(outcome.errorMessage)) {
    console.warn(`[dsh-advisor] 配置的推理档位 "${selection.effort}" 不被 ${selection.provider}/${selection.model} 支持，已自动降级为模型默认档（可在设置页调整档位）`)
    outcome = await callReviewerInner(
      ctx,
      { provider: selection.provider, model: selection.model },
      systemPrompt,
      messages,
      signal,
      tools,
      sessionId,
    )
  }
  // 上下文截断降级：执行模型窗口（如 1M）远大于审查模型（如 190k）时，长会话
  // 整段转发会溢出（实测 reviewer-model 报 CONTEXT_WINDOW_EXCEEDED）。截到尾部
  // 近况重试一次——巡逻裁决主要依赖近期行为，截断后仍足以判断方向。
  if (outcome.ok === false && isContextOverflowError(outcome.errorMessage) && messages.length > 8) {
    const truncated = truncateForReviewer(messages)
    console.warn(`[dsh-advisor] 会话超出审查模型窗口，已截断转发（${messages.length} → ${truncated.length} 条消息），仅保留工具清单与近期活动`)
    outcome = await callReviewerInner(ctx, selection, systemPrompt, truncated, signal, tools, sessionId)
  }
  return outcome
}

/** 调查循环轮数上限（对照 OMP"每次建议 2-3 次调用，blocker 前可更多"） */
const MAX_INVESTIGATE_ROUNDS = 4

async function investigateLoop(
  ctx: Context,
  selection: Selection,
  systemPrompt: string,
  messages: Message[],
  signal: AbortSignal | undefined,
  root: string,
  sessionId?: SessionId,
): Promise<AdvisorOutcome> {
  const convo: Message[] = [...messages]
  const execute = createInvestigateExecutor(root)
  let totalUsage: TokenUsage | undefined
  for (let round = 0; ; round += 1) {
    const isFinal = round >= MAX_INVESTIGATE_ROUNDS
    const inner = await attemptWithDegradation(ctx, selection, systemPrompt, convo, signal, isFinal ? undefined : INVESTIGATE_TOOL_SCHEMAS, sessionId)
    if (inner.ok === false) return inner
    if (totalUsage === undefined) totalUsage = inner.usage
    else if (inner.usage !== undefined) totalUsage = sumUsage(totalUsage, inner.usage)
    if (inner.toolCalls.length === 0 || isFinal) {
      return { ok: true, text: inner.text, usage: totalUsage, finishKind: inner.finishKind }
    }
    // 重建本轮 assistant 消息（含工具调用块），执行调查工具并回灌结果
    convo.push(createAssistantMessage({
      content: inner.blocks.filter(b => b.type === 'text' || b.type === 'tool-call'),
      source: { provider: selection.provider, model: selection.model },
    }))
    for (const call of inner.toolCalls) {
      const started = Date.now()
      const result = await execute(call)
      console.log(`[dsh-advisor] 审查者调查 ${call.name}（${Date.now() - started}ms，${result.isError ? '失败' : `${result.content.length} 字符`}）`)
      convo.push(createToolResultMessage({
        callId: call.id,
        content: [{ type: 'text', text: result.content }],
        isError: result.isError,
      }))
    }
  }
}

function sumUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(a.cacheReadTokens !== undefined || b.cacheReadTokens !== undefined
      ? { cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0) }
      : {}),
  }
}

/** 是否"模型不支持该推理档位"类错误（纯函数，可单测） */
export function isUnsupportedEffortError(errorMessage: string | undefined): boolean {
  if (errorMessage === undefined) return false
  const upper = errorMessage.toUpperCase()
  return upper.includes('UNSUPPORTED_REASONING_EFFORT') || upper.includes('DOES NOT SUPPORT REASONING EFFORT')
}

/** 是否"上下文窗口溢出"类错误（纯函数，可单测） */
export function isContextOverflowError(errorMessage: string | undefined): boolean {
  if (errorMessage === undefined) return false
  const upper = errorMessage.toUpperCase()
  return upper.includes('CONTEXT_WINDOW_EXCEEDED') || upper.includes('CONTEXT LENGTH EXCEEDED') || upper.includes('CONTEXTWINDOW')
}

/** 截断系数：保留尾部消息条数占比（溢出通常差数倍，砍到 1/4 最稳） */
const TRUNCATE_KEEP_RATIO = 0.25

/**
 * 是否工具结果消息（截断配对安全的判定单元，纯函数可单测）。
 *
 * 0.2 把工具结果提升为一等 tool 角色消息（ToolResultMessage）；0.1.x 是
 * user 消息里带 tool-result 内容块。两条都认：0.2 上必须认 role==='tool'，
 * 否则截断会把 tool 消息留在保留区头部而配对的 tool-call 已被丢弃，provider
 * 会整包拒绝（unexpected tool_use_id ... must have a corresponding tool_use）。
 */
function isToolResultMessage(message: Message | undefined): boolean {
  if (message === undefined) return false
  if (message.role === 'tool') return true
  return message.role === 'user'
    && (message.content as readonly { type?: unknown }[]).some(block => block.type === 'tool-result')
}

/**
 * 溢出时的截断转发（纯函数，可单测）：保留首条（工具清单合成消息）+
 * 尾部约 1/4 的近期消息，并在衔接处插入一条截断说明。巡逻/咨询的裁决
 * 主要依赖近期行为，截断后仍足以判断方向。
 *
 * 配对安全：消息边界截断可能把 tool_use 切在丢弃区、把配对的
 * tool_result 留在保留区头部——孤儿 tool_result 会被 Claude/OpenAI 类
 * provider 整包拒绝（实测 `unexpected tool_use_id ... must have a
 * corresponding tool_use block`）。从保留区头部起剥掉含 tool-result 块
 * 的 user 消息，直到首条不再引用被切断的调用。
 */
export function truncateForReviewer(messages: readonly Message[]): Message[] {
  if (messages.length <= 8) return [...messages]
  const head = messages.slice(0, 1)
  const keepCount = Math.max(4, Math.floor(messages.length * TRUNCATE_KEEP_RATIO))
  let tail = messages.slice(-keepCount)
  while (tail.length > 0 && isToolResultMessage(tail[0])) {
    tail = tail.slice(1)
  }
  const notice = createUserMessage({
    content: [{ type: 'text', text: '[advisor] Earlier conversation was truncated to fit the reviewer\'s context window; judge from the recent activity below.' }],
    source: { kind: 'user' },
  })
  return [...head, notice, ...tail]
}

async function callReviewerInner(
  ctx: Context,
  selection: Selection,
  systemPrompt: string,
  messages: Message[],
  signal: AbortSignal | undefined,
  tools?: readonly ToolSchema[],
  sessionId?: SessionId,
): Promise<InnerOutcome | { ok: false, errorMessage: string }> {
  let attempt = await runAttempt(ctx, selection, systemPrompt, messages, signal, tools, sessionId)
  const toolCallsOf = (a: typeof attempt): ToolCallBlock[] => a.blocks.filter((b): b is ToolCallBlock => b.type === 'tool-call')

  const firstTerminal = terminal(attempt.finish)
  if (firstTerminal !== undefined) return firstTerminal

  // 有界重试：持久返回空正文且未请求工具的 provider 不会热循环
  // （调查轮里"只有工具调用没有正文"是正常形态，不触发重试）
  if (attempt.text.trim() === '' && toolCallsOf(attempt).length === 0) {
    attempt = await runAttempt(ctx, selection, systemPrompt, messages, signal, tools, sessionId)
    const retryTerminal = terminal(attempt.finish)
    if (retryTerminal !== undefined) return retryTerminal
    if (attempt.text.trim() === '' && toolCallsOf(attempt).length === 0) {
      return { ok: false, errorMessage: 'Advisor 返回了空正文（已重试一次）。' }
    }
  }

  return {
    ok: true,
    text: attempt.text.trim(),
    usage: attempt.usage,
    finishKind: attempt.finish.kind,
    blocks: attempt.blocks,
    toolCalls: toolCallsOf(attempt),
  }
}

// ─────────────────────────── 审查者调查工具 ───────────────────────────
// 对照 oh-my-pi：advisor 默认被授予 read/grep/glob，建议前先亲自查证。
// 这里用 node:fs 实现等价的两个只读原语，锁定在会话工作区子树内。

/** 启用调查时追加到系统提示的说明（最终裁决格式契约不变） */
const INVESTIGATE_NOTE = '\n\nYou may call the provided read-only tools (search_files / read_file) to verify facts in the workspace before giving your verdict. Investigate sparingly (a few calls), then answer in the exact format requested above.'

const INVESTIGATE_TOOL_SCHEMAS: readonly ToolSchema[] = [
  {
    name: 'search_files',
    description: 'Recursively search file contents inside the session workspace (case-sensitive regex). Returns file:line: text matches (max 50). Use to verify code/config facts before ruling.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex, e.g. poiRegion|districtCode' },
        glob: { type: 'string', description: 'Optional filename filter, e.g. *.java or **/*.ts' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'read_file',
    description: 'Read one file inside the session workspace with line numbers (max 200 lines per call).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the workspace root' },
        startLine: { type: 'number', description: 'First line to read (default 1)' },
        endLine: { type: 'number', description: 'Last line to read (default startLine+199)' },
      },
      required: ['path'],
    },
  },
]

/** 搜索时跳过的目录与超大文件 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'target', '.venv', '__pycache__', '.idea', '.next', 'out'])
const MAX_FILE_BYTES = 1_500_000
const MAX_READ_LINES = 200
const MAX_OUTPUT_CHARS = 12_000
const MAX_MATCHES = 50

/** 简易 glob → RegExp（* 不跨目录、** 跨目录、双星号加斜杠匹配零个或多个目录、? 单字符） */
export function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          // **/ 允许零层目录：src/**/*.ts 也要匹配 src/a.ts
          re += '(?:.*/)?'
          i += 2
        } else {
          re += '.*'
          i += 1
        }
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`(^|/)${re}$`)
}

/**
 * 把目标路径解析进工作区子树（纯函数，可单测）：越界（../ 或绝对路径指向
 * 区外）返回 undefined——审查者的读取面被硬限制在会话工作区内。
 */
export function resolveWithinRoot(root: string, target: string): string | undefined {
  const base = path.resolve(root)
  const resolved = path.resolve(base, target)
  const rel = path.relative(base, resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined
  return resolved
}

/** 截断到字符上限并标注（结果给模型看的部分保持紧凑） */
function clampOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n… [truncated at ${MAX_OUTPUT_CHARS} chars]`
}

async function searchFiles(root: string, args: Record<string, unknown>): Promise<{ content: string, isError: boolean }> {
  const pattern = typeof args.pattern === 'string' ? args.pattern : ''
  if (pattern === '') return { content: 'missing "pattern"', isError: true }
  let regex: RegExp
  try {
    regex = new RegExp(pattern)
  } catch (error) {
    return { content: `invalid regex: ${String(error)}`, isError: true }
  }
  const glob = typeof args.glob === 'string' && args.glob !== '' ? globToRegExp(args.glob) : undefined
  const base = path.resolve(root)
  const out: string[] = []
  const stack: string[] = [base]
  let scanned = 0
  while (stack.length > 0 && out.length < MAX_MATCHES && scanned < 4_000) {
    const dir = stack.pop()
    if (dir === undefined) break
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (out.length >= MAX_MATCHES) break
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(full)
        continue
      }
      if (!entry.isFile()) continue
      // glob 同时匹配相对路径与文件名：支持 src/**/*.ts 这类路径模式，
      // 也保留 *.java 这类仅文件名模式（旧行为不回归）
      const relativePath = path.relative(base, full)
      if (glob !== undefined && !glob.test(relativePath) && !glob.test(entry.name)) continue
      scanned += 1
      try {
        const info = await stat(full)
        if (info.size > MAX_FILE_BYTES) continue
        const text = await readFile(full, 'utf8')
        const lines = text.split('\n')
        for (let i = 0; i < lines.length && out.length < MAX_MATCHES; i += 1) {
          if (regex.test(lines[i] ?? '')) {
            out.push(`${path.relative(base, full)}:${i + 1}: ${(lines[i] ?? '').trim().slice(0, 200)}`)
          }
        }
      } catch {
        // 不可读/非文本文件直接跳过
      }
    }
  }
  if (out.length === 0) return { content: `no matches for /${pattern}/`, isError: false }
  return { content: clampOutput(out.join('\n')), isError: false }
}

async function readFileSlice(root: string, args: Record<string, unknown>): Promise<{ content: string, isError: boolean }> {
  const target = typeof args.path === 'string' ? args.path : ''
  if (target === '') return { content: 'missing "path"', isError: true }
  const resolved = resolveWithinRoot(root, target)
  if (resolved === undefined) return { content: `path escapes the workspace: ${target}`, isError: true }
  // 词法钳制挡不住符号链接：按真实路径再确认一次，防止工作区内的
  // symlink 把审查者读到区外（如 ~/.ssh、/etc）
  let safePath: string
  try {
    const realRoot = await realpath(path.resolve(root))
    const realTarget = await realpath(resolved)
    const rel = path.relative(realRoot, realTarget)
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return { content: `path escapes the workspace through a symlink: ${target}`, isError: true }
    }
    safePath = realTarget
  } catch (error) {
    return { content: `cannot read ${target}: ${String(error)}`, isError: true }
  }
  const rawStart = typeof args.startLine === 'number' && Number.isFinite(args.startLine) ? args.startLine : 1
  const startLine = Math.max(1, Math.floor(rawStart))
  // endLine 是 schema 公开参数：尊重调用方请求，但仍保留单次 200 行硬上限
  const rawEnd = typeof args.endLine === 'number' && Number.isFinite(args.endLine)
    ? args.endLine
    : startLine + MAX_READ_LINES - 1
  const endLine = Math.min(Math.floor(rawEnd), startLine + MAX_READ_LINES - 1)
  let text: string
  try {
    const info = await stat(safePath)
    if (info.size > MAX_FILE_BYTES * 10) return { content: `file too large (${info.size} bytes)`, isError: true }
    text = await readFile(safePath, 'utf8')
  } catch (error) {
    return { content: `cannot read ${target}: ${String(error)}`, isError: true }
  }
  const lines = text.split('\n')
  const picked: string[] = []
  for (let i = startLine - 1; i < Math.min(endLine, lines.length); i += 1) {
    picked.push(`${i + 1}\t${lines[i] ?? ''}`)
  }
  if (picked.length === 0) return { content: `empty range ${startLine}-${endLine} (file has ${lines.length} lines)`, isError: true }
  return { content: clampOutput(picked.join('\n')), isError: false }
}

/** 调查工具执行器（只读、限工作区、结果截断） */
export function createInvestigateExecutor(root: string): (call: ToolCallBlock) => Promise<{ content: string, isError: boolean }> {
  return async (call) => {
    let args: Record<string, unknown>
    try {
      args = JSON.parse(call.arguments) as Record<string, unknown>
    } catch {
      return { content: `arguments is not valid JSON: ${call.arguments.slice(0, 120)}`, isError: true }
    }
    try {
      if (call.name === 'search_files') return await searchFiles(root, args)
      if (call.name === 'read_file') return await readFileSlice(root, args)
      return { content: `unknown tool: ${call.name}`, isError: true }
    } catch (error) {
      return { content: `tool failed: ${String(error)}`, isError: true }
    }
  }
}
