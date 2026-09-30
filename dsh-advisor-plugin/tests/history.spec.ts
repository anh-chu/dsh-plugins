import { describe, expect, it } from 'vitest'
import type { Message } from '@deepseek-ai/dsh-llm'
import { repairToolPairs } from '../src/history.js'

const modelSource = { kind: 'model', provider: 'p', model: 'm', replayState: { version: 1 } }
const assistant = (content: unknown[], source = modelSource) => ({
  role: 'assistant',
  id: 'assistant-1',
  content,
  source,
}) as unknown as Message
const call = (id: string, name = 'test') => ({ type: 'tool-call', id, name, arguments: '{}' })
const result = (callId: string, sourceCallId = callId) => ({
  role: 'tool',
  id: `result-${callId}`,
  toolCallId: callId,
  source: { kind: 'tool', callId: sourceCallId },
  content: [{ type: 'text', text: 'result' }],
}) as unknown as Message

describe('repairToolPairs', () => {
  it('drops unanswered batched calls and the emptied assistant message', () => {
    const messages = [assistant([call('advisor-1', 'advisor'), call('bash-1', 'bash')])]
    expect(repairToolPairs(messages)).toEqual([])
  })

  it('keeps a sibling call with its result when another call is unanswered', () => {
    const messages = [
      assistant([call('keep-me'), call('drop-me')]),
      result('keep-me'),
    ]
    const repaired = repairToolPairs(messages)
    expect(repaired).toHaveLength(2)
    expect((repaired[0] as Extract<Message, { role: 'assistant' }>).content.map(block => block.type === 'tool-call' ? block.id : '')).toEqual(['keep-me'])
    expect((repaired[1] as Extract<Message, { role: 'tool' }>).toolCallId).toBe('keep-me')
  })

  it('drops a result when its call is missing', () => {
    expect(repairToolPairs([result('orphan')])).toEqual([])
  })

  it('sanitizes pipe-separated IDs consistently across call and result', () => {
    const repaired = repairToolPairs([assistant([call('a|b')]), result('a|b')])
    const callId = (repaired[0] as Extract<Message, { role: 'assistant' }>).content[0]
    const tool = repaired[1] as Extract<Message, { role: 'tool' }>
    expect(callId).toMatchObject({ type: 'tool-call', id: 'a_b' })
    expect(tool.toolCallId).toBe('a_b')
    expect(tool.source.callId).toBe('a_b')
  })

  it('reserves legal IDs before sanitizing collisions in either order', () => {
    for (const ids of [['a|b', 'a_b'], ['a_b', 'a|b']]) {
      const repaired = repairToolPairs([
        assistant(ids.map(id => call(id))),
        ...ids.map(id => result(id)),
      ])
      const actual = (repaired[0] as Extract<Message, { role: 'assistant' }>).content
        .map(block => block.type === 'tool-call' ? block.id : '')
      expect(actual).toEqual(ids.map(id => id === 'a|b' ? 'a_b_2' : 'a_b'))
      expect(new Set(actual).size).toBe(actual.length)
      expect(actual.every(id => /^[A-Za-z0-9_-]+$/.test(id))).toBe(true)
      for (const tool of repaired.slice(1) as Extract<Message, { role: 'tool' }>[]) {
        expect(actual).toContain(tool.toolCallId)
        expect(tool.source.callId).toBe(tool.toolCallId)
      }
    }
  })

  it('keeps assistant text after removing unanswered calls', () => {
    const repaired = repairToolPairs([assistant([
      { type: 'text', text: 'keep this' },
      call('unanswered'),
    ])])
    expect(repaired).toHaveLength(1)
    expect((repaired[0] as Extract<Message, { role: 'assistant' }>).content).toEqual([
      { type: 'text', text: 'keep this' },
    ])
  })

  it('drops reasoning-only assistant leftovers after removing unanswered calls', () => {
    const repaired = repairToolPairs([assistant([
      { type: 'reasoning', text: 'internal thought' },
      call('unanswered'),
    ])])
    expect(repaired).toEqual([])
  })

  it('drops replayState only from modified assistant messages', () => {
    const changed = assistant([call('a|b')])
    const unchanged = assistant([{ type: 'text', text: 'stable' }])
    const repaired = repairToolPairs([changed, result('a|b'), unchanged])
    expect((repaired[0] as Extract<Message, { role: 'assistant' }>).source).not.toHaveProperty('replayState')
    expect((repaired[2] as Extract<Message, { role: 'assistant' }>).source).toHaveProperty('replayState', { version: 1 })
  })
})
