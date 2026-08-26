/**
 * `prompt-library` 模块的唯一公共出口（任务 6.4，设计第二条）。
 *
 * 本模块承载提示词工作区；现有实现随阶段 11 的切换迁入，在此之前保持现状
 * 行为与一级入口（任务 11.1）。其他模块与应用外壳只允许从本文件导入，
 * `internal/` 是实现细节——结构检查 `scripts/module-boundaries.lib.mjs`
 * 强制这一契约。这里先行冻结与图片模块对称的组合属性形状。
 */

import type { OpenLibrarySession } from "../library-lifecycle";

/** 提示词工作区的组合属性：由应用外壳持有会话与一级导航状态后下发。 */
export type PromptLibraryWorkspaceProps = {
  session: OpenLibrarySession;
  /** 是否为当前激活的一级工作区；非激活时模块挂起交互但保留现场。 */
  active: boolean;
};
