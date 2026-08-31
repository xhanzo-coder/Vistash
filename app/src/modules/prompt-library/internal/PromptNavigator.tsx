import { useMemo, useState, type ReactNode } from "react";
import { NotePencilIcon } from "@phosphor-icons/react/dist/csr/NotePencil";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { StarIcon } from "@phosphor-icons/react/dist/csr/Star";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
import { TrayIcon } from "@phosphor-icons/react/dist/csr/Tray";

import type { FolderFilter, TagUsage } from "../../../shared/types";
import { Button, IconButton } from "../../../ui/button/Button";
import { Dialog } from "../../../ui/dialog/Dialog";
import { Tooltip } from "../../../ui/overlays/Tooltip";
import { FolderTree, InlineFolderCreatorForm } from "../../../features/workspace/FolderTree";
import { PromptMoveFolderDialog } from "./PromptMoveFolderDialog";
import { folderLeaf, sortFolderPaths } from "../../../features/workspace/folderPath";
import styles from "./PromptWorkspace.module.css";

export type PromptNavigationScope = {
  folder: FolderFilter;
  favoriteOnly: boolean;
  location: "active" | "trash";
  selectedTags: readonly string[];
};

/** 提示词导航与文件夹组织的内部深模块；所有表单草稿和拖动状态都留在这里。 */
export function PromptNavigator({ folders, tags, trashCount, scope, mutating, onSelectFolder, onSelectFavorites, onSelectTrash, onToggleTag, onCreateFolder, onRenameFolder, onMoveFolder, onDeleteFolder }: {
  folders: readonly string[];
  tags: readonly TagUsage[];
  trashCount: number;
  scope: PromptNavigationScope;
  mutating: boolean;
  onSelectFolder: (folder: FolderFilter) => void;
  onSelectFavorites: () => void;
  onSelectTrash: () => void;
  onToggleTag: (tag: string) => void;
  onCreateFolder: (parent: string | null, name: string) => Promise<boolean>;
  onRenameFolder: (path: string, name: string) => Promise<boolean>;
  onMoveFolder: (path: string, destinationParent: string | null) => Promise<boolean>;
  onDeleteFolder: (path: string) => void;
}): ReactNode {
  const [createParent, setCreateParent] = useState<string | null | undefined>(undefined);
  const [renamePath, setRenamePath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [movePath, setMovePath] = useState<string | null>(null);
  const sortedFolders = useMemo(() => {
    return sortFolderPaths(folders);
  }, [folders]);
  const creator = createParent === undefined ? null : { parent: createParent, node: <InlineFolderCreatorForm parent={createParent} disabled={mutating} inputName="inline-prompt-folder-name"
    onSubmit={(name) => { void onCreateFolder(createParent, name).then((created) => { if (created) setCreateParent(undefined); return undefined; }); }} onCancel={() => setCreateParent(undefined)} /> };

  return <>
    <nav aria-label="提示词导航" className={styles.navigator}>
      <div className={styles.navGroup}>
        <Button size="compact" variant="ghost" className={styles.navEntry} title="全部提示词" startIcon={<NotePencilIcon />}
          aria-current={scope.location === "active" && !scope.favoriteOnly && scope.folder.kind === "all" ? "page" : undefined}
          onClick={() => onSelectFolder({ kind: "all" })}>全部提示词</Button>
        <Button size="compact" variant="ghost" className={styles.navEntry} title="收藏" startIcon={<StarIcon weight={scope.favoriteOnly ? "fill" : "regular"} />} aria-label="收藏提示词"
          aria-current={scope.location === "active" && scope.favoriteOnly ? "page" : undefined} onClick={onSelectFavorites}>收藏</Button>
        <Button size="compact" variant="ghost" className={styles.navEntry} title="提示词根位置" startIcon={<TrayIcon />}
          aria-current={scope.location === "active" && !scope.favoriteOnly && scope.folder.kind === "root" ? "page" : undefined}
          onClick={() => onSelectFolder({ kind: "root" })}>提示词根位置</Button>
      </div>
      <section className={styles.folderSection}>
        <div className={styles.sectionHeading}><span>文件夹</span><div className={styles.folderActions} role="group" aria-label="提示词文件夹操作">
          <Tooltip content={scope.folder.kind === "path" ? "新建子文件夹" : "新建文件夹"}><IconButton size="compact" label="新建提示词文件夹" icon={<PlusIcon />} disabled={mutating || scope.location === "trash"} onClick={() => setCreateParent(scope.folder.kind === "path" ? scope.folder.path : null)} /></Tooltip>
        </div></div>
        <div className={styles.folderList} aria-label="提示词文件夹"><FolderTree folders={sortedFolders}
          currentPath={scope.location === "active" && !scope.favoriteOnly && scope.folder.kind === "path" ? scope.folder.path : null}
          disabled={mutating || scope.location === "trash"} navEntryClassName={styles.navEntry!} creator={creator}
          onSelect={(path) => onSelectFolder({ kind: "path", path })} onMove={(path, destinationParent) => { void onMoveFolder(path, destinationParent); }}
          onAction={(action, path) => {
            switch (action) {
              case "create-child": setCreateParent(path); break;
              case "rename": setRenamePath(path); setRenameValue(folderLeaf(path)); break;
              case "move": setMovePath(path); break;
              case "delete": onDeleteFolder(path); break;
            }
          }} /></div>
      </section>
      {scope.location === "active" && tags.length > 0 ? <section className={styles.tagSection}><div className={styles.sectionHeading}><span>标签</span></div><div className={styles.tagPanel} aria-label="标签筛选">
        {tags.map((usage) => <Button key={usage.tag} size="compact" variant="ghost" className={styles.tagChip} data-tag={usage.tag} aria-label={`${usage.tag}，${usage.count} 条提示词`} title={`${usage.count} 条提示词`} aria-pressed={scope.selectedTags.includes(usage.tag)} onClick={() => onToggleTag(usage.tag)}><span>{usage.tag}</span></Button>)}
      </div></section> : null}
      <div className={styles.trashEntry}><Button size="compact" variant="ghost" className={styles.navEntry} title="回收站" startIcon={<TrashIcon />} aria-label="回收站" aria-current={scope.location === "trash" ? "page" : undefined} onClick={onSelectTrash}>回收站</Button>{trashCount > 0 ? <span className={styles.countBadge}>{trashCount}</span> : null}</div>
    </nav>
    <Dialog title="重命名提示词文件夹" description={renamePath === null ? "请选择一个提示词文件夹。" : `修改「${renamePath}」的最后一级名称。`} open={renamePath !== null} onOpenChange={(open) => { if (!mutating && !open) setRenamePath(null); }}>
      <form className={styles.folderForm} onSubmit={(event) => { event.preventDefault(); if (renamePath !== null) void onRenameFolder(renamePath, renameValue).then((saved) => { if (saved) setRenamePath(null); return undefined; }); }}><label htmlFor="rename-prompt-folder">文件夹名称</label><input id="rename-prompt-folder" name="rename-prompt-folder" autoComplete="off" value={renameValue} onChange={(event) => setRenameValue(event.target.value)} required disabled={mutating} /><Button type="submit" variant="primary" disabled={mutating || renameValue.trim().length === 0}>保存名称</Button></form>
    </Dialog>
    {movePath === null ? null : <PromptMoveFolderDialog path={movePath} folders={sortedFolders} disabled={mutating} onMove={(destinationParent) => { void onMoveFolder(movePath, destinationParent).then((moved) => { if (moved) setMovePath(null); return undefined; }); }} onClose={() => setMovePath(null)} />}
  </>;
}
