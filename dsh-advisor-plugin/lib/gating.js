/**
 * gating —— 按 agent 动态可见性。每次解析模型请求时把执行路由对照
 * 黑名单：命中的 agent 在自己的作用域上挂 restrict({deny:['advisor']})
 * （工具 schema 从该 agent 的提示里消失），未命中的解除限制。
 */
import { ADVISOR_TOOL_NAME } from './advisor-prompt.js';
import { isExecutorBlocked } from './config.js';
export function registerGating(ctx, getConfig, hasReviewer) {
    const restrictions = new Map();
    const lift = (agent) => {
        const dispose = restrictions.get(agent);
        if (dispose !== undefined) {
            dispose();
            restrictions.delete(agent);
        }
    };
    const reconcile = (agent, provider, model, reasoningEffort) => {
        // 未武装时工具根本没注册——无事可藏，且 restrict() 会拒绝未知名
        if (!hasReviewer()) {
            lift(agent);
            return;
        }
        const blocked = isExecutorBlocked(getConfig(), provider, model, reasoningEffort);
        if (blocked && !restrictions.has(agent)) {
            restrictions.set(agent, agent.ctx.tools.restrict({ deny: [ADVISOR_TOOL_NAME] }));
        }
        else if (!blocked) {
            lift(agent);
        }
    };
    const disposeListener = ctx.on('agent/request', async (payload, next) => {
        const config = await next();
        try {
            reconcile(payload.agent, config.provider, config.model, config.reasoningEffort);
        }
        catch (error) {
            // 可见性门控绝不破坏用户的 turn
            console.error('[dsh-advisor] gating 失败：', error);
        }
        return config;
    });
    return () => {
        disposeListener();
        for (const dispose of restrictions.values())
            dispose();
        restrictions.clear();
    };
}
