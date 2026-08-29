import { useDeferredValue, useId, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { LibraryId } from "../../../app/common";
import { promptSnapshot } from "../../../shared/ipc";
import { formatError, IpcError } from "../../../shared/errors";
import type { BatchReport } from "../../../shared/types";
import { Button } from "../../../ui/button/Button";
import { Dialog } from "../../../ui/dialog/Dialog";
import { SearchField } from "../../../ui/search-field/SearchField";
import { assetKeys } from "./queryKeys";
import { promptTitle } from "./AssetPromptLinks";
import type { useAssetActions } from "./useAssetActions";
import styles from "./AssetInspector.module.css";

export type BatchEdit = { kind: "tags" | "link"; hashes: readonly string[] };
type BatchEditProps = { edit: BatchEdit | null; libraryId: LibraryId; active: boolean; busy: boolean; run: ReturnType<typeof useAssetActions>["run"]; onClose: () => void; restoreFocus: () => void };

/** 表单只在打开期间存在；目标属于打开时的编辑会话，不随集合或选择变化。 */
export function BatchEditDialog({ edit, libraryId, active, busy, run, onClose, restoreFocus }: BatchEditProps): ReactNode {
  return <Dialog title={edit?.kind === "link" ? "批量关联提示词" : "批量编辑标签"} description={edit?.kind === "link" ? "把选中图片与一条现有提示词建立普通关联，不修改图片内容。" : "添加或移除一个标签，不覆盖图片已有的其他标签。"} open={active && edit !== null}
    onOpenChange={(open) => { if (!open && !busy) onClose(); }} onCloseAutoFocus={(event) => { event.preventDefault(); restoreFocus(); }}>
    {edit === null ? null : edit.kind === "tags" ? <TagEditForm edit={edit} busy={busy} run={run} onClose={onClose} /> : <LinkEditForm libraryId={libraryId} edit={edit} busy={busy} run={run} onClose={onClose} />}
  </Dialog>;
}

function LinkEditForm({ edit, libraryId, busy, run, onClose }: Pick<BatchEditProps, "libraryId" | "busy" | "run" | "onClose"> & { edit: BatchEdit }): ReactNode {
  const groupId = useId();
  const [targets, setTargets] = useState(edit.hashes);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [choice, setChoice] = useState<{ id: string; title: string } | null>(null);
  const [report, setReport] = useState<BatchReport | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const candidates = useQuery({
    queryKey: assetKeys.promptCandidates(libraryId, deferredSearch),
    queryFn: async ({ signal }) => {
      signal.throwIfAborted();
      const result = await promptSnapshot({ text: deferredSearch, tags: [], folder: { kind: "all" }, favorite: null, location: "active" });
      signal.throwIfAborted();
      return result.prompts;
    },
    enabled: report === null,
  });
  for (const failure of [error, candidates.error]) if (failure !== null && !(failure instanceof IpcError)) throw failure;
  const canSubmit = choice !== null && (report !== null || (!candidates.isError && !candidates.isFetching && search === deferredSearch && candidates.data?.some((prompt) => prompt.id === choice.id) === true));
  return <form className={styles.form} onSubmit={(event) => {
    event.preventDefault();
    if (busy || !canSubmit) return;
    if (choice === null || targets.length === 0) throw new Error("批量关联必须指定提示词和图片");
    setError(null);
    run({ kind: "link", hashes: [...targets], promptId: choice.id, promptTitle: choice.title }, {
      onSuccess: (result) => {
        if (result.failures.length === 0) onClose();
        else { setReport(result); setTargets(result.failures.map((failure) => failure.id)); }
      },
      onError: setError,
    });
  }}>
    <p>待关联 {targets.length} 张图片</p>
    <SearchField label="搜索目标提示词" name="batch-link-prompt" placeholder="按标题或正文搜索…" value={search} disabled={busy || report !== null} onValueChange={(text) => { setSearch(text); setChoice(null); }} />
    {candidates.isError && report === null ? <div><p role="alert" className={styles.error}>{candidates.error.message}</p><Button size="compact" onClick={() => void candidates.refetch()}>重试读取提示词</Button></div> : candidates.isPending ? <p role="status">正在读取提示词…</p> : <fieldset className={styles.candidates} disabled={busy || report !== null || search !== deferredSearch}>
      <legend>选择一条正常提示词</legend>
      {candidates.data?.length === 0 ? <p className={styles.hint}>没有匹配的正常提示词。</p> : candidates.data?.map((prompt) => <label key={prompt.id}>
        <input type="radio" name={groupId} value={prompt.id} checked={choice?.id === prompt.id} onChange={() => setChoice({ id: prompt.id, title: promptTitle(prompt) })} /><span>{promptTitle(prompt)}</span>
      </label>)}
    </fieldset>}
    {error === null ? null : <p role="alert" className={styles.error}>{error.message}</p>}
    {report === null ? null : <div><p role="status">成功 {report.succeeded} 项，失败 {report.failures.length} 项；重试只处理失败图片。</p>{report.failures.map((failure) => <p key={failure.id} role="alert" className={styles.error}>{failure.display_name}：{formatError(failure.error)}</p>)}</div>}
    <Button type="submit" variant="primary" disabled={busy || !canSubmit}>{busy ? "正在关联…" : report === null ? "关联到所选图片" : "重试失败项"}</Button>
  </form>;
}

function TagEditForm({ edit, busy, run, onClose }: Pick<BatchEditProps, "busy" | "run" | "onClose"> & { edit: BatchEdit }): ReactNode {
  const tagId = useId();
  const modeId = useId();
  const errorId = useId();
  const [targets, setTargets] = useState(edit.hashes);
  const [tag, setTag] = useState("");
  const [add, setAdd] = useState(true);
  const [report, setReport] = useState<BatchReport | null>(null);
  const [error, setError] = useState<Error | null>(null);
  if (error !== null && !(error instanceof IpcError)) throw error;
  return <form className={styles.form} onSubmit={(event) => {
    event.preventDefault();
    if (busy) return;
    if (targets.length === 0 || tag.trim().length === 0) throw new Error("批量标签必须指定目标和标签");
    setError(null);
    run({ kind: "tag", hashes: [...targets], tag, add }, {
      onSuccess: (result) => {
        if (result.failures.length === 0) onClose();
        else { setReport(result); setTargets(result.failures.map((failure) => failure.id)); }
      },
      onError: setError,
    });
  }}>
    <p>待处理 {targets.length} 张图片</p>
    <fieldset className={styles.candidates} disabled={busy || report !== null}><legend>标签操作</legend>
      <label><input type="radio" name={modeId} value="add" checked={add} onChange={() => setAdd(true)} />添加标签</label>
      <label><input type="radio" name={modeId} value="remove" checked={!add} onChange={() => setAdd(false)} />移除标签</label>
    </fieldset>
    <label htmlFor={tagId}>标签名称</label><input id={tagId} name="batch-asset-tag" autoComplete="off" value={tag} disabled={busy || report !== null} onChange={(event) => setTag(event.target.value)} aria-describedby={error === null ? undefined : errorId} />
    {error === null ? null : <p id={errorId} role="alert" className={styles.error}>{error.message}</p>}
    {report === null ? null : <div><p role="status">成功 {report.succeeded} 项，失败 {report.failures.length} 项；重试只处理失败图片。</p>{report.failures.map((failure) => <p key={failure.id} role="alert" className={styles.error}>{failure.display_name}：{formatError(failure.error)}</p>)}</div>}
    <Button type="submit" variant="primary" disabled={busy || tag.trim().length === 0}>{busy ? "正在处理…" : report !== null ? "重试失败项" : add ? "添加到所选图片" : "从所选图片移除"}</Button>
  </form>;
}
