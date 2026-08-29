import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "../../../ui/button/Button";
import { appPlatform, appTaskCenter } from "../../../app/runtime";
import { createLibraryTransferKey, type TaskCenter, type TaskOutcome, type TaskRecord } from "../../../app/taskCenter";
import { IpcError, formatError } from "../../../shared/errors";
import type { LibraryId } from "../../../app/common";
import type { AppError, ImportOutcome, TransferProgress, TransferRunStatus } from "../../../shared/types";
import { assetKeys } from "./queryKeys";
import styles from "./AssetTransfer.module.css";

export type TransferHandle = {
  readonly appTaskId: string;
  backendTaskId: string | null;
  stopRequested: boolean;
  stopAcknowledged: boolean;
  stopError: AppError | null;
  outcome: TaskOutcome | null;
};

const transferHandles = new Map<string, TransferHandle>();
const STOP_CONFIRMATION_RETRY_MS = 100;
const STOP_CONFIRMATION_MAX_ATTEMPTS = 100;

export function registerTransferTask(libraryId: LibraryId, title: string, kind: "import" | "export"): { kind: "registered"; appTaskId: string; handle: TransferHandle } | { kind: "rejected"; conflictingTaskId: string } {
  const registration = appTaskCenter.register({ kind, title, libraryId, stoppable: true, concurrencyKey: createLibraryTransferKey(libraryId) });
  if (registration.kind === "rejected_by_concurrency") return { kind: "rejected", conflictingTaskId: registration.conflictingTaskId };
  const handle: TransferHandle = { appTaskId: registration.record.id, backendTaskId: null, stopRequested: false, stopAcknowledged: false, stopError: null, outcome: null };
  transferHandles.set(handle.appTaskId, handle);
  return { kind: "registered", appTaskId: handle.appTaskId, handle };
}

/** 任务中心只有在后端 task ID 已到达后才应显示真实停止按钮。 */
export function canStopTransferTask(appTaskId: string): boolean {
  const handle = transferHandles.get(appTaskId);
  return handle !== undefined && handle.backendTaskId !== null;
}

/** 任务结束后的终态确认失败仍属于当前传输任务，供全局任务中心稳定呈现错误码。 */
export function getTransferTaskStopError(appTaskId: string): AppError | null {
  return transferHandles.get(appTaskId)?.stopError ?? null;
}

function reportStopError(handle: TransferHandle, error: AppError): void {
  handle.stopError = error;
  const record = appTaskCenter.snapshot().find((item) => item.id === handle.appTaskId);
  if (record === undefined) throw new Error(`任务中心不存在传输任务：${handle.appTaskId}`);
  if (record.progress !== null) appTaskCenter.reportProgress(handle.appTaskId, record.progress);
}

function useTaskRecords(center: TaskCenter): readonly TaskRecord[] {
  const [records, setRecords] = useState<readonly TaskRecord[]>(() => center.snapshot());
  useEffect(() => center.subscribe(() => setRecords(center.snapshot())), [center]);
  return records;
}

function importOutcome(outcome: ImportOutcome): TaskOutcome {
  return {
    counts: { succeeded: outcome.imported, skipped: outcome.skipped_non_images + outcome.duplicates, failed: outcome.failures.length, unprocessed: outcome.pending_count },
    failures: outcome.failures.map((failure) => ({ displayName: failure.original_filename, error: failure.error })),
    skipDetails: [
      { kind: "unsupported" as const, count: outcome.skipped_non_images },
      { kind: "duplicate" as const, count: outcome.duplicates },
    ].filter((detail) => detail.count > 0),
    error: null,
  };
}

export function completeTransfer(handle: TransferHandle, outcome: TaskOutcome): void {
  handle.outcome = outcome;
  if (handle.stopRequested) {
    if (handle.stopAcknowledged) {
      appTaskCenter.confirmStopped(handle.appTaskId, outcome);
      transferHandles.delete(handle.appTaskId);
    }
    // `import_stop` may legitimately acknowledge the request with `stopping` while
    // the last item transaction is still finishing. Once the result arrives there
    // is no progress event left to drive another confirmation, so ask the backend
    // for the terminal state again instead of leaving the task there forever.
    if (!handle.stopAcknowledged && handle.backendTaskId !== null) {
      void confirmStopAfterOutcome(handle).catch((raw: unknown) => {
        if (!(raw instanceof IpcError)) throw raw;
        reportStopError(handle, raw.appError);
      });
    }
    return;
  }
  appTaskCenter.complete(handle.appTaskId, outcome);
  transferHandles.delete(handle.appTaskId);
}

async function confirmStopAfterOutcome(handle: TransferHandle): Promise<void> {
  const taskId = handle.backendTaskId;
  if (taskId === null || handle.stopAcknowledged || handle.outcome === null) return;
  for (let attempt = 0; attempt < STOP_CONFIRMATION_MAX_ATTEMPTS; attempt += 1) {
    const status = await appPlatform.stopTransfer(taskId);
    if (status.task_id !== taskId) throw new Error("停止响应的任务 ID 与当前任务不一致");
    if (status.state === "stopped") {
      if (handle.stopAcknowledged || transferHandles.get(handle.appTaskId) !== handle) return;
      handle.stopAcknowledged = true;
      appTaskCenter.confirmStopped(handle.appTaskId, handle.outcome);
      transferHandles.delete(handle.appTaskId);
      return;
    }
    if (attempt + 1 < STOP_CONFIRMATION_MAX_ATTEMPTS) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, STOP_CONFIRMATION_RETRY_MS));
    }
  }
  reportStopError(handle, {
    code: "transfer.stop_confirmation_timeout",
    detail: `后端在 ${STOP_CONFIRMATION_MAX_ATTEMPTS * STOP_CONFIRMATION_RETRY_MS}ms 内未确认停止`,
  });
}

export async function stopTransferTask(appTaskId: string): Promise<void> {
  const handle = transferHandles.get(appTaskId);
  if (handle === undefined) throw new Error(`传输任务不存在：${appTaskId}`);
  if (handle.backendTaskId === null) throw new Error(`传输任务尚未取得后端任务 ID：${appTaskId}`);
  const record = appTaskCenter.snapshot().find((item) => item.id === appTaskId);
  if (record === undefined) throw new Error(`任务中心不存在传输任务：${appTaskId}`);
  if (record.state === "running") {
    appTaskCenter.markStopRequested(appTaskId);
    handle.stopRequested = true;
  } else if (record.state !== "stopping") {
    throw new Error(`传输任务当前不可停止：${record.state}`);
  } else {
    handle.stopRequested = true;
  }
  handle.stopError = null;
  let status: TransferRunStatus;
  try {
    status = await appPlatform.stopTransfer(handle.backendTaskId);
  } catch (raw) {
    if (!(raw instanceof IpcError)) throw raw;
    reportStopError(handle, raw.appError);
    throw raw;
  }
  if (status.task_id !== handle.backendTaskId) throw new Error("停止响应的任务 ID 与当前任务不一致");
  if (status.state === "stopped") {
    handle.stopAcknowledged = true;
    if (handle.outcome !== null) {
      appTaskCenter.confirmStopped(appTaskId, handle.outcome);
      transferHandles.delete(appTaskId);
    }
  } else if (handle.outcome !== null) {
    await confirmStopAfterOutcome(handle);
  }
}

function hasTauriRuntime(): boolean {
  const internals: unknown = Reflect.get(window, "__TAURI_INTERNALS__");
  if (typeof internals !== "object" || internals === null) return false;
  const invoke: unknown = Reflect.get(internals, "invoke");
  const metadata: unknown = Reflect.get(internals, "metadata");
  if (typeof invoke !== "function" || typeof metadata !== "object" || metadata === null) return false;
  return Reflect.get(metadata, "currentWindow") !== undefined && Reflect.get(metadata, "currentWebview") !== undefined;
}

export function useAssetTransfer(libraryId: LibraryId, active: boolean, currentFolder: string | null, onImported: () => void) {
  const client = useQueryClient();
  const [error, setError] = useState<AppError | null>(null);
  const [dragging, setDragging] = useState(false);
  const run = useCallback(async (paths: readonly string[] | null): Promise<void> => {
    if (paths !== null && paths.length === 0) return;
    setError(null);
    const registration = registerTransferTask(libraryId, paths === null ? "粘贴导入" : paths.length === 1 ? "导入图片文件夹" : "导入图片", "import");
    if (registration.kind === "rejected") {
      setError({ code: "transfer.already_running", detail: `任务 ${registration.conflictingTaskId} 正在运行` });
      return;
    }
    const { appTaskId, handle } = registration;
    const progress = (update: TransferProgress): void => {
      handle.backendTaskId = update.task_id;
      appTaskCenter.reportProgress(appTaskId, { kind: "transfer", done: update.done, total: update.total, currentFilename: update.current_filename });
    };
    try {
      const outcome = paths === null ? await appPlatform.pasteImport(currentFolder, progress) : await appPlatform.importSources([...paths], currentFolder, progress);
      completeTransfer(handle, importOutcome(outcome));
      await client.invalidateQueries({ queryKey: assetKeys.collections(libraryId) });
      onImported();
    } catch (raw) {
      if (!(raw instanceof IpcError)) throw raw;
      completeTransfer(handle, { counts: { succeeded: 0, skipped: 0, failed: 0, unprocessed: 0 }, failures: [], error: raw.appError });
      setError(raw.appError);
    }
  }, [client, currentFolder, libraryId, onImported]);
  const chooseImages = useCallback(async (): Promise<void> => {
    try {
      await run(await appPlatform.pickImageFiles());
    } catch (raw) {
      if (!(raw instanceof IpcError)) throw raw;
      setError(raw.appError);
    }
  }, [run]);
  const chooseFolder = useCallback(async (): Promise<void> => {
    try {
      const path = await appPlatform.pickImportDirectory();
      if (path !== null) await run([path]);
    } catch (raw) {
      if (!(raw instanceof IpcError)) throw raw;
      setError(raw.appError);
    }
  }, [run]);
  const paste = useCallback(() => void run(null), [run]);
  useEffect(() => {
    if (!active || import.meta.env.MODE === "test" || !hasTauriRuntime()) return undefined;
    return appPlatform.onFileDrag((event) => {
      if (event.type === "leave") { setDragging(false); return; }
      setDragging(true);
      if (event.type === "drop") { setDragging(false); void run(event.paths); }
    });
  }, [active, run]);
  useEffect(() => {
    if (!active) return undefined;
    const onPaste = (event: KeyboardEvent): void => {
      if (!event.ctrlKey || event.altKey || event.metaKey || (event.key !== "v" && event.key !== "V")) return;
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [role="alertdialog"], [role="menu"]') !== null) return;
      event.preventDefault();
      paste();
    };
    window.addEventListener("keydown", onPaste);
    return () => window.removeEventListener("keydown", onPaste);
  }, [active, paste]);
  const records = useTaskRecords(appTaskCenter);
  const busy = records.some((record) => record.libraryId === libraryId && (record.state === "running" || record.state === "stopping"));
  return { chooseImages, chooseFolder, paste, error, dragging, busy };
}

export type AssetTransferController = ReturnType<typeof useAssetTransfer>;

/** 非空工作区只呈现传输状态；实际入口由顶栏、拖放和 Ctrl+V 统一拥有。 */
export function AssetTransferFeedback({ transfer }: { transfer: AssetTransferController }): ReactNode {
  return <>
    {transfer.error === null ? null : <p className={styles.error} role="alert">{formatError(transfer.error)}</p>}
    {transfer.dragging ? <div className={styles.dragNotice} role="status">松开以导入图片或文件夹</div> : null}
  </>;
}

export function ImportGuide({ onImportImages, onImportFolder, onPaste }: { onImportImages: () => void; onImportFolder: () => void; onPaste: () => void }): ReactNode {
  return <div className={styles.guide}><p className={styles.eyebrow}>IMAGE ARCHIVE</p><h2>建立本地视觉档案</h2><p>图片会复制进入当前库，源文件不会被移动或修改。你可以选择图片、导入文件夹，或直接粘贴剪贴板内容。</p><div className={styles.guideActions}><Button variant="primary" onClick={onImportImages}>导入图片</Button><Button onClick={onImportFolder}>导入文件夹</Button><Button onClick={onPaste}>从剪贴板导入</Button></div></div>;
}
