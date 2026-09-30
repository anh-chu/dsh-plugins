/**
 * emission-guard —— 审查建议的防噪闸（对照 oh-my-pi AdvisorEmissionGuard，
 * 其源于生产事故：某会话 advisor 发了 309 次 advise、其中 114 次是
 * "Stop."——防噪规则必须是代码而不是提示词）。
 *
 * 我们对应的问题：巡逻重复发同类 CORRECTION（实测"已咨询过不要重复"
 * 连续纠偏）、无理由的"停止"式裁决。三道闸：
 *   1. 归一化：大小写/NFKC/非字母数字折叠——"Stop."/"*STOP*"/"  停止！"
 *      归一到同一个键；
 *   2. 内容空短语黑名单：归一化后整体匹配（中英双语）——只说结论不给
 *      理由的建议没有信息量，按 unclear 处理不打扰；
 *   3. 会话内精确去重：已注入过的建议再次出现直接丢弃（FIFO 容量上限，
 *      对齐 OMP 的 4096）。
 */
/** 会话内建议去重的历史容量（对齐 oh-my-pi） */
export declare const ADVICE_DEDUPE_CAPACITY = 4096;
/**
 * 归一化建议文本（纯函数，可单测）：小写 + NFKC + 非字母数字连续段折叠为
 * 单空格 + 修剪。\p{L} 覆盖 CJK 表意字符，中文建议同样可归一。
 */
export declare function normalizeAdvice(text: string): string;
/**
 * 归一化后的建议是否"内容空"（纯函数）：整体命中黑名单、或归一化后为空。
 * 部分匹配不算——"停止：await 缺失会丢缓冲写"这类带理由的建议不受影响。
 */
export declare function isContentFreeAdvice(normalized: string): boolean;
/**
 * 会话内建议去重器（每 agent 一份）。返回一个判定函数：输入归一化后的
 * 建议键，首次出现返回 true（接受并记录），重复出现返回 false（丢弃）。
 * FIFO 容量上限防止长会话无界增长。
 */
export declare function createAdviceDeduper(capacity?: number): (normalized: string) => boolean;
