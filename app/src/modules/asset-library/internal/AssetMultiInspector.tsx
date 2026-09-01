import type { ReactNode } from "react";
import type { AssetRow } from "../../../shared/types";
import styles from "./AssetMultiInspector.module.css";

/** 只归纳当前选择的轻量记录；不读取逐图详情，也不让活动项代替整组共同值。 */
export function AssetMultiInspector({ assets }: { assets: readonly AssetRow[] }): ReactNode {
  const first = assets[0];
  if (first === undefined || assets.length < 2) throw new Error("多选检查器至少需要两张图片");
  const folders = new Set<string | null>();
  const formats = new Set<string>();
  const dimensions = new Set<string>();
  const tagCounts = new Map<string, number>();
  let favorites = 0;
  for (const asset of assets) {
    folders.add(asset.folder);
    formats.add(asset.ext.toUpperCase());
    dimensions.add(`${asset.width} × ${asset.height}`);
    if (asset.favorite) favorites += 1;
    for (const tag of new Set(asset.tags)) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  }
  const commonTags = [...tagCounts].filter(([, count]) => count === assets.length);
  const mixedTags = [...tagCounts].filter(([, count]) => count < assets.length);
  const trashed = assets.some((asset) => asset.deleted_at !== null);
  return <section className={styles.inspector} aria-label="多选图片信息">
    <header><h2 tabIndex={-1} data-inspector-heading>已选 {assets.length} 张图片</h2></header>
    <section className={styles.section} aria-label="共同值与混合值"><h3>组织摘要</h3><dl>
      <div><dt>所在文件夹</dt><dd>{trashed ? "还原时恢复删除前位置" : folders.size === 1 ? first.folder === null ? "未分类" : first.folder : `混合值（${folders.size} 个位置）`}</dd></div>
      <div><dt>收藏</dt><dd>{favorites === 0 ? "全部未收藏" : favorites === assets.length ? "全部已收藏" : `混合值（${favorites}/${assets.length} 已收藏）`}</dd></div>
      <div><dt>格式</dt><dd>{formats.size === 1 ? first.ext.toUpperCase() : `混合值（${[...formats].join("、")}）`}</dd></div>
      <div><dt>尺寸</dt><dd>{dimensions.size === 1 ? `${first.width} × ${first.height}` : `混合值（${dimensions.size} 种尺寸）`}</dd></div>
    </dl></section>
    <section className={styles.section}><h3>共同标签</h3><div aria-label="共同标签" className={styles.tags}>{commonTags.length === 0 ? <span className={styles.hint}>无共同标签</span> : commonTags.map(([tag]) => <span key={tag}>{tag}</span>)}</div>
      <h3>部分图片标签</h3><div aria-label="部分图片标签" className={styles.tags}>{mixedTags.length === 0 ? <span className={styles.hint}>无混合标签</span> : mixedTags.map(([tag, count]) => <span key={tag}>{tag}（{count}/{assets.length}）</span>)}</div>
    </section>
    {trashed ? <p className={styles.hint}>回收站中的组织信息只读，可从底部操作栏还原。</p> : null}
  </section>;
}
