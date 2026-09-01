import { useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { CopyIcon } from "@phosphor-icons/react/dist/csr/Copy";
import { ExportIcon } from "@phosphor-icons/react/dist/csr/Export";
import { parseAssetId, type AssetId, type LibraryId } from "../../../app/common";
import { appPlatform, appTaskCenter } from "../../../app/runtime";
import { planExport } from "../../../shared/ipc";
import { formatError, IpcError } from "../../../shared/errors";
import type { AppError, AssetRow, ConflictPolicy, ExportOutcome, PlannedExport } from "../../../shared/types";
import { Button, IconButton } from "../../../ui/button/Button";
import { ConfirmDialog, Dialog } from "../../../ui/dialog/Dialog";
import { Tooltip } from "../../../ui/overlays/Tooltip";
import { createLibraryTransferKey, type TaskOutcome } from "../../../app/taskCenter";
import { appendTransferReport, completeTransfer, dismissTransferReport, registerTransferTask, TransferOutcomeReport, useLibraryTransferBusy, usePersistentTransferReports, type TransferHandle } from "./AssetTransfer";
import styles from "./AssetTransfer.module.css";

type ExportPlan = { hashes: readonly AssetId[]; targetDir: string; entries: readonly PlannedExport[] };

function toTaskOutcome(outcome: ExportOutcome): TaskOutcome {
  return {
    counts: { succeeded: outcome.exported.length, skipped: outcome.skipped_existing, failed: outcome.failed.length, unprocessed: outcome.pending_count },
    skipDetails: outcome.skipped_existing === 0 ? [] : [{ kind: "conflict", count: outcome.skipped_existing }],
    failures: outcome.failed.map((failure) => ({ displayName: failure.display_filename === null ? `素材哈希 ${failure.hash}` : failure.display_filename, error: failure.error })),
    error: null,
  };
}

export function AssetOutboundControls({ libraryId, assets, active, disabled }: { libraryId: LibraryId; assets: readonly AssetRow[]; active: boolean; disabled: boolean }): ReactNode {
  const [plan, setPlan] = useState<ExportPlan | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const busy = useLibraryTransferBusy(libraryId);
  const selectedHashes = assets.map((asset) => parseAssetId(asset.hash));
  let single: AssetRow | null = null;
  if (assets.length === 1) {
    const only = assets[0];
    if (only === undefined) throw new Error("单选状态缺少图片");
    single = only;
  }
  const exportJob = useMutation({
    scope: { id: createLibraryTransferKey(libraryId) },
    mutationFn: async (request: { hashes: readonly AssetId[]; targetDir: string; policy: ConflictPolicy; handle: TransferHandle; appTaskId: string }) => {
      const progress = (update: { task_id: string; done: number; total: number; current_filename: string | null }): void => {
        request.handle.backendTaskId = update.task_id;
        appTaskCenter.reportProgress(request.appTaskId, { kind: "transfer", done: update.done, total: update.total, currentFilename: update.current_filename });
      };
      return appPlatform.exportAssets([...request.hashes], request.targetDir, request.policy, progress);
    },
    onSuccess: (outcome, request) => {
      const completed = toTaskOutcome(outcome);
      completeTransfer(request.handle, completed);
      if (completed.failures.length > 0 || completed.counts.unprocessed > 0 || request.handle.stopRequested) {
        appendTransferReport("export", completed, request.handle);
      }
      setError(null);
      setNotice(completed.failures.length === 0 && completed.counts.unprocessed === 0 ? `已导出 ${outcome.exported.length} 张图片` : null);
    },
    onError: (raw, request) => {
      if (!(raw instanceof IpcError)) throw raw;
      const failed: TaskOutcome = { counts: { succeeded: 0, skipped: 0, failed: 0, unprocessed: 0 }, failures: [], error: raw.appError };
      completeTransfer(request.handle, failed);
      appendTransferReport("export", failed, request.handle);
      setNotice(null);
    },
  });
  const runExport = async (targetDir: string, hashes: readonly AssetId[], policy: ConflictPolicy): Promise<void> => {
    setError(null);
    const registration = registerTransferTask(libraryId, "导出图片", "export");
    if (registration.kind === "rejected") {
      setError({ code: "transfer.already_running", detail: `任务 ${registration.conflictingTaskId} 正在运行` });
      return;
    }
    setPlan(null);
    exportJob.mutate({ hashes, targetDir, policy, handle: registration.handle, appTaskId: registration.appTaskId });
  };
  const chooseExport = async (): Promise<void> => {
    if (disabled || busy || selectedHashes.length === 0) return;
    setNotice(null);
    let targetDir: string | null;
    try {
      targetDir = await appPlatform.pickExportDirectory();
    } catch (raw) {
      if (!(raw instanceof IpcError)) throw raw;
      setError(raw.appError);
      return;
    }
    if (targetDir === null) return;
    try {
      const entries = await planExport([...selectedHashes], targetDir);
      if (entries.some((entry) => entry.existing)) setPlan({ hashes: [...selectedHashes], targetDir, entries });
      else await runExport(targetDir, selectedHashes, "skip");
    } catch (raw) {
      if (!(raw instanceof IpcError)) throw raw;
      setError(raw.appError);
    }
  };
  const copy = async (): Promise<void> => {
    if (single === null || disabled || busy) return;
    setNotice(null);
    try { await appPlatform.copyImageToClipboard(single.hash); setError(null); setNotice("已复制图片到剪贴板"); }
    catch (raw) { if (!(raw instanceof IpcError)) throw raw; setError(raw.appError); }
  };
  const open = async (): Promise<void> => {
    if (single === null || disabled || busy) return;
    setNotice(null);
    try { await appPlatform.openWithDefaultApp(single.hash); setError(null); setNotice("已交给 Windows 默认程序打开"); }
    catch (raw) { if (!(raw instanceof IpcError)) throw raw; setError(raw.appError); }
  };
  const exportBusy = exportJob.isPending || busy;
  return <>
    <div className={styles.controls} role="group" aria-label="图片出站操作">
      {single === null ? null : <>
        <Tooltip content="复制图像"><IconButton size="compact" label="复制图像" icon={<CopyIcon />} disabled={!active || disabled || exportBusy} onClick={() => void copy()} /></Tooltip>
        <Tooltip content="用默认程序打开"><IconButton size="compact" label="用默认程序打开" icon={<ArrowSquareOutIcon />} disabled={!active || disabled || exportBusy} onClick={() => void open()} /></Tooltip>
      </>}
      {assets.length === 0 ? null : <Tooltip content="导出原图"><IconButton size="compact" label="导出原图" icon={<ExportIcon />} disabled={!active || disabled || exportBusy} onClick={() => void chooseExport()} /></Tooltip>}
    </div>
    {notice === null && error === null ? null : <p className={error === null ? undefined : styles.error} role={error === null ? "status" : "alert"}>{error === null ? notice : formatError(error)}</p>}
    {plan === null ? null : <Dialog title="导出文件冲突" description={`目标目录中有 ${plan.entries.filter((entry) => entry.existing).length} 个同名文件。请选择每个冲突的统一处理方式。`} open onOpenChange={(openState) => { if (!openState && !exportBusy) setPlan(null); }} onCloseAutoFocus={(event) => { event.preventDefault(); document.querySelector<HTMLButtonElement>('[aria-label="图片出站操作"] button:last-of-type')?.focus(); }}>
      <div className={styles.conflicts}>{plan.entries.filter((entry) => entry.existing).map((entry) => <p key={entry.hash}>{entry.display_filename}</p>)}</div>
      <div className={styles.controls}>
        <Button onClick={() => void runExport(plan.targetDir, plan.hashes, "skip")} disabled={exportBusy}>跳过冲突并导出</Button>
        <Button onClick={() => void runExport(plan.targetDir, plan.hashes, "auto_number")} disabled={exportBusy}>自动编号并导出</Button>
        <ConfirmDialog title="覆盖现有导出文件？" description="同名文件将被原图覆盖，此操作无法撤销。" confirmLabel="确认覆盖" trigger={<Button variant="danger" disabled={exportBusy}>覆盖并导出</Button>} onConfirm={() => void runExport(plan.targetDir, plan.hashes, "overwrite")} />
      </div>
    </Dialog>}
  </>;
}

/** 导出异常独立于当前选择，返回原素材库时继续显示，直到使用者逐份关闭。 */
export function AssetOutboundFeedback({ libraryId }: { libraryId: LibraryId }): ReactNode {
  const reports = usePersistentTransferReports(libraryId, "export");
  return reports.map((report) => <TransferOutcomeReport key={report.id} report={report} label="导出结果" title="导出未完全完成"
    onDismiss={() => dismissTransferReport(libraryId, report.id)} />);
}
