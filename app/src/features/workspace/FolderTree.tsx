import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { FolderIcon } from "@phosphor-icons/react/dist/csr/Folder";
import { FolderOpenIcon } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";

import { Button, IconButton } from "../../ui/button/Button";
import { ContextMenu, ContextMenuItem } from "../../ui/overlays/Menu";
import { FolderRootDropTarget } from "./FolderRootDropTarget";
import { buildFolderTreeRows, folderLeaf, folderParent } from "./folderPath";
import { useFolderTreeDrag } from "./useFolderTreeDrag";
import styles from "./FolderTree.module.css";

export type FolderTreeAction = "create-child" | "rename" | "move" | "delete";
export type FolderReorderDirection = "up" | "down";

/** 图片与提示词共享的无业务状态文件夹树；领域范围和 mutation 全由调用方注入。 */
export function FolderTree({ folders, currentPath, disabled, navEntryClassName, creator, externalDropTarget, onSelect, onMove, onAction, onReorder }: {
  folders: readonly string[];
  currentPath: string | null;
  disabled: boolean;
  navEntryClassName: string;
  creator: { parent: string | null; node: ReactNode } | null;
  externalDropTarget?: string | null | undefined;
  onSelect: (path: string) => void;
  onMove: (path: string, destinationParent: string | null) => void;
  onAction: (action: FolderTreeAction, path: string) => void;
  /** 提供时同级节点快捷菜单出现「上移 / 下移」；缺省表示该领域不支持手动排序。 */
  onReorder?: ((path: string, direction: FolderReorderDirection) => void) | undefined;
}): ReactNode {
  // 树行顺序即权威存储顺序：手动排序的结果直接来自后端清单，前端不再字母排序。
  const { rows, childrenOf } = useMemo(() => buildFolderTreeRows(folders), [folders]);
  const drag = useFolderTreeDrag(disabled, onMove);
  const [collapsedPaths, setCollapsedPaths] = useState<ReadonlySet<string>>(() => new Set());
  // 进行中的交互优先于折叠状态：内联创建的父节点与当前选中路径的祖先强制展开。
  const forcedOpen = useMemo(() => {
    const forced = new Set<string>();
    const expandAncestors = (path: string | null): void => {
      let current = path === null ? null : folderParent(path);
      while (current !== null) {
        forced.add(current);
        current = folderParent(current);
      }
    };
    expandAncestors(creator === null ? null : creator.parent);
    expandAncestors(currentPath);
    return forced;
  }, [creator, currentPath]);
  const hiddenPaths = useMemo(() => {
    const hidden = new Set<string>();
    for (const collapsed of collapsedPaths) {
      if (forcedOpen.has(collapsed)) continue;
      for (const row of rows) if (row.path.startsWith(`${collapsed}/`)) hidden.add(row.path);
    }
    return hidden;
  }, [collapsedPaths, forcedOpen, rows]);
  const toggleCollapsed = (path: string): void => {
    setCollapsedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };
  const siblingPosition = (path: string): { canUp: boolean; canDown: boolean } => {
    const parent = folderParent(path);
    const siblings = childrenOf.get(parent !== null && childrenOf.has(parent) ? parent : null) ?? [];
    const index = siblings.indexOf(path);
    return { canUp: index > 0, canDown: index >= 0 && index < siblings.length - 1 };
  };
  return <div className={styles.tree} data-folder-tree-root {...drag.handlers}>
    {drag.preview === null ? null : <div className={styles.preview} role="status" style={{ left: drag.preview.x + 12, top: drag.preview.y + 12 }}>
      {drag.preview.target.kind === "invalid" ? "不能移动到这里" : drag.preview.target.kind === "top" ? `移动 ${folderLeaf(drag.preview.source)} 到顶层` : `移动 ${folderLeaf(drag.preview.source)} 到 ${drag.preview.target.path}`}
    </div>}
    {drag.preview === null ? null : <FolderRootDropTarget className={styles.rootDrop!} active={drag.preview.target.kind === "top"} />}
    {creator?.parent === null ? <div className={styles.inlineRow} style={{ paddingInlineStart: ".5rem" }}>{creator.node}</div> : null}
    {rows.map((row) => {
      const { path, depth, hasChildren } = row;
      if (hiddenPaths.has(path)) return null;
      const isCollapsed = collapsedPaths.has(path) && !forcedOpen.has(path);
      const reorder = onReorder === undefined ? null : siblingPosition(path);
      const button = <Button size="compact" variant="ghost" className={`${navEntryClassName} ${styles.node}`} title={path} startIcon={hasChildren ? <FolderOpenIcon /> : <FolderIcon />}
        data-folder={path} data-depth={depth} data-tree-guide={depth > 0 ? "vertical" : undefined}
        data-folder-drop={path} data-drop-target={externalDropTarget === path ? "true" : undefined}
        data-folder-tree-drop={drag.preview?.target.kind === "folder" && drag.preview.target.path === path ? "true" : undefined}
        aria-current={currentPath === path ? "page" : undefined} onClick={() => onSelect(path)}>
        <span className={styles.label}>{depth === 0 ? null : <span className={styles.guide} aria-hidden="true" />}{folderLeaf(path)}</span>
      </Button>;
      return <div key={path}>
        <div className={styles.row} style={{ paddingInlineStart: `${0.5 + depth * 1.4}rem` }}>
          {hasChildren
            ? <button type="button" className={styles.caret} aria-label={isCollapsed ? `展开文件夹 ${folderLeaf(path)}` : `折叠文件夹 ${folderLeaf(path)}`} aria-expanded={!isCollapsed} data-collapsed={isCollapsed ? "true" : undefined}
              disabled={disabled} onClick={() => toggleCollapsed(path)}><CaretDownIcon aria-hidden="true" /></button>
            : <span className={styles.caretSpacer} aria-hidden="true" />}
          <ContextMenu label="文件夹快捷菜单" content={<>
            <ContextMenuItem onSelect={() => onAction("create-child", path)}>新建子文件夹</ContextMenuItem>
            <ContextMenuItem onSelect={() => onAction("rename", path)}>重命名</ContextMenuItem>
            {reorder === null ? null : <>
              <ContextMenuItem disabled={!reorder.canUp} onSelect={() => onReorder?.(path, "up")}>上移</ContextMenuItem>
              <ContextMenuItem disabled={!reorder.canDown} onSelect={() => onReorder?.(path, "down")}>下移</ContextMenuItem>
            </>}
            {depth > 0 ? <ContextMenuItem onSelect={() => onMove(path, null)}>移到顶层</ContextMenuItem> : null}
            <ContextMenuItem onSelect={() => onAction("move", path)}>移动文件夹</ContextMenuItem>
            <ContextMenuItem destructive onSelect={() => onAction("delete", path)}>删除</ContextMenuItem>
          </>}>{button}</ContextMenu>
        </div>
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
  const inputRef = useRef<HTMLInputElement | null>(null);
  // 右键菜单（Radix）关闭后会把焦点交还触发按钮，恰好压过挂载时的聚焦；
  // 因此在下一帧与短暂延迟后重新夺回输入焦点，除非使用者已主动移入其他文本控件。
  useEffect(() => {
    const input = inputRef.current;
    if (input === null) return undefined;
    input.focus();
    const frame = requestAnimationFrame(() => input.focus());
    const timer = window.setTimeout(() => {
      const active = document.activeElement;
      const elsewhere = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
      if (active !== input && !elsewhere) input.focus();
    }, 150);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, []);
  return <form className={styles.creator} data-inline-folder-creator data-parent={parent ?? ""} onSubmit={(event) => { event.preventDefault(); onSubmit(name); }}>
    <input ref={inputRef} name={inputName} aria-label="新文件夹名称" placeholder="文件夹名称" value={name} disabled={disabled || busy} onChange={(event) => setName(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Escape" && !busy) { event.preventDefault(); onCancel(); } }} />
    <IconButton size="compact" label="创建文件夹" icon={<CheckIcon />} type="submit" disabled={disabled || busy || name.trim().length === 0} />
    <IconButton size="compact" label="取消新建文件夹" icon={<XIcon />} disabled={busy} onClick={onCancel} />
    {error === null ? null : <p role="alert" className={styles.error}>{error}</p>}
  </form>;
}
