import { useRef, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { parseAssetId, type AssetId, type LibraryId } from "../../../app/common";
import { appTaskCenter } from "../../../app/runtime";
import type { TaskOutcome } from "../../../app/taskCenter";
import { batchAddAssetTag, batchDeleteAssets, batchLinkToPrompt, batchMoveAssetsToFolder, batchRemoveAssetTag, batchSetAssetFavorite, setAssetFavorite } from "../../../shared/ipc";
import { formatError, IpcError } from "../../../shared/errors";
import type { BatchProgress, BatchReport } from "../../../shared/types";
import { Button } from "../../../ui/button/Button";
import { assetKeys } from "./queryKeys";
import styles from "./AssetLibraryWorkspace.module.css";
import type { ImagePromptRelations } from "../../image-prompt-relations";

type AssetAction =
  | { kind: "favorite-one"; hash: AssetId; value: boolean }
  | { kind: "favorite"; hashes: string[]; value: boolean }
  | { kind: "trash"; hashes: string[] }
  | { kind: "tag"; hashes: string[]; tag: string; add: boolean }
  | { kind: "link"; hashes: string[]; promptId: string; promptTitle: string }
  | { kind: "move"; hashes: string[]; folder: string | null };

type ActionResult = {
  id: number;
  title: string;
  result: { kind: "completed"; report: BatchReport } | { kind: "failed"; error: Error };
};

function titleOf(action: AssetAction): string {
  if (action.kind === "move") return action.folder === null ? "移到未分类" : `移动到 ${action.folder}`;
  if (action.kind === "tag") return `${action.add ? "添加" : "移除"}标签「${action.tag}」`;
  if (action.kind === "link") return `关联提示词「${action.promptTitle}」`;
  return action.kind === "trash" ? "移入回收站" : action.value ? "收藏图片" : "取消收藏";
}

/** 目标属于这次动作，而不是异步执行时的选择；结果不随选择栏卸载而丢失。 */
export function useAssetActions(libraryId: LibraryId, relations: ImagePromptRelations) {
  const client = useQueryClient();
  const nextResultId = useRef(0);
  const taskIds = useRef(new WeakMap<object, string>());
  const [results, setResults] = useState<readonly ActionResult[]>([]);
  const action = useMutation({
    scope: { id: `asset-organization:${libraryId}` },
    mutationFn: async (request: AssetAction): Promise<BatchReport> => {
      const registration = appTaskCenter.register({ kind: "batch_organization", title: titleOf(request), libraryId, stoppable: false, concurrencyKey: null });
      if (registration.kind !== "registered") throw new Error("批量组织任务意外触发并发拒绝");
      taskIds.current.set(request, registration.record.id);
      const reportProgress = (progress: BatchProgress): void => {
        appTaskCenter.reportProgress(registration.record.id, { kind: "items", done: progress.done, total: progress.total });
      };
      switch (request.kind) {
        case "favorite-one":
          await setAssetFavorite(request.hash, request.value);
          return { succeeded: 1, failures: [] };
        case "favorite": return batchSetAssetFavorite(request.hashes, request.value, reportProgress);
        case "trash": return batchDeleteAssets(request.hashes, reportProgress);
        case "move": return batchMoveAssetsToFolder(request.hashes, request.folder, reportProgress);
        case "tag": return request.add ? batchAddAssetTag(request.hashes, request.tag, reportProgress) : batchRemoveAssetTag(request.hashes, request.tag, reportProgress);
        case "link": return batchLinkToPrompt(request.promptId, request.hashes, reportProgress);
      }
      const unexpected: never = request;
      throw new Error(`未知素材操作：${JSON.stringify(unexpected)}`);
    },
    onSuccess: async (report, request) => {
      const taskId = taskIds.current.get(request);
      if (taskId === undefined) throw new Error("批量组织成功但缺少任务中心标识");
      const outcome: TaskOutcome = { counts: { succeeded: report.succeeded, skipped: 0, failed: report.failures.length, unprocessed: 0 }, failures: report.failures.map((failure) => ({ displayName: failure.display_name, error: failure.error })), error: null };
      appTaskCenter.complete(taskId, outcome);
      if (report.failures.length > 0) {
        const result: ActionResult = { id: ++nextResultId.current, title: titleOf(request), result: { kind: "completed", report } };
        setResults((current) => [...current, result]);
      }
      const ids = new Set(request.kind === "favorite-one" ? [request.hash] : request.hashes);
      if (request.kind === "trash" || request.kind === "link") {
        const failed = new Set(report.failures.map((failure) => failure.id));
        const changed = request.hashes.filter((hash) => !failed.has(hash)).map(parseAssetId);
        const refreshError = await relations.synchronize(libraryId, {
          imageIds: changed,
          promptIds: request.kind === "link" ? [request.promptId] : [],
        });
        if (refreshError !== null) {
          const result: ActionResult = { id: ++nextResultId.current, title: titleOf(request), result: { kind: "failed", error: new IpcError(refreshError) } };
          setResults((current) => [...current, result]);
        }
      }
      await Promise.all([
        client.invalidateQueries({ queryKey: request.kind === "link" ? assetKeys.promptCandidatesRoot(libraryId) : assetKeys.collections(libraryId) }),
        client.invalidateQueries({ queryKey: assetKeys.details(libraryId), predicate: (query) => typeof query.queryKey[3] === "string" && ids.has(query.queryKey[3]) }),
      ]);
    },
    onError: (error, request) => {
      const taskId = taskIds.current.get(request);
      if (taskId !== undefined) {
        if (!(error instanceof IpcError)) throw error;
        appTaskCenter.complete(taskId, { counts: { succeeded: 0, skipped: 0, failed: 0, unprocessed: 0 }, failures: [], error: error.appError });
      }
      const result: ActionResult = { id: ++nextResultId.current, title: titleOf(request), result: { kind: "failed", error } };
      setResults((current) => [...current, result]);
    },
  });
  return { run: action.mutate, busy: action.isPending, results, dismiss: (id: number) => setResults((current) => current.filter((result) => result.id !== id)) };
}

export function ActionResults({ results, dismiss }: { results: readonly ActionResult[]; dismiss: (id: number) => void }): ReactNode {
  if (results.length === 0) return null;
  return <section className={styles.actionResults} aria-label="操作结果">
    {results.map(({ id, title, result }) => {
      if (result.kind === "failed" && !(result.error instanceof IpcError)) throw result.error;
      return <article key={id}>
        <div className={styles.resultHeading}>
          <strong>{title}</strong>
          <Button size="compact" variant="ghost" aria-label={`关闭${title}报告`} onClick={() => dismiss(id)}>关闭</Button>
        </div>
        {result.kind === "failed" ? <p role="alert" className={styles.error}>{result.error.message}</p> : <>
          <p role="status">成功 {result.report.succeeded} 项，失败 {result.report.failures.length} 项</p>
          {result.report.failures.length > 0 ? <ul>{result.report.failures.map((failure) =>
            <li key={failure.id} role="alert">{failure.display_name}：{formatError(failure.error)}</li>,
          )}</ul> : null}
        </>}
      </article>;
    })}
  </section>;
}
