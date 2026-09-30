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
import type { Context } from '@deepseek-ai/cordis';
import { Config as ConfigSchema, type Config } from './config.js';
export declare const name = "dsh-advisor";
export declare const inject: string[];
export { ConfigSchema as Config };
export declare function apply(ctx: Context, config: Config): void;
