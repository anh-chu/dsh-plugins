#!/usr/bin/env node
/**
 * compat-0.2 —— DSH 0.2.0-rc.2 兼容性断言（无框架，直接跑）。
 *
 *   node test/compat-0.2.cjs
 *
 * 覆盖本项目在 0.2 上必须成立的事实。前四条是 0.2 的硬约束，后三条是回归
 * 保护——任何一条挂掉都意味着这次 fork 的关键修复被改回去了：
 *
 *   1. client 半的 inject 只声明宿主一定提供的服务。0.2 移除了 settingsScope
 *      与 conversationEvents，声明它们会让整个条目停在 pending(entry did not
 *      activate)，且插件自己的 try/catch 来不及执行。
 *   2. 设置卡片挂 0.2 的 settings.plugins.tab 槽，数据走 configForms。
 *   3. host 半不再向 hook/invoked 写事件（0.2 该类型已被 hooks 子系统接管并
 *      带强制载荷校验），也不再借道任何会话事件做观测。
 *   4. 注入上下文的来源用自声明 kind 'advisor-patrol'（0.2 移除了 catch-all
 *      'plugin' kind，MessageSourceMap 改为各生产者自声明）。
 *   5. 构建产物里的死文件必须真的消失（tsc 只增不删，漏清理会继续分发
 *      hook/invoked 写入端）。
 *   6. 可换入设置作用域：attach 前为 unavailable、attach 后转发并通知。
 *   7. configForms 表单投影：快照直通、写入走裸字段名、拒绝的写入抛错。
 */

'use strict'

const assert = require('node:assert/strict')
const { existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')

let passed = 0
const check = (name, fn) => {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.error(`  FAIL ${name}`)
    console.error(`       ${error && error.message ? error.message : error}`)
    process.exitCode = 1
  }
}

const clientBundle = read('lib/client/index.js')

console.log('0.2 兼容断言：')

// 1 + 2：inject 与槽位/服务
check('client inject 只声明 0.2 提供的服务', () => {
  const match = clientBundle.match(/inject = (\[[^\]]*\])/)
  assert.ok(match, '未在构建产物里找到 inject 数组')
  const inject = JSON.parse(match[1].replace(/'/g, '"'))
  assert.deepEqual(inject, ['slots', 'locale', 'connection'])
  for (const gone of ['settingsScope', 'conversationEvents']) {
    assert.ok(!inject.includes(gone), `inject 仍声明了 0.2 不提供的服务：${gone}`)
  }
})

check('设置卡片挂 settings.plugins.tab 且数据走 configForms', () => {
  assert.ok(clientBundle.includes('settings.plugins.tab'), '构建产物里没有 settings.plugins.tab')
  assert.ok(clientBundle.includes('configForms'), '构建产物里没有 configForms 解析')
})

check('conversationEvents 残留清空（API 已从 0.2 移除）', () => {
  assert.ok(!clientBundle.includes('conversationEvents'), 'client 半仍引用 conversationEvents')
})

check('bundle 自注册 id 等于包名（loader 按包名解析模块）', () => {
  const pkgName = JSON.parse(read('package.json')).name
  const match = clientBundle.match(/__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/)
  assert.ok(match, '未找到 __ModuleLoader__.load({ id }) 自注册')
  assert.equal(match[1], pkgName, `注册 id 与包名不一致：${match[1]} ≠ ${pkgName}`)
})

// 3：host 半不再借道会话事件
check('host 半不再写会话事件（hook/invoked 已被 hooks 子系统接管）', () => {
  const hostFiles = ['lib/patrol.js', 'lib/index.js', 'lib/settings.js', 'lib/tool.js']
    .filter((rel) => existsSync(join(root, rel)))
  for (const rel of hostFiles) {
    const text = read(rel)
    assert.ok(!/session\.append\s*\(/.test(text), `${rel} 仍在 session.append`)
    assert.ok(!text.includes('appendPatrolVerdict'), `${rel} 仍在调用 appendPatrolVerdict`)
  }
})

// 4：注入上下文的来源是自声明 kind
check("注入上下文来源为自声明 kind 'advisor-patrol' + form 'notice'", () => {
  const patrol = read('lib/patrol.js')
  assert.ok(/kind:\s*'advisor-patrol'/.test(patrol), "没找到 kind: 'advisor-patrol'")
  assert.ok(/form:\s*'notice'/.test(patrol), "没找到 form: 'notice'")
  assert.ok(patrol.includes('boundContextSummary'), 'summary 未经 boundContextSummary 截断')
  assert.ok(!/kind:\s*'plugin'/.test(patrol), "仍在用 0.2 已移除的 catch-all kind 'plugin'")
})

// 5：死文件真的消失（tsc 只增不删）
check('上一版构建的死文件已清理', () => {
  for (const dead of ['lib/patrol-event.js', 'lib/client/patrol-chat.js', 'lib/client/PatrolNodeView.js']) {
    assert.ok(!existsSync(join(root, dead)), `死文件仍在分发：${dead}`)
  }
})

// 6 + 7：纯函数行为（直接跑构建产物）
const run = async () => {
  const mod = await import(join(root, 'lib/client/settings-controller.js'))

  check('可换入作用域：attach 前 unavailable 且写入为空操作', async () => {
    const scope = mod.createResolvingScope()
    const snap = scope.getSnapshot()
    assert.equal(snap.status, 'unavailable')
    assert.equal(snap.writable, false)
    await scope.set('provider', 'x')
    assert.equal(scope.getSnapshot().status, 'unavailable', 'attach 前不应有数据')
  })

  check('可换入作用域：attach 后转发快照并通知既有订阅者', async () => {
    const scope = mod.createResolvingScope()
    let notified = 0
    scope.subscribe(() => { notified += 1 })
    const written = []
    scope.attach({
      getSnapshot: () => ({ status: 'ready', value: { provider: 'gw' }, writable: true }),
      subscribe: () => () => {},
      set: async (field, value) => { written.push([field, value]) },
    })
    assert.ok(notified >= 1, 'attach 未通知已有订阅者')
    const snap = scope.getSnapshot()
    assert.equal(snap.status, 'ready')
    assert.deepEqual(snap.value, { provider: 'gw' })
    assert.equal(snap.writable, true)
    await scope.set('model', 'm')
    assert.deepEqual(written, [['model', 'm']])
  })

  check('configForms 解析：按设置命名空间取表单，缺席时 undefined', async () => {
    const host = {
      get: (name) => name === 'configForms'
        ? { get: (ns) => ns === 'advisor' ? { getSnapshot: () => ({ status: 'ready', value: {}, writable: true }), subscribe: () => () => {} } : undefined }
        : undefined,
    }
    const scope = mod.resolveConfigForms(host)
    assert.ok(scope, '未解析到 configForms 表单')
    assert.equal(scope.getSnapshot().status, 'ready')
    assert.equal(mod.resolveConfigForms({ get: () => undefined }), undefined)
  })

  check('configForms 投影：裸字段名写入，被拒时抛错', async () => {
    const calls = []
    const ok = mod.projectConfigForm({
      getSnapshot: () => ({ status: 'ready', value: { enabled: true }, writable: true }),
      subscribe: () => () => {},
      set: async (field, value) => { calls.push([field, value]); return true },
    })
    await ok.set('enabled', false)
    assert.deepEqual(calls, [['enabled', false]], '写入未使用裸字段名')

    const refusing = mod.projectConfigForm({
      getSnapshot: () => ({ status: 'ready', value: {}, writable: true }),
      subscribe: () => () => {},
      set: async () => false,
    })
    await assert.rejects(() => refusing.set('model', 'x'), /拒绝/, '被拒写入应抛错以触达卡片失败态')
  })

  check('configForms 投影：无 set 时回落到 mutate 的 [field] 路径', async () => {
    const ops = []
    const viaMutate = mod.projectConfigForm({
      getSnapshot: () => ({ status: 'ready', value: {}, writable: true }),
      subscribe: () => () => {},
      mutate: async (list) => { ops.push(list); return true },
    })
    await viaMutate.set('provider', 'gw')
    assert.deepEqual(ops, [[{ op: 'set', path: ['provider'], value: 'gw' }]])
  })

  console.log(`\n${passed} 条断言通过${process.exitCode === 1 ? '，存在失败项' : ''}`)
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
