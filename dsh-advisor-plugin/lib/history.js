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
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { ADVISOR_TOOL_NAME, MSG_USER_TAIL_NUDGE } from './advisor-prompt.js';
// 递归键排序序列化：键序与 V8 插入序无关，同一清单字节级一致
function stableStringify(value) {
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value);
    if (Array.isArray(value)) {
        return `[${value.map(v => (v === undefined ? 'null' : stableStringify(v))).join(',')}]`;
    }
    const obj = value;
    const entries = [];
    for (const k of Object.keys(obj).sort()) {
        const v = obj[k];
        if (v === undefined)
            continue;
        entries.push(`${JSON.stringify(k)}:${stableStringify(v)}`);
    }
    return `{${entries.join(',')}}`;
}
function createUserText(text) {
    return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
}
function getInventoryMessage(ctx, cache, scope) {
    // 传 agent 作用域：审查者看到的必须是执行模型实际可见的工具面
    // （黑名单 restrict、agent-scoped 工具都体现在这个 scope 里）
    const schemas = ctx.tools.schemas(scope);
    if (schemas.length === 0)
        return undefined;
    const sorted = [...schemas].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const signature = sorted.map(t => t.name).join('|');
    if (cache.signature === signature && cache.message !== undefined)
        return cache.message;
    const block = sorted
        .map(t => `### ${t.name}\n${t.description}\n\nParameters: ${stableStringify(t.parameters)}`)
        .join('\n\n---\n\n');
    const message = createUserText(`## Available Executor Tools\n\n${block}`);
    cache.signature = signature;
    cache.message = message;
    return message;
}
// 剥掉尾部 assistant 消息里 in-flight 的 advisor() toolCall——正是触发本次
// 咨询的那个调用，还没有配对结果，转发它只会让 provider 拒绝载荷
function stripInflightAdvisorCall(messages) {
    if (messages.length === 0)
        return messages;
    const last = messages[messages.length - 1];
    if (last === undefined || last.role !== 'assistant')
        return messages;
    const filtered = last.content.filter(block => !(block.type === 'tool-call' && block.name === ADVISOR_TOOL_NAME));
    if (filtered.length === last.content.length)
        return messages;
    if (filtered.length === 0)
        return messages.slice(0, -1);
    return [...messages.slice(0, -1), { ...last, content: filtered }];
}
// 保证 user 结尾：剥除后尾部可能是 assistant（executor 在调用前输出了思考）
function ensureUserTail(messages) {
    if (messages.length === 0)
        return messages;
    const last = messages[messages.length - 1];
    if (last === undefined || last.role !== 'assistant')
        return messages;
    return [...messages, createUserText(MSG_USER_TAIL_NUDGE)];
}
export function createHistoryBuilder(ctx) {
    // 每个 agent 一份清单缓存（WeakMap 不阻碍临时 agent 回收）：工具可见面
    // 是 per-agent 的，作用域不同清单也不同，不能共用同一份缓存
    const caches = new WeakMap();
    return function buildAdvisorMessages(agent) {
        const branch = ensureUserTail(stripInflightAdvisorCall(agent.session.deriveMessages()));
        let cache = caches.get(agent);
        if (cache === undefined) {
            cache = {};
            caches.set(agent, cache);
        }
        const inventory = getInventoryMessage(ctx, cache, agent);
        return inventory === undefined ? branch : [inventory, ...branch];
    };
}
