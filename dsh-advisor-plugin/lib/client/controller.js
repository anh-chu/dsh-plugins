/**
 * controller —— Advisor 设置卡片的暂存编辑器（浏览器半）。
 *
 * 数据面（均为 rc.6 客户端服务）：
 *   - 设置：ctx.settingsScope.bind({namespace:'advisor'}) —— 快照/订阅/
 *     set(field, value) 逐字段写入（写的是用户层 ~/.dsh/settings.yaml）
 *   - 模型目录：ctx.get('connection').api.llm.models({}) —— 枚举 DSH 已
 *     配置的全部 provider 与模型，正是"选择 DSH 已经配置好的模型"的数据源
 *
 * 暂存语义：改动先进 draft，save 一次性逐字段写入；discard 丢掉 draft。
 * 类型上不依赖官方 client 包的模块增强（rc 阶段漂移面大），
 * 连接 API 在边界做一次结构化收窄——白皮书第 3/4 章的边界放宽纪律。
 */
import { createSnapshotStore } from './store.js';
function routeKey(provider, model) {
    return `${provider}\u0000${model}`;
}
/** 目录 + 生效路由 → 分组候选行（纯函数；已保存但目录外路由以不可用行展示） */
export function buildCandidates(groups, effective) {
    const selectedKey = effective.provider === '' || effective.model === '' ? undefined : routeKey(effective.provider, effective.model);
    const seen = new Set();
    const out = groups.map(group => ({
        id: group.id,
        name: group.name,
        candidates: group.models.map(model => {
            const key = routeKey(group.id, model.id);
            seen.add(key);
            const declared = model.reasoning?.efforts;
            return {
                key,
                provider: group.id,
                model: model.id,
                providerName: group.name,
                modelName: model.name,
                available: true,
                selected: key === selectedKey,
                ...(declared === undefined || declared === null ? {} : { effortLevels: declared.map(e => e.id) }),
            };
        }),
    }));
    let stale = false;
    // 已保存但目录中不存在的路由：以"不可用"行展示，保证用户能取消选择
    if (selectedKey !== undefined && !seen.has(selectedKey)) {
        stale = true;
        out.push({
            id: effective.provider,
            name: effective.provider,
            candidates: [{
                    key: selectedKey,
                    provider: effective.provider,
                    model: effective.model,
                    providerName: effective.provider,
                    modelName: effective.model,
                    available: false,
                    selected: true,
                }],
        });
    }
    return { groups: out, stale };
}
/** 当前生效路由的档位支持面（纯函数）：known=false 表示目录未声明，不做过滤 */
export function currentEffortSupport(groups, route) {
    if (route.provider === '' || route.model === '')
        return { known: false, levels: [] };
    const declared = groups
        .find(g => g.id === route.provider)
        ?.models.find(m => m.id === route.model)
        ?.reasoning?.efforts;
    if (declared === undefined || declared === null)
        return { known: false, levels: [] };
    return { known: true, levels: declared.map(e => e.id) };
}
export class AdvisorCardController {
    scope;
    ctx;
    catalogGroups = [];
    catalogStatus = 'idle';
    catalogPartial = false;
    draft;
    saving = false;
    failed = false;
    disposed = false;
    catalogGeneration = 0;
    store;
    unsubscribe;
    constructor(scope, ctx) {
        this.scope = scope;
        this.ctx = ctx;
        this.store = createSnapshotStore(this.projection());
        this.unsubscribe = scope.subscribe(() => {
            if (!this.saving)
                this.publish();
        });
        if (this.catalogStatus === 'idle')
            void this.loadCatalog();
    }
    dispose() {
        this.disposed = true;
        this.catalogGeneration += 1;
        this.unsubscribe();
    }
    inject() {
        return {
            hooks: { advisorCard: this.store },
            pickRoute: (key) => this.pickRoute(key),
            toggleEnabled: () => this.toggleEnabled(),
            setEffort: (effort) => this.setEffort(effort),
            togglePatrol: () => this.togglePatrol(),
            setPatrolEverySteps: (steps) => this.setPatrolEverySteps(steps),
            setPatrolImmuneTurns: (n) => this.setPatrolImmuneTurns(n),
            toggleInvestigate: () => this.toggleInvestigate(),
            save: () => { void this.save(); },
            discard: () => this.discard(),
            retryCatalog: () => { void this.loadCatalog(); },
        };
    }
    saved() {
        const value = this.scope.getSnapshot().value;
        return {
            enabled: value?.enabled ?? true,
            provider: value?.provider ?? '',
            model: value?.model ?? '',
            effort: value?.effort ?? '',
            patrolEnabled: value?.patrolEnabled ?? true,
            patrolEverySteps: value?.patrolEverySteps ?? 6,
            patrolImmuneTurns: value?.patrolImmuneTurns ?? 3,
            investigate: value?.investigate ?? true,
        };
    }
    savedPatrol() {
        const saved = this.saved();
        return { enabled: saved.patrolEnabled !== false, everySteps: saved.patrolEverySteps ?? 6 };
    }
    effective() {
        return this.draft ?? this.saved();
    }
    pickRoute(key) {
        if (!this.scope.getSnapshot().writable || this.saving)
            return;
        const all = this.catalogGroups.flatMap(g => g.models.map(m => ({ provider: g.id, model: m.id })));
        const hit = all.find(r => routeKey(r.provider, r.model) === key);
        const base = this.effective();
        const currentKey = base.provider === '' || base.model === '' ? undefined : routeKey(base.provider, base.model);
        // 再次点击已选路由 = 取消选择（advisor 回到未武装态）；目录外 stale 行同理
        if (currentKey === key) {
            this.draft = { ...base, provider: '', model: '' };
        }
        else if (hit !== undefined) {
            let draft = { ...base, provider: hit.provider, model: hit.model };
            // 档位校验：新模型已声明支持面且当前档位不在其中 → 自动清空（走模型默认）
            const support = currentEffortSupport(this.catalogGroups, draft);
            if (support.known && draft.effort !== '' && !support.levels.includes(draft.effort)) {
                console.log(`[dsh-advisor] 档位 ${draft.effort} 不被 ${draft.provider}/${draft.model} 支持，已自动清空`);
                draft = { ...draft, effort: '' };
            }
            this.draft = draft;
        }
        this.failed = false;
        this.publish();
    }
    setEffort(effort) {
        if (!this.scope.getSnapshot().writable || this.saving)
            return;
        // 档位校验：已声明支持面时只接受其中的档位
        const support = currentEffortSupport(this.catalogGroups, this.effective());
        if (support.known && effort !== '' && !support.levels.includes(effort))
            return;
        this.draft = { ...this.effective(), effort };
        this.failed = false;
        this.publish();
    }
    toggleEnabled() {
        if (!this.scope.getSnapshot().writable || this.saving)
            return;
        const current = this.effective();
        this.draft = { ...current, enabled: !(current.enabled ?? true) };
        this.failed = false;
        this.publish();
    }
    togglePatrol() {
        if (!this.scope.getSnapshot().writable || this.saving)
            return;
        const current = this.effective();
        this.draft = { ...current, patrolEnabled: !(current.patrolEnabled ?? true) };
        this.failed = false;
        this.publish();
    }
    setPatrolEverySteps(steps) {
        if (!this.scope.getSnapshot().writable || this.saving)
            return;
        const bounded = Number.isFinite(steps) ? Math.min(500, Math.max(2, Math.round(steps))) : 6;
        this.draft = { ...this.effective(), patrolEverySteps: bounded };
        this.failed = false;
        this.publish();
    }
    setPatrolImmuneTurns(n) {
        if (!this.scope.getSnapshot().writable || this.saving)
            return;
        const bounded = Number.isFinite(n) ? Math.min(20, Math.max(0, Math.round(n))) : 3;
        this.draft = { ...this.effective(), patrolImmuneTurns: bounded };
        this.failed = false;
        this.publish();
    }
    toggleInvestigate() {
        if (!this.scope.getSnapshot().writable || this.saving)
            return;
        const current = this.effective();
        this.draft = { ...current, investigate: !(current.investigate ?? true) };
        this.failed = false;
        this.publish();
    }
    discard() {
        if (this.saving)
            return;
        this.draft = undefined;
        this.failed = false;
        this.publish();
    }
    async save() {
        const desired = this.draft;
        if (this.disposed || desired === undefined || this.saving || !this.scope.getSnapshot().writable)
            return;
        this.saving = true;
        this.failed = false;
        this.publish();
        try {
            // rc.6 scope 是逐字段写：顺序写入（'' / false 也写，保证旧值被清掉）
            await this.scope.set('enabled', desired.enabled ?? true);
            await this.scope.set('provider', desired.provider);
            await this.scope.set('model', desired.model);
            await this.scope.set('effort', desired.effort);
            await this.scope.set('patrolEnabled', desired.patrolEnabled ?? true);
            await this.scope.set('patrolEverySteps', desired.patrolEverySteps ?? 6);
            await this.scope.set('patrolImmuneTurns', desired.patrolImmuneTurns ?? 3);
            await this.scope.set('investigate', desired.investigate ?? true);
            this.draft = undefined;
        }
        catch {
            this.failed = true;
        }
        this.saving = false;
        this.publish();
    }
    async loadCatalog() {
        if (this.disposed || this.catalogStatus === 'loading')
            return;
        const generation = this.catalogGeneration;
        this.catalogStatus = 'loading';
        this.catalogPartial = false;
        this.publish();
        try {
            const connection = this.ctx.get('connection');
            const response = await connection.api.llm.models({});
            if (generation !== this.catalogGeneration)
                return;
            if (response.result.ok) {
                this.catalogGroups = response.result.value.groups;
                this.catalogPartial = response.result.value.failures.length > 0;
                this.catalogStatus = 'ready';
            }
            else {
                this.catalogStatus = 'error';
            }
        }
        catch {
            if (generation !== this.catalogGeneration)
                return;
            this.catalogStatus = 'error';
        }
        this.publish();
    }
    projection() {
        const snapshot = this.scope.getSnapshot();
        const effective = this.effective();
        const built = buildCandidates(this.catalogGroups, effective);
        return {
            available: snapshot.status === 'ready',
            writable: snapshot.writable,
            saving: this.saving,
            failed: this.failed,
            dirty: this.draft !== undefined,
            catalogStatus: this.catalogStatus,
            catalogPartial: this.catalogPartial,
            enabled: effective.enabled ?? true,
            effective,
            patrol: {
                enabled: effective.patrolEnabled ?? true,
                everySteps: effective.patrolEverySteps ?? 6,
                immuneTurns: effective.patrolImmuneTurns ?? 3,
                investigate: effective.investigate ?? true,
            },
            efforts: currentEffortSupport(this.catalogGroups, effective),
            groups: built.groups,
        };
    }
    publish() {
        this.store.set(this.projection());
    }
}
