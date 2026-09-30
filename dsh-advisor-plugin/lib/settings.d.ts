/**
 * settings —— 把 'advisor' 命名空间接入 settings 服务（用户层 =
 * ~/.dsh/settings.yaml 的 advisor: 段；设置页卡片写的也是这一层）。
 *
 * 双路径兼容（rc.6 与更新版本宿主）：
 *   - installSection（较新宿主）：带 setSource/onChange 钩子的注册面
 *   - settings.register（rc.6）：scope.get() 初读 + scope.watch() 活编辑
 */
import type { Context } from '@deepseek-ai/cordis';
import { type Config, type Selection } from './config.js';
export interface SettingsWiring {
    /** 设置服务状态描述（进 /advisor 命令输出与日志） */
    info: string;
}
export declare function wireSettings(ctx: Context, state: {
    config: Config;
    selection: Selection | undefined;
}, onConfigChange: () => void): SettingsWiring;
