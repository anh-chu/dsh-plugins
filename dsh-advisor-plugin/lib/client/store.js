/**
 * store —— 极简快照存储（结构兼容渲染器的 HostObservable：
 * { getSnapshot, subscribe }），避免对官方 client-store 的值导入，
 * 让外部 client 插件保持零运行时外部依赖。
 */
export function createSnapshotStore(initial) {
    let current = initial;
    const listeners = new Set();
    return {
        getSnapshot: () => current,
        subscribe: (fn) => {
            listeners.add(fn);
            return () => {
                listeners.delete(fn);
            };
        },
        set: (value) => {
            current = value;
            for (const fn of listeners)
                fn();
        },
    };
}
