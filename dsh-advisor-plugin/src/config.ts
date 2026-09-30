/**
 * config —— schemastery 配置 schema、审查模型选择解析、执行模型黑名单语法。
 *
 * 配置三层合成（rc.6 settings 服务）：schema 默认值 → 插件组合层 base →
 * 用户层（~/.dsh/settings.yaml 的 advisor: 段，设置页卡片写入的就是这一层）。
 *
 * `enabled` 是用户总开关；`provider` + `model` 齐备且总开关打开时 advisor
 * 才武装（对应 rpiv 的 "off costs nothing"：关闭或没有审查模型时，工具与
 * 提示词段都不注册）。
 *
 * disabledForModels 条目语法（字符串数组，与设置页文案一致）：
 *   "model"                 —— 任意 provider 跑该模型都禁用
 *   "provider/model"        —— 精确路由禁用
 *   "provider/model@effort" —— 档位达到 effort 及以上才禁用
 */

import z from '@deepseek-ai/schemastery'

export interface Config {
  enabled?: boolean
  provider?: string
  model?: string
  effort?: string
  disabledForModels?: string[]
  guidelines?: string[]
  patrolEnabled?: boolean
  patrolEverySteps?: number
  patrolImmuneTurns?: number
  investigate?: boolean
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true).description('advisor 总开关：关闭后不注册 advisor 工具与升级守则提示段，已保存的模型配置保留'),
  provider: z.string().default('').description('审查模型所在的 provider 路由名（ctx.llm 适配器路由，如 example-provider）'),
  model: z.string().default('').description('该路由下的审查模型 id（如 deepseek-v4-pro）'),
  effort: z.string().default('').description('审查模型推理档位；留空走模型默认'),
  disabledForModels: z.array(z.string()).default([]).description('执行模型黑名单："model" / "provider/model" / "provider/model@minEffort"'),
  guidelines: z.array(z.string()).default([]).description('覆盖默认的升级守则（系统提示段文本，每条一行）'),
  patrolEnabled: z.boolean().default(true).description('巡逻模式：执行中每 N 步自动把会话快照发给审查模型检查是否跑偏，跑偏时注入纠偏'),
  patrolEverySteps: z.number().default(6).min(2).max(500).description('巡逻间隔（模型请求步数）；每次巡逻整段会话计费一次审查模型。当保底用可以配大（如 100）'),
  patrolImmuneTurns: z.number().default(3).min(0).max(20).description('纠偏冷却：一次纠偏注入后的 N 个请求内，新的 CORRECTION 降级为只记日志不注入（STOP 不受冷却限制）'),
  investigate: z.boolean().default(true).description('审查者调查工具：允许审查模型在裁决前用只读工具（工作区内搜索/读文件）亲自核实，建议更有据'),
})

/** 已武装的审查路由；undefined = advisor 关闭 */
export interface Selection {
  readonly provider: string
  readonly model: string
  readonly effort?: string
}

export function resolveSelection(config: Config): Selection | undefined {
  if (config.enabled === false) return undefined
  const { provider, model } = config
  if (provider === undefined || provider === '' || model === undefined || model === '') return undefined
  return config.effort === undefined || config.effort === ''
    ? { provider, model }
    : { provider, model, effort: config.effort }
}

export function selectionLabel(selection: Selection): string {
  return selection.effort === undefined
    ? `${selection.provider}/${selection.model}`
    : `${selection.provider}/${selection.model} (${selection.effort})`
}

// "@minEffort" 阈值比较用的档位序；未知档位排名 NaN 而不是猜
const EFFORT_LADDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

function effortRank(effort: string): number {
  const index = EFFORT_LADDER.indexOf(effort as (typeof EFFORT_LADDER)[number])
  return index === -1 ? Number.NaN : index
}

interface BlockRule {
  provider?: string
  model: string
  minEffort?: string
}

function parseRule(entry: string): BlockRule | undefined {
  const parts = entry.split('@')
  const route = parts[0] ?? ''
  const minEffort = parts[1]
  const trimmed = route.trim()
  if (trimmed === '') return undefined
  const slash = trimmed.indexOf('/')
  if (slash === -1) return { model: trimmed, ...(minEffort === undefined ? {} : { minEffort }) }
  return {
    provider: trimmed.slice(0, slash),
    model: trimmed.slice(slash + 1),
    ...(minEffort === undefined ? {} : { minEffort }),
  }
}

/** 执行路由在当前档位下是否命中黑名单（fail-soft：未知档位/未知阈值不禁用） */
export function isExecutorBlocked(
  config: Config,
  provider: string | undefined,
  model: string | undefined,
  reasoningEffort: string | undefined,
): boolean {
  if (provider === undefined || model === undefined) return false
  for (const entry of config.disabledForModels ?? []) {
    const rule = parseRule(entry)
    if (rule === undefined) continue
    if (rule.provider !== undefined && rule.provider !== provider) continue
    if (rule.model !== model) continue
    if (rule.minEffort !== undefined) {
      const current = effortRank(reasoningEffort ?? '')
      const floor = effortRank(rule.minEffort)
      if (Number.isNaN(current) || Number.isNaN(floor) || current < floor) continue
    }
    return true
  }
  return false
}
