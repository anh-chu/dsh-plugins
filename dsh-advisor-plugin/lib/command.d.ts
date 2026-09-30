/**
 * command —— `/advisor` 人类命令：报告当前审查模型选择、逐 provider 列出
 * 可配置模型（来自 llm 服务的模型目录）、以及黑名单状态。不产生模型消息。
 */
import type { Context } from '@deepseek-ai/cordis';
import { type Config, type Selection } from './config.js';
export declare function registerAdvisorCommand(ctx: Context, getConfig: () => Config, getSelection: () => Selection | undefined, getSettingsInfo: () => string): (() => void) | undefined;
