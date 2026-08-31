import { useEffect, useMemo, useState, type ReactNode } from "react";
import { DotsThreeIcon } from "@phosphor-icons/react/dist/csr/DotsThree";
import { LinkSimpleIcon } from "@phosphor-icons/react/dist/csr/LinkSimple";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";

import { asAppError } from "../../../shared/errors";
import { catalogSnapshot } from "../../../shared/ipc";
import type { AppError, AssetRow, PromptRow } from "../../../shared/types";
import { ErrorLine } from "../../../features/library/ErrorLine";
import { BatchToolbar } from "../../../features/workspace/batchToolbar";
import { summarizePromptCommon } from "../../../features/workspace/inspectorSummary";
import { useSelection } from "../../../features/workspace/selectionContext";
import { Button, IconButton } from "../../../ui/button/Button";
import { Dialog } from "../../../ui/dialog/Dialog";
import { Menu, MenuItem } from "../../../ui/overlays/Menu";
import styles from "./PromptWorkspace.module.css";

type Props = {
  prompts: readonly PromptRow[];
  folders: readonly string[];
  mutating: boolean;
  onBatchFolders: (ids: string[], folder: string, add: boolean) => void;
  onBatchTags: (ids: string[], tag: string, add: boolean) => void;
  onBatchFavorite: (ids: string[], favorite: boolean) => void;
  onBatchLinkImages: (hash: string, ids: string[]) => void;
  onBatchDelete: (ids: string[]) => void;
};

function BatchImagePicker({ disabled, count, onLink }: { disabled: boolean; count: number; onLink: (hash: string) => void }): ReactNode {
  const [candidates, setCandidates] = useState<readonly AssetRow[] | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [choice, setChoice] = useState("");
  useEffect(() => {
    let cancelled = false;
    void catalogSnapshot({ text: "", tags: [], folder: { kind: "all" }, favorite: null, location: "active" })
      .then((snapshot) => { if (!cancelled) { setCandidates(snapshot.assets); setError(null); } return undefined; })
      .catch((raw: unknown) => { if (!cancelled) setError(asAppError(raw)); return undefined; });
    return () => { cancelled = true; };
  }, []);
  if (error !== null) return <ErrorLine error={error} />;
  if (candidates === null) return <p role="status">正在读取图片候选…</p>;
  if (candidates.length === 0) return <p>图片库还没有可关联的图片。</p>;
  return <form className={styles.batchDialogForm} onSubmit={(event) => { event.preventDefault(); if (choice !== "") onLink(choice); }}>
    <label htmlFor="prompt-batch-image">目标图片</label>
    <select id="prompt-batch-image" name="prompt-batch-image" value={choice} onChange={(event) => setChoice(event.currentTarget.value)}>
      <option value="" disabled>选择图片…</option>
      {candidates.map((asset) => <option key={asset.hash} value={asset.hash}>{asset.display_filename}</option>)}
    </select>
    <p>将把 {count} 条提示词普通关联到这张图片。</p>
    <Button type="submit" variant="primary" disabled={disabled || choice === ""}>建立关联</Button>
  </form>;
}

/** 多选动作只属于集合底部栏；右检查器保持共同/混合值只读。 */
export function PromptBatchBar({ prompts, folders, mutating, onBatchFolders, onBatchTags, onBatchFavorite, onBatchLinkImages, onBatchDelete }: Props): ReactNode {
  const { state, selectAll, clearSelection } = useSelection();
  const [folderOpen, setFolderOpen] = useState(false);
  const [tagOpen, setTagOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const selected = useMemo(() => prompts.filter((prompt) => state.selectedIds.has(prompt.id)), [prompts, state.selectedIds]);
  if (selected.length < 2) return null;
  const ids = selected.map((prompt) => prompt.id);
  const summary = summarizePromptCommon(selected);
  const tagUnion = [...new Set(selected.flatMap((prompt) => prompt.tags))];
  const favoriteAction = summary.favorite.kind === "common" ? !summary.favorite.value : true;
  const favoriteLabel = summary.favorite.kind === "common" && summary.favorite.value ? "取消收藏" : "收藏";

  return <>
    <BatchToolbar count={selected.length} totalCount={prompts.length} onSelectAll={selectAll} onClear={clearSelection}>
      <Button size="compact" aria-label="批量编辑文件夹" onClick={() => setFolderOpen(true)}>文件夹</Button>
      <Button size="compact" aria-label="批量编辑标签" onClick={() => setTagOpen(true)}>标签</Button>
      <Button size="compact" aria-label="批量收藏" disabled={mutating} onClick={() => onBatchFavorite(ids, favoriteAction)}>{favoriteLabel}</Button>
      <Menu align="end" label="更多批量操作" trigger={<IconButton size="compact" label="更多批量操作" icon={<DotsThreeIcon />} disabled={mutating} />}>
        <MenuItem icon={<LinkSimpleIcon />} onSelect={() => setLinkOpen(true)}>关联图片</MenuItem>
        <MenuItem icon={<TrashIcon />} destructive onSelect={() => onBatchDelete(ids)}>移入回收站</MenuItem>
      </Menu>
    </BatchToolbar>

    <Dialog title="批量编辑提示词文件夹" description="提示词可以属于多个文件夹；混合状态按加入全部处理。" open={folderOpen} onOpenChange={(open) => { if (!mutating) setFolderOpen(open); }}>
      <div className={styles.batchChoices}>{folders.length === 0 ? <p>还没有提示词文件夹。</p> : folders.map((folder) => {
        const inAll = summary.folders.kind !== "empty" && summary.folders.values.includes(folder);
        const inSome = selected.some((prompt) => prompt.folders.includes(folder));
        return <label key={folder}><input type="checkbox" checked={inAll} ref={(element) => { if (element !== null) element.indeterminate = !inAll && inSome; }} disabled={mutating} onChange={() => onBatchFolders(ids, folder, !inAll)} /><span>{folder}{!inAll && inSome ? "（部分）" : ""}</span></label>;
      })}</div>
    </Dialog>

    <Dialog title="批量编辑提示词标签" description="共同标签可移除，部分标签可补齐；输入新标签会添加到全部选中项。" open={tagOpen} onOpenChange={(open) => { if (!mutating) setTagOpen(open); }}>
      <div className={styles.batchChoices}>{tagUnion.map((tag) => {
        const inAll = summary.tags.kind !== "empty" && summary.tags.values.includes(tag);
        return <Button key={tag} size="compact" variant="ghost" aria-pressed={inAll} disabled={mutating} onClick={() => onBatchTags(ids, tag, !inAll)}>{tag}{inAll ? "" : "（部分）"}</Button>;
      })}</div>
      <form className={styles.batchDialogForm} onSubmit={(event) => { event.preventDefault(); onBatchTags(ids, tagDraft, true); setTagDraft(""); }}><label htmlFor="prompt-batch-tag">添加到全部选中项</label><input id="prompt-batch-tag" name="prompt-batch-tag" value={tagDraft} onChange={(event) => setTagDraft(event.currentTarget.value)} autoComplete="off" /><Button type="submit" variant="primary" disabled={mutating || tagDraft.trim().length === 0}>添加标签</Button></form>
    </Dialog>

    <Dialog title="批量关联图片" description="为全部选中提示词建立同一条普通图片关联。" open={linkOpen} onOpenChange={(open) => { if (!mutating) setLinkOpen(open); }}><BatchImagePicker disabled={mutating} count={ids.length} onLink={(hash) => onBatchLinkImages(hash, ids)} /></Dialog>
  </>;
}
