import { useId, useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import type { LibraryId } from "../../../app/common";
import { createFolder, deleteFolder, renameFolder } from "../../../shared/ipc";
import { IpcError } from "../../../shared/errors";
import { Button } from "../../../ui/button/Button";
import { ConfirmDialog, Dialog } from "../../../ui/dialog/Dialog";
import styles from "./AssetLibraryWorkspace.module.css";

export type FolderChange = { kind: "create"; path: string } | { kind: "rename"; previousPath: string; path: string } | { kind: "delete"; path: string };
type FolderRequest = { kind: "create"; parent: string | null; name: string } | { kind: "rename"; path: string; name: string };

/** 文件夹表单拥有未保存输入；后端成功之前不改查询和导航。 */
type FolderControlsProps = {
  libraryId: LibraryId;
  currentFolder: string | null;
  folders: readonly string[];
  disabled: boolean;
  onCommitted: (change: FolderChange) => Promise<void>;
};

export function FolderEditor({ mode, libraryId, currentFolder, folders, disabled, onCommitted }: FolderControlsProps & { mode: "create" | "rename" }): ReactNode {
  const nameId = useId();
  const parentId = useId();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [parent, setParent] = useState<string | null>(currentFolder);
  const title = mode === "create" ? "新建文件夹" : "重命名文件夹";
  const save = useMutation({
    scope: { id: `asset-organization:${libraryId}` },
    mutationFn: (request: FolderRequest) => request.kind === "create" ? createFolder(request.parent, request.name) : renameFolder(request.path, request.name, () => undefined),
    onSuccess: async (path, request) => {
      await onCommitted(request.kind === "create" ? { kind: "create", path } : { kind: "rename", previousPath: request.path, path });
      setOpen(false);
    },
  });
  if (save.error !== null && !(save.error instanceof IpcError)) throw save.error;
  return <Dialog title={title} description={mode === "create" ? "创建逻辑文件夹，不会在磁盘建立素材目录。" : "重命名会更新所有子文件夹和素材归属，不改动图片本体。"}
    open={open} onOpenChange={(next) => {
      if (save.isPending) return;
      if (next) { setName(mode === "create" || currentFolder === null ? "" : currentFolder.slice(currentFolder.lastIndexOf("/") + 1)); setParent(currentFolder); save.reset(); }
      setOpen(next);
    }} trigger={<Button size="compact" disabled={disabled || (mode === "rename" && folders.length === 0)}>{title}</Button>}>
    <form className={styles.folderForm} onSubmit={(event) => {
      event.preventDefault();
      if (mode === "create") save.mutate({ kind: "create", parent, name });
      else {
        if (parent === null) throw new Error("未选择重命名目标");
        save.mutate({ kind: "rename", path: parent, name });
      }
    }}>
      <label htmlFor={parentId}>{mode === "create" ? "父文件夹" : "目标文件夹"}</label>
      <select id={parentId} name="folder-parent" value={parent === null ? "" : parent} disabled={save.isPending}
        onChange={(event) => {
          const path = event.target.value;
          setParent(path === "" ? null : path);
          if (mode === "rename") setName(path.slice(path.lastIndexOf("/") + 1));
        }}>
        <option value="" disabled={mode === "rename"}>{mode === "create" ? "库根位置" : "请选择文件夹"}</option>
        {folders.map((path) => <option key={path} value={path}>{path}</option>)}
      </select>
      <label htmlFor={nameId}>文件夹名称</label>
      <input id={nameId} name="folder-name" value={name} onChange={(event) => setName(event.target.value)} required autoComplete="off" disabled={save.isPending} />
      {save.error === null ? null : <p role="alert" className={styles.error}>{save.error.message}</p>}
      <Button type="submit" variant="primary" disabled={save.isPending || name.trim().length === 0 || (mode === "rename" && parent === null)}>{save.isPending ? "正在保存…" : mode === "create" ? "创建文件夹" : "保存名称"}</Button>
    </form>
  </Dialog>;
}

/** 删除只作用于逻辑组织；二次确认明确告知子树范围与图片保留语义。 */
export function DeleteFolderDialog({ libraryId, currentFolder, folders, disabled, onCommitted }: FolderControlsProps): ReactNode {
  const targetId = useId();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<string | null>(currentFolder);
  const deletion = useMutation({
    scope: { id: `asset-organization:${libraryId}` },
    mutationFn: (path: string) => deleteFolder(path),
    onSuccess: async (_result, path) => { await onCommitted({ kind: "delete", path }); setOpen(false); },
  });
  if (deletion.error !== null && !(deletion.error instanceof IpcError)) throw deletion.error;
  return <Dialog title="删除文件夹" description="仅删除文件夹组织关系，图片保留在素材库。" open={open}
    onOpenChange={(next) => {
      if (deletion.isPending) return;
      if (next) { setTarget(currentFolder); deletion.reset(); }
      setOpen(next);
    }} trigger={<Button size="compact" disabled={disabled || folders.length === 0}>删除文件夹</Button>}>
    <div className={styles.folderForm}>
      <label htmlFor={targetId}>目标文件夹</label>
      <select id={targetId} name="folder-target" value={target === null ? "" : target} disabled={deletion.isPending}
        onChange={(event) => setTarget(event.target.value)}>
        <option value="" disabled>请选择文件夹</option>
        {folders.map((path) => <option key={path} value={path}>{path}</option>)}
      </select>
      {deletion.error === null ? null : <p role="alert" className={styles.error}>{deletion.error.message}</p>}
      {deletion.isPending ? <p role="status">正在删除文件夹…</p> : null}
      <ConfirmDialog title="删除文件夹及全部子文件夹？"
        description={target === null ? "请先选择文件夹。" : `删除「${target}」及其全部子文件夹，不会删除图片；对应图片会回到未分类。`}
        trigger={<Button variant="danger" disabled={target === null || deletion.isPending}>继续删除</Button>}
        confirmLabel="确认删除文件夹" onConfirm={() => {
          if (target === null) throw new Error("未选择删除目标");
          deletion.mutate(target);
        }} />
    </div>
  </Dialog>;
}
