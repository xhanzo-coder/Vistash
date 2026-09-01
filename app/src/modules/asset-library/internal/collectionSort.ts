import type { AssetRow } from "../../../shared/types";
import type { CollectionSort } from "./preferences";

/**
 * 界面内排序：同一份快照在瀑布流与详情列表间保持共同序列。
 *
 * 后端基线顺序即规格要求的导入时间倒序＋哈希决胜（imported-desc），此时直接
 * 透传；其余选项在副本上重排并保留哈希作为稳定决胜字段。绝不原地修改集合
 * 缓存里的行数组。
 */
/** 哈希是所有排序选项共用的稳定决胜字段（规格与后端基线一致）。 */
function byHash(left: AssetRow, right: AssetRow): number {
  return left.hash.localeCompare(right.hash);
}

export function sortAssets(assets: readonly AssetRow[], sort: CollectionSort): readonly AssetRow[] {
  const copy = [...assets];
  switch (sort) {
    // 后端基线同样是导入时间倒序＋哈希决胜；这里统一在界面内归一，保证无论
    // 数据来源顺序如何，两种视图与三个选项呈现同一确定序列。
    case "imported-desc":
      copy.sort(
        (left, right) =>
          right.imported_at.localeCompare(left.imported_at) || byHash(left, right),
      );
      break;
    case "name-asc":
      copy.sort(
        (left, right) =>
          left.display_filename.localeCompare(right.display_filename, "zh-Hans-CN") || byHash(left, right),
      );
      break;
    case "size-desc":
      copy.sort((left, right) => right.byte_size - left.byte_size || byHash(left, right));
      break;
  }
  return copy;
}
