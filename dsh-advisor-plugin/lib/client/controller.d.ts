/**
 * controller —— Advisor 设置卡片的暂存编辑器（浏览器半）。
 *
 * 数据面（0.2 形态）：
 *   - 设置：configForms 里本插件条目的表单（见 settings-controller.ts）——
 *     快照/订阅/set(field, value) 逐字段写入条目 Config
 *   - 模型目录：ctx.remote.session.modelCatalog() —— 枚举本部署当前可路由的
 *     全部 provider 与模型，正是"选择 DSH 已经配置好的模型"的数据源，
 *     与官方 composer 的模型选择器同源
 *
 * 暂存语义：改动先进 draft，save 一次性逐字段写入；discard 丢掉 draft。
 * 类型上不依赖官方 client 包的模块增强（rc 阶段漂移面大），
 * 两个 Remotes/表单面都在边界做一次结构化收窄——白皮书第 3/4 章的边界放宽纪律。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis';
import { type SnapshotStore } from './store.js';
/**
 * 设置作用域的结构化契约（本地声明，跨 dsh 版本无关——rc.6/0.1.1 的类型
 * 宿主在 dsh-client-runtime，0.1.2 在 dsh-client-ui-settings，追版本不如
 * 只声明自己用到的面）。bind 边界做一次收窄。
 */
export interface AdvisorSettingsScope<T> {
    getSnapshot(): {
        status: 'loading' | 'ready' | 'unavailable';
        value: T | undefined;
        writable: boolean;
    };
    subscribe(listener: () => void): () => void;
    set(field: string, value: unknown): Promise<void>;
}
/** 模型目录的一行（llm.models wire schema 的结构子集） */
export interface CatalogModel {
    id: string;
    name: string;
    /** 该模型声明的推理档位；null/缺省 = 未声明（配置时不过滤，靠 host 自动降级兜底） */
    reasoning?: {
        efforts: readonly {
            id: string;
            name: string;
        }[] | null;
    } | null;
}
export interface CatalogGroup {
    id: string;
    name: string;
    models: readonly CatalogModel[];
}
/** 一条精确的 provider/model 路由 + 档位 */
export interface AdvisorRoute {
    provider: string;
    model: string;
    effort: string;
}
/** 目录里的一行（含与生效路由的 join 结果） */
export interface AdvisorCandidate {
    key: string;
    provider: string;
    model: string;
    providerName: string;
    modelName: string;
    available: boolean;
    selected: boolean;
    /** 该模型支持的推理档位（从目录 reasoning 声明提取）；undefined = 未声明 */
    effortLevels?: readonly string[];
}
export interface AdvisorCardState {
    /** 设置命名空间就绪 */
    available: boolean;
    writable: boolean;
    saving: boolean;
    failed: boolean;
    dirty: boolean;
    catalogStatus: 'idle' | 'loading' | 'ready' | 'error';
    catalogPartial: boolean;
    /** 总开关的生效值（draft 优先） */
    enabled: boolean;
    /** 生效值（draft 优先，其次已保存值） */
    effective: AdvisorRoute;
    /** 巡逻模式的生效值（同 draft 优先） */
    patrol: {
        enabled: boolean;
        everySteps: number;
        immuneTurns: number;
        investigate: boolean;
    };
    /** 当前路由的推理档位支持面（目录声明） */
    efforts: {
        known: boolean;
        levels: readonly string[];
    };
    groups: readonly {
        id: string;
        name: string;
        candidates: readonly AdvisorCandidate[];
    }[];
}
export interface AdvisorCardFace {
    hooks: {
        advisorCard: SnapshotStore<AdvisorCardState>;
    };
    pickRoute: (key: string) => void;
    toggleEnabled: () => void;
    setEffort: (effort: string) => void;
    togglePatrol: () => void;
    setPatrolEverySteps: (steps: number) => void;
    setPatrolImmuneTurns: (n: number) => void;
    toggleInvestigate: () => void;
    save: () => void;
    discard: () => void;
    retryCatalog: () => void;
}
/** 目录 + 生效路由 → 分组候选行（纯函数；已保存但目录外路由以不可用行展示） */
export declare function buildCandidates(groups: readonly CatalogGroup[], effective: AdvisorRoute): {
    groups: {
        id: string;
        name: string;
        candidates: AdvisorCandidate[];
    }[];
    stale: boolean;
};
/** 当前生效路由的档位支持面（纯函数）：known=false 表示目录未声明，不做过滤 */
export declare function currentEffortSupport(groups: readonly CatalogGroup[], route: AdvisorRoute): {
    known: boolean;
    levels: readonly string[];
};
export interface AdvisorSection {
    enabled?: boolean;
    provider?: string;
    model?: string;
    effort?: string;
    patrolEnabled?: boolean;
    patrolEverySteps?: number;
    patrolImmuneTurns?: number;
    investigate?: boolean;
}
export declare class AdvisorCardController {
    private readonly scope;
    private readonly ctx;
    private catalogGroups;
    private catalogStatus;
    private catalogPartial;
    private draft;
    private saving;
    private failed;
    private disposed;
    private catalogGeneration;
    private readonly store;
    private readonly unsubscribe;
    constructor(scope: AdvisorSettingsScope<AdvisorSection>, ctx: ClientContext);
    dispose(): void;
    inject(): AdvisorCardFace;
    private saved;
    private savedPatrol;
    private effective;
    private pickRoute;
    private setEffort;
    private toggleEnabled;
    private togglePatrol;
    private setPatrolEverySteps;
    private setPatrolImmuneTurns;
    private toggleInvestigate;
    private discard;
    private save;
    private loadCatalog;
    private projection;
    private publish;
}
