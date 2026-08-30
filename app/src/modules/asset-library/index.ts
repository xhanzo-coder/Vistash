/**
 * `asset-library` 模块的唯一公共出口（任务 6.4，设计第二条）。
 *
 * 本模块内部拥有查询、选择、文件夹、标签、检查器、灯箱、导入导出、布局偏好、
 * query key、虚拟化与图片 URL 生命周期。其他模块与应用外壳只允许从本文件
 * 导入，`internal/` 是实现细节——结构检查 `scripts/module-boundaries.lib.mjs`
 * 强制这一契约；与 `prompt-library` 的关联变更经权威写入结果与模块级失效事件
 * 协调，不经任何一方内部实现。会话切片已由任务 8.2 实现，后续能力仍通过
 * 这一个 interface 接入；生产 App 的统一切换属于任务 11.3。
 */

import type { AssetId, RequestId } from "../../app/common";
import type { AssetLocationScope } from "../../app/navigation";
import type { OpenLibrarySession } from "../library-lifecycle";

export { AssetLibraryWorkspace } from "./internal/AssetLibraryWorkspace";
export {
  canStopTransferTask,
  getTransferTaskStopError,
  stopTransferTask as stopAssetTransferTask,
} from "./internal/AssetTransfer";

/** 应用外壳交给图片工作区的一次性入口：恢复现场，或按哈希定位到活动库/回收站。 */
export type AssetLibraryEntry =
  | { kind: "resume" }
  | { kind: "locate"; requestId: RequestId; hash: AssetId; location: AssetLocationScope };

/** 应用外壳发给图片工作区的一次性入站意图；路径选择仍由图片模块自己的 transfer seam 完成。 */
export type AssetImportRequest = {
  requestId: RequestId;
  kind: "images" | "folder";
};

/**
 * 图片工作区的组合属性：由应用外壳持有会话与一级导航状态后下发。
 * session 必须对应后端当前已通过开库门禁的库；库 ID 是缓存身份，不是 IPC 路由。
 * 切库须先离开旧会话，再由 library-lifecycle 完成打开并下发新会话。
 */
export type AssetLibraryWorkspaceProps = {
  session: OpenLibrarySession;
  /** 是否为当前激活的一级工作区；非激活时模块挂起交互但保留现场。 */
  active: boolean;
  /** 待处理的定位条目；模块消费后按 `requestId` 去重。 */
  entry?: AssetLibraryEntry;
  /** 顶栏导入菜单发来的单次意图；组件消费后通过回调确认，不重复触发。 */
  importRequest?: AssetImportRequest;
  onImportRequestHandled?: (requestId: RequestId) => void;
};
