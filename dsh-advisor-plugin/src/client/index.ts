/**
 * dsh-advisor —— 浏览器半（client half）入口。
 *
 * 职责：把 Advisor 设置卡片注册进设置页"插件"栏的 `settings.plugins.tab`
 * 槽（0.1.7+ 形态：id 标识的列表项卡片），advisor 工具的专属会话行注册进
 * keyed `tool.call.toolview` 槽。卡片数据 = 设置命名空间 'advisor' 的
 * configForms 表单（0.1.6 及更早回落到 settingsScope）+ 
 * connection.api.llm.models 模型目录。
 *
 * 依赖纪律（0.2 实测教训）：inject 只能声明**宿主一定提供**的服务。声明一个
 * 宿主没有的名字，cordis 的 inject waiting 会让整个 client 半永远停在
 * pending——页面报 "entry did not activate"，且插件自己的 try/catch 与
 * "可选服务"判断都来不及执行（apply 根本不会被调用）。0.2 已移除
 * settingsScope 与 conversationEvents，故二者都不出现在 inject；设置源改为
 * ctx.inject(...) 软等待，未就绪时卡片走既有 unavailable 只读分支。
 *
 * 本包零运行时值导入（@deepseek-ai/* 只做类型导入，react 走平台 jsx-runtime）。
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
// 0.1.2 起 slots 的 Context/SlotMap 类型增强住在 dsh-client-ui-cordis；
// ui-tool 携带 tool.call.toolview 槽契约（key 域对插件自有工具开放）
import type {} from '@deepseek-ai/dsh-client-ui-cordis/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { AdvisorCard } from './AdvisorCard.js'
import { AdvisorToolRow } from './AdvisorToolRow.js'
import { AdvisorCardController } from './controller.js'
import { createResolvingScope, resolveConfigForms, resolveLegacySettingsScope, type SettingsHostFace } from './settings-controller.js'
import { en, zh, type LocaleKey } from './locales.js'

// 声明本插件的 locale 命名空间（值类型 = 文案键联合，官方同款姿势）
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-advisor.card': LocaleKey
  }
}

/**
 * 必需服务：只列宿主一定提供的三个。
 *
 * settingsScope / configForms 刻意不在此列——它们跨版本互斥且并非人人提供，
 * 进 inject 的代价是整个条目停在 pending；改由 apply 内的 ctx.inject 软等待
 * （见 settings-controller.ts）。
 */
export const inject = ['slots', 'locale', 'connection']

const NS = 'dsh-advisor.card'

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-advisor: card dictionaries')

  // 设置源：先不可用态构造，服务就绪后换入（0.2 用 configForms，旧宿主用
  // settingsScope）；两个都没有时卡片按 unavailable 渲染只读态，不影响其它
  const scope = createResolvingScope()
  const controller = new AdvisorCardController(scope, ctx)
  ctx.effect(() => () => { controller.dispose() }, 'dsh-advisor: settings card')

  ctx.inject(['configForms'], (formsCtx) => {
    const source = resolveConfigForms(formsCtx as unknown as SettingsHostFace)
    if (source !== undefined) scope.attach(source)
  })
  ctx.inject(['settingsScope'], (legacyCtx) => {
    const source = resolveLegacySettingsScope(legacyCtx as unknown as SettingsHostFace)
    if (source !== undefined) scope.attach(source)
  })

  const t = (): ((key: LocaleKey) => string) => ctx.locale.bind(NS) as (key: LocaleKey) => string

  /**
   * 每个注册各自包住：一处槽位/契约不匹配只损失那一张卡片，绝不把整个条目
   * 拖成 failed（0.2 的 boot 报告按条目计）。注册用普通回调而非 generator——
   * 本仓 dsh-opencode2dsh 在 0.1.7 上实测 generator 形态会让 web boot 失败。
   */
  type SlotKey = Parameters<ClientContext['slots']['inject']>[0]
  const contained = (slot: SlotKey, build: () => Record<string, unknown>, component: unknown): void => {
    try {
      ctx.slots.inject(slot, () => ctx.slots.register(build() as never, component as never))
    } catch (error) {
      console.warn(`[dsh-advisor] 槽 ${slot} 注册失败（不影响其余功能）：`, error)
    }
  }

  // 0.1.7+：插件页的列表槽（id 是格子键，label 是导航行文案）
  contained('settings.plugins.tab', () => ({
    name: 'settings.plugins.tab',
    id: 'advisor',
    order: 30,
    label: () => t()('title'),
    locale: NS,
    inject: () => ({ ...controller.inject(), t: t() }),
  }), AdvisorCard)

  // ≤0.1.6：旧插件页槽（keyed 与 list 两种小版本形态，key/id 双写各自读各自的）。
  // 该槽名不在 0.2 的 SlotMap 里，故类型上放宽——0.2 上 slots.inject 等不到它，
  // 这段注册自然不生效（卡片由上面的 settings.plugins.tab 承担）。
  contained('settings.plugin.item' as SlotKey, () => ({
    name: 'settings.plugin.item',
    key: 'advisor',
    id: 'advisor',
    order: 30,
    locale: NS,
    inject: () => ({ ...controller.inject(), t: t() }),
  }), AdvisorCard)

  // advisor 工具的专属会话行（keyed 槽按工具名派发，官方对插件自有工具
  // 开放的渲染定制点）：🧭 标题 + 状态徽标 + 可展开的建议全文
  contained('tool.call.toolview', () => ({
    name: 'tool.call.toolview',
    key: 'advisor',
    locale: NS,
    inject: () => ({ t: t() }),
  }), AdvisorToolRow)
}
