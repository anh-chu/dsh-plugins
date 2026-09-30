/**
 * tool —— 零参数 `advisor` 工具（defineTool）。
 *
 * execute() 解析当前选择 → 组装审查消息 → 侧调用 → 返回规范值；
 * 每条失败路径同样返回值（渲染成可读文本），执行模型读到错误说明后
 * 继续本轮——advisor 挂掉绝不炸掉执行模型的 turn。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { ADVISOR_SYSTEM_PROMPT, ADVISOR_TOOL_DESCRIPTION, ADVISOR_TOOL_NAME, MSG_NO_AGENT_SCOPE, MSG_NO_MODEL } from './advisor-prompt.js';
import { selectionLabel } from './config.js';
import { callReviewer, stripExecutorEcho } from './llm-call.js';
function renderText(value) {
    if (!value.ok)
        return value.errorMessage ?? 'Advisor call failed.';
    return value.guidance ?? '';
}
/** 从工具结果内容块提取纯文本（presentResult 只拿得到渲染后的内容块） */
function textOfContent(content) {
    return content
        .filter((block) => block.type === 'text')
        .map(block => block.text)
        .join('\n')
        .trim();
}
export function createAdvisorTool(ctx, getSelection, buildMessages, getConfig) {
    return defineTool({
        name: ADVISOR_TOOL_NAME,
        description: ADVISOR_TOOL_DESCRIPTION,
        parameters: {},
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    ok: { type: 'boolean' },
                    advisorModel: { type: 'string' },
                    guidance: { type: 'string' },
                    effort: { type: 'string' },
                    finishKind: { type: 'string' },
                    errorMessage: { type: 'string' },
                    inputTokens: { type: 'number' },
                    outputTokens: { type: 'number' },
                },
            },
            render: (_args, value) => [{ type: 'text', text: renderText(value) }],
        },
        // 专属卡片：调用中/结果两态都有 🧭 标识，结果卡片正文就是审查建议，
        // 用户在消息列表展开即见"真的调了 advisor、建议是什么"
        presentCall: () => ({ card: 'generic', title: '🧭 Advisor 咨询中…' }),
        presentResult: (_args, result) => {
            const text = textOfContent(result.content);
            return {
                card: 'generic',
                title: result.isError ? '🧭 Advisor 调用失败' : '🧭 Advisor 建议',
                ...(text === '' ? {} : { content: [{ type: 'text', text }] }),
            };
        },
        async execute(_args, exec) {
            const selection = getSelection();
            if (selection === undefined) {
                return { ok: false, advisorModel: '(not configured)', errorMessage: MSG_NO_MODEL };
            }
            if (exec.agent === undefined) {
                return { ok: false, advisorModel: selectionLabel(selection), errorMessage: MSG_NO_AGENT_SCOPE };
            }
            const messages = buildMessages(exec.agent);
            // 调查授权与巡逻一致：审查模型可先只读核实再给建议
            const investigate = getConfig().investigate !== false ? exec.agent.session.header.cwd : undefined;
            const outcome = await callReviewer(ctx, selection, ADVISOR_SYSTEM_PROMPT, messages, exec.signal, investigate, exec.agent.session.id);
            if (!outcome.ok) {
                return {
                    ok: false,
                    advisorModel: selectionLabel(selection),
                    ...(selection.effort === undefined ? {} : { effort: selection.effort }),
                    errorMessage: outcome.errorMessage,
                };
            }
            return {
                ok: true,
                advisorModel: selectionLabel(selection),
                // 剥掉审查模型对执行模型"最后一句话"的回显（网关实测行为）
                guidance: stripExecutorEcho(outcome.text, messages),
                ...(selection.effort === undefined ? {} : { effort: selection.effort }),
                finishKind: outcome.finishKind,
                ...(outcome.usage === undefined
                    ? {}
                    : { inputTokens: outcome.usage.inputTokens, outputTokens: outcome.usage.outputTokens }),
            };
        },
    });
}
