/**
 * dsh-advisor —— advisor 策略模式的 DSH 实现（host 半入口）。
 *
 * 机制（rpiv-advisor 移植）：
 *   1. 执行模型拿到零参数 `advisor` 工具；调用即把整段会话分支
 *      （compaction 感知）+ 工具清单转发给配置的更强审查模型；
 *   2. 审查模型按 plan / correction / stop signal 三选一契约回文，
 *      作为工具结果交还执行模型——不进人类可见对话流；
 *   3. 组合关系：选了审查模型 ⇔ 工具 + 升级守则提示段注册在案
 *      （未武装的 advisor 零提示词成本）；
 *   4. agent/request 监听每次解析的执行路由，命中 disabledForModels
 *      黑名单时对那个 agent 作用域挂 restrict 隐藏工具；
 *   5. settings 服务就绪后配置接入 'advisor' 命名空间（用户层在
 *      ~/.dsh/settings.yaml 的 advisor: 段；设置页卡片实时读写）。
 *
 * 服务时序：tools/llm/systemPrompt 是硬依赖（inject 导出）；settings 与
 * commands 是软依赖——用 ctx.inject 等待就绪，apply 时刻 ctx.get
 * 拿到 undefined 只说明服务尚未激活，不代表不存在。
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import { Config as ConfigSchema, resolveSelection, type Config, type Selection } from './config.js'
import { registerAdvisorCommand } from './command.js'
import { registerGating } from './gating.js'
import { createHistoryBuilder } from './history.js'
import { registerPatrol } from './patrol.js'
import { registerAdvisorSection } from './prompt-section.js'
import { createAdvisorTool } from './tool.js'
import { wireSettings } from './settings.js'

export const name = 'dsh-advisor'
export const inject = ['tools', 'llm', 'systemPrompt']
export { ConfigSchema as Config }

export function apply(ctx: Context, config: Config) {
  const state: { config: Config, selection: Selection | undefined, settingsInfo: string } = {
    config,
    selection: resolveSelection(config),
    settingsInfo: 'settings 服务未接入',
  }

  const buildMessages = createHistoryBuilder(ctx)
  let registration: (() => void) | undefined

  // 武装/解除的总闸：工具与提示段同生同灭
  const reconcileRegistration = () => {
    registration?.()
    registration = undefined
    if (state.selection === undefined) return
    const disposeTool = ctx.tools.register(createAdvisorTool(ctx, () => state.selection, buildMessages, () => state.config))
    const disposeSection = registerAdvisorSection(ctx, state.config)
    registration = () => {
      disposeTool()
      disposeSection()
    }
  }

  const disposeGating = registerGating(ctx, () => state.config, () => state.selection !== undefined)

  // 巡逻模式：按间隔自动检查执行是否跑偏并注入纠偏（未武装/被禁用时内部 no-op）
  const disposePatrol = registerPatrol(ctx, {
    getConfig: () => state.config,
    getSelection: () => state.selection,
    buildMessages,
  })
  if (state.config.patrolEnabled !== false) {
    console.log(`[dsh-advisor] 巡逻模式开启：每 ${state.config.patrolEverySteps ?? 6} 步自动检查（间隔下限 90s）`)
  }

  // /advisor 命令：commands 服务就绪后注册（fiber 卸载自动清理）
  ctx.inject(['commands'], (commandsCtx) => {
    const dispose = registerAdvisorCommand(commandsCtx, () => state.config, () => state.selection, () => state.settingsInfo)
    if (dispose !== undefined) commandsCtx.effect(() => dispose, 'dsh-advisor: /advisor command')
  })

  // 设置接入：settings 服务就绪后把 'advisor' 命名空间接进来并活编辑。
  // 注意传插件根 ctx：rc.6 cordis 的 Service 方法绑定调用者 fiber，注册
  // effect 挂在 inject 的临时 fiber 上会在 fiber 回收时静默注销命名空间。
  ctx.inject(['settings'], () => {
    const wiring = wireSettings(ctx, state, reconcileRegistration)
    state.settingsInfo = wiring.info
    reconcileRegistration()
    console.log(`[dsh-advisor] ${wiring.info}`)
    // 设置解析后的最终武装状态（apply 时刻的那条"未武装"只是组合层初值）
    if (state.selection === undefined) {
      console.log('[dsh-advisor] 设置解析完成：仍未武装（advisor: 段缺 provider/model）——工具不注册')
    } else {
      console.log(`[dsh-advisor] 设置解析完成：已武装 ${state.selection.provider}/${state.selection.model}${state.selection.effort === undefined ? '' : ` (${state.selection.effort})`}——advisor 工具已注册`)
    }
  })

  reconcileRegistration()

  if (state.selection === undefined) {
    console.log('[dsh-advisor] 未武装：未配置审查模型（provider+model），advisor 工具不注册')
  } else {
    console.log(`[dsh-advisor] 已武装：${state.selection.provider}/${state.selection.model}${state.selection.effort === undefined ? '' : ` (${state.selection.effort})`}`)
  }

  ctx.effect(() => () => {
    registration?.()
    disposeGating()
    disposePatrol()
  })
}
