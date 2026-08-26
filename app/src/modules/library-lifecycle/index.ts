/**
 * `library-lifecycle` 模块的唯一公共出口（任务 6.4，设计第二条）。
 *
 * 本模块拥有欢迎、开库、损坏/版本失败、迁移计划、冲突处理与切库；只有通过
 * 兼容性门禁后才产生 [`OpenLibrarySession`]。其他模块与应用外壳只允许从本
 * 文件导入，`internal/` 是实现细节、不属于可依赖的 interface——结构检查
 * `scripts/module-boundaries.lib.mjs` 强制这一契约。界面随阶段 7.5 落地。
 */

/** 一次通过兼容性门禁的打开库会话：后续两个工作区都由它驱动。 */
export type OpenLibrarySession = {
  /** 库实例标识，来自后端；同一进程内切换库会产生新的会话。 */
  id: string;
  /** 界面呈现用的库名（目录名），不承担身份职责。 */
  displayName: string;
};
