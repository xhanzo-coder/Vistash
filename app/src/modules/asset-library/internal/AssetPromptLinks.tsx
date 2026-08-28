import { useDeferredValue, useId, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { parseAssetId, type LibraryId } from "../../../app/common";
import { linkImages, promptSnapshot, unlinkImage } from "../../../shared/ipc";
import { IpcError } from "../../../shared/errors";
import type { PromptRow } from "../../../shared/types";
import { Button } from "../../../ui/button/Button";
import { SearchField } from "../../../ui/search-field/SearchField";
import { assetKeys } from "./queryKeys";
import styles from "./AssetInspector.module.css";

function promptTitle(prompt: PromptRow): string {
  if (prompt.title !== null) return prompt.title;
  const line = prompt.body.split(/\r?\n/).find((text) => text.trim().length > 0);
  if (line === undefined) throw new TypeError("无标题提示词必须包含非空正文");
  return line.trim();
}

/** 每次只提交一个提示词关联，后端事务结果就是本次完整结果，不隐藏部分成功。 */
export function AssetPromptLinks({ libraryId, hash, linked, disabled, active }: { libraryId: LibraryId; hash: string; linked: readonly PromptRow[]; disabled: boolean; active: boolean }): ReactNode {
  const client = useQueryClient();
  const groupId = useId();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [choice, setChoice] = useState("");
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
    mutationFn: (edit: { kind: "link" | "unlink"; promptId: string }) => edit.kind === "link" ? linkImages(edit.promptId, [hash]) : unlinkImage(edit.promptId, hash),
    onSuccess: async (_result, edit) => {
      await Promise.all([
        client.invalidateQueries({ queryKey: assetKeys.detail(libraryId, parseAssetId(hash)), exact: true }),
        client.invalidateQueries({ queryKey: assetKeys.promptCandidatesRoot(libraryId) }),
      ]);
      if (edit.kind === "link") { setOpen(false); setChoice(""); }
    },
  });
  for (const error of [candidates.error, save.error]) if (error !== null && !(error instanceof IpcError)) throw error;
  const available = candidates.data?.filter((prompt) => !linked.some((item) => item.id === prompt.id));
  const currentChoice = available?.some((prompt) => prompt.id === choice) === true;
  return <div className={styles.form}>
    {linked.length === 0 ? <p className={styles.hint}>尚未关联提示词。</p> : <ul className={styles.links}>{linked.map((prompt) => <li key={prompt.id}>
      <span>{promptTitle(prompt)}{prompt.deleted_at === null ? null : <small>已删除</small>}</span>
      <Button size="compact" aria-label={`解除关联 ${promptTitle(prompt)}`} disabled={disabled || save.isPending || prompt.deleted_at !== null} onClick={() => save.mutate({ kind: "unlink", promptId: prompt.id })}>解除</Button>
    </li>)}</ul>}
    <Button size="compact" disabled={disabled || save.isPending} aria-expanded={open} onClick={() => { setOpen(!open); setSearch(""); setChoice(""); save.reset(); }}>{open ? "取消关联选择" : "建立关联"}</Button>
    {open ? <form className={styles.form} onSubmit={(event) => { event.preventDefault(); if (currentChoice) save.mutate({ kind: "link", promptId: choice }); }}>
      <SearchField label="搜索提示词" aria-label="搜索提示词" name="asset-link-prompt" placeholder="按标题或正文搜索…" value={search} onValueChange={(value) => { setSearch(value); setChoice(""); }} disabled={save.isPending} />
      {candidates.isError ? <div><p role="alert" className={styles.error}>{candidates.error.message}</p><Button size="compact" onClick={() => void candidates.refetch()}>重试读取提示词</Button></div> : candidates.isPending ? <p role="status">正在读取提示词…</p> : <fieldset className={styles.candidates} disabled={disabled || save.isPending || search !== deferredSearch}>
        <legend>选择一条提示词</legend>
        {available?.length === 0 ? <p className={styles.hint}>没有可新增关联的提示词。</p> : available?.map((prompt) => <label key={prompt.id}><input type="radio" name={groupId} value={prompt.id} checked={choice === prompt.id} onChange={() => setChoice(prompt.id)} /><span>{promptTitle(prompt)}</span></label>)}
      </fieldset>}
      <Button size="compact" type="submit" disabled={disabled || save.isPending || candidates.isError || candidates.isFetching || search !== deferredSearch || !currentChoice}>确认关联</Button>
    </form> : null}
    {save.error === null ? null : <p role="alert" className={styles.error}>{save.error.message}</p>}
  </div>;
}
