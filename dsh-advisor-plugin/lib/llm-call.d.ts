/**
 * llm-call —— 审查模型侧调用，走 ctx.llm.stream（复用 DSH 已注册的
 * provider 路由与凭据——审查模型就是"DSH 已经配置好的模型"之一）。
 *
 * 聚合 text-delta、捕获 usage、把 finish 分块路由成类型化结果；
 * 正常停止但无正文时恰好重试一次（aborted / error 短路不重试）。
 *
 * 调查工具（对照 oh-my-pi：advisor 默认授予 read/grep/glob，建议前先
 * 亲自查证）：传入 investigateRoot 时走 agentic 循环——审查模型可用
 * 两个只读工具（工作区内正则搜索 / 读文件）核实事实后再出最终裁决。
 * 工具在本地用 node:fs 实现（只读、锁定在会话工作区子树内、结果截断），
 * 不经过宿主工具运行时（无审批/沙箱副作用，代价是只有这两个只读原语）。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Message, ToolCallBlock, TokenUsage } from '@deepseek-ai/dsh-llm';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { Selection } from './config.js';
export type AdvisorOutcome = {
    ok: true;
    text: string;
    usage: TokenUsage | undefined;
    finishKind: string;
} | {
    ok: false;
    errorMessage: string;
};
export declare function isReviewerCallActive(): boolean;
/**
 * 剥离审查模型对执行模型"最后一句话"的回显。实测部分审查模型（经由
 * 代理网关）会在正式建议前先复读执行模型调用 advisor 前的可见文本
 * （如"好的，马上调用 advisor 咨询！"）——对执行模型毫无信息量。
 * 仅当 guidance 的首个非空行与转发消息里最后一条 assistant 文本完全
 * 一致时剥掉该行，误伤面最小。
 */
export declare function stripExecutorEcho(guidance: string, messages: readonly Message[]): string;
/**
 * 审查侧调用入口。
 * @param investigateRoot 提供时启用调查循环：审查模型可用只读工具在工作区
 * 内核实后再出最终裁决（对照 oh-my-pi 的 advisor 调查授权）
 */
export declare function callReviewer(ctx: Context, selection: Selection, systemPrompt: string, messages: Message[], signal: AbortSignal | undefined, investigateRoot?: string, sessionId?: SessionId): Promise<AdvisorOutcome>;
/** 是否"模型不支持该推理档位"类错误（纯函数，可单测） */
export declare function isUnsupportedEffortError(errorMessage: string | undefined): boolean;
/** 是否"上下文窗口溢出"类错误（纯函数，可单测） */
export declare function isContextOverflowError(errorMessage: string | undefined): boolean;
/**
 * 溢出时的截断转发（纯函数，可单测）：保留首条（工具清单合成消息）+
 * 尾部约 1/4 的近期消息，并在衔接处插入一条截断说明。巡逻/咨询的裁决
 * 主要依赖近期行为，截断后仍足以判断方向。
 *
 * 配对安全：消息边界截断可能把 tool_use 切在丢弃区、把配对的
 * tool_result 留在保留区头部——孤儿 tool_result 会被 Claude/OpenAI 类
 * provider 整包拒绝（实测 `unexpected tool_use_id ... must have a
 * corresponding tool_use block`）。从保留区头部起剥掉含 tool-result 块
 * 的 user 消息，直到首条不再引用被切断的调用。
 */
export declare function truncateForReviewer(messages: readonly Message[]): Message[];
/** 简易 glob → RegExp（* 不跨目录、** 跨目录、双星号加斜杠匹配零个或多个目录、? 单字符） */
export declare function globToRegExp(glob: string): RegExp;
/**
 * 把目标路径解析进工作区子树（纯函数，可单测）：越界（../ 或绝对路径指向
 * 区外）返回 undefined——审查者的读取面被硬限制在会话工作区内。
 */
export declare function resolveWithinRoot(root: string, target: string): string | undefined;
/** 调查工具执行器（只读、限工作区、结果截断） */
export declare function createInvestigateExecutor(root: string): (call: ToolCallBlock) => Promise<{
    content: string;
    isError: boolean;
}>;
