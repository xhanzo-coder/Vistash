import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { parseAssetId, type AssetId, type LibraryId } from "../../../app/common";
import { appTaskCenter } from "../../../app/runtime";
import type { TaskOutcome } from "../../../app/taskCenter";
import { catalogSnapshot, purgeTrash, restoreAsset } from "../../../shared/ipc";
import { asAppError, formatError, IpcError } from "../../../shared/errors";
import type { AppError } from "../../../shared/types";
import { Button } from "../../../ui/button/Button";
import { assetKeys } from "./queryKeys";
import styles from "./AssetLibraryWorkspace.module.css";

export type TrashTarget = { hash: AssetId; displayName: string };
type RestoreReport = { restored: number; failures: Array<TrashTarget & { error: AppError }>; missing: Array<TrashTarget & { folders: string[] }>; unprocessed: readonly TrashTarget[] };
type PurgeOutcome = { kind: "purged"; purged: number; failures: Array<TrashTarget & { error: AppError }> } | { kind: "not-started" };
type TrashOutcome = { kind: "restored"; report: RestoreReport } | PurgeOutcome | { kind: "error"; operation: "还原" | "清空"; error: Error };
type TrashResult = { id: number } & TrashOutcome;

function requireTaskId(value: string | null | undefined, operation: string): string {
  if (value === null || value === undefined) throw new Error(`${operation}任务结束但缺少任务中心标识`);
  return value;
}

function restoreTaskOutcome(report: RestoreReport): TaskOutcome {
  return {
    counts: {
      succeeded: report.restored,
      skipped: 0,
      failed: report.failures.length,
      unprocessed: report.unprocessed.length,
    },
    failures: report.failures.map((item) => ({ displayName: item.displayName, error: item.error })),
    error: null,
  };
}

function purgeTaskOutcome(outcome: PurgeOutcome): TaskOutcome {
  if (outcome.kind === "not-started") {
    return {
      counts: { succeeded: 0, skipped: 0, failed: 0, unprocessed: 1 },
      failures: [],
      error: null,
    };
  }
  return {
    counts: { succeeded: outcome.purged, skipped: 0, failed: outcome.failures.length, unprocessed: 0 },
    failures: outcome.failures.map((item) => ({ displayName: item.displayName, error: item.error })),
    error: null,
  };
}

function failedTaskOutcome(error: AppError): TaskOutcome {
  return {
    counts: { succeeded: 0, skipped: 0, failed: 0, unprocessed: 0 },
    failures: [],
    error,
  };
}

/** 报告直到使用者关闭才移除；切库或旧请求稍后完成不能丢失这份操作记录。 */
class TrashHistory {
  private records: readonly TrashResult[] = [];
  private nextId = 0;
  private readonly listeners = new Set<() => void>();
  snapshot = (): readonly TrashResult[] => this.records;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  append(outcome: TrashOutcome): void {
    this.records = [...this.records, { id: ++this.nextId, ...outcome }];
    for (const listener of this.listeners) listener();
  }
  dismiss = (id: number): void => {
    this.records = this.records.filter((record) => record.id !== id);
    for (const listener of this.listeners) listener();
  };
}

const histories = new WeakMap<QueryClient, Map<LibraryId, TrashHistory>>();

/** 还原逐项沿用 Rust 单素材事务；切库后不再向新的当前库发出后续写入。 */
export function useTrashActions(libraryId: LibraryId) {
  const client = useQueryClient();
  const mounted = useRef(true);
  const [history] = useState(() => {
    let libraries = histories.get(client);
    if (libraries === undefined) { libraries = new Map(); histories.set(client, libraries); }
    let records = libraries.get(libraryId);
    if (records === undefined) { records = new TrashHistory(); libraries.set(libraryId, records); }
    return records;
  });
  const results = useSyncExternalStore(history.subscribe, history.snapshot);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const restoreTaskIds = useRef(new WeakMap<object, string>());
  const purgeTaskId = useRef<string | null>(null);
  const refreshTrashState = async (): Promise<void> => {
    await Promise.all([
      client.invalidateQueries({ queryKey: assetKeys.collections(libraryId) }),
      client.invalidateQueries({ queryKey: assetKeys.details(libraryId) }),
      client.invalidateQueries({ queryKey: assetKeys.promptCandidatesRoot(libraryId) }),
    ]);
  };
  const restore = useMutation({
    scope: { id: `asset-organization:${libraryId}` },
    mutationFn: async (targets: readonly TrashTarget[]): Promise<RestoreReport> => {
      if (targets.length === 0) throw new Error("还原必须指定图片");
      const registration = appTaskCenter.register({ kind: "batch_organization", title: "还原图片", libraryId, stoppable: false, concurrencyKey: null });
      if (registration.kind !== "registered") throw new Error("还原任务意外触发并发拒绝");
      restoreTaskIds.current.set(targets, registration.record.id);
      const report: RestoreReport = { restored: 0, failures: [], missing: [], unprocessed: [] };
      for (const [index, target] of targets.entries()) {
        if (!mounted.current) { report.unprocessed = targets.slice(index); break; }
        try {
          const outcome = await restoreAsset(target.hash);
          report.restored += 1;
          if (outcome.missing_folders.length > 0) report.missing.push({ ...target, folders: outcome.missing_folders });
        } catch (error) {
          if (!(error instanceof IpcError)) throw error;
          report.failures.push({ ...target, error: error.appError });
        }
      }
      return report;
    },
    onSuccess: (report, targets) => {
      const taskId = requireTaskId(restoreTaskIds.current.get(targets), "还原");
      restoreTaskIds.current.delete(targets);
      appTaskCenter.complete(taskId, restoreTaskOutcome(report));
      if (report.failures.length > 0 || report.missing.length > 0 || report.unprocessed.length > 0) {
        history.append({ kind: "restored", report });
      }
    },
    onError: (error, targets) => {
      const taskId = requireTaskId(restoreTaskIds.current.get(targets), "还原");
      restoreTaskIds.current.delete(targets);
      const appError = asAppError(error);
      appTaskCenter.complete(taskId, failedTaskOutcome(appError));
      if (!(error instanceof IpcError)) throw error;
      history.append({ kind: "error", operation: "还原", error });
    },
    onSettled: refreshTrashState,
  });
  const purge = useMutation({
    scope: { id: `asset-organization:${libraryId}` },
    mutationFn: async (): Promise<PurgeOutcome> => {
      const registration = appTaskCenter.register({ kind: "batch_organization", title: "清空图片回收站", libraryId, stoppable: false, concurrencyKey: null });
      if (registration.kind !== "registered") throw new Error("清空回收站任务意外触发并发拒绝");
      purgeTaskId.current = registration.record.id;
      if (!mounted.current) return { kind: "not-started" };
      // 清空作用于整个回收站；先取得完整显示名，不以当前筛选或来源名代替。
      const snapshot = await catalogSnapshot({ text: "", tags: [], folder: { kind: "all" }, favorite: null, location: "trash" });
      if (!mounted.current) return { kind: "not-started" };
      const names = new Map(snapshot.assets.map((asset) => [asset.hash, asset.display_filename]));
      const outcome = await purgeTrash();
      return { kind: "purged", purged: outcome.purged, failures: outcome.failures.map((failure) => {
        const displayName = names.get(failure.hash);
        if (displayName === undefined) throw new Error(`清空结果包含快照之外的图片：${failure.hash}`);
        return { hash: parseAssetId(failure.hash), displayName, error: failure.error };
      }) };
    },
    onSuccess: (outcome) => {
      const taskId = requireTaskId(purgeTaskId.current, "清空回收站");
      purgeTaskId.current = null;
      appTaskCenter.complete(taskId, purgeTaskOutcome(outcome));
      if (outcome.kind === "not-started" || outcome.failures.length > 0) history.append(outcome);
    },
    onError: (error) => {
      const taskId = requireTaskId(purgeTaskId.current, "清空回收站");
      purgeTaskId.current = null;
      const appError = asAppError(error);
      appTaskCenter.complete(taskId, failedTaskOutcome(appError));
      if (!(error instanceof IpcError)) throw error;
      history.append({ kind: "error", operation: "清空", error });
    },
    // 清空可能已删除部分图片才在索引重建时失败，失败同样要重取权威状态。
    onSettled: refreshTrashState,
  });
  return { restore: restore.mutate, purge: purge.mutate, busy: restore.isPending || purge.isPending, operation: purge.isPending ? "清空" : "还原", results, dismiss: history.dismiss };
}

/** 成功、缺失原文件夹与失败分开呈现，结果不随选中图片离开回收站而卸载。 */
export function TrashResults({ actions }: { actions: ReturnType<typeof useTrashActions> }): ReactNode {
  if (actions.results.length === 0 && !actions.busy) return null;
  return <section aria-label="回收站操作结果" className={styles.actionResults}>
    {actions.busy ? <p role="status">正在{actions.operation}图片…</p> : null}
    {actions.results.map((result) => {
      if (result.kind === "error" && !(result.error instanceof IpcError)) throw result.error;
      const operation = result.kind === "restored" ? "还原" : result.kind === "error" ? result.operation : "清空";
      return <article key={result.id}>
        <div className={styles.resultHeading}><strong>{operation}结果</strong><Button size="compact" variant="ghost" aria-label={`关闭${operation}报告`} onClick={() => actions.dismiss(result.id)}>关闭</Button></div>
        {result.kind === "error" ? <><p role="alert" className={styles.error}>{result.error.message}</p><p>操作未完成，请以刷新后的回收站内容为准。</p></> : result.kind === "not-started" ? <p role="status">切库后未执行清空。</p> : result.kind === "purged" ? <>
          <p role="status">已永久删除 {result.purged} 张图片，失败 {result.failures.length} 张</p>
          {result.failures.map((item) => <p key={item.hash} role="alert" className={styles.error}>{item.displayName}：{formatError(item.error)}</p>)}
        </> : <>
          <p role="status">已还原 {result.report.restored} 张图片，失败 {result.report.failures.length} 张，未处理 {result.report.unprocessed.length} 张</p>
          {result.report.missing.map((item) => <p key={item.hash} role="status">{item.displayName}：已还原到未分类；原文件夹「{item.folders.join("、")}」不存在。[trash.restore_target_folder_missing]</p>)}
          {result.report.failures.map((item) => <p key={item.hash} role="alert" className={styles.error}>{item.displayName}：{formatError(item.error)}</p>)}
          {result.report.unprocessed.length > 0 ? <p>切库后未继续处理：{result.report.unprocessed.map((item) => item.displayName).join("、")}</p> : null}
        </>}
      </article>;
    })}
  </section>;
}
