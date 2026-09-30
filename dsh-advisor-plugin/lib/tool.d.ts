/**
 * tool —— 零参数 `advisor` 工具（defineTool）。
 *
 * execute() 解析当前选择 → 组装审查消息 → 侧调用 → 返回规范值；
 * 每条失败路径同样返回值（渲染成可读文本），执行模型读到错误说明后
 * 继续本轮——advisor 挂掉绝不炸掉执行模型的 turn。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { type Selection } from './config.js';
/** 工具结果信封：成功带指导文本，失败带可读错误（渲染层只取文本） */
export interface AdvisorValue {
    ok: boolean;
    advisorModel: string;
    guidance?: string;
    effort?: string;
    finishKind?: string;
    errorMessage?: string;
    inputTokens?: number;
    outputTokens?: number;
}
export declare function createAdvisorTool(ctx: Context, getSelection: () => Selection | undefined, buildMessages: (agent: Agent) => import('@deepseek-ai/dsh-llm').Message[], getConfig: () => import('./config.js').Config): import("@deepseek-ai/dsh-tools").ToolDefinition;
