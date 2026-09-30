/**
 * patrol —— 巡逻模式：把 advisor 从"被动求助"升级为"主动监控"。
 *
 * 工作方式：
 *   1. agent/request 每步触发（复用现有 waterfall），按间隔步数 + 最小时间
 *      间隔决定是否发起一次巡逻（不阻塞当前请求，异步执行）；
 *   2. 巡逻 = 把会话快照 + 巡逻问题发给审查模型，要求回
 *      ON-TRACK / CORRECTION: ... / STOP: ... 三选一裁决；
 *   3. 裁决为纠偏/停止时，把干预文本经 `agent.inject()` 以 user 上下文排进
 *      下一步请求——落在对话尾部（新近性最高，实测系统提示段在几百条工具
 *      结果的会话里权重不足，执行模型"读到但不动"）；
 *   4. 侧调用（巡逻自身 + 显式 advisor() 工具）通过 llm-call 的
 *      深度计数排除，避免把自己的请求当成执行请求。
 *
 * 裁决的人类可观测性只走控制台日志（每轮一行，含裁决与耗时）。0.1.x 曾把
 * 裁决写进会话日志以在消息流出 🧭 卡片；0.2 起不再可行，见 COMPAT-0.2.0.md
 * （借用的 hook/invoked 已被 hooks 子系统接管并带强制载荷校验，而插件自有
 * 的外部事件类型不被持久化读取路径接受）。
 *
 * 成本提示：每次巡逻 = 整段会话计费一次审查模型（与显式 advisor()
 * 相同）。patrolEnabled / patrolEverySteps 可在设置页调整或关闭。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Message } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Config, Selection } from './config.js';
/** 两次巡逻之间的最小墙钟间隔（防止快速工具链把审查模型打爆） */
export declare const MIN_PATROL_INTERVAL_MS = 90000;
/**
 * 注入上下文的来源身份。
 *
 * 0.2 的 `MessageSourceMap` 是 merge-extensible 的，并移除了 0.1.x 的
 * catch-all `plugin` kind——每个生产者声明自己的 kind（同 dsh-skill 的
 * 'skill-invocation'、dsh-session-reference 的 'session-reference'）。
 * `form: 'notice'` 取自 0.2 的语义词表：一次性事件通报、不覆盖任何先前快照，
 * 正是巡逻裁决的定位。0.1.x 上这段声明无副作用（旧宿主不读取 kind 词表，
 * 只把它当不透明来源）。
 */
interface AdvisorPatrolSource {
    readonly kind: 'advisor-patrol';
    readonly form: 'notice';
    readonly summary: string;
}
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        'advisor-patrol': AdvisorPatrolSource;
    }
}
/** 巡逻裁决（解析失败归为 unclear——不确定时宁可不打扰执行模型） */
export type PatrolVerdictKind = 'on-track' | 'correction' | 'stop' | 'unclear';
export interface PatrolVerdict {
    kind: PatrolVerdictKind;
    detail: string;
}
/** 是否该发起一次巡逻（纯函数，可单测） */
export declare function shouldPatrol(input: {
    armed: boolean;
    blocked: boolean;
    step: number;
    everySteps: number;
    now: number;
    lastPatrolMs: number;
    minIntervalMs: number;
    inFlight: boolean;
    patrolEnabled: boolean;
}): boolean;
/** 解析审查模型的巡逻裁决（纯函数）：只认首行前缀，其余整段作为细节 */
export declare function parsePatrolVerdict(text: string): PatrolVerdict;
export interface PatrolDeps {
    getConfig: () => Config;
    getSelection: () => Selection | undefined;
    buildMessages: (agent: Agent) => Message[];
}
export declare function registerPatrol(ctx: Context, deps: PatrolDeps): () => void;
export {};
