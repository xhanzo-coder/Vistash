import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "../../../ui/button/Button";
import { appPlatform, appTaskCenter } from "../../../app/runtime";
import { createLibraryTransferKey, type TaskOutcome, type TaskRecord } from "../../../app/taskCenter";
import { IpcError, formatError } from "../../../shared/errors";
import type { LibraryId } from "../../../app/common";
import type { AppError, ImportOutcome, TransferProgress, TransferRunStatus } from "../../../shared/types";
import { assetKeys } from "./queryKeys";
import styles from "./AssetTransfer.module.css";
import { useToast } from "../../../ui/toast/Toast";

export type TransferHandle = {
  readonly appTaskId: string;
  readonly libraryId: LibraryId;
  backendTaskId: string | null;
  stopRequested: boolean;
  stopAcknowledged: boolean;
  stopError: AppError | null;
  outcome: TaskOutcome | null;
  reportId: number | null;
};

const transferHandles = new Map<string, TransferHandle>();
let nextTransferReportId = 0;
export type TransferReportKind = "import" | "export";
export type TransferReportStatus = "completed" | "stopping" | "stopped";
export type TransferReportRecord = { id: number; kind: TransferReportKind; status: TransferReportStatus; outcome: TaskOutcome };
const EMPTY_TRANSFER_REPORTS: readonly TransferReportRecord[] = [];
const transferReportsByLibrary = new Map<LibraryId, readonly TransferReportRecord[]>();
const transferReportListeners = new Map<LibraryId, Set<() => void>>();
const STOP_CONFIRMATION_RETRY_MS = 100;
const STOP_CONFIRMATION_MAX_ATTEMPTS = 100;

function transferReports(libraryId: LibraryId): readonly TransferReportRecord[] {
  return transferReportsByLibrary.get(libraryId) ?? EMPTY_TRANSFER_REPORTS;
}

function publishTransferReports(libraryId: LibraryId, reports: readonly TransferReportRecord[]): void {
  if (reports.length === 0) transferReportsByLibrary.delete(libraryId);
  else transferReportsByLibrary.set(libraryId, reports);
  transferReportListeners.get(libraryId)?.forEach((listener) => listener());
}

/** 异常传输报告属于素材库会话；只有明确关闭才会从该库移除。 */
export function appendTransferReport(kind: TransferReportKind, outcome: TaskOutcome, handle: TransferHandle): void {
  const id = ++nextTransferReportId;
  const status: TransferReportStatus = !handle.stopRequested ? "completed" : handle.stopAcknowledged ? "stopped" : "stopping";
  handle.reportId = id;
  publishTransferReports(handle.libraryId, [...transferReports(handle.libraryId), { id, kind, status, outcome }]);
}

function markTransferReportStopped(handle: TransferHandle): void {
  if (handle.reportId === null) return;
  publishTransferReports(handle.libraryId, transferReports(handle.libraryId).map((report) =>
    report.id === handle.reportId ? { ...report, status: "stopped" } : report));
}

export function dismissTransferReport(libraryId: LibraryId, id: number): void {
  publishTransferReports(libraryId, transferReports(libraryId).filter((report) => report.id !== id));
}

export function usePersistentTransferReports(libraryId: LibraryId, kind: TransferReportKind): readonly TransferReportRecord[] {
  const subscribe = useCallback((listener: () => void) => {
    const listeners = transferReportListeners.get(libraryId) ?? new Set<() => void>();
    listeners.add(listener);
    transferReportListeners.set(libraryId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) transferReportListeners.delete(libraryId);
    };
  }, [libraryId]);
  const snapshot = useCallback(() => transferReports(libraryId), [libraryId]);
  const reports = useSyncExternalStore(subscribe, snapshot, snapshot);
  return useMemo(() => reports.filter((report) => report.kind === kind), [kind, reports]);
}

export function registerTransferTask(libraryId: LibraryId, title: string, kind: "import" | "export"): { kind: "registered"; appTaskId: string; handle: TransferHandle } | { kind: "rejected"; conflictingTaskId: string } {
  const registration = appTaskCenter.register({ kind, title, libraryId, stoppable: true, concurrencyKey: createLibraryTransferKey(libraryId) });
  if (registration.kind === "rejected_by_concurrency") return { kind: "rejected", conflictingTaskId: registration.conflictingTaskId };
  const handle: TransferHandle = { appTaskId: registration.record.id, libraryId, backendTaskId: null, stopRequested: false, stopAcknowledged: false, stopError: null, outcome: null, reportId: null };
  transferHandles.set(handle.appTaskId, handle);
  return { kind: "registered", appTaskId: handle.appTaskId, handle };
}

/** 只有后端 task ID 已到达后，内部协调器才允许提交真实停止请求。 */
export function canStopTransferTask(appTaskId: string): boolean {
  const handle = transferHandles.get(appTaskId);
  return handle !== undefined && handle.backendTaskId !== null;
}

/** 任务结束后的终态确认失败仍属于当前传输任务，供内部记录保留稳定错误码。 */
export function getTransferTaskStopError(appTaskId: string): AppError | null {
  return transferHandles.get(appTaskId)?.stopError ?? null;
}

function reportStopError(handle: TransferHandle, error: AppError): void {
  handle.stopError = error;
  const record = appTaskCenter.snapshot().find((item) => item.id === handle.appTaskId);
  if (record === undefined) throw new Error(`任务中心不存在传输任务：${handle.appTaskId}`);
  if (record.progress !== null) appTaskCenter.reportProgress(handle.appTaskId, record.progress);
}

function useTaskRecords(): readonly TaskRecord[] {
  const [records, setRecords] = useState<readonly TaskRecord[]>(() => appTaskCenter.snapshot());
  useEffect(() => appTaskCenter.subscribe(() => setRecords(appTaskCenter.snapshot())), []);
  return records;
}

export function useLibraryTransferBusy(libraryId: LibraryId): boolean {
  const records = useTaskRecords();
  return records.some((record) => record.libraryId === libraryId && (record.state === "running" || record.state === "stopping"));
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
      markTransferReportStopped(handle);
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
      markTransferReportStopped(handle);
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
  const toast = useToast();
  const [error, setError] = useState<AppError | null>(null);
  const reports = usePersistentTransferReports(libraryId, "import");
  const [dragging, setDragging] = useState(false);
  const run = useCallback(async (paths: readonly string[] | null): Promise<void> => {
    if (paths !== null && paths.length === 0) return;
    setError(null);
    const registration = registerTransferTask(libraryId, paths === null ? "粘贴导入" : paths.length === 1 ? "导入图片文件夹" : "导入图片", "import");
    if (registration.kind === "rejected") {
      setError({ code: "transfer.already_running", detail: `任务 ${registration.conflictingTaskId} 正在运行` });
      toast.publish({ tone: "warning", title: "导入任务正在运行", description: "请等待当前导入结束后重试。" });
      return;
    }
    const { appTaskId, handle } = registration;
    const progress = (update: TransferProgress): void => {
      handle.backendTaskId = update.task_id;
      appTaskCenter.reportProgress(appTaskId, { kind: "transfer", done: update.done, total: update.total, currentFilename: update.current_filename });
    };
    try {
      const outcome = paths === null ? await appPlatform.pasteImport(currentFolder, progress) : await appPlatform.importSources([...paths], currentFolder, progress);
      const completed = importOutcome(outcome);
      completeTransfer(handle, completed);
      if (completed.failures.length > 0 || completed.counts.unprocessed > 0 || handle.stopRequested) {
        appendTransferReport("import", completed, handle);
      }
      if (paths === null) {
        if (outcome.duplicates > 0) toast.publish({ tone: "info", title: "图片已经在素材库中" });
        else if (outcome.imported === 0 && outcome.failures.length === 0) toast.publish({ tone: "info", title: "剪贴板中没有可导入的图片", description: "请复制图片或图片文件后重试。" });
      }
      await client.invalidateQueries({ queryKey: assetKeys.collections(libraryId) });
      if (outcome.imported > 0) onImported();
    } catch (raw) {
      if (!(raw instanceof IpcError)) throw raw;
      const failed: TaskOutcome = { counts: { succeeded: 0, skipped: 0, failed: 0, unprocessed: 0 }, failures: [], error: raw.appError };
      completeTransfer(handle, failed);
      appendTransferReport("import", failed, handle);
      toast.publish({ tone: "warning", title: paths === null ? "剪贴板导入失败" : "图片导入失败", description: formatError(raw.appError) });
    }
  }, [client, currentFolder, libraryId, onImported, toast]);
  const chooseImages = useCallback(async (): Promise<void> => {
    try {
      await run(await appPlatform.pickImageFiles());
    } catch (raw) {
      if (!(raw instanceof IpcError)) throw raw;
      setError(raw.appError);
      toast.publish({ tone: "warning", title: "无法选择图片", description: formatError(raw.appError) });
    }
  }, [run, toast]);
  const chooseFolder = useCallback(async (): Promise<void> => {
    try {
      const path = await appPlatform.pickImportDirectory();
      if (path !== null) await run([path]);
    } catch (raw) {
      if (!(raw instanceof IpcError)) throw raw;
      setError(raw.appError);
      toast.publish({ tone: "warning", title: "无法选择文件夹", description: formatError(raw.appError) });
    }
  }, [run, toast]);
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
  useEffect(() => {
    if (!active) return undefined;
    const onNativePaste = (event: Event): void => {
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [role="alertdialog"], [role="menu"]') !== null) return;
      event.preventDefault();
      paste();
    };
    window.addEventListener("paste", onNativePaste);
    return () => window.removeEventListener("paste", onNativePaste);
  }, [active, paste]);
  const busy = useLibraryTransferBusy(libraryId);
  return { chooseImages, chooseFolder, paste, error, reports, dragging, busy,
    clearError: () => setError(null),
    dismissReport: (id: number) => dismissTransferReport(libraryId, id),
  };
}

export type AssetTransferController = ReturnType<typeof useAssetTransfer>;

const SKIP_LABELS = {
  duplicate: "重复内容",
  unsupported: "不支持的格式",
  conflict: "同名冲突",
} satisfies Record<NonNullable<TaskOutcome["skipDetails"]>[number]["kind"], string>;

export function TransferOutcomeReport({ report, label, title, onDismiss }: {
  report: TransferReportRecord;
  label: string;
  title: string;
  onDismiss: () => void;
}): ReactNode {
  const { id, outcome, status } = report;
  return <section className={styles.result} aria-label={label}>
    <div><strong>{title}</strong>{status === "completed" ? null : <span>{status === "stopped" ? "已停止" : "正在停止"}</span>}<p>成功 {outcome.counts.succeeded} · 跳过 {outcome.counts.skipped} · 失败 {outcome.counts.failed} · 未处理 {outcome.counts.unprocessed}</p></div>
    <Button size="compact" variant="ghost" aria-label={`关闭${label}`} onClick={onDismiss}>关闭</Button>
    {outcome.error === null ? null : <p role="alert"><code>{outcome.error.code}</code>{outcome.error.detail === null ? null : <small>{outcome.error.detail}</small>}</p>}
    {outcome.skipDetails === undefined || outcome.skipDetails.length === 0 ? null : <ul>{outcome.skipDetails.map((detail) => <li key={`${id}:skip:${detail.kind}`}><span>{SKIP_LABELS[detail.kind]}</span><small>{detail.count} 项</small></li>)}</ul>}
    {outcome.failures.length === 0 ? null : <ul>{outcome.failures.map((failure, index) => <li key={`${id}:failure:${index}`}><span>{failure.displayName}</span><code>{failure.error.code}</code>{failure.error.detail === null ? null : <small>{failure.error.detail}</small>}</li>)}</ul>}
  </section>;
}

/** 非空工作区只呈现传输状态；实际入口由顶栏、拖放和 Ctrl+V 统一拥有。 */
export function AssetTransferFeedback({ transfer }: { transfer: AssetTransferController }): ReactNode {
  return <>
    {transfer.dragging ? <div className={styles.dragNotice} role="status">松开以导入图片或文件夹</div> : null}
    {transfer.error === null ? null : <section className={styles.result} aria-label="导入错误">
      <div><strong>导入失败</strong><p role="alert">{formatError(transfer.error)}</p><code>{transfer.error.code}</code></div>
      <Button size="compact" variant="ghost" aria-label="关闭导入错误" onClick={transfer.clearError}>关闭</Button>
    </section>}
    {transfer.reports.map((report) => <TransferOutcomeReport key={report.id} report={report} label="导入结果" title="导入未完全完成" onDismiss={() => transfer.dismissReport(report.id)} />)}
  </>;
}

export function ImportGuide({ onImportImages, onImportFolder }: { onImportImages: () => void; onImportFolder: () => void }): ReactNode {
  return <div className={styles.guide}><h2>建立本地视觉档案</h2><p>图片会复制进入当前库，源文件不会被移动或修改。也可以复制图片或图片文件后，直接按 <kbd>Ctrl V</kbd> 导入。</p><div className={styles.guideActions}><Button variant="primary" onClick={onImportImages}>导入图片</Button><Button onClick={onImportFolder}>导入文件夹</Button></div></div>;
}
