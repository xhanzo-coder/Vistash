import { useId, useState, type ReactNode } from "react";
import type { LibraryId } from "../../../app/common";
import { formatError, IpcError } from "../../../shared/errors";
import type { AssetRow, BatchReport } from "../../../shared/types";
import { Button } from "../../../ui/button/Button";
import { Dialog } from "../../../ui/dialog/Dialog";
import type { useAssetActions } from "./useAssetActions";
import type { ImagePromptRelations } from "../../image-prompt-relations";
import { PromptAssociationDialog } from "./PromptAssociationDialog";
import styles from "./AssetInspector.module.css";

export type BatchEdit = { kind: "tags"; hashes: readonly string[] } | { kind: "link"; assets: readonly AssetRow[] };
type BatchEditProps = { edit: BatchEdit | null; libraryId: LibraryId; relations: ImagePromptRelations; active: boolean; busy: boolean; run: ReturnType<typeof useAssetActions>["run"]; onClose: () => void; restoreFocus: () => void };

/** 表单只在打开期间存在；目标属于打开时的编辑会话，不随集合或选择变化。 */
export function BatchEditDialog({ edit, libraryId, relations, active, busy, run, onClose, restoreFocus }: BatchEditProps): ReactNode {
  if (edit?.kind === "link") return <PromptAssociationDialog active={active} libraryId={libraryId} relations={relations} targets={edit.assets} onClose={onClose}
    onCloseAutoFocus={(event) => { event.preventDefault(); restoreFocus(); }} />;
  return <Dialog title="批量编辑标签" description="添加或移除一个标签，不覆盖图片已有的其他标签。" open={active && edit !== null}
    onOpenChange={(open) => { if (!open && !busy) onClose(); }} onCloseAutoFocus={(event) => { event.preventDefault(); restoreFocus(); }}>
    {edit === null ? null : <TagEditForm edit={edit} busy={busy} run={run} onClose={onClose} />}
  </Dialog>;
}

function TagEditForm({ edit, busy, run, onClose }: Pick<BatchEditProps, "busy" | "run" | "onClose"> & { edit: Extract<BatchEdit, { kind: "tags" }> }): ReactNode {
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
