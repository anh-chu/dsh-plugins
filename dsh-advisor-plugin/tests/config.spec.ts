import { describe, expect, it } from 'vitest'
import { isExecutorBlocked, resolveSelection, selectionLabel } from '../src/config.js'

describe('resolveSelection 武装条件', () => {
  it('provider 与 model 缺一即未武装（off costs nothing）', () => {
    expect(resolveSelection({})).toBeUndefined()
    expect(resolveSelection({ provider: 'example-provider' })).toBeUndefined()
    expect(resolveSelection({ model: 'deepseek-v4-pro' })).toBeUndefined()
    expect(resolveSelection({ provider: 'example-provider', model: 'deepseek-v4-pro' })).toEqual({
      provider: 'example-provider',
      model: 'deepseek-v4-pro',
    })
  })

  it('空串与 undefined 同义；effort 空串 = 未设置（走模型默认）', () => {
    expect(resolveSelection({ provider: '', model: '' })).toBeUndefined()
    const sel = resolveSelection({ provider: 'p', model: 'm', effort: '' })
    expect(sel).toEqual({ provider: 'p', model: 'm' })
    expect('effort' in (sel ?? {})).toBe(false)
  })

  it('effort 非空时进入选择', () => {
    expect(resolveSelection({ provider: 'p', model: 'm', effort: 'high' })).toEqual({
      provider: 'p', model: 'm', effort: 'high',
    })
  })

  it('selectionLabel 人类可读', () => {
    expect(selectionLabel({ provider: 'p', model: 'm' })).toBe('p/m')
    expect(selectionLabel({ provider: 'p', model: 'm', effort: 'max' })).toBe('p/m (max)')
  })

  it('enabled=false：总开关关闭时不武装，即使 provider/model 齐备', () => {
    expect(resolveSelection({ enabled: false, provider: 'example-provider', model: 'reviewer-model' })).toBeUndefined()
    expect(resolveSelection({ enabled: true, provider: 'example-provider', model: 'reviewer-model' })).toEqual({
      provider: 'example-provider',
      model: 'reviewer-model',
    })
    expect(resolveSelection({ provider: 'example-provider', model: 'reviewer-model' })).toEqual({
      provider: 'example-provider',
      model: 'reviewer-model',
    })
  })
})

describe('isExecutorBlocked 黑名单语法', () => {
  it('"model"：任意 provider 跑该模型都禁用', () => {
    const config = { disabledForModels: ['deepseek-v4-pro'] }
    expect(isExecutorBlocked(config, 'example-provider', 'deepseek-v4-pro', 'high')).toBe(true)
    expect(isExecutorBlocked(config, 'other-provider', 'deepseek-v4-pro', undefined)).toBe(true)
    expect(isExecutorBlocked(config, 'example-provider', 'deepseek-v4-flash', 'high')).toBe(false)
  })

  it('"provider/model"：精确路由禁用', () => {
    const config = { disabledForModels: ['example-provider/deepseek-v4-pro'] }
    expect(isExecutorBlocked(config, 'example-provider', 'deepseek-v4-pro', 'low')).toBe(true)
    expect(isExecutorBlocked(config, 'example-provider1', 'deepseek-v4-pro', 'low')).toBe(false)
  })

  it('"provider/model@effort"：档位达到阈值才禁用', () => {
    const config = { disabledForModels: ['gpt-5.2@high'] }
    expect(isExecutorBlocked(config, 'x', 'gpt-5.2', 'low')).toBe(false)
    expect(isExecutorBlocked(config, 'x', 'gpt-5.2', 'high')).toBe(true)
    expect(isExecutorBlocked(config, 'x', 'gpt-5.2', 'max')).toBe(true)
  })

  it('未知档位（含未设置）按 fail-soft 永不禁用；未知阈值条目跳过', () => {
    expect(isExecutorBlocked({ disabledForModels: ['m@high'] }, 'p', 'm', undefined)).toBe(false)
    expect(isExecutorBlocked({ disabledForModels: ['m@ultra'] }, 'p', 'm', 'max')).toBe(false)
  })

  it('空串条目跳过；无 provider/model 不禁用；空名单不禁用', () => {
    expect(isExecutorBlocked({ disabledForModels: [''] }, 'p', 'm', 'high')).toBe(false)
    expect(isExecutorBlocked({ disabledForModels: ['m'] }, undefined, 'm', 'high')).toBe(false)
    expect(isExecutorBlocked({}, 'p', 'm', 'high')).toBe(false)
  })
})
