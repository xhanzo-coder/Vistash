import type { ReactNode } from "react";
import { ImagesIcon } from "@phosphor-icons/react/dist/csr/Images";
import { StarIcon } from "@phosphor-icons/react/dist/csr/Star";
import { TrayIcon } from "@phosphor-icons/react/dist/csr/Tray";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
import { SidebarSimpleIcon } from "@phosphor-icons/react/dist/csr/SidebarSimple";

import type { FolderFilter } from "../../../shared/types";
import { Button, IconButton } from "../../../ui/button/Button";
import { Tooltip } from "../../../ui/overlays/Tooltip";
import styles from "./AssetLibraryWorkspace.module.css";
import { FolderTree, type FolderReorderDirection, type FolderTreeAction } from "../../../features/workspace/FolderTree";

type TagUsage = { tag: string; count: number };
export type FolderNodeAction = FolderTreeAction;

/** 左栏读写本模块查询轴的最小集合；text/view 等其余布局字段由上层持有。 */
export type NavigatorScope = {
  text: string;
  tags: readonly string[];
  folder: FolderFilter;
  favorite: boolean | null;
  location: "active" | "trash";
};

type NavigatorProps = {
  folderActions: ReactNode;
  width: number;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** 快照给出的全部逻辑文件夹路径；展示为按段缩进的树。 */
  folders: readonly string[];
  tagUsage: readonly TagUsage[];
  trashCount: number;
  scope: NavigatorScope;
  onChange: (patch: Partial<NavigatorScope>) => void;
  dropTarget: string | null | undefined;
  presentation: "sidebar" | "dialog";
  onFolderAction: (action: FolderNodeAction, path: string) => void;
  folderInteractionDisabled: boolean;
  onFolderMove: (source: string, destinationParent: string | null) => void;
  onFolderReorder: (path: string, direction: FolderReorderDirection) => void;
  folderCreator: { parent: string | null; node: ReactNode } | null;
};

const ALL_ASSETS_PATCH = {
  text: "",
  tags: [] as readonly string[],
  folder: { kind: "all" } as const,
  favorite: null,
  location: "active" as const,
};

/**
 * 左侧档案导航：浏览作用域（全部图片/收藏/未分类/回收站）、文件夹树与标签
 * 筛选面板。它是现场的镜子——恢复出的查询轴由入口选中态呈现；全部动作都经
 * 上层的统一偏好通道，因此筛选变化会写回当前库。
 *
 * 范围语义：全部、收藏、未分类、具体文件夹与回收站彼此互斥，并在进入范围时
 * 清空旧文本与标签。每个范围入口原子写入全部查询轴，避免上一范围静默残留。
 * 重复点击当前范围是幂等选择而非反选。
 */
export function AssetNavigator({ folderActions, width, collapsed, onToggleCollapsed, folders, tagUsage, trashCount, scope, onChange, dropTarget, presentation, onFolderAction, folderInteractionDisabled, onFolderMove, onFolderReorder, folderCreator }: NavigatorProps): ReactNode {
  // 排序保证父路径先于后代出现；先复制副本再就地排序（与 assetSort 相同写法）。
  const sortedTags: TagUsage[] = [...tagUsage];
  // 批量移除最后一个标签后，当前筛选仍须可见、可取消；完整用量中不存在即为零。
  const knownTags = new Set(tagUsage.map(({ tag }) => tag));
  for (const tag of scope.tags) if (!knownTags.has(tag)) sortedTags.push({ tag, count: 0 });
  sortedTags.sort((left, right) => left.tag.localeCompare(right.tag, "zh-Hans-CN"));
  const browsingActive = scope.location === "active";
  const favoritesCurrent = scope.favorite === true;

  return (
    <aside className={presentation === "sidebar" ? styles.navigationRail : styles.dialogNavigator}
      data-collapsed={presentation === "sidebar" && collapsed ? "true" : undefined}
      style={presentation === "sidebar" ? { flexBasis: collapsed ? "3.5rem" : `${width}px` } : undefined}>
      {presentation === "sidebar" ? <div className={styles.panelHeader}>
        <Tooltip content={collapsed ? "展开图片导航" : "收起图片导航"}><IconButton size="compact" label={collapsed ? "展开图片导航" : "收起图片导航"} icon={<SidebarSimpleIcon />} onClick={onToggleCollapsed} /></Tooltip>
      </div> : null}
      <nav aria-label="图片导航" className={styles.navigator}>
        <div className={styles.navGroup}>
          <Button size="compact" variant="ghost" className={styles.navEntry} title="全部图片" startIcon={<ImagesIcon />}
            aria-current={browsingActive && !favoritesCurrent && scope.folder.kind === "all" ? "true" : undefined}
            onClick={() => onChange(ALL_ASSETS_PATCH)}>
            全部图片
          </Button>
          <Button size="compact" variant="ghost" className={styles.navEntry} title="收藏" startIcon={<StarIcon weight={favoritesCurrent ? "fill" : "regular"} />} aria-current={favoritesCurrent ? "true" : undefined}
            onClick={() => onChange({ text: "", tags: [], favorite: true, folder: { kind: "all" }, location: "active" })}>
            收藏
          </Button>
          <Button size="compact" variant="ghost" className={styles.navEntry} title="未分类" startIcon={<TrayIcon />}
            data-folder-drop="" data-drop-target={dropTarget === null ? "true" : undefined}
            aria-current={browsingActive && !favoritesCurrent && scope.folder.kind === "root" ? "true" : undefined}
            onClick={() => onChange({ text: "", tags: [], favorite: null, folder: { kind: "root" }, location: "active" })}>
            未分类
          </Button>
        </div>
        <div className={styles.folderSection}>
          <div className={styles.sectionHeading}><span>文件夹</span><div className={styles.folderActions} role="group" aria-label="文件夹操作">{folderActions}</div></div>
        {folders.length > 0 || folderCreator !== null ? <FolderTree folders={folders}
          currentPath={browsingActive && !favoritesCurrent && scope.folder.kind === "path" ? scope.folder.path : null}
          disabled={folderInteractionDisabled} navEntryClassName={styles.navEntry!} creator={folderCreator} externalDropTarget={dropTarget}
          onSelect={(path) => onChange({ text: "", tags: [], favorite: null, folder: { kind: "path", path }, location: "active" })}
          onMove={onFolderMove} onAction={onFolderAction} onReorder={onFolderReorder} /> : <p className={styles.navigationHint}>还没有文件夹</p>}
        </div>
      {sortedTags.length > 0 ? (
        <div className={styles.tagSection}>
          <div className={styles.sectionHeading}><span>标签</span></div>
        <div role="group" aria-label="标签筛选" className={styles.tagPanel}>
          {sortedTags.map(({ tag, count }) => {
              const pressed = scope.tags.includes(tag);
              return (
                <Button key={tag} size="compact" variant="ghost" data-tag={tag} aria-pressed={pressed}
                  aria-label={`${tag}，${count} 张图片`} title={`${count} 张图片`}
                  onClick={() =>
                    onChange({
                      tags: pressed
                        ? scope.tags.filter((name) => name !== tag)
                        : [...scope.tags, tag],
                    })
                  }>
                  <span className={styles.tagName}>{tag}</span>
                </Button>
              );
            })}
        </div>
        </div>
      ) : null}
        <div className={styles.entryRow}>
          <Button size="compact" variant="ghost" className={styles.navEntry} title="回收站" startIcon={<TrashIcon />}
            aria-current={!browsingActive ? "true" : undefined}
            onClick={() => onChange({ text: "", tags: [], favorite: null, folder: { kind: "all" }, location: "trash" })}>回收站</Button>
          {trashCount > 0 ? <span className={styles.trashBadge}>{trashCount}</span> : null}
        </div>
      </nav>
    </aside>
  );
}
