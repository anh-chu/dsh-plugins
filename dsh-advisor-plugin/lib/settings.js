/**
 * settings —— 把 'advisor' 命名空间接入 settings 服务（用户层 =
 * ~/.dsh/settings.yaml 的 advisor: 段；设置页卡片写的也是这一层）。
 *
 * 双路径兼容（rc.6 与更新版本宿主）：
 *   - installSection（较新宿主）：带 setSource/onChange 钩子的注册面
 *   - settings.register（rc.6）：scope.get() 初读 + scope.watch() 活编辑
 */
import { Config as ConfigSchema, resolveSelection } from './config.js';
export function wireSettings(ctx, state, onConfigChange) {
    const settings = ctx.get('settings');
    if (settings === undefined) {
        return { info: 'settings 服务不可用——advisor 配置固定为插件组合层' };
    }
    if (typeof settings.installSection === 'function') {
        // 较新宿主：setSource 把"当前值来源"交给设置服务接管
        let source = () => state.config;
        settings.installSection(ctx, 'advisor', ConfigSchema, state.config, {
            setSource: (next) => {
                source = next;
            },
            onChange: () => {
                state.config = source();
                state.selection = resolveSelection(state.config);
                onConfigChange();
            },
        });
        return { info: 'settings.installSection 已接入（advisor 命名空间可在设置页编辑）' };
    }
    if (typeof settings.register === 'function') {
        // rc.6 宿主：scope.get() 读合成值（schema 默认 → base → 用户层），watch 活编辑
        try {
            const scope = settings.register('advisor', ConfigSchema, { base: state.config });
            const resolved = scope.get();
            state.selection = resolveSelection(resolved);
            state.config = resolved;
            onConfigChange();
            scope.watch(next => {
                state.config = next;
                state.selection = resolveSelection(next);
                onConfigChange();
            });
            return { info: `settings.register 已接入（advisor 命名空间，用户层在 ~/.dsh/settings.yaml）` };
        }
        catch (error) {
            return { info: `settings.register 失败：${error instanceof Error ? error.message : String(error)}` };
        }
    }
    // 0.2：设置文档改为"每个 profile 条目自己的 Config"，两个命名空间注册面
    // （installSection / register）都不再存在。Config 仍由 loader 从条目 config
    // 交给 apply()，所以配置照常生效——由设置页的 Advisor 卡片（configForms）
    // 或直接编辑 profile 的 cordis.patch.yml 条目 config 写入。
    return { info: '宿主无命名空间注册面（0.2 形态）：配置来自 profile 条目 config，可在 设置 → 插件 → Advisor 卡片修改' };
}
