/**
 * `library-lifecycle` 模块的唯一公共出口（任务 6.4，设计第二条）。
 *
 * 本模块拥有欢迎、开库、损坏/版本失败、迁移计划、冲突处理与切库；只有通过
 * 兼容性门禁后才产生 [`OpenLibrarySession`]。其他模块与应用外壳只允许从本
 * 文件导入，`internal/` 是实现细节、不属于可依赖的 interface——结构检查
 * `scripts/module-boundaries.lib.mjs` 强制这一契约。界面随阶段 7.5 落地。
 */

import { createElement, type ReactNode } from "react";

import type { LibraryId } from "../../app/common";
import type {
  LibraryStatus,
  MigrationProgress,
  V3FolderResolutionInput,
  V3MigrationPlan,
} from "../../shared/types";
import { LibraryLifecycle as LibraryLifecycleInternal } from "./internal/LibraryLifecycle";
import { createTauriLibraryLifecyclePort } from "./internal/portTauri";

/** 一次通过兼容性门禁的打开库会话：后续两个工作区都由它驱动。 */
export type OpenLibrarySession = {
  /** 库实例标识，来自后端；同一进程内切换库会产生新的会话。 */
  id: LibraryId;
  /** 界面呈现用的库名（目录名），不承担身份职责。 */
  displayName: string;
};

export type OpenLibraryContext = {
  session: OpenLibrarySession;
  path: string;
  formatVersion: number;
};

/** 已通过开库门禁的工作现场可请求的生命周期动作。 */
export type LibraryLifecycleControls = {
  openOtherLibrary: () => void;
};

export type LibraryPickerPurpose = "create" | "open" | "relocate";

/** 库生命周期依赖的窄 port；生产与测试 adapter 都只在此边界交换 DTO。 */
export type LibraryLifecyclePort = {
  status: () => Promise<LibraryStatus>;
  pickLibraryDirectory: (purpose: LibraryPickerPurpose) => Promise<string | null>;
  open: (path: string) => Promise<LibraryStatus>;
  migrateLegacy: (
    path: string,
    onProgress: (progress: MigrationProgress) => void,
  ) => Promise<LibraryStatus>;
  planV3: (path: string) => Promise<V3MigrationPlan>;
  commitV3: (
    path: string,
    resolutions: V3FolderResolutionInput[],
    onProgress: (progress: MigrationProgress) => void,
  ) => Promise<LibraryStatus>;
};

export function LibraryLifecycle({
  children,
  port,
}: {
  port: LibraryLifecyclePort;
  children: (context: OpenLibraryContext, controls: LibraryLifecycleControls) => ReactNode;
}): ReactNode {
  // oxlint-disable-next-line react/no-children-prop -- 这里的 children 是显式 render prop，不是可渲染 ReactNode；index.ts 不能使用 JSX。
  return createElement(LibraryLifecycleInternal, { port, children });
}

export { createTauriLibraryLifecyclePort };
