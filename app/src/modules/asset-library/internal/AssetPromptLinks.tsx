import { useDeferredValue, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { DotsThreeIcon } from "@phosphor-icons/react/dist/csr/DotsThree";
import { LinkSimpleIcon } from "@phosphor-icons/react/dist/csr/LinkSimple";
import { parseAssetId, type LibraryId } from "../../../app/common";
import { promptSnapshot } from "../../../shared/ipc";
import { asAppError, IpcError } from "../../../shared/errors";
import type { PromptRow } from "../../../shared/types";
import { Button, IconButton } from "../../../ui/button/Button";
import { Dialog } from "../../../ui/dialog/Dialog";
import { Menu, MenuItem } from "../../../ui/overlays/Menu";
import { SearchField } from "../../../ui/search-field/SearchField";
import type { ImagePromptRelations, RelationFailure } from "../../image-prompt-relations";
import { assetKeys } from "./queryKeys";
import styles from "./AssetInspector.module.css";

export function promptTitle(prompt: PromptRow): string {
  if (prompt.title !== null) return prompt.title;
  const line = prompt.body.split(/\r?\n/).find((text) => text.trim().length > 0);
  if (line === undefined) throw new TypeError("无标题提示词必须包含非空正文");
  return line.trim();
}

function promptSummary(prompt: PromptRow): string {
  const lines = prompt.body.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  return lines.slice(0, 2).join(" ");
}

/** 图片检查器中的关联提示词是可打开对象；建立关联使用搜索多选 Dialog。 */
export function AssetPromptLinks({ libraryId, relations, hash, linked, disabled, active }: { libraryId: LibraryId; relations: ImagePromptRelations; hash: string; linked: readonly PromptRow[]; disabled: boolean; active: boolean }): ReactNode {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [failures, setFailures] = useState<readonly RelationFailure[]>([]);
  const [refreshError, setRefreshError] = useState<ReturnType<typeof asAppError> | null>(null);
  const candidates = useQuery({
    queryKey: assetKeys.promptCandidates(libraryId, deferredSearch),
    queryFn: async ({ signal }) => {
      signal.throwIfAborted();
      const result = await promptSnapshot({ text: deferredSearch, tags: [], folder: { kind: "all" }, favorite: null, location: "active" });
      signal.throwIfAborted();
      return result.prompts;
    },
    enabled: active && open && !disabled,
  });
  const save = useMutation({
    scope: { id: `asset-organization:${libraryId}` },
    mutationFn: (promptIds: readonly string[]) => relations.execute({ kind: "link", libraryId, images: [parseAssetId(hash)], prompts: promptIds }),
    onSuccess: (commit) => {
      setFailures(commit.failures);
      setRefreshError(commit.refreshError);
      if (commit.failures.length === 0 && commit.refreshError === null) {
        setOpen(false);
        setSelected([]);
      } else if (commit.refreshError === null) {
        setSelected(commit.failures.map((failure) => failure.promptId));
      }
    },
  });
  const unlink = useMutation({
    scope: { id: `asset-organization:${libraryId}` },
    mutationFn: (promptId: string) => relations.execute({ kind: "unlink", libraryId, image: parseAssetId(hash), prompt: promptId }),
    onSuccess: (commit) => {
      setFailures(commit.failures);
      setRefreshError(commit.refreshError);
    },
  });
  const openTarget = useMutation({
    mutationFn: (prompt: PromptRow) => relations.open({ kind: "prompt", libraryId, id: prompt.id, location: prompt.deleted_at === null ? "active" : "trash" }),
  });
  for (const error of [candidates.error, save.error, unlink.error, openTarget.error]) if (error !== null && !(error instanceof IpcError)) throw error;
  const linkedIds = new Set(linked.map((prompt) => prompt.id));
  const busy = save.isPending || unlink.isPending;

  return <div className={styles.form}>
    {linked.length === 0 ? <p className={styles.hint}>尚未关联提示词。</p> : <ul className={styles.relationList}>{linked.map((prompt) => <li key={prompt.id}>
      <Button className={styles.relationMain} variant="ghost" aria-label={`打开提示词 ${promptTitle(prompt)}`} onClick={() => openTarget.mutate(prompt)}>
        <span className={styles.relationText}><strong>{promptTitle(prompt)}</strong><small>{promptSummary(prompt)}</small><em>{prompt.model ?? "未填写模型"}{prompt.deleted_at === null ? "" : " · 已删除"}</em></span>
      </Button>
      <Menu trigger={<IconButton size="compact" label={`提示词关联操作 ${promptTitle(prompt)}`} icon={<DotsThreeIcon />} disabled={busy} />}>
        <MenuItem icon={<LinkSimpleIcon />} destructive onSelect={() => unlink.mutate(prompt.id)}>解除关联</MenuItem>
      </Menu>
    </li>)}</ul>}

    {refreshError === null ? null : <div role="alert"><p>关系已写入、刷新失败。当前选择已保留；重试只会重新读取，不会撤销关联。</p><code>{refreshError.code}</code></div>}
    {openTarget.error instanceof IpcError ? <p role="alert" className={styles.error}>{openTarget.error.message}</p> : null}
    <Button size="compact" startIcon={<LinkSimpleIcon />} disabled={disabled || busy} onClick={() => { setOpen(true); setSearch(""); setSelected([]); setFailures([]); setRefreshError(null); }}>添加关联</Button>
    <Dialog title="添加关联提示词" description="搜索并选择要与当前图片建立普通关联的提示词。" open={open} onOpenChange={(next) => { if (!busy) setOpen(next); }} footer={<Button variant="primary" disabled={busy || selected.length === 0} onClick={() => save.mutate(selected)}>确认关联 {selected.length} 条</Button>}>
      <div className={styles.relationPicker}>
        <SearchField label="搜索提示词" aria-label="搜索提示词" name="asset-link-prompt" placeholder="按标题或正文搜索…" value={search} onValueChange={setSearch} disabled={busy} />
        {candidates.isError ? <div><p role="alert" className={styles.error}>{candidates.error.message}</p><Button size="compact" onClick={() => void candidates.refetch()}>重试读取提示词</Button></div> : candidates.isPending ? <p role="status">正在读取提示词…</p> : <ul>{candidates.data?.map((prompt) => {
          const alreadyLinked = linkedIds.has(prompt.id);
          return <li key={prompt.id}><label><input type="checkbox" value={prompt.id} checked={alreadyLinked || selected.includes(prompt.id)} disabled={alreadyLinked || busy} onChange={() => setSelected((current) => current.includes(prompt.id) ? current.filter((id) => id !== prompt.id) : [...current, prompt.id])} /><span><strong>{promptTitle(prompt)}</strong><small>{promptSummary(prompt)}</small><em>{alreadyLinked ? "已关联" : prompt.model ?? "未填写模型"}</em></span></label></li>;
        })}</ul>}
        {failures.length === 0 ? null : <ul aria-label="关联失败">{failures.map((failure) => <li key={failure.promptId}><code>{failure.error.code}</code><span>{failure.error.detail}</span></li>)}</ul>}
      </div>
    </Dialog>
  </div>;
}
