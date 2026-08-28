import { useRef, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AssetId, LibraryId } from "../../../app/common";
import { batchDeleteAssets, batchMoveAssetsToFolder, batchSetAssetFavorite, setAssetFavorite } from "../../../shared/ipc";
import { formatError, IpcError } from "../../../shared/errors";
import type { BatchReport } from "../../../shared/types";
import { Button } from "../../../ui/button/Button";
import { assetKeys } from "./queryKeys";
import styles from "./AssetLibraryWorkspace.module.css";

type AssetAction =
  | { kind: "favorite-one"; hash: AssetId; value: boolean }
  | { kind: "favorite"; hashes: string[]; value: boolean }
  | { kind: "trash"; hashes: string[] }
  | { kind: "move"; hashes: string[]; folder: string | null };

type ActionResult = {
  id: number;
  title: string;
  result: { kind: "completed"; report: BatchReport } | { kind: "failed"; error: Error };
};

function titleOf(action: AssetAction): string {
  if (action.kind === "move") return action.folder === null ? "移到未分类" : `移动到 ${action.folder}`;
  return action.kind === "trash" ? "移入回收站" : action.value ? "收藏图片" : "取消收藏";
}

/** 目标属于这次动作，而不是异步执行时的选择；结果不随选择栏卸载而丢失。 */
export function useAssetActions(libraryId: LibraryId) {
  const client = useQueryClient();
  const nextResultId = useRef(0);
  const [results, setResults] = useState<readonly ActionResult[]>([]);
  const action = useMutation({
    scope: { id: `asset-organization:${libraryId}` },
    mutationFn: async (request: AssetAction): Promise<BatchReport> => {
      switch (request.kind) {
        case "favorite-one":
          await setAssetFavorite(request.hash, request.value);
          return { succeeded: 1, failures: [] };
        case "favorite": return batchSetAssetFavorite(request.hashes, request.value, () => undefined);
        case "trash": return batchDeleteAssets(request.hashes, () => undefined);
        case "move": return batchMoveAssetsToFolder(request.hashes, request.folder, () => undefined);
      }
      const unexpected: never = request;
      throw new Error(`未知素材操作：${JSON.stringify(unexpected)}`);
    },
    onSuccess: async (report, request) => {
      const result: ActionResult = { id: ++nextResultId.current, title: titleOf(request), result: { kind: "completed", report } };
      setResults((current) => [...current, result]);
      const ids = new Set(request.kind === "favorite-one" ? [request.hash] : request.hashes);
      await Promise.all([
        client.invalidateQueries({ queryKey: assetKeys.collections(libraryId) }),
        client.invalidateQueries({ queryKey: assetKeys.details(libraryId), predicate: (query) => typeof query.queryKey[3] === "string" && ids.has(query.queryKey[3]) }),
      ]);
    },
    onError: (error, request) => {
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
