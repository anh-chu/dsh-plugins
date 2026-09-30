/**
 * history —— 组装发给审查模型的消息列表。
 *
 * 结构（对齐 rpiv-advisor）：
 *   [工具清单合成消息] + [session.deriveMessages() 的模型可见面]
 *
 * 两个工程要点：
 *   1. deriveMessages() 是 compaction 感知的——压缩摘要按模型实际看到的
 *      面貌转发，而不是重放压缩前的原始历史；
 *   2. 工具清单做"按名排序 + 键排序稳定序列化"——多次 advisor 调用间
 *      字节级一致，命中 DeepSeek 上下文缓存（缓存是整段转发模式的省钱杠杆）。
 *
 * 尾部两条规则原样移植 rpiv：剥掉 in-flight 的 advisor() 调用（孤儿
 * toolCall 会被 provider 拒绝）；保证 user 结尾（部分 provider 拒绝
 * assistant 结尾）。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { type Message } from '@deepseek-ai/dsh-llm';
export declare function createHistoryBuilder(ctx: Context): (agent: Agent) => Message[];
