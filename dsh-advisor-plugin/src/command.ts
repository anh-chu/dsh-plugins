/**
 * command —— `/advisor` 人类命令：报告当前审查模型选择、逐 provider 列出
 * 可配置模型（来自 llm 服务的模型目录）、以及黑名单状态。不产生模型消息。
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import { selectionLabel, type Config, type Selection } from './config.js'

export function registerAdvisorCommand(
  ctx: Context,
  getConfig: () => Config,
  getSelection: () => Selection | undefined,
  getSettingsInfo: () => string,
): (() => void) | undefined {
  const commands = ctx.get('commands')
  if (commands === undefined) return undefined
  return commands.register({
    name: 'advisor',
    description: '查看 advisor（审查模型）配置与各 provider 可用模型',
    handler: async () => {
      const selection = getSelection()
      const current = selection === undefined
        ? '未配置审查模型——advisor 工具对模型不可见。'
        : `Advisor：${selectionLabel(selection)}`

      const providers = ctx.llm.listProviders()
      let routesBlock: string
      if (providers.length === 0) {
        routesBlock = '没有已注册的 provider 路由（需要挂载 llm 适配器，如 llm-pi-ai）。'
      } else {
        const perProvider = await Promise.all(providers.map(async p => {
          try {
            const models = await ctx.llm.listModels(p.id)
            const list = models.length === 0 ? '（无模型）' : models.map(m => m.id).join(', ')
            return `- ${p.id}（${p.name}）: ${list}`
          } catch {
            return `- ${p.id}（${p.name}）: 模型列表获取失败`
          }
        }))
        routesBlock = ['已注册 provider 路由与模型：', ...perProvider].join('\n')
      }

      const config = getConfig()
      const blocklist = (config.disabledForModels ?? []).length === 0
        ? '执行模型黑名单：（空）'
        : `执行模型黑名单：${config.disabledForModels?.join(', ')}`

      return {
        kind: 'success',
        text: [
          current,
          routesBlock,
          blocklist,
          getSettingsInfo(),
          '在 设置 → 插件 → Advisor 卡片中选择审查模型，或直接编辑 ~/.dsh/settings.yaml 的 advisor: 段。',
        ].join('\n'),
      }
    },
  })
}
