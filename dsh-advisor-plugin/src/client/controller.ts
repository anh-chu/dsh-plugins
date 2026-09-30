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

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { createSnapshotStore, type SnapshotStore } from './store.js'

/**
 * 设置作用域的结构化契约（本地声明，跨 dsh 版本无关——rc.6/0.1.1 的类型
 * 宿主在 dsh-client-runtime，0.1.2 在 dsh-client-ui-settings，追版本不如
 * 只声明自己用到的面）。bind 边界做一次收窄。
 */
export interface AdvisorSettingsScope<T> {
  getSnapshot(): { status: 'loading' | 'ready' | 'unavailable', value: T | undefined, writable: boolean }
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
}

/** 模型目录的一行（llm.models wire schema 的结构子集） */
export interface CatalogModel {
  id: string
  name: string
  /** 该模型声明的推理档位；null/缺省 = 未声明（配置时不过滤，靠 host 自动降级兜底） */
  reasoning?: { efforts: readonly { id: string, name: string }[] | null } | null
}

export interface CatalogGroup {
  id: string
  name: string
  models: readonly CatalogModel[]
}

interface ModelCatalogResponse {
  groups: CatalogGroup[]
  failures: readonly { id: string }[]
}

/** connection 服务的 llm 面结构收窄（唯一边界） */
interface ConnectionLlApi {
  llm: {
    models: (payload: Record<string, never>, signal?: AbortSignal) => Promise<
      | { result: { ok: true, value: ModelCatalogResponse } }
      | { result: { ok: false } }
    >
  }
}

/** 一条精确的 provider/model 路由 + 档位 */
export interface AdvisorRoute {
  provider: string
  model: string
  effort: string
}

/** 卡片暂存的完整段值（路由 + 档位 + 巡逻设置） */
type SectionDraft = Required<AdvisorSection>

/** 目录里的一行（含与生效路由的 join 结果） */
export interface AdvisorCandidate {
  key: string
  provider: string
  model: string
  providerName: string
  modelName: string
  available: boolean
  selected: boolean
  /** 该模型支持的推理档位（从目录 reasoning 声明提取）；undefined = 未声明 */
  effortLevels?: readonly string[]
}

export interface AdvisorCardState {
  /** 设置命名空间就绪 */
  available: boolean
  writable: boolean
  saving: boolean
  failed: boolean
  dirty: boolean
  catalogStatus: 'idle' | 'loading' | 'ready' | 'error'
  catalogPartial: boolean
  /** 总开关的生效值（draft 优先） */
  enabled: boolean
  /** 生效值（draft 优先，其次已保存值） */
  effective: AdvisorRoute
  /** 巡逻模式的生效值（同 draft 优先） */
  patrol: { enabled: boolean, everySteps: number, immuneTurns: number, investigate: boolean }
  /** 当前路由的推理档位支持面（目录声明） */
  efforts: { known: boolean, levels: readonly string[] }
  groups: readonly { id: string, name: string, candidates: readonly AdvisorCandidate[] }[]
}

export interface AdvisorCardFace {
  hooks: { advisorCard: SnapshotStore<AdvisorCardState> }
  pickRoute: (key: string) => void
  toggleEnabled: () => void
  setEffort: (effort: string) => void
  togglePatrol: () => void
  setPatrolEverySteps: (steps: number) => void
  setPatrolImmuneTurns: (n: number) => void
  toggleInvestigate: () => void
  save: () => void
  discard: () => void
  retryCatalog: () => void
}

function routeKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`
}

/** 目录 + 生效路由 → 分组候选行（纯函数；已保存但目录外路由以不可用行展示） */
export function buildCandidates(
  groups: readonly CatalogGroup[],
  effective: AdvisorRoute,
): { groups: { id: string, name: string, candidates: AdvisorCandidate[] }[], stale: boolean } {
  const selectedKey = effective.provider === '' || effective.model === '' ? undefined : routeKey(effective.provider, effective.model)
  const seen = new Set<string>()
  const out = groups.map(group => ({
    id: group.id,
    name: group.name,
    candidates: group.models.map(model => {
      const key = routeKey(group.id, model.id)
      seen.add(key)
      const declared = model.reasoning?.efforts
      return {
        key,
        provider: group.id,
        model: model.id,
        providerName: group.name,
        modelName: model.name,
        available: true,
        selected: key === selectedKey,
        ...(declared === undefined || declared === null ? {} : { effortLevels: declared.map(e => e.id) }),
      }
    }),
  }))
  let stale = false
  // 已保存但目录中不存在的路由：以"不可用"行展示，保证用户能取消选择
  if (selectedKey !== undefined && !seen.has(selectedKey)) {
    stale = true
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
    })
  }
  return { groups: out, stale }
}

/** 当前生效路由的档位支持面（纯函数）：known=false 表示目录未声明，不做过滤 */
export function currentEffortSupport(
  groups: readonly CatalogGroup[],
  route: AdvisorRoute,
): { known: boolean, levels: readonly string[] } {
  if (route.provider === '' || route.model === '') return { known: false, levels: [] }
  const declared = groups
    .find(g => g.id === route.provider)
    ?.models.find(m => m.id === route.model)
    ?.reasoning?.efforts
  if (declared === undefined || declared === null) return { known: false, levels: [] }
  return { known: true, levels: declared.map(e => e.id) }
}

export interface AdvisorSection {
  enabled?: boolean
  provider?: string
  model?: string
  effort?: string
  patrolEnabled?: boolean
  patrolEverySteps?: number
  patrolImmuneTurns?: number
  investigate?: boolean
}

export class AdvisorCardController {
  private catalogGroups: readonly CatalogGroup[] = []
  private catalogStatus: AdvisorCardState['catalogStatus'] = 'idle'
  private catalogPartial = false
  private draft: SectionDraft | undefined
  private saving = false
  private failed = false
  private disposed = false
  private catalogGeneration = 0
  private readonly store: SnapshotStore<AdvisorCardState>
  private readonly unsubscribe: () => void

  constructor(
    private readonly scope: AdvisorSettingsScope<AdvisorSection>,
    private readonly ctx: ClientContext,
  ) {
    this.store = createSnapshotStore<AdvisorCardState>(this.projection())
    this.unsubscribe = scope.subscribe(() => {
      if (!this.saving) this.publish()
    })
    if (this.catalogStatus === 'idle') void this.loadCatalog()
  }

  dispose(): void {
    this.disposed = true
    this.catalogGeneration += 1
    this.unsubscribe()
  }

  inject(): AdvisorCardFace {
    return {
      hooks: { advisorCard: this.store },
      pickRoute: (key) => this.pickRoute(key),
      toggleEnabled: () => this.toggleEnabled(),
      setEffort: (effort) => this.setEffort(effort),
      togglePatrol: () => this.togglePatrol(),
      setPatrolEverySteps: (steps) => this.setPatrolEverySteps(steps),
      setPatrolImmuneTurns: (n) => this.setPatrolImmuneTurns(n),
      toggleInvestigate: () => this.toggleInvestigate(),
      save: () => { void this.save() },
      discard: () => this.discard(),
      retryCatalog: () => { void this.loadCatalog() },
    }
  }

  private saved(): SectionDraft {
    const value = this.scope.getSnapshot().value
    return {
      enabled: value?.enabled ?? true,
      provider: value?.provider ?? '',
      model: value?.model ?? '',
      effort: value?.effort ?? '',
      patrolEnabled: value?.patrolEnabled ?? true,
      patrolEverySteps: value?.patrolEverySteps ?? 6,
      patrolImmuneTurns: value?.patrolImmuneTurns ?? 3,
      investigate: value?.investigate ?? true,
    }
  }

  private savedPatrol(): { enabled: boolean, everySteps: number } {
    const saved = this.saved()
    return { enabled: saved.patrolEnabled !== false, everySteps: saved.patrolEverySteps ?? 6 }
  }

  private effective(): SectionDraft {
    return this.draft ?? this.saved()
  }

  private pickRoute(key: string): void {
    if (!this.scope.getSnapshot().writable || this.saving) return
    const all = this.catalogGroups.flatMap(g => g.models.map(m => ({ provider: g.id, model: m.id })))
    const hit = all.find(r => routeKey(r.provider, r.model) === key)
    const base = this.effective()
    const currentKey = base.provider === '' || base.model === '' ? undefined : routeKey(base.provider, base.model)
    // 再次点击已选路由 = 取消选择（advisor 回到未武装态）；目录外 stale 行同理
    if (currentKey === key) {
      this.draft = { ...base, provider: '', model: '' }
    } else if (hit !== undefined) {
      let draft: SectionDraft = { ...base, provider: hit.provider, model: hit.model }
      // 档位校验：新模型已声明支持面且当前档位不在其中 → 自动清空（走模型默认）
      const support = currentEffortSupport(this.catalogGroups, draft)
      if (support.known && draft.effort !== '' && !support.levels.includes(draft.effort)) {
        console.log(`[dsh-advisor] 档位 ${draft.effort} 不被 ${draft.provider}/${draft.model} 支持，已自动清空`)
        draft = { ...draft, effort: '' }
      }
      this.draft = draft
    }
    this.failed = false
    this.publish()
  }

  private setEffort(effort: string): void {
    if (!this.scope.getSnapshot().writable || this.saving) return
    // 档位校验：已声明支持面时只接受其中的档位
    const support = currentEffortSupport(this.catalogGroups, this.effective())
    if (support.known && effort !== '' && !support.levels.includes(effort)) return
    this.draft = { ...this.effective(), effort }
    this.failed = false
    this.publish()
  }

  private toggleEnabled(): void {
    if (!this.scope.getSnapshot().writable || this.saving) return
    const current = this.effective()
    this.draft = { ...current, enabled: !(current.enabled ?? true) }
    this.failed = false
    this.publish()
  }

  private togglePatrol(): void {
    if (!this.scope.getSnapshot().writable || this.saving) return
    const current = this.effective()
    this.draft = { ...current, patrolEnabled: !(current.patrolEnabled ?? true) }
    this.failed = false
    this.publish()
  }

  private setPatrolEverySteps(steps: number): void {
    if (!this.scope.getSnapshot().writable || this.saving) return
    const bounded = Number.isFinite(steps) ? Math.min(500, Math.max(2, Math.round(steps))) : 6
    this.draft = { ...this.effective(), patrolEverySteps: bounded }
    this.failed = false
    this.publish()
  }

  private setPatrolImmuneTurns(n: number): void {
    if (!this.scope.getSnapshot().writable || this.saving) return
    const bounded = Number.isFinite(n) ? Math.min(20, Math.max(0, Math.round(n))) : 3
    this.draft = { ...this.effective(), patrolImmuneTurns: bounded }
    this.failed = false
    this.publish()
  }

  private toggleInvestigate(): void {
    if (!this.scope.getSnapshot().writable || this.saving) return
    const current = this.effective()
    this.draft = { ...current, investigate: !(current.investigate ?? true) }
    this.failed = false
    this.publish()
  }

  private discard(): void {
    if (this.saving) return
    this.draft = undefined
    this.failed = false
    this.publish()
  }

  private async save(): Promise<void> {
    const desired = this.draft
    if (this.disposed || desired === undefined || this.saving || !this.scope.getSnapshot().writable) return
    this.saving = true
    this.failed = false
    this.publish()
    try {
      // rc.6 scope 是逐字段写：顺序写入（'' / false 也写，保证旧值被清掉）
      await this.scope.set('enabled', desired.enabled ?? true)
      await this.scope.set('provider', desired.provider)
      await this.scope.set('model', desired.model)
      await this.scope.set('effort', desired.effort)
      await this.scope.set('patrolEnabled', desired.patrolEnabled ?? true)
      await this.scope.set('patrolEverySteps', desired.patrolEverySteps ?? 6)
      await this.scope.set('patrolImmuneTurns', desired.patrolImmuneTurns ?? 3)
      await this.scope.set('investigate', desired.investigate ?? true)
      this.draft = undefined
    } catch {
      this.failed = true
    }
    this.saving = false
    this.publish()
  }

  private async loadCatalog(): Promise<void> {
    if (this.disposed || this.catalogStatus === 'loading') return
    const generation = this.catalogGeneration
    this.catalogStatus = 'loading'
    this.catalogPartial = false
    this.publish()
    try {
      const connection = this.ctx.get('connection') as unknown as { api: ConnectionLlApi }
      const response = await connection.api.llm.models({})
      if (generation !== this.catalogGeneration) return
      if (response.result.ok) {
        this.catalogGroups = response.result.value.groups
        this.catalogPartial = response.result.value.failures.length > 0
        this.catalogStatus = 'ready'
      } else {
        this.catalogStatus = 'error'
      }
    } catch {
      if (generation !== this.catalogGeneration) return
      this.catalogStatus = 'error'
    }
    this.publish()
  }

  private projection(): AdvisorCardState {
    const snapshot = this.scope.getSnapshot()
    const effective = this.effective()
    const built = buildCandidates(this.catalogGroups, effective)
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
    }
  }

  private publish(): void {
    this.store.set(this.projection())
  }
}
