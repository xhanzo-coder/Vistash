import { useMemo, useState, type ReactNode } from "react";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { FolderIcon } from "@phosphor-icons/react/dist/csr/Folder";
import { FolderOpenIcon } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";

import { Button, IconButton } from "../../ui/button/Button";
import { ContextMenu, ContextMenuItem } from "../../ui/overlays/Menu";
import { FolderRootDropTarget } from "./FolderRootDropTarget";
import { folderLeaf, sortFolderPaths } from "./folderPath";
import { useFolderTreeDrag } from "./useFolderTreeDrag";
import styles from "./FolderTree.module.css";

export type FolderTreeAction = "create-child" | "rename" | "move" | "delete";

/** 图片与提示词共享的无业务状态文件夹树；领域范围和 mutation 全由调用方注入。 */
export function FolderTree({ folders, currentPath, disabled, navEntryClassName, creator, externalDropTarget, onSelect, onMove, onAction }: {
  folders: readonly string[];
  currentPath: string | null;
  disabled: boolean;
  navEntryClassName: string;
  creator: { parent: string | null; node: ReactNode } | null;
  externalDropTarget?: string | null | undefined;
  onSelect: (path: string) => void;
  onMove: (path: string, destinationParent: string | null) => void;
  onAction: (action: FolderTreeAction, path: string) => void;
}): ReactNode {
  const sortedFolders = useMemo(() => sortFolderPaths(folders), [folders]);
  const drag = useFolderTreeDrag(disabled, onMove);
  return <div className={styles.tree} data-folder-tree-root {...drag.handlers}>
    {drag.preview === null ? null : <div className={styles.preview} role="status" style={{ left: drag.preview.x + 12, top: drag.preview.y + 12 }}>
      {drag.preview.target.kind === "invalid" ? "不能移动到这里" : drag.preview.target.kind === "top" ? `移动 ${folderLeaf(drag.preview.source)} 到顶层` : `移动 ${folderLeaf(drag.preview.source)} 到 ${drag.preview.target.path}`}
    </div>}
    {drag.preview === null ? null : <FolderRootDropTarget className={styles.rootDrop!} active={drag.preview.target.kind === "top"} />}
    {creator?.parent === null ? <div className={styles.inlineRow} style={{ paddingInlineStart: ".5rem" }}>{creator.node}</div> : null}
    {sortedFolders.map((path) => {
      const depth = path.split("/").length - 1;
      const hasChildren = sortedFolders.some((candidate) => candidate.startsWith(`${path}/`));
      const button = <Button size="compact" variant="ghost" className={`${navEntryClassName} ${styles.node}`} title={path} startIcon={hasChildren ? <FolderOpenIcon /> : <FolderIcon />}
        data-folder={path} data-depth={depth} data-tree-guide={depth > 0 ? "vertical" : undefined}
        data-folder-drop={path} data-drop-target={externalDropTarget === path ? "true" : undefined}
        data-folder-tree-drop={drag.preview?.target.kind === "folder" && drag.preview.target.path === path ? "true" : undefined}
        style={{ paddingInlineStart: `${0.5 + depth * 1.4}rem` }} aria-current={currentPath === path ? "page" : undefined} onClick={() => onSelect(path)}>
        <span className={styles.label}>{depth === 0 ? null : <span className={styles.guide} aria-hidden="true" />}{folderLeaf(path)}</span>
      </Button>;
      return <div key={path}><ContextMenu label="文件夹快捷菜单" content={<>
        <ContextMenuItem onSelect={() => onAction("create-child", path)}>新建子文件夹</ContextMenuItem>
        <ContextMenuItem onSelect={() => onAction("rename", path)}>重命名</ContextMenuItem>
        {depth > 0 ? <ContextMenuItem onSelect={() => onMove(path, null)}>移到顶层</ContextMenuItem> : null}
        <ContextMenuItem onSelect={() => onAction("move", path)}>移动文件夹</ContextMenuItem>
        <ContextMenuItem destructive onSelect={() => onAction("delete", path)}>删除</ContextMenuItem>
      </>}>{button}</ContextMenu>
        {creator?.parent === path ? <div className={styles.inlineRow} style={{ paddingInlineStart: `${0.5 + (depth + 1) * 1.4}rem` }}>{creator.node}</div> : null}
      </div>;
    })}
  </div>;
}

/** 树内即时命名的共享表单；创建事务与错误恢复由领域调用方拥有。 */
export function InlineFolderCreatorForm({ parent, disabled, busy = false, error = null, inputName = "inline-folder-name", onSubmit, onCancel }: {
  parent: string | null;
  disabled: boolean;
  busy?: boolean;
  error?: string | null;
  inputName?: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}): ReactNode {
  const [name, setName] = useState("");
  return <form className={styles.creator} data-inline-folder-creator data-parent={parent ?? ""} onSubmit={(event) => { event.preventDefault(); onSubmit(name); }}>
    <input autoFocus name={inputName} aria-label="新文件夹名称" placeholder="文件夹名称" value={name} disabled={disabled || busy} onChange={(event) => setName(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Escape" && !busy) { event.preventDefault(); onCancel(); } }} />
    <IconButton size="compact" label="创建文件夹" icon={<CheckIcon />} type="submit" disabled={disabled || busy || name.trim().length === 0} />
    <IconButton size="compact" label="取消新建文件夹" icon={<XIcon />} disabled={busy} onClick={onCancel} />
    {error === null ? null : <p role="alert" className={styles.error}>{error}</p>}
  </form>;
}
