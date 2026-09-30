/**
 * AdvisorCard —— 设置页“插件”栏里的 Advisor 卡片（浏览器半）。
 *
 * 交互：总开关 + 可折叠的模型/档位区块与巡逻区块；数据与动作全部由
 * controller 通过 slot inject 面注入；本组件纯渲染，样式内联。
 */
import type { AdvisorCardFace, AdvisorCardState } from './controller.js';
import type { LocaleKey } from './locales.js';
/** 组件收到的 props：face 里的 hooks 被渲染器绑定成 use 选择器 hook */
export type AdvisorCardProps = Omit<AdvisorCardFace, 'hooks'> & {
    useAdvisorCard: <S>(selector: (s: AdvisorCardState) => S) => S;
    t: (key: LocaleKey) => string;
};
export declare function AdvisorCard(props: AdvisorCardProps): import("react").JSX.Element;
