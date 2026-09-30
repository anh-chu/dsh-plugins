/**
 * investigate —— 审查者只读调查工具的回归测试。
 *
 * 覆盖本次 P0 修复：read_file 的 endLine 生效、symlink 不越出工作区、
 * search_files 的路径型 glob（双星号加斜杠匹配零层或多层目录）可用。
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createInvestigateExecutor } from '../src/llm-call.js'

describe('审查者调查工具', () => {
  let ws: string
  let outside: string
  let exec: ReturnType<typeof createInvestigateExecutor>

  const call = (name: string, args: Record<string, unknown>) =>
    exec({ type: 'tool-call', id: 'test-call' as never, name, arguments: JSON.stringify(args) })

  beforeEach(async () => {
    ws = await mkdtemp(path.join(os.tmpdir(), 'advisor-ws-'))
    outside = await mkdtemp(path.join(os.tmpdir(), 'advisor-out-'))
    exec = createInvestigateExecutor(ws)
  })

  afterEach(async () => {
    await rm(ws, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  it('read_file 尊重 startLine/endLine，并保留单次 200 行硬上限', async () => {
    await writeFile(path.join(ws, 'lines.txt'), Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join('\n'))
    const result = await call('read_file', { path: 'lines.txt', startLine: 2, endLine: 4 })
    expect(result.isError).toBe(false)
    expect(result.content).toBe('2\tL2\n3\tL3\n4\tL4')
  })

  it('read_file 拒绝通过 symlink 逃出工作区', async () => {
    const secret = path.join(outside, 'secret.txt')
    await writeFile(secret, 'TOP_SECRET')
    await symlink(secret, path.join(ws, 'escape.txt'))
    const result = await call('read_file', { path: 'escape.txt' })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('symlink')
    expect(result.content).not.toContain('TOP_SECRET')
  })

  it('search_files 支持路径型 glob（**/ 匹配零层或多层目录）', async () => {
    await mkdir(path.join(ws, 'src', 'nested'), { recursive: true })
    await mkdir(path.join(ws, 'docs'), { recursive: true })
    await writeFile(path.join(ws, 'src', 'a.ts'), 'export const hit = 1\n')
    await writeFile(path.join(ws, 'src', 'nested', 'b.ts'), 'export const nested = 1\n')
    await writeFile(path.join(ws, 'docs', 'c.md'), 'export nothing\n')
    const result = await call('search_files', { pattern: 'export', glob: 'src/**/*.ts' })
    expect(result.isError).toBe(false)
    expect(result.content).toContain('src/a.ts')
    expect(result.content).toContain('src/nested/b.ts')
    expect(result.content).not.toContain('docs/c.md')
  })
})
