#!/usr/bin/env node
/**
 * compat-0.2 —— DSH 0.2.0-rc.2 兼容性断言（无框架，直接跑）。
 *
 *   node test/compat-0.2.cjs
 *
 * 这次 fork 只有一个改动，但它决定投递能否落盘：0.2 的会话格式 v4 拒绝
 * catch-all 的 `kind: "plugin"`（"format v4 message requires a producer-owned
 * source kind"），于是上游 rc.17 的 session_send 构造出的消息在写入会话日志时
 * 被拒，目标会话本轮失败且无法导出（上游 issue #4，未修）。修复是让投递消息
 * 使用本插件自有的 kind。
 *
 * 断言：
 *   1. 真实投递路径产出的 source.kind 是生产方自有 kind（等于包名），且不再带
 *      被移除的 `plugin` 字段。
 *   2. 该消息能通过宿主真实的 v4 准入校验（assertReleasedV4Relationships）——
 *      动态加载安装里的 codec，而不是复述规则。
 *   3. 反向对照：旧的 `kind: "plugin"` 形状必须仍被同一校验拒绝。没有这一条，
 *      第 2 条可能因为 fixture 写错而“碰巧通过”。
 *   4. 工具面没有扩大：仍然只注册 session_list / session_send / session_messages。
 */

'use strict'

const assert = require('node:assert/strict')
const { existsSync, readFileSync, realpathSync } = require('node:fs')
const { execFileSync } = require('node:child_process')
const { join, dirname } = require('node:path')
const { pathToFileURL } = require('node:url')

const root = join(__dirname, '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')

let passed = 0
let failed = 0
const run = async (name, fn) => {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${name}`)
    console.error(`       ${error && error.message ? error.message : error}`)
    process.exitCode = 1
  }
}

/** 定位安装里的 @deepseek-ai 包根，用于加载宿主真实的 codec。 */
function resolveHarnessPackages() {
  const candidates = []
  if (process.env.DSH_PKGS) candidates.push(process.env.DSH_PKGS)
  // `-l` 在部分环境里没有可用的 login shell，先试 `-c` 再退回 `-lc`。
  for (const flags of [['-c'], ['-lc']]) {
    try {
      const bin = execFileSync('bash', [...flags, 'command -v dsh'], { encoding: 'utf8' }).trim()
      if (bin) candidates.push(join(dirname(dirname(realpathSync(bin))), 'node_modules', '@deepseek-ai'))
      break
    } catch {
      /* try the next shell flavour, then the fallbacks below */
    }
  }
  if (process.env.HOME) {
    candidates.push(join(process.env.HOME, '.dsh', 'profiles', 'web', 'node_modules', '@deepseek-ai'))
  }
  // Assumes scripts/link-deps.sh has run; still the same installed files.
  candidates.push(join(root, 'node_modules', '@deepseek-ai'))
  return candidates.find((base) => existsSync(join(base, 'dsh-session-format-v3-to-v4', 'lib', 'index.js')))
}

const main = async () => {
  const mod = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)

  // Capture the message the real delivery path hands to the target agent.
  const captured = []
  const target = {
    id: 'session-probe-b',
    status: 'idle',
    session: { id: 'session-probe-b' },
    followup(message) { captured.push(message) },
  }
  const ctx = {
    agents: {
      get: (id) => (String(id) === 'session-probe-b' ? target : undefined),
      list: () => [target],
    },
    workspaceRegistry: { archivedSessionIds: [] },
    sessionPersistence: { list: async () => [] },
    typert: { lookups: { get: () => undefined } },
  }
  const messaging = new mod.LocalSessionMessagingImpl(ctx, {})
  await messaging.deliver({
    id: 'compat-probe-1',
    from: 'session-probe-a',
    to: 'session-probe-b',
    text: 'compat probe',
    transport: 'local',
  })

  const base = resolveHarnessPackages()
  if (base === undefined) {
    throw new Error('could not locate @deepseek-ai packages; set DSH_PKGS to the @deepseek-ai directory')
  }
  const codec = await import(pathToFileURL(join(base, 'dsh-session-format-v3-to-v4', 'lib', 'index.js')).href)

  /** Wrap a message source in the minimal artifact the v4 admission path accepts. */
  const admit = (source) => codec.assertReleasedV4Relationships({
    header: { id: 'session-probe-b', parentSession: undefined },
    inheritedEventCount: 0,
    events: [{
      seq: 0,
      type: 'user/message',
      surfaceOp: 'append',
      data: { id: 'compat-probe-1', role: 'user', content: [{ type: 'text', text: 'compat probe' }], source },
    }],
  }, new Set(['user/message']))

  await run('投递消息带生产方自有 kind，且不再有被移除的 plugin 字段', () => {
    assert.equal(captured.length, 1, 'delivery did not reach the target agent')
    const source = captured[0].source
    assert.equal(source.kind, mod.name, 'source.kind must be the plugin-owned name')
    assert.notEqual(source.kind, 'plugin', 'the removed catch-all kind must not return')
    assert.equal(Object.hasOwn(source, 'plugin'), false, 'the legacy `plugin` field must be gone')
    assert.equal(source.form, 'relay', 'relay is the ContextForm for a carried message')
  })

  await run('该消息通过宿主真实的 v4 准入校验', () => {
    admit(captured[0].source)
  })

  await run('反向对照：旧的 kind:"plugin" 形状仍被同一校验拒绝', () => {
    assert.throws(
      () => admit({ kind: 'plugin', plugin: 'dsh-bridge', form: 'relay' }),
      /producer-owned source kind/,
      'the validator no longer rejects `plugin`, so the assertion above proves nothing',
    )
  })

  await run('工具面未扩大：仍为三个消息工具', () => {
    const registered = []
    mod.apply({
      provide: () => {},
      accessor: () => {},
      tools: { register: (tool) => { registered.push(tool.name) } },
    }, {})
    assert.deepEqual([...registered].sort(), ['session_list', 'session_messages', 'session_send'])
  })

  await run('lib/ 里不再有遗留的 kind:"plugin" 投递', () => {
    assert.equal(/"plugin"/.test(read(join('lib', 'index.js'))), false, 'lib/index.js still builds a "plugin" source')
  })

  console.log(`\n${passed} passed${failed > 0 ? `, ${failed} FAILED` : ''}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
