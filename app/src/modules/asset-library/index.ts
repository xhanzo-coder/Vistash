/**
 * `asset-library` 模块的唯一公共出口（任务 6.4，设计第二条）。
 *
 * 本模块内部拥有查询、选择、文件夹、标签、检查器、灯箱、导入导出、布局偏好、
 * query key、虚拟化与图片 URL 生命周期。其他模块与应用外壳只允许从本文件
 * 导入，`internal/` 是实现细节——结构检查 `scripts/module-boundaries.lib.mjs`
 * 强制这一契约；与 `prompt-library` 的关联变更经权威写入结果与模块级失效事件
 * 协调，不经任何一方内部实现。界面随阶段 8 落地，这里先行冻结组合所需的
 * 类型级接口（设计第二条的公开 interface 形状）。
 */

import type { AssetId, RequestId } from "../../app/common";
import type { AssetLocationScope } from "../../app/navigation";
import type { OpenLibrarySession } from "../library-lifecycle";

/** 应用外壳交给图片工作区的一次性入口：恢复现场，或按哈希定位到活动库/回收站。 */
export type AssetLibraryEntry =
  | { kind: "resume" }
  | { kind: "locate"; requestId: RequestId; hash: AssetId; location: AssetLocationScope };

/** 图片工作区的组合属性：由应用外壳持有会话与一级导航状态后下发。 */
export type AssetLibraryWorkspaceProps = {
  session: OpenLibrarySession;
  /** 是否为当前激活的一级工作区；非激活时模块挂起交互但保留现场。 */
  active: boolean;
  /** 待处理的定位条目；模块消费后按 `requestId` 去重。 */
  entry?: AssetLibraryEntry;
};
