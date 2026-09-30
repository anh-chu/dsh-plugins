/**
 * store —— 极简快照存储（结构兼容渲染器的 HostObservable：
 * { getSnapshot, subscribe }），避免对官方 client-store 的值导入，
 * 让外部 client 插件保持零运行时外部依赖。
 */
export interface SnapshotStore<T> {
    getSnapshot(): T;
    subscribe(fn: () => void): () => void;
    set(value: T): void;
}
export declare function createSnapshotStore<T>(initial: T): SnapshotStore<T>;
