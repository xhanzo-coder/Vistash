/**
 * 提示词详情列表信息列排序（任务 10.2）。
 *
 * 纯计算：对当前查询的结果集做客户端稳定排序。卡片瀑布流与详情列表消费同一个
 * 排序值（规格要求两视图共用同一排序），排序状态由提示词工作区持有。可排序列
 * 只取单值列：文件夹与标签是多值列，字典序没有稳定的使用者预期；关联图片数与
 * 收藏也不参与——前者是派生计数，后者是二值状态。
 */

import type { PromptRow } from "../../shared/types";
import { promptDisplayTitle } from "./promptDisplay";

/** 可排序列：标题按展示标题（缺省时为正文首行）。 */
export type PromptSortColumn = "title" | "model" | "updatedAt";

export type PromptSort = {
  readonly column: PromptSortColumn;
  readonly direction: "asc" | "desc";
};

/** 默认最近更新在前，与后端查询结果的既有顺序一致。 */
export const DEFAULT_PROMPT_SORT: Readonly<PromptSort> = {
  column: "updatedAt",
  direction: "desc",
};

function compareByColumn(a: PromptRow, b: PromptRow, column: PromptSortColumn): number {
  switch (column) {
    case "title":
      return promptDisplayTitle(a).localeCompare(promptDisplayTitle(b), "zh");
    case "model": {
      const modelA = a.model ?? "";
      const modelB = b.model ?? "";
      // 缺省模型的素材在升序里恒排在有值之后；两侧都缺省时视为相等，
      // 由 Array.prototype.sort 的稳定性保证不打乱原有顺序。
      if (modelA === "" && modelB === "") return 0;
      if (modelA === "") return 1;
      if (modelB === "") return -1;
      return modelA.localeCompare(modelB);
    }
    case "updatedAt":
      return a.updated_at.localeCompare(b.updated_at);
    default: {
      const unhandled: never = column;
      throw new Error(`未知的提示词排序列：${String(unhandled)}`);
    }
  }
}

/** 返回稳定排序后的新数组；输入不被修改，空结果原样返回空数组。 */
export function sortPrompts(
  prompts: readonly PromptRow[],
  sort: PromptSort,
): readonly PromptRow[] {
  const copy = [...prompts];
  copy.sort((a, b) => (sort.direction === "asc" ? 1 : -1) * compareByColumn(a, b, sort.column));
  return copy;
}
