/**
 * AdvisorToolRow —— `advisor` 工具在会话消息流里的专属行（keyed
 * `tool.call.toolview` 槽，官方给插件自有工具预留的定制点）。
 *
 * 折叠态：🧭 标题 + 进行中/完成/失败状态 + 审查模型路由；
 * 展开态：审查建议全文（或错误说明）——用户点开即见"真的调了
 * advisor、建议是什么"。
 */
import type { LocaleKey } from './locales.js';
/** 会话工具块的最小结构（RunningToolCall / settled result 的并集子集） */
interface AdvisorBlock {
    kind?: unknown;
    callId?: unknown;
    call?: {
        argsRaw?: unknown;
    } | undefined;
    argsRaw?: unknown;
    content?: readonly {
        type?: unknown;
        text?: unknown;
    }[] | undefined;
    isError?: boolean | undefined;
    error?: {
        name?: unknown;
        code?: unknown;
        message?: unknown;
    } | undefined;
}
export type AdvisorToolRowProps = {
    callId?: string;
    toolName?: string;
    block?: AdvisorBlock;
    cwd?: string;
    home?: string;
    openFile?: (path: string) => void;
    inspect?: () => void;
    t?: (key: LocaleKey) => string;
};
export declare function AdvisorToolRow(props: AdvisorToolRowProps): import("react").JSX.Element;
export {};
