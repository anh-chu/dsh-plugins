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
import type { Context as ClientContext } from '@deepseek-ai/cordis';
import { type LocaleKey } from './locales.js';
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        'dsh-advisor.card': LocaleKey;
    }
}
/**
 * 必需服务：只列宿主一定提供的三个。
 *
 * settingsScope / configForms 刻意不在此列——它们跨版本互斥且并非人人提供，
 * 进 inject 的代价是整个条目停在 pending；改由 apply 内的 ctx.inject 软等待
 * （见 settings-controller.ts）。
 *
 * remote / remote.session 是另一回事：0.2 的 Host Remote 命名空间就是 inject
 * 令牌（官方 composer 的模型选择器同样依赖 remote.session），模型目录
 * `ctx.remote.session.modelCatalog()` 是 0.2 唯一的数据源，故显式声明。
 */
export declare const inject: string[];
export declare function apply(ctx: ClientContext): void;
