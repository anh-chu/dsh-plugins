import { describe, expect, it } from 'vitest'
import { MIN_PATROL_INTERVAL_MS, parsePatrolVerdict, shouldPatrol } from '../src/patrol.js'
import { buildInterventionText } from '../src/advisor-prompt.js'

describe('shouldPatrol 巡逻调度判定', () => {
  const base = {
    armed: true,
    blocked: false,
    step: 6,
    everySteps: 6,
    now: 1_000_000,
    lastPatrolMs: 0,
    minIntervalMs: MIN_PATROL_INTERVAL_MS,
    inFlight: false,
    patrolEnabled: true,
  }

  it('步数命中间隔且距上次够久 → 巡逻', () => {
    expect(shouldPatrol(base)).toBe(true)
  })

  it('未武装 / 被禁用 / 黑名单命中 / 上轮未结束 → 不巡逻', () => {
    expect(shouldPatrol({ ...base, armed: false })).toBe(false)
    expect(shouldPatrol({ ...base, patrolEnabled: false })).toBe(false)
    expect(shouldPatrol({ ...base, blocked: true })).toBe(false)
    expect(shouldPatrol({ ...base, inFlight: true })).toBe(false)
  })

  it('步数不命中间隔 → 不巡逻', () => {
    expect(shouldPatrol({ ...base, step: 5 })).toBe(false)
    expect(shouldPatrol({ ...base, step: 12, everySteps: 6 })).toBe(true) // 12 % 6 === 0
  })

  it('墙钟节流：距上次巡逻不足最小间隔 → 不巡逻', () => {
    expect(shouldPatrol({ ...base, lastPatrolMs: base.now - 10_000 })).toBe(false)
    expect(shouldPatrol({ ...base, lastPatrolMs: base.now - MIN_PATROL_INTERVAL_MS })).toBe(true)
  })

  it('非法间隔（<1）不巡逻', () => {
    expect(shouldPatrol({ ...base, everySteps: 0 })).toBe(false)
  })
})

describe('parsePatrolVerdict 裁决解析', () => {
  it('ON-TRACK 单行 → 正常', () => {
    expect(parsePatrolVerdict('ON-TRACK')).toEqual({ kind: 'on-track', detail: '' })
    expect(parsePatrolVerdict('on-track\nlooks fine')).toEqual({ kind: 'on-track', detail: 'looks fine' })
  })

  it('CORRECTION：首行内联 + 后续行合并为细节', () => {
    const v = parsePatrolVerdict('CORRECTION: wrong file\nEdit src/a.ts instead.\nAlso check imports.')
    expect(v.kind).toBe('correction')
    expect(v.detail).toContain('wrong file')
    expect(v.detail).toContain('Edit src/a.ts instead.')
  })

  it('STOP 同理', () => {
    const v = parsePatrolVerdict('STOP: the task was already completed two steps ago')
    expect(v.kind).toBe('stop')
    expect(v.detail).toContain('already completed')
  })

  it('无法解析（空/其他格式）→ unclear，不干预执行模型', () => {
    expect(parsePatrolVerdict('').kind).toBe('unclear')
    expect(parsePatrolVerdict('一切都好！继续！').kind).toBe('unclear')
  })
})

describe('buildInterventionText 干预文本', () => {
  it('纠偏带 advisor patrol 标识 + 调整指令', () => {
    const text = buildInterventionText('correction', 'You are editing the wrong module.')
    expect(text).toContain('[advisor patrol]')
    expect(text).toContain('You are editing the wrong module.')
    expect(text).toContain('Adjust your approach now')
  })

  it('停止信号带停机 + 向用户报告指令', () => {
    const text = buildInterventionText('stop', 'Task already satisfied.')
    expect(text).toContain('STOP signal')
    expect(text).toContain('Halt')
    expect(text).toContain('report the situation to the user')
  })
})

import { isUnsupportedEffortError } from '../src/llm-call.js'

describe('isUnsupportedEffortError 档位不支持错误识别', () => {
  it('识别实测错误格式', () => {
    expect(isUnsupportedEffortError('Advisor 调用失败：UNSUPPORTED_REASONING_EFFORT: provider "example-provider" model "example-model" does not support reasoning effort "max"')).toBe(true)
    expect(isUnsupportedEffortError('... DOES NOT SUPPORT REASONING EFFORT low')).toBe(true)
  })

  it('其他错误不误判', () => {
    expect(isUnsupportedEffortError('网络请求失败：ECONNREFUSED')).toBe(false)
    expect(isUnsupportedEffortError(undefined)).toBe(false)
    expect(isUnsupportedEffortError('')).toBe(false)
  })
})

import { isContextOverflowError, truncateForReviewer } from '../src/llm-call.js'

describe('isContextOverflowError 溢出错误识别', () => {
  it('识别实测错误格式', () => {
    expect(isContextOverflowError('Advisor 调用失败：CONTEXT_WINDOW_EXCEEDED: pi-ai detected context overflow for model "reviewer-model"')).toBe(true)
    expect(isContextOverflowError('... context length exceeded ...')).toBe(true)
  })
  it('其他错误不误判', () => {
    expect(isContextOverflowError('ECONNREFUSED')).toBe(false)
    expect(isContextOverflowError(undefined)).toBe(false)
  })
})

describe('truncateForReviewer 溢出截断', () => {
  it('短列表原样返回', () => {
    expect(truncateForReviewer([])).toEqual([])
  })
  it('保留首条（工具清单）+ 尾部 1/4 + 截断说明', () => {
    const msgs = Array.from({ length: 100 }, (_, i) => ({ role: 'user', content: [{ type: 'text', text: `m${i}` }] })) as never[]
    const out = truncateForReviewer(msgs)
    // 1（清单）+ 1（说明）+ 25（尾部）= 27
    expect(out).toHaveLength(27)
  })
  it('配对安全：剥掉保留区头部孤儿 tool-result 消息（配对的 tool_use 被切在丢弃区）', () => {
    const toolResultMsg = { role: 'user', content: [{ type: 'tool-result', callId: 'c1', content: 'r' }] }
    const toolResultMsg2 = { role: 'user', content: [{ type: 'tool-result', callId: 'c2', content: 'r2' }] }
    // 27 条：keepCount = floor(27/4) = 6 → 截断点正好切在 tool_result 前
    const msgs = [
      { role: 'user', content: [{ type: 'text', text: 'inventory' }] },
      ...Array.from({ length: 20 }, (_, i) => ({ role: 'assistant', content: [{ type: 'text', text: `a${i}` }] })),
      toolResultMsg,
      toolResultMsg2,
      ...Array.from({ length: 4 }, (_, i) => ({ role: 'assistant', content: [{ type: 'text', text: `kept${i}` }] })),
    ] as never[]
    const out = truncateForReviewer(msgs)
    const outRoles = (out as never[]).map(m => (m as { role: string }).role)
    // 首条清单 + 说明 + 4 条保留 assistant，两条孤儿 tool-result 已被剥掉
    expect(out).toHaveLength(6)
    expect(outRoles[1]).toBe('user')
    expect(JSON.stringify(out)).not.toContain('tool-result')
    expect(JSON.stringify(out)).toContain('kept0')
  })
})
