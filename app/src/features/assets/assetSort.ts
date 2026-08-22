/**
 * 详情列表信息列排序（任务 9.2）。
 *
 * 纯计算：对当前查询的结果集做客户端稳定排序。瀑布流与详情列表消费同一个
 * 排序值（规格要求两视图共用同一排序），排序状态由 AssetWorkspace 持有，
 * 不进布局偏好——设计第 8.3 条定义的持久化形状只有视图/筛选/滚动，没有排序列。
 */

import type { AssetRow } from "../../shared/types";

/** 可排序列：多值列（文件夹、标签、备注）不参与排序。 */
export type AssetSortColumn = "filename" | "dimensions" | "format" | "importedAt";

export type AssetSort = {
  readonly column: AssetSortColumn;
  readonly direction: "asc" | "desc";
};

/** 默认最新导入在前，与后端查询结果的既有顺序一致。 */
export const DEFAULT_SORT: Readonly<AssetSort> = { column: "importedAt", direction: "desc" };

function compareByColumn(a: AssetRow, b: AssetRow, column: AssetSortColumn): number {
  switch (column) {
    case "filename":
      return a.original_filename.localeCompare(b.original_filename, "zh");
    case "dimensions": {
      const areaA = a.width * a.height;
      const areaB = b.width * b.height;
      // 同面积时宽度大者视为"更宽"，避免完全相同时的比较抖动。
      return areaA - areaB || a.width - b.width;
    }
    case "format":
      return a.media_type.localeCompare(b.media_type);
    case "importedAt":
      return a.imported_at.localeCompare(b.imported_at);
    default: {
      const unhandled: never = column;
      throw new Error(`未知的排序列：${String(unhandled)}`);
    }
  }
}

/** 返回稳定排序后的新数组；输入不被修改，空结果原样返回空数组。 */
export function sortAssets(
  assets: readonly AssetRow[],
  sort: AssetSort,
): readonly AssetRow[] {
  const copy = [...assets];
  copy.sort((a, b) => (sort.direction === "asc" ? 1 : -1) * compareByColumn(a, b, sort.column));
  return copy;
}
