import { useRef, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";

import type { LibraryId } from "../../../app/common";
import { appTaskCenter } from "../../../app/runtime";
import { asAppError, IpcError } from "../../../shared/errors";
import { moveFolder } from "../../../shared/ipc";
import { Dialog } from "../../../ui/dialog/Dialog";
import { FolderMoveTargetForm } from "../../../features/workspace/FolderMoveTargetForm";
import type { FolderChange } from "./FolderEditor";
import styles from "./AssetLibraryWorkspace.module.css";

/** 文件夹移动的键盘等价入口；拖放与本 Dialog 共用同一个深命令。 */
export function MoveFolderDialog({
  libraryId,
  path,
  folders,
  disabled,
  onCommitted,
  onClosed,
}: {
  libraryId: LibraryId;
  path: string;
  folders: readonly string[];
  disabled: boolean;
  onCommitted: (change: FolderChange) => Promise<void>;
  onClosed: () => void;
}): ReactNode {
  const move = useMoveFolder(libraryId, onCommitted);
  if (move.error !== null && !(move.error instanceof IpcError)) throw move.error;
  return (
    <Dialog
      title="移动文件夹"
      description="移动完整逻辑子树并同步更新图片归属，不会移动图片文件。"
      open
      onOpenChange={(open) => {
        if (!open && !move.isPending) onClosed();
      }}
    >
      <FolderMoveTargetForm path={path} folders={folders} disabled={disabled} busy={move.isPending}
        topLabel="顶层（无父文件夹）" error={move.error === null ? null : <p role="alert" className={styles.error}>{move.error.message}</p>}
        onSubmit={(destinationParent) => move.mutate({ path, destinationParent }, { onSuccess: onClosed })} />
    </Dialog>
  );
}

export type MoveFolderRequest = { path: string; destinationParent: string | null };

/** 右键 Dialog 与直接拖放共用的唯一文件夹移动 mutation。 */
export function useMoveFolder(
  libraryId: LibraryId,
  onCommitted: (change: FolderChange) => Promise<void>,
) {
  const taskIds = useRef(new WeakMap<object, string>());
  return useMutation({
    scope: { id: `asset-organization:${libraryId}` },
    mutationFn: async (request: MoveFolderRequest) => {
      const registration = appTaskCenter.register({
        kind: "folder_mutation",
        title: "移动文件夹",
        libraryId,
        stoppable: false,
        concurrencyKey: null,
      });
      if (registration.kind !== "registered") throw new Error("移动文件夹任务意外触发并发拒绝");
      taskIds.current.set(request, registration.record.id);
      return moveFolder(request.path, request.destinationParent, (progress) =>
        appTaskCenter.reportProgress(registration.record.id, {
          kind: "items",
          done: progress.done,
          total: progress.total,
        }),
      );
    },
    onSuccess: async (movedPath, request) => {
      const taskId = taskIds.current.get(request);
      if (taskId === undefined) throw new Error("移动文件夹成功但缺少任务中心标识");
      appTaskCenter.complete(taskId, {
        counts: { succeeded: 1, skipped: 0, failed: 0, unprocessed: 0 },
        failures: [],
        error: null,
      });
      await onCommitted({ kind: "move", previousPath: request.path, path: movedPath });
    },
    onError: (error, request) => {
      const taskId = taskIds.current.get(request);
      if (taskId === undefined) throw new Error("移动文件夹失败但缺少任务中心标识");
      const appError = asAppError(error);
      appTaskCenter.complete(taskId, {
        counts: { succeeded: 0, skipped: 0, failed: 0, unprocessed: 0 },
        failures: [],
        error: appError,
      });
      if (!(error instanceof IpcError)) throw error;
    },
  });
}
