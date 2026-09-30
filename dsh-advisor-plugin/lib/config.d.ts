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
import z from '@deepseek-ai/schemastery';
export interface Config {
    enabled?: boolean;
    provider?: string;
    model?: string;
    effort?: string;
    disabledForModels?: string[];
    guidelines?: string[];
    patrolEnabled?: boolean;
    patrolEverySteps?: number;
    patrolImmuneTurns?: number;
    investigate?: boolean;
}
export declare const Config: z<Config>;
/** 已武装的审查路由；undefined = advisor 关闭 */
export interface Selection {
    readonly provider: string;
    readonly model: string;
    readonly effort?: string;
}
export declare function resolveSelection(config: Config): Selection | undefined;
export declare function selectionLabel(selection: Selection): string;
/** 执行路由在当前档位下是否命中黑名单（fail-soft：未知档位/未知阈值不禁用） */
export declare function isExecutorBlocked(config: Config, provider: string | undefined, model: string | undefined, reasoningEffort: string | undefined): boolean;
