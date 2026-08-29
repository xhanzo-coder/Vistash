/**
 * 全局搜索的应用级 seam（任务 6.1，设计第三条）。
 *
 * 顶栏搜索框执行一次跨图片与提示词的查询，再把选中结果翻译成一次跨工作区
 * 定位。执行本身复用共享 IPC 的 `global_search` command；这里拥有的是结果的
 * 解释权：一条结果如何变成 [`locateRequestFromSelection`] 给出的定位条目。
 * 图片模块与提示词模块都不需要知道搜索的存在——它们只消费自己的导航条目。
 */

import { createRequestId, parseAssetId } from "./common";
import type { AssetLocationScope, LocateEntry } from "./navigation";
import type { AssetRow, GlobalSearchResult, PromptRow } from "../shared/types";

/** 使用者在全局搜索结果里选中的一项。 */
export type GlobalSearchSelection =
  | { kind: "asset"; row: AssetRow }
  | { kind: "prompt"; row: PromptRow };

/** 从素材侧车推导定位范围：deleted_at 是否有值是活动/回收站的唯一事实来源。 */
export function assetLocationScope(row: AssetRow): AssetLocationScope {
  return row.deleted_at === null ? "active" : "trash";
}

/**
 * 把选中的搜索结果翻译成导航定位条目。
 *
 * requestId 在此处生成并随条目传递：同一次选择无论经过多少层转发，
 * 目标模块看到的都是同一个请求身份。回收站里的图片照常可定位——
 * 范围由侧车事实决定，而不是在这里悄悄改道到活动集合。
 */
export function locateRequestFromSelection(selection: GlobalSearchSelection): LocateEntry {
  const requestId = createRequestId();
  if (selection.kind === "asset") {
    return {
      kind: "locate_asset",
      requestId,
      hash: parseAssetId(selection.row.hash),
      location: assetLocationScope(selection.row),
    };
  }
  return {
    kind: "locate_prompt",
    requestId,
    promptId: selection.row.id,
    location: selection.row.deleted_at === null ? "active" : "trash",
  };
}

/**
 * 全局搜索的执行 interface。生产实现包一层共享 IPC；测试用脚本化假实现。
 *
 * 刻意只有一个方法——防抖、面板开合与键盘导航都是顶栏 UI 的事，
 * 不属于应用级 seam。
 */
export interface GlobalSearch {
  run(text: string): Promise<GlobalSearchResult>;
}
