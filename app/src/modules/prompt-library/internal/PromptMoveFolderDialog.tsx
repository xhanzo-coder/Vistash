import type { ReactNode } from "react";

import { Dialog } from "../../../ui/dialog/Dialog";
import { FolderMoveTargetForm } from "../../../features/workspace/FolderMoveTargetForm";

/** 提示词文件夹移动的键盘等价入口；拖放与本 Dialog 共用同一深命令。 */
export function PromptMoveFolderDialog({ path, folders, disabled, onMove, onClose }: {
  path: string;
  folders: readonly string[];
  disabled: boolean;
  onMove: (destinationParent: string | null) => void;
  onClose: () => void;
}): ReactNode {
  return (
    <Dialog title="移动文件夹" description="移动完整提示词文件夹子树并同步更新提示词归属。" open onOpenChange={(open) => { if (!open && !disabled) onClose(); }}>
      <FolderMoveTargetForm path={path} folders={folders} disabled={disabled} topLabel="顶层（提示词文件夹树）" onSubmit={onMove} />
    </Dialog>
  );
}
