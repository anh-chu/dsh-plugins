/**
 * settings-controller —— 设置卡片的跨版本数据面（浏览器半）。
 *
 * DSH 在 0.1.7 前后同时更换了设置服务与插件页槽位：
 *   - `settingsScope.bind({ namespace: 'advisor' })`（≤ 0.1.6）返回 Host 注册
 *     的命名空间控制器；0.2 已把该服务整个移除。
 *   - `configForms.get('advisor')`（≥ 0.1.7）返回同一命名空间在描述镜像上的
 *     表单：`{ status, value, base, user, revision, writable, mode }`。其中
 *     `value` 就是该命名空间的段值——advisor 的 Config 是平铺的，因此与卡片
 *     期望的 section 形状一致，无需下钻；`set(field, value)` 写段内字段。
 *
 * 键是**设置命名空间**（Host 半 `settings.installSection(ctx, 'advisor', …)`
 * 注册的那个），不是 loader 条目 id（`dsh-advisor-plugin`）。
 *
 * 解析时机：两个服务都可能在 apply 时尚未就绪；而 0.2 的条目契约是
 * "inject 里出现宿主不提供的名字 → 整个 client 半停在 pending（页面报
 * entry did not activate）"。因此这里用"可换入"的作用域：先以不可用态构造
 * 控制器，服务就绪后 attach，由 index.ts 的 ctx.inject([...]) 软等待驱动。
 */
import type { AdvisorSection, AdvisorSettingsScope } from './controller.js';
/** Host 半注册的设置命名空间（`settings.installSection(ctx, 'advisor', …)`） */
export declare const SETTINGS_NAMESPACE = "advisor";
/** 0.1.7+ 的 configForms 单命名空间表单（结构收窄，跨版本无关） */
export interface ConfigFormFace<T> {
    getSnapshot(): {
        status: 'loading' | 'ready' | 'unavailable';
        value: T | undefined;
        writable: boolean;
    };
    subscribe(listener: () => void): () => void;
    /** 段内标量字段写入；true = 宿主接受 */
    set?(field: string, value: unknown): Promise<boolean>;
    /** 原子多字段写入（唯一能触达嵌套字段的面；本命名空间平铺，path 即 [field]） */
    mutate?(ops: readonly {
        op: 'set' | 'unset';
        path: string[];
        value?: unknown;
    }[]): Promise<boolean>;
}
/** 0.1.6 及更早的 settingsScope 服务（结构收窄） */
export interface LegacySettingsScopeFace<T> {
    bind(options: {
        namespace: string;
    }): AdvisorSettingsScope<T>;
}
/**
 * 服务探测面。cordis 里属性访问受调用方 fiber 的 inject 列表门控，只有
 * `get()` 是"读一个未声明服务"的可靠通道——属性访问仅作兜底。
 */
export interface SettingsHostFace {
    get?(name: string): unknown;
    [key: string]: unknown;
}
/** 可换入的作用域：控制器按不可用态构造，真实服务就绪后 attach */
export interface ResolvingScope extends AdvisorSettingsScope<AdvisorSection> {
    /** 接入真实设置源；重复 attach 同一个源为空操作 */
    attach(source: AdvisorSettingsScope<AdvisorSection>): void;
}
/**
 * 建一个先不可用的作用域，服务就绪后 attach。
 *
 * 订阅归这个门面自己持有，attach 时再向真实源订阅并转发通知——这样控制器
 * 的订阅不会因为换源而失效（控制器在构造时就订阅一次）。
 */
export declare function createResolvingScope(): ResolvingScope;
/**
 * 把 configForms 的表单适配成卡片消费的作用域。
 *
 * 投影是恒等的（`value` 已是本命名空间的段值），故直接转发官方快照——
 * 官方保证"stable reference until the next change"，满足 useSyncExternalStore
 * 的按引用比较要求，不需要额外缓存。拒绝的写入抛错，让卡片的既有所存失败
 * 分支（controller.save 的 catch → failed）可见，而不是静默当成成功。
 */
export declare function projectConfigForm(form: ConfigFormFace<AdvisorSection>): AdvisorSettingsScope<AdvisorSection>;
/** 0.1.7+：按设置命名空间取 configForms 表单；不支持时返回 undefined */
export declare function resolveConfigForms(host: SettingsHostFace): AdvisorSettingsScope<AdvisorSection> | undefined;
/** ≤0.1.6：命名空间作用域；服务缺席时返回 undefined */
export declare function resolveLegacySettingsScope(host: SettingsHostFace): AdvisorSettingsScope<AdvisorSection> | undefined;
