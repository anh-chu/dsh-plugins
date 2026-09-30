/**
 * prompt-section —— 注入系统提示的升级守则段。
 * 只在已选审查模型时注册——未武装的 advisor 零提示词成本。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Config } from './config.js';
export declare function registerAdvisorSection(ctx: Context, config: Config): () => void;
