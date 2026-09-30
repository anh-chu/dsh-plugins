/**
 * gating —— 按 agent 动态可见性。每次解析模型请求时把执行路由对照
 * 黑名单：命中的 agent 在自己的作用域上挂 restrict({deny:['advisor']})
 * （工具 schema 从该 agent 的提示里消失），未命中的解除限制。
 */
import type { Context } from '@deepseek-ai/cordis';
import { type Config } from './config.js';
export declare function registerGating(ctx: Context, getConfig: () => Config, hasReviewer: () => boolean): () => void;
