import { useId, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { parseAssetId, type LibraryId } from "../../../app/common";
import { moveAssetToFolder, setAssetFavorite, setAssetTags } from "../../../shared/ipc";
import { IpcError } from "../../../shared/errors";
import type { AssetRow } from "../../../shared/types";
import { Button } from "../../../ui/button/Button";
import { assetKeys } from "./queryKeys";
import styles from "./AssetInspector.module.css";

type OrganizationEdit = { kind: "move"; folder: string | null } | { kind: "tags"; tags: string[]; clearDraft: boolean } | { kind: "favorite"; value: boolean };

/** 每张图片各有编辑会话；动作只在成功后展示权威新值，失败保留输入。 */
export function AssetOrganization({ libraryId, asset, folders, disabled }: { libraryId: LibraryId; asset: AssetRow; folders: readonly string[]; disabled: boolean }): ReactNode {
  const client = useQueryClient();
  const tagId = useId();
  const [tag, setTag] = useState("");
  const [folderDraft, setFolderDraft] = useState<string | null>(null);
  const save = useMutation({
    scope: { id: `asset-organization:${libraryId}` },
    mutationFn: (edit: OrganizationEdit) => {
      switch (edit.kind) {
        case "move": return moveAssetToFolder(asset.hash, edit.folder);
        case "tags": return setAssetTags(asset.hash, edit.tags);
        case "favorite": return setAssetFavorite(asset.hash, edit.value);
      }
      const unexpected: never = edit;
      throw new Error(`未知组织操作：${JSON.stringify(unexpected)}`);
    },
    onSuccess: async (_result, edit) => {
      await Promise.all([
        client.invalidateQueries({ queryKey: assetKeys.collections(libraryId) }),
        client.invalidateQueries({ queryKey: assetKeys.detail(libraryId, parseAssetId(asset.hash)), exact: true }),
      ]);
      if (edit.kind === "move") setFolderDraft(null);
      if (edit.kind === "tags" && edit.clearDraft) setTag("");
    },
  });
  if (save.error !== null && !(save.error instanceof IpcError)) throw save.error;
  if (asset.deleted_at !== null) return <div className={styles.form}><p>原文件夹：{asset.folder === null ? "未分类" : asset.folder}</p><p>标签：{asset.tags.length === 0 ? "无" : asset.tags.join("、")}</p><p>{asset.favorite ? "已收藏" : "未收藏"}</p><p className={styles.hint}>回收站中的组织信息只读，还原后可继续编辑。</p></div>;
  return <div className={styles.form}>
    <label>所在文件夹<select name="asset-folder" aria-label="图片所在文件夹" disabled={disabled || save.isPending} value={folderDraft === null ? asset.folder === null ? "root" : `folder:${asset.folder}` : folderDraft}
      onChange={(event) => {
        const choice = event.target.value;
        setFolderDraft(choice);
        save.mutate({ kind: "move", folder: choice === "root" ? null : choice.slice("folder:".length) });
      }}>
      <option value="root">未分类</option>{folders.map((folder) => <option value={`folder:${folder}`} key={folder}>{folder}</option>)}
    </select></label>
    {save.isError && save.variables.kind === "move" ? <Button size="compact" disabled={disabled} onClick={() => save.mutate(save.variables)}>重试移动</Button> : null}
    <Button size="compact" aria-pressed={asset.favorite} disabled={disabled || save.isPending} onClick={() => save.mutate({ kind: "favorite", value: !asset.favorite })}>{asset.favorite ? "取消此图片收藏" : "收藏此图片"}</Button>
    <div className={styles.tags} aria-label="图片标签">{asset.tags.length === 0 ? <span className={styles.hint}>暂无标签</span> : asset.tags.map((item) => <Button key={item} size="compact" aria-label={`移除图片标签 ${item}`} disabled={disabled || save.isPending} onClick={() => save.mutate({ kind: "tags", tags: asset.tags.filter((value) => value !== item), clearDraft: false })}>{item}</Button>)}</div>
    <form className={styles.form} onSubmit={(event) => { event.preventDefault(); save.mutate({ kind: "tags", tags: [...asset.tags, tag], clearDraft: true }); }}>
      <label htmlFor={tagId}>添加图片标签</label>
      <input id={tagId} name="asset-new-tag" aria-label="添加图片标签" autoComplete="off" value={tag} disabled={disabled || save.isPending} onChange={(event) => setTag(event.target.value)} />
      <Button size="compact" type="submit" disabled={disabled || save.isPending || tag.trim().length === 0}>添加标签</Button>
    </form>
    {save.error === null ? null : <p role="alert" className={styles.error}>{save.error.message}</p>}
  </div>;
}
