import { describe, expect, it } from 'vitest'
import { createAdviceDeduper, isContentFreeAdvice, normalizeAdvice } from '../src/emission-guard.js'
import { globToRegExp, resolveWithinRoot } from '../src/llm-call.js'

describe('normalizeAdvice 归一化', () => {
  it('大小写/标点/空白折叠到同一键（中文同样参与）', () => {
    expect(normalizeAdvice('Stop.')).toBe('stop')
    expect(normalizeAdvice('*STOP*')).toBe('stop')
    expect(normalizeAdvice('  停止！ ')).toBe('停止')
    expect(normalizeAdvice('没有问题，继续。')).toBe('没有问题 继续')
  })
  it('保留实质内容（部分匹配不算空）', () => {
    const n = normalizeAdvice('停止：await 缺失会丢缓冲写')
    expect(isContentFreeAdvice(n)).toBe(false)
  })
})

describe('isContentFreeAdvice 内容空短语', () => {
  it('中英黑名单命中', () => {
    for (const text of ['Stop.', 'done', 'task complete', 'no issue continue', 'lgtm', '停止', '已完成', '没有问题 继续', '一切正常', '方向正确']) {
      expect(isContentFreeAdvice(normalizeAdvice(text))).toBe(true)
    }
  })
  it('空串与带理由的建议不误伤', () => {
    expect(isContentFreeAdvice('')).toBe(true)
    expect(isContentFreeAdvice(normalizeAdvice('CORRECTION: 已收集全部证据，停止搜索日志并整理结论'))).toBe(false)
  })
})

describe('createAdviceDeduper 会话内去重', () => {
  it('首见接受、重复丢弃、不同建议各自接受', () => {
    const dedupe = createAdviceDeduper()
    expect(dedupe('stop enumerating logs')).toBe(true)
    expect(dedupe('stop enumerating logs')).toBe(false)
    expect(dedupe('wrong file edit src a ts instead')).toBe(true)
  })
  it('FIFO 容量上限：最老的键被逐出后可再次接受', () => {
    const dedupe = createAdviceDeduper(2)
    dedupe('a')
    dedupe('b')
    dedupe('c') // 逐出 a
    expect(dedupe('b')).toBe(false)
    expect(dedupe('a')).toBe(true)
  })
})

describe('resolveWithinRoot 工作区路径钳制', () => {
  const root = '/tmp/ws'
  it('区内相对/绝对路径放行', () => {
    expect(resolveWithinRoot(root, 'src/a.ts')).toBe('/tmp/ws/src/a.ts')
    expect(resolveWithinRoot(root, '/tmp/ws/b.ts')).toBe('/tmp/ws/b.ts')
  })
  it('越界路径（../ 与区外绝对路径）拒绝', () => {
    expect(resolveWithinRoot(root, '../secrets')).toBeUndefined()
    expect(resolveWithinRoot(root, '/etc/passwd')).toBeUndefined()
  })
})

describe('globToRegExp 简易 glob', () => {
  it('* 不跨目录、** 跨目录、通配后缀', () => {
    expect(globToRegExp('*.java').test('Foo.java')).toBe(true)
    expect(globToRegExp('*.java').test('a/Foo.java')).toBe(true)
    expect(globToRegExp('*.md').test('docs/x.md')).toBe(true)
    expect(globToRegExp('*.java').test('Foo.ts')).toBe(false)
  })
  it('**/ 匹配零层或多层目录（路径型 glob 可用）', () => {
    const srcTs = globToRegExp('src/**/*.ts')
    expect(srcTs.test('src/a.ts')).toBe(true)
    expect(srcTs.test('src/nested/a.ts')).toBe(true)
    expect(srcTs.test('src/nested/a.md')).toBe(false)
    const anyTs = globToRegExp('**/*.ts')
    expect(anyTs.test('a.ts')).toBe(true)
    expect(anyTs.test('src/a.ts')).toBe(true)
  })
})
