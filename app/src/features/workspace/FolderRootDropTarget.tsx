import type { ReactNode } from "react";
import { TrayIcon } from "@phosphor-icons/react/dist/csr/Tray";

/** 文件夹拖动时才揭示的顶层放置目标；领域模块负责样式，移动语义仍由共享 hook 裁决。 */
export function FolderRootDropTarget({ active, className }: {
  active: boolean;
  className: string;
}): ReactNode {
  return (
    <div
      className={className}
      data-folder-tree-root
      data-folder-root-drop
      data-drop-active={active ? "true" : undefined}
      aria-label="移到顶层放置区"
    >
      <TrayIcon aria-hidden="true" />
      <span>移到顶层</span>
    </div>
  );
}
