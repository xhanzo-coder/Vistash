/**
 * 共同/混合检查器摘要。
 *
 * 多选时检查器不逐项罗列组织事实，只呈现交集与分歧：完全一致原样展示；多值字段
 * 存在分歧时标记为混合但仍携带共同子集。图片与提示词的文件夹语义在 v3 下分叉：
 * 图片是单归属——全等（含同为未分类）即共同，否则不一致，没有"部分共同"；提示词
 * 仍可多归属，沿用列表的共同子集。纯计算，不触碰 React 与 IPC。
 */

/** 单个图片素材的组织事实，由视图从轻量行里取出。 */
export type OrgFacts = {
  readonly tags: readonly string[];
  /** 唯一归属；null 即未分类，是合法的共同值而不是缺失。 */
  readonly folder: string | null;
  readonly favorite: boolean;
};

/** 单个提示词的组织事实：文件夹仍是多归属（v3 只收敛了图片侧）。 */
export type PromptOrgFacts = {
  readonly tags: readonly string[];
  readonly folders: readonly string[];
  readonly favorite: boolean;
};

/** 多值字段的摘要：empty 无项可选；common 完全一致；mixed 有分歧但带共同子集。 */
export type CommonList =
  | { kind: "empty" }
  | { kind: "common"; values: string[] }
  | { kind: "mixed"; values: string[] };

/** 单值字段（唯一归属）的摘要。 */
export type CommonFolder =
  | { kind: "empty" }
  | { kind: "common"; value: string | null }
  | { kind: "mixed" };

/** 二值字段（收藏）的摘要。 */
export type CommonFlag =
  | { kind: "empty" }
  | { kind: "common"; value: boolean }
  | { kind: "mixed" };

export type CommonSummary = {
  readonly tags: CommonList;
  readonly folder: CommonFolder;
  readonly favorite: CommonFlag;
};

export type PromptCommonSummary = {
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

function favoriteOf(items: ReadonlyArray<{ readonly favorite: boolean }>): CommonFlag {
  if (items.length === 0) return { kind: "empty" };
  const allFavorite = items.every((item) => item.favorite);
  const noneFavorite = items.every((item) => !item.favorite);
  return allFavorite || noneFavorite
    ? { kind: "common", value: allFavorite }
    : { kind: "mixed" };
}

/** 图片多选摘要（v3 单归属）：文件夹按单值比较。 */
export function summarizeCommon(items: readonly OrgFacts[]): CommonSummary {
  if (items.length === 0) {
    return { tags: { kind: "empty" }, folder: { kind: "empty" }, favorite: { kind: "empty" } };
  }
  // 首项的归属作为基准：数组非空时元素必然存在，undefined 只可能是越界。
  const first = items[0]?.folder;
  return {
    tags: commonOfLists(items.map((item) => item.tags)),
    folder:
      first !== undefined && items.every((item) => item.folder === first)
        ? { kind: "common", value: first }
        : { kind: "mixed" },
    favorite: favoriteOf(items),
  };
}

/** 提示词多选摘要：文件夹沿用多归属的共同子集语义。 */
export function summarizePromptCommon(items: readonly PromptOrgFacts[]): PromptCommonSummary {
  if (items.length === 0) {
    return { tags: { kind: "empty" }, folders: { kind: "empty" }, favorite: { kind: "empty" } };
  }
  return {
    tags: commonOfLists(items.map((item) => item.tags)),
    folders: commonOfLists(items.map((item) => item.folders)),
    favorite: favoriteOf(items),
  };
}
