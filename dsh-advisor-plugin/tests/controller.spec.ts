import { describe, expect, it } from 'vitest'
import { buildCandidates, type CatalogGroup } from '../src/client/controller.js'
import { createSnapshotStore } from '../src/client/store.js'

const GROUPS: CatalogGroup[] = [
  {
    id: 'example-provider1',
    name: 'OpenCode Go 1',
    models: [
      { id: 'glm-5.3', name: 'GLM 5.3' },
      { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek V4 Flash Vision' },
    ],
  },
  {
    id: 'example-provider',
    name: 'OpenCode Go',
    models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }],
  },
]

describe('buildCandidates 目录 join（设置页卡片纯函数）', () => {
  it('分组展开并按路由生成候选行', () => {
    const { groups, stale } = buildCandidates(GROUPS, { provider: '', model: '', effort: '' })
    expect(stale).toBe(false)
    expect(groups).toHaveLength(2)
    expect(groups[0]?.candidates).toHaveLength(2)
    expect(groups[0]?.candidates[0]).toMatchObject({ provider: 'example-provider1', model: 'glm-5.3', available: true, selected: false })
  })

  it('生效路由命中目录行 → selected 标记', () => {
    const { groups, stale } = buildCandidates(GROUPS, { provider: 'example-provider', model: 'deepseek-v4-pro', effort: 'high' })
    expect(stale).toBe(false)
    const selected = groups.flatMap(g => g.candidates).filter(c => c.selected)
    expect(selected).toHaveLength(1)
    expect(selected[0]).toMatchObject({ provider: 'example-provider', model: 'deepseek-v4-pro' })
  })

  it('已保存路由不在目录中 → 追加不可用分组行（仍可取消选择）', () => {
    const { groups, stale } = buildCandidates(GROUPS, { provider: 'gone-provider', model: 'gone-model', effort: '' })
    expect(stale).toBe(true)
    const last = groups[groups.length - 1]
    expect(last?.candidates[0]).toMatchObject({ provider: 'gone-provider', model: 'gone-model', available: false, selected: true })
  })
})

describe('createSnapshotStore 极简快照存储', () => {
  it('set 触发订阅者；退订后不再触发；getSnapshot 返回最新值', () => {
    const store = createSnapshotStore(1)
    const seen: number[] = []
    const off = store.subscribe(() => seen.push(store.getSnapshot()))
    store.set(2)
    store.set(3)
    off()
    store.set(4)
    expect(seen).toEqual([2, 3])
    expect(store.getSnapshot()).toBe(4)
  })

  it('结构满足渲染器 HostObservable 契约（getSnapshot/subscribe 均为函数）', () => {
    const store = createSnapshotStore('x')
    expect(typeof store.getSnapshot).toBe('function')
    expect(typeof store.subscribe).toBe('function')
    expect(store.subscribe(() => {})).toBeTypeOf('function')
  })
})
