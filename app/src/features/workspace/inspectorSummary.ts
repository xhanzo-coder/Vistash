/**
 * 共同/混合检查器摘要（任务 8.5）。
 *
 * 多选时检查器不逐项罗列组织事实，只呈现交集与分歧：完全一致原样展示；多值字段
 * 存在分歧时标记为混合但仍携带共同子集，UI 据此呈现「人像（混合）」。纯计算，
 * 不触碰 React 与 IPC。
 */

/** 单个素材/提示词的组织事实，由视图从轻量行或详情里取出。 */
export type OrgFacts = {
  readonly tags: readonly string[];
  readonly folders: readonly string[];
  readonly favorite: boolean;
};

/** 多值字段的摘要：empty 无项可选；common 完全一致；mixed 有分歧但带共同子集。 */
export type CommonList =
  | { kind: "empty" }
  | { kind: "common"; values: string[] }
  | { kind: "mixed"; values: string[] };

/** 二值字段（收藏）的摘要。 */
export type CommonFlag =
  | { kind: "empty" }
  | { kind: "common"; value: boolean }
  | { kind: "mixed" };

export type CommonSummary = {
  readonly tags: CommonList;
  readonly folders: CommonList;
  readonly favorite: CommonFlag;
};

/**
 * 多值列表的共同子集：并集中出现在每一份列表里的成员，保持首项出现顺序。
 * 并集与交集一致即完全共同；否则混合——但共同子集照样随结果携带。
 */
function commonOfLists(lists: ReadonlyArray<readonly string[]>): CommonList {
  if (lists.length === 0) return { kind: "empty" };
  const union: string[] = [];
  for (const list of lists) {
    for (const entry of list) {
      if (!union.includes(entry)) union.push(entry);
    }
  }
  const common = union.filter((entry) => lists.every((list) => list.includes(entry)));
  if (common.length === union.length) return { kind: "common", values: common };
  return { kind: "mixed", values: common };
}

export function summarizeCommon(items: readonly OrgFacts[]): CommonSummary {
  if (items.length === 0) {
    return { tags: { kind: "empty" }, folders: { kind: "empty" }, favorite: { kind: "empty" } };
  }
  const favoriteValues = items.map((item) => item.favorite);
  const allFavorite = favoriteValues.every((value) => value);
  const noneFavorite = favoriteValues.every((value) => !value);
  return {
    tags: commonOfLists(items.map((item) => item.tags)),
    folders: commonOfLists(items.map((item) => item.folders)),
    favorite:
      allFavorite || noneFavorite
        ? { kind: "common", value: allFavorite }
        : { kind: "mixed" },
  };
}
