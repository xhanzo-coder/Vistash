import { useId, useState, type ReactNode } from "react";
import type { BatchReport } from "../../../shared/types";
import { formatError, IpcError } from "../../../shared/errors";
import { Button } from "../../../ui/button/Button";
import { Dialog } from "../../../ui/dialog/Dialog";
import type { useAssetActions } from "./useAssetActions";
import styles from "./AssetLibraryWorkspace.module.css";

/** 开启时冻结目标，部分失败仅重试失败项；移动从不增加第二个文件夹归属。 */
export function MoveAssetsDialog({ hashes, folders, disabled, busy, run }: {
  hashes: readonly string[];
  folders: readonly string[];
  disabled: boolean;
  busy: boolean;
  run: ReturnType<typeof useAssetActions>["run"];
}): ReactNode {
  const targetId = useId();
  const [open, setOpen] = useState(false);
  const [targets, setTargets] = useState<readonly string[]>([]);
  const [target, setTarget] = useState<string | null | undefined>(undefined);
  const [report, setReport] = useState<BatchReport | null>(null);
  const [error, setError] = useState<Error | null>(null);
  if (error !== null && !(error instanceof IpcError)) throw error;
  return <Dialog title="移动图片" description="移动后图片只属于所选文件夹；也可以移回未分类。" open={open}
    onOpenChange={(next) => {
      if (busy) return;
      if (next) { setTargets([...hashes]); setTarget(undefined); setReport(null); setError(null); }
      setOpen(next);
    }} trigger={<Button size="compact" disabled={disabled}>移动</Button>}>
    <form className={styles.folderForm} onSubmit={(event) => {
      event.preventDefault();
      if (target === undefined || targets.length === 0) throw new Error("移动必须指定目标及素材");
      setError(null);
      run({ kind: "move", hashes: [...targets], folder: target }, {
        onSuccess: (result) => {
          setReport(result);
          if (result.failures.length === 0) setOpen(false);
          else setTargets(result.failures.map((failure) => failure.id));
        },
        onError: setError,
      });
    }}>
      <p>待移动 {targets.length} 张图片</p>
      <label htmlFor={targetId}>目标文件夹</label>
      <select id={targetId} name="move-target" value={target === undefined ? "" : target === null ? "root" : `folder:${target}`} disabled={busy}
        onChange={(event) => {
          if (event.target.value === "root") { setTarget(null); return; }
          const path = folders.find((folder) => `folder:${folder}` === event.target.value);
          if (path === undefined) throw new Error("移动目标不在文件夹清单中");
          setTarget(path);
        }}>
        <option value="" disabled>请选择目标</option>
        <option value="root">未分类</option>
        {folders.map((folder) => <option key={folder} value={`folder:${folder}`}>{folder}</option>)}
      </select>
      {error === null ? null : <p role="alert" className={styles.error}>{error.message}</p>}
      {report === null ? null : report.failures.map((failure) => <p key={failure.id} role="alert" className={styles.error}>{failure.display_name}：{formatError(failure.error)}</p>)}
      <Button type="submit" variant="primary" disabled={busy || target === undefined}>{busy ? "正在移动…" : report === null ? "确认移动" : "重试失败项"}</Button>
    </form>
  </Dialog>;
}
