/**
 * history —— 组装发给审查模型的消息列表。
 *
 * 结构（对齐 rpiv-advisor）：
 *   [工具清单合成消息] + [session.deriveMessages() 的模型可见面]
 *
 * deriveMessages() 是 compaction 感知的——按执行模型实际看到的样貌转发，
 * 而不是重放压缩前的原始历史；工具清单按名排序、键排序稳定序列化，
 * 让多次 advisor 调用字节级一致。
 * 转发前剔除未配对的 tool call/result，并清理 tool-call id，作为
 * Anthropic 兼容审查路由适配器修复之外的纵深防御。
 * 保留 user 结尾规则（部分 provider 拒绝 assistant 结尾）。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { type Message } from '@deepseek-ai/dsh-llm';
/** Remove tool calls without results and results whose calls were not forwarded. */
export declare function repairToolPairs(messages: Message[]): Message[];
export declare function createHistoryBuilder(ctx: Context): (agent: Agent) => Message[];
