/**
 * advisor-prompt —— 插件全部固定文案与提示词常量（纯声明，无逻辑）。
 *
 * 面向模型的文本用英文（模型侧语义稳定），面向用户的日志用中文。
 * 三个提示词共同构成 advisor 策略模式契约：审查模型三选一回文、
 * 执行模型按守则升级、尾部 nudge 保证 user 结尾。
 */
export declare const ADVISOR_TOOL_NAME = "advisor";
/** 发给审查模型的系统提示词：plan / correction / stop signal 三选一契约 */
export declare const ADVISOR_SYSTEM_PROMPT: string;
/** 零参数工具 description —— 执行模型判断"何时升级"的主要依据 */
export declare const ADVISOR_TOOL_DESCRIPTION: string;
/** 注入系统提示的升级守则（未配置审查模型时不注册，零提示词成本） */
export declare const DEFAULT_GUIDELINES: readonly string[];
/** 尾部 nudge：部分 provider 拒绝 assistant 结尾的载荷 */
export declare const MSG_USER_TAIL_NUDGE = "Please advise on the executor's situation above.";
/**
 * 巡逻模式系统提示：审查模型对执行过程做中段检查，回三选一裁决。
 * 首行前缀是机器可解析契约（patrol.parsePatrolVerdict），细节跟在后面。
 */
export declare const PATROL_SYSTEM_PROMPT: string;
/** 巡逻问题（挂在快照尾部，随整段会话发给审查模型） */
export declare const PATROL_NUDGE = "Patrol check: is the executor still on track for the user's task? Reply per the patrol contract.";
/** 把巡逻裁决转成注入执行模型的干预文本（llm/stream 尾部 user 消息） */
export declare function buildInterventionText(kind: 'correction' | 'stop', detail: string): string;
/** 用户可见文案（中文） */
export declare const MSG_NO_MODEL = "\u672A\u914D\u7F6E advisor \u5BA1\u67E5\u6A21\u578B\u2014\u2014\u5728\u8BBE\u7F6E \u2192 \u63D2\u4EF6\u91CC\u9009\u62E9\u4E00\u4E2A\u5BA1\u67E5\u6A21\u578B\uFF08\u6216 /advisor \u67E5\u770B\u53EF\u7528\u8DEF\u7531\uFF09\u3002";
export declare const MSG_NO_AGENT_SCOPE = "advisor \u65E0\u6CD5\u8BBF\u95EE\u5F53\u524D\u4F1A\u8BDD\uFF08\u672A\u62FF\u5230 agent \u4E0A\u4E0B\u6587\uFF09\u2014\u2014\u8BF7\u4ECE\u4F1A\u8BDD\u5185\u8C03\u7528\u3002";
