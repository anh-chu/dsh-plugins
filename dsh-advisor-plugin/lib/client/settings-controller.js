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
/** Host 半注册的旧设置命名空间（≤0.1.6 的 settingsScope 用它寻址） */
export const LEGACY_SETTINGS_NAMESPACE = 'advisor';
/**
 * 0.1.7+ configForms 的寻址键 = **loader 条目 id**，不是旧命名空间。
 *
 * 0.2 的 Host 侧 `describe()` 里是 `ns: entry.options.id`，客户端 `get(entryId)`
 * 的文档也写明 "one Host plugin entry"——设置文档已从"插件自注册命名空间"改为
 * "每个 profile 条目自己的 Config"。本插件的条目 id 由自身 cordis.patch.yml
 * 决定（`- insert: - id: dsh-advisor-plugin`），与包名一致。
 */
export const ENTRY_ID = 'dsh-advisor-plugin';
/** 探测顺序：新键（条目 id）优先，旧命名空间兜底 */
export const SETTINGS_KEYS = [ENTRY_ID, LEGACY_SETTINGS_NAMESPACE];
/** 两个服务都缺席时的快照（卡片按既有 unavailable 分支渲染只读态） */
const UNAVAILABLE_SNAPSHOT = {
    status: 'unavailable',
    value: undefined,
    writable: false,
};
/**
 * 建一个先不可用的作用域，服务就绪后 attach。
 *
 * 订阅归这个门面自己持有，attach 时再向真实源订阅并转发通知——这样控制器
 * 的订阅不会因为换源而失效（控制器在构造时就订阅一次）。
 */
export function createResolvingScope() {
    const listeners = new Set();
    let source;
    let detach;
    const notify = () => {
        for (const listener of [...listeners])
            listener();
    };
    return {
        getSnapshot: () => source?.getSnapshot() ?? UNAVAILABLE_SNAPSHOT,
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        set: (field, value) => source?.set(field, value) ?? Promise.resolve(),
        attach: (next) => {
            if (next === source)
                return;
            detach?.();
            source = next;
            detach = next.subscribe(notify);
            notify();
        },
    };
}
/**
 * 把 configForms 的表单适配成卡片消费的作用域。
 *
 * 投影是恒等的（`value` 已是本命名空间的段值），故直接转发官方快照——
 * 官方保证"stable reference until the next change"，满足 useSyncExternalStore
 * 的按引用比较要求，不需要额外缓存。拒绝的写入抛错，让卡片的既有所存失败
 * 分支（controller.save 的 catch → failed）可见，而不是静默当成成功。
 */
export function projectConfigForm(form) {
    const write = async (field, value) => {
        if (typeof form.mutate === 'function') {
            const accepted = await form.mutate([{ op: 'set', path: [field], value }]);
            if (!accepted)
                throw new Error(`设置写入被宿主拒绝：${field}`);
            return;
        }
        if (typeof form.set === 'function') {
            const accepted = await form.set(field, value);
            if (!accepted)
                throw new Error(`设置写入被宿主拒绝：${field}`);
            return;
        }
        throw new Error('设置表单既无 set 也无 mutate，无法写入');
    };
    return {
        getSnapshot: () => form.getSnapshot(),
        subscribe: (listener) => form.subscribe(listener),
        set: (field, value) => write(field, value),
    };
}
function readService(host, name) {
    try {
        if (typeof host.get === 'function') {
            const viaGet = host.get(name);
            if (viaGet !== undefined)
                return viaGet;
        }
    }
    catch {
        // get() 对未知服务可能抛错——继续走属性访问兜底
    }
    return host[name];
}
/**
 * 0.1.7+：取本插件条目的 configForms 表单；服务缺席时返回 undefined。
 *
 * `get(entryId)` 对任何键都会现场造一个表单，所以"存在"不代表"被服务"——
 * 判断依据是快照的 status：`unavailable` = 该命名空间没被 Host 提供。
 * 因此按 SETTINGS_KEYS 顺序探测，谁被服务就用谁（首帧多为 loading，算命中），
 * 全都没被服务时退回第一个，卡片照旧渲染只读不可用态。
 */
export function resolveConfigForms(host, keys = SETTINGS_KEYS) {
    try {
        const service = readService(host, 'configForms');
        if (service === undefined || service === null || typeof service.get !== 'function')
            return undefined;
        let fallback;
        for (const key of keys) {
            const form = service.get(key);
            if (form === undefined || form === null)
                continue;
            if (typeof form.getSnapshot !== 'function' || typeof form.subscribe !== 'function')
                continue;
            fallback ??= form;
            const status = form.getSnapshot().status;
            if (status !== 'unavailable')
                return projectConfigForm(form);
        }
        return fallback === undefined ? undefined : projectConfigForm(fallback);
    }
    catch (error) {
        console.warn('[dsh-advisor] configForms 设置源解析失败（卡片将显示为不可用）：', error);
        return undefined;
    }
}
/** ≤0.1.6：命名空间作用域；服务缺席时返回 undefined */
export function resolveLegacySettingsScope(host) {
    try {
        const service = readService(host, 'settingsScope');
        if (service === undefined || service === null || typeof service.bind !== 'function')
            return undefined;
        return service.bind({ namespace: LEGACY_SETTINGS_NAMESPACE });
    }
    catch (error) {
        console.warn('[dsh-advisor] settingsScope 设置源解析失败（卡片将显示为不可用）：', error);
        return undefined;
    }
}
