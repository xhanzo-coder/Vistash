import { useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { DotsThreeIcon } from "@phosphor-icons/react/dist/csr/DotsThree";
import { LinkBreakIcon } from "@phosphor-icons/react/dist/csr/LinkBreak";
import { LinkSimpleIcon } from "@phosphor-icons/react/dist/csr/LinkSimple";
import { parseAssetId, type LibraryId } from "../../../app/common";
import { IpcError } from "../../../shared/errors";
import type { AppError, AssetRow, PromptRow } from "../../../shared/types";
import { Button, IconButton } from "../../../ui/button/Button";
import { Menu, MenuItem } from "../../../ui/overlays/Menu";
import type { ImagePromptRelations } from "../../image-prompt-relations";
import { PromptAssociationDialog } from "./PromptAssociationDialog";
import styles from "./AssetInspector.module.css";

export function promptTitle(prompt: PromptRow): string {
  if (prompt.title !== null) return prompt.title;
  const line = prompt.body.split(/\r?\n/).find((text) => text.trim().length > 0);
  if (line === undefined) throw new TypeError("无标题提示词必须包含非空正文");
  return line.trim();
}

export function promptSummary(prompt: PromptRow): string {
  const lines = prompt.body.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  return lines.slice(0, 2).join(" ");
}

/** 图片检查器中的关联提示词是可打开对象；建立关联使用搜索多选 Dialog。 */
export function AssetPromptLinks({ libraryId, relations, asset, linked, disabled, active }: { libraryId: LibraryId; relations: ImagePromptRelations; asset: AssetRow; linked: readonly PromptRow[]; disabled: boolean; active: boolean }): ReactNode {
  const [open, setOpen] = useState(false);
  const [actionError, setActionError] = useState<AppError | null>(null);
  const unlink = useMutation({
    scope: { id: `asset-organization:${libraryId}` },
    mutationFn: (promptId: string) => relations.execute({ kind: "unlink", libraryId, image: parseAssetId(asset.hash), prompt: promptId }),
    onSuccess: (commit) => {
      setActionError(commit.failures[0]?.error ?? commit.refreshError);
    },
  });
  const openTarget = useMutation({
    mutationFn: (prompt: PromptRow) => relations.open({ kind: "prompt", libraryId, id: prompt.id, location: prompt.deleted_at === null ? "active" : "trash" }),
  });
  for (const error of [unlink.error, openTarget.error]) if (error !== null && !(error instanceof IpcError)) throw error;
  const busy = unlink.isPending;

  return <div className={styles.form}>
    {linked.length === 0 ? <p className={styles.hint}>尚未关联提示词。</p> : <ul className={styles.relationList}>{linked.map((prompt) => <li key={prompt.id}>
      <Button className={styles.relationMain} variant="ghost" aria-label={`打开提示词 ${promptTitle(prompt)}`} onClick={() => openTarget.mutate(prompt)}>
        <span className={styles.relationText}><strong>{promptTitle(prompt)}</strong><small>{promptSummary(prompt)}</small><em>{prompt.model ?? "未填写模型"}{prompt.deleted_at === null ? "" : " · 已删除"}</em></span>
      </Button>
      <span className={styles.relationActions}>
        <IconButton className={styles.relationDirectAction} size="compact" title="解除关联" label={`解除与提示词 ${promptTitle(prompt)} 的关联`} icon={<LinkBreakIcon />} disabled={busy} onClick={() => unlink.mutate(prompt.id)} />
        <Menu trigger={<IconButton size="compact" label={`提示词关联操作 ${promptTitle(prompt)}`} icon={<DotsThreeIcon />} disabled={busy} />}>
          <MenuItem icon={<LinkSimpleIcon />} destructive onSelect={() => unlink.mutate(prompt.id)}>解除关联</MenuItem>
        </Menu>
      </span>
    </li>)}</ul>}

    {actionError === null ? null : <p role="alert" className={styles.error}>{actionError.code}：{actionError.detail}</p>}
    {openTarget.error instanceof IpcError ? <p role="alert" className={styles.error}>{openTarget.error.message}</p> : null}
    <Button size="compact" startIcon={<LinkSimpleIcon />} disabled={disabled || busy} onClick={() => setOpen(true)}>添加已有提示词</Button>
    {open ? <PromptAssociationDialog active={active} libraryId={libraryId} relations={relations} targets={[asset]} onClose={() => setOpen(false)} /> : null}
  </div>;
}
