/**
 * prompt-section —— 注入系统提示的升级守则段。
 * 只在已选审查模型时注册——未武装的 advisor 零提示词成本。
 */
import { DEFAULT_GUIDELINES } from './advisor-prompt.js';
export function registerAdvisorSection(ctx, config) {
    const guidelines = config.guidelines === undefined || config.guidelines.length === 0
        ? DEFAULT_GUIDELINES
        : config.guidelines;
    const text = ['## Advisor escalation', '', ...guidelines.map(g => `- ${g}`)].join('\n');
    return ctx.systemPrompt.section({
        name: 'advisor-guidelines',
        order: 550,
        text,
    });
}
