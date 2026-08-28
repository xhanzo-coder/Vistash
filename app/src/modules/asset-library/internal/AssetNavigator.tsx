import type { ReactNode } from "react";

import type { FolderFilter } from "../../../shared/types";
import { Button } from "../../../ui/button/Button";
import styles from "./AssetLibraryWorkspace.module.css";

type TagUsage = { tag: string; count: number };

/** 左栏读写本模块查询轴的最小集合；text/view 等其余布局字段由上层持有。 */
export type NavigatorScope = {
  tags: readonly string[];
  folder: FolderFilter;
  favorite: boolean | null;
  location: "active" | "trash";
};

type NavigatorProps = {
  /** 快照给出的全部逻辑文件夹路径；展示为按段缩进的树。 */
  folders: readonly string[];
  tagUsage: readonly TagUsage[];
  trashCount: number;
  scope: NavigatorScope;
  onChange: (patch: Partial<NavigatorScope>) => void;
  dropTarget: string | null | undefined;
  presentation: "sidebar" | "dialog";
};

const ALL_ASSETS_PATCH = { folder: { kind: "all" } as const, location: "active" as const };

function leafSegment(path: string): string {
  return path.split("/").at(-1) ?? path;
}

/**
 * 左侧档案导航：浏览作用域（全部图片/收藏/未分类/回收站）、文件夹树与标签
 * 筛选面板。它是现场的镜子——恢复出的查询轴由入口选中态呈现；全部动作都经
 * 上层的统一偏好通道，因此筛选变化会写回当前库。
 *
 * 轴语义：收藏独立于其他条件；「回收站」只切换位置（后端在回收站查询里忽略
 * 正常文件夹条件）；文件夹树、「全部图片」与「未分类」都意味着回到正常集合，
 * 因此同时把 location 拉回 active。重复点击同一文件夹是幂等的选择而非反选。
 */
export function AssetNavigator({ folders, tagUsage, trashCount, scope, onChange, dropTarget, presentation }: NavigatorProps): ReactNode {
  // 排序保证父路径先于后代出现；先复制副本再就地排序（与 assetSort 相同写法）。
  const sortedFolders: string[] = [...folders];
  sortedFolders.sort((left, right) => left.localeCompare(right, "zh-Hans-CN"));
  const sortedTags: TagUsage[] = [...tagUsage];
  sortedTags.sort((left, right) => left.tag.localeCompare(right.tag, "zh-Hans-CN"));
  const browsingActive = scope.location === "active";
  const favoritesCurrent = scope.favorite === true;

  return (
    <aside className={presentation === "sidebar" ? styles.navigationRail : styles.dialogNavigator}>
      <nav aria-label="图片导航" className={styles.navigator}>
        <div className={styles.navGroup}>
          <Button size="compact" className={styles.navEntry}
            aria-current={browsingActive && scope.folder.kind === "all" ? "true" : undefined}
            onClick={() => onChange(ALL_ASSETS_PATCH)}>
            全部图片
          </Button>
          <Button size="compact" className={styles.navEntry} aria-current={favoritesCurrent ? "true" : undefined}
            onClick={() => onChange({ favorite: !favoritesCurrent })}>
            收藏
          </Button>
          <Button size="compact" className={styles.navEntry}
            data-folder-drop="" data-drop-target={dropTarget === null ? "true" : undefined}
            aria-current={browsingActive && scope.folder.kind === "root" ? "true" : undefined}
            onClick={() => onChange({ folder: { kind: "root" }, location: "active" })}>
            未分类
          </Button>
          <div className={styles.entryRow}>
            <Button size="compact" className={styles.navEntry}
              aria-current={!browsingActive ? "true" : undefined}
              onClick={() => onChange({ location: "trash" })}>
              回收站
            </Button>
            {trashCount > 0 ? <span className={styles.trashBadge}>{trashCount}</span> : null}
          </div>
        </div>
        {sortedFolders.length > 0 ? (
          <div className={styles.tree}>
            {sortedFolders.map((path) => {
              const depth = path.split("/").length - 1;
              const current = browsingActive && scope.folder.kind === "path" && scope.folder.path === path;
              return (
                <Button key={path} size="compact" className={styles.navEntry}
                  data-folder={path}
                  data-folder-drop={path} data-drop-target={dropTarget === path ? "true" : undefined}
                  style={{ paddingInlineStart: `${(depth + 1) * 0.75}em` }}
                  aria-current={current ? "true" : undefined}
                  onClick={() => onChange({ folder: { kind: "path", path }, location: "active" })}>
                  {leafSegment(path)}
                </Button>
              );
            })}
          </div>
        ) : null}
      </nav>
      {tagUsage.length > 0 ? (
        <div role="group" aria-label="标签筛选" className={styles.tagPanel}>
          {sortedTags.map(({ tag, count }) => {
              const pressed = scope.tags.includes(tag);
              return (
                <Button key={tag} size="compact" data-tag={tag} aria-pressed={pressed}
                  onClick={() =>
                    onChange({
                      tags: pressed
                        ? scope.tags.filter((name) => name !== tag)
                        : [...scope.tags, tag],
                    })
                  }>
                  {tag}
                  <span className={styles.tagCount}>{count}</span>
                </Button>
              );
            })}
        </div>
      ) : null}
    </aside>
  );
}
