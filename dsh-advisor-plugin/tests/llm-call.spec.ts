import { describe, expect, it } from 'vitest'
import { callReviewer, isUnsupportedEffortError } from '../src/llm-call.js'
import { stripExecutorEcho } from '../src/llm-call.js'
import type { Message } from '@deepseek-ai/dsh-llm'

describe('isUnsupportedEffortError 思考强度错误识别', () => {
  it('识别实测的 UNSUPPORTED_REASONING_EFFORT 错误', () => {
    expect(isUnsupportedEffortError('Advisor 调用失败：UNSUPPORTED_REASONING_EFFORT: provider "example-provider" model "example-model" does not support reasoning effort "max"')).toBe(true)
  })

  it('大小写不敏感；两种措辞都认', () => {
    expect(isUnsupportedEffortError('does not support reasoning effort low')).toBe(true)
    expect(isUnsupportedEffortError('UNSUPPORTED_REASONING_EFFORT: nope')).toBe(true)
  })

  it('其他错误/空值不误判', () => {
    expect(isUnsupportedEffortError(undefined)).toBe(false)
    expect(isUnsupportedEffortError('')).toBe(false)
    expect(isUnsupportedEffortError('Advisor 调用失败：HTTP 429: rate limited')).toBe(false)
    expect(isUnsupportedEffortError('网络请求失败：ECONNREFUSED')).toBe(false)
  })
})

describe('stripExecutorEcho 回显剥离', () => {
  const msgs: Message[] = [
    { role: 'user', content: [{ type: 'text', text: '任务' }] } as unknown as Message,
    { role: 'assistant', content: [{ type: 'text', text: '好的，马上调用 advisor 咨询！' }] } as unknown as Message,
  ]

  it('guidance 以执行模型最后一句话开头 → 剥掉该行', () => {
    const out = stripExecutorEcho('好的，马上调用 advisor 咨询！\n\nCORRECTION: 换个方法查日志。', msgs)
    expect(out.startsWith('CORRECTION')).toBe(true)
    expect(out).not.toContain('好的，马上')
  })

  it('不匹配前缀 → 原样返回', () => {
    expect(stripExecutorEcho('CORRECTION: 直接改。', msgs)).toBe('CORRECTION: 直接改。')
  })

  it('没有 assistant 消息 → 原样返回', () => {
    const onlyUser: Message[] = [msgs[0]]
    expect(stripExecutorEcho('任意建议', onlyUser)).toBe('任意建议')
  })
})

describe('callReviewer sessionId 透传', () => {
  it('侧调用把主会话 id 写进 GenerateOptions（example-provider 路由依赖）', async () => {
    const calls: Record<string, unknown>[] = []
    const ctx = {
      llm: {
        stream: (options: Record<string, unknown>) => (async function* () {
          calls.push(options)
          yield { type: 'text-delta', text: 'ok' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })(),
      },
    }
    const outcome = await callReviewer(
      ctx as never,
      { provider: 'example-provider1', model: 'deepseek-v4-pro' },
      'system',
      [],
      undefined,
      undefined,
      'session-1' as never,
    )
    expect(outcome.ok).toBe(true)
    expect(calls[0]?.sessionId).toBe('session-1')
  })
})
