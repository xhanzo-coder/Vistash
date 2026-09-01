import { useId, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { parseAssetId, type LibraryId } from "../../../app/common";
import { imageDetail, regenerateColorCard } from "../../../shared/ipc";
import { IpcError } from "../../../shared/errors";
import type { AssetRow } from "../../../shared/types";
import { Button } from "../../../ui/button/Button";
import { FileInformation } from "./AssetFilename";
import { INSPECTOR_SECTIONS, type InspectorSection, type InspectorSections } from "./preferences";
import { assetKeys } from "./queryKeys";
import styles from "./AssetInspector.module.css";
import type { AssetNotes } from "./assetNotes";
import { AssetOrganization } from "./AssetOrganization";
import { AssetPromptLinks } from "./AssetPromptLinks";
import { AssetThumbnail } from "./AssetCollection";
import type { ImagePromptRelations } from "../../image-prompt-relations";

const TITLES: Record<InspectorSection, string> = { summary: "摘要", colors: "色卡", organization: "组织", note: "备注", links: "关联提示词", files: "文件信息" };

/** 纵向分区始终保留内容实例，折叠只隐藏，不销毁输入或保存状态。 */
function Section({ name, expanded, toggle, children }: { name: InspectorSection; expanded: boolean; toggle: () => void; children: ReactNode }): ReactNode {
  const id = useId();
  return <section data-inspector-section={name} aria-labelledby={`${id}-heading`} className={styles.section}>
    <h2><button id={`${id}-heading`} type="button" aria-expanded={expanded} aria-controls={`${id}-content`} onClick={toggle}>
      {TITLES[name]}<CaretDownIcon aria-hidden="true" className={styles.caret} />
    </button></h2>
    <div id={`${id}-content`} hidden={!expanded} className={styles.sectionBody}>{children}</div>
  </section>;
}

function colorRole(role: string): string {
  switch (role) {
    case "dominant": return "主色";
    case "secondary": return "次色";
    case "accent": return "强调色";
    case "neutral": return "中性色";
    default: throw new TypeError(`未知色卡角色：${role}`);
  }
}

function colorFailureMessage(reason: string): string {
  switch (reason) {
    case "color_card.insufficient_opaque_pixels": return "图片中可参与分析的可见像素太少。";
    case "color_card.decode_failed": return "无法读取原图像素。";
    case "color_card.cluster_failed": return "色彩聚类没有得到可靠结果。";
    default: return "暂时无法生成可靠色卡。";
  }
}

function Colors({ libraryId, asset, editable }: { libraryId: LibraryId; asset: AssetRow; editable: boolean }): ReactNode {
  const client = useQueryClient();
  const regenerate = useMutation({
    scope: { id: `asset-color-card:${libraryId}` },
    mutationFn: () => regenerateColorCard(asset.hash),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: assetKeys.collections(libraryId) }),
        client.invalidateQueries({ queryKey: assetKeys.details(libraryId) }),
      ]);
    },
  });
  if (regenerate.error !== null && !(regenerate.error instanceof IpcError)) throw regenerate.error;
  if (asset.color_card_status !== "ok" && asset.color_card_status !== "failed") throw new TypeError(`未知色卡状态：${asset.color_card_status}`);
  if (asset.color_card_status !== "ok") {
    if (asset.color_card_failure_reason === null) throw new TypeError("失败色卡缺少原因");
    return <div role="alert" className={styles.paletteFailure}>
      <p>{colorFailureMessage(asset.color_card_failure_reason)}</p>
      <Button size="compact" disabled={!editable || regenerate.isPending} onClick={() => regenerate.mutate()}>{regenerate.isPending ? "正在分析…" : "重新分析色卡"}</Button>
      {regenerate.error === null ? null : <p className={styles.error}>{regenerate.error.message}</p>}
      <details><summary>技术详情</summary><code>{asset.color_card_failure_reason}</code></details>
    </div>;
  }
  if (asset.colors.length === 0) return <p className={styles.hint}>暂无色卡数据。</p>;
  const paletteLabel = asset.colors.map((color) => `${color.hex} ${(color.share * 100).toFixed(1)}%`).join("，");
  return <div className={styles.palette}>
    <div className={styles.paletteStrip} role="img" aria-label={`色彩比例：${paletteLabel}`}>
      {asset.colors.map((color, index) => <span key={`${index}-${color.hex}`} style={{ backgroundColor: color.hex, flexGrow: color.share }} title={`${color.hex} · ${colorRole(color.role)} · ${(color.share * 100).toFixed(1)}%`} />)}
    </div>
    <ul className={styles.paletteLegend}>
      {asset.colors.map((color, index) => <li key={`${index}-${color.hex}`}>
        <span className={styles.paletteMarker} style={{ backgroundColor: color.hex }} aria-hidden="true" />
        <span><code>{color.hex}</code><small>{colorRole(color.role)}</small></span>
        <strong>{(color.share * 100).toFixed(1)}%</strong>
      </li>)}
    </ul>
    <div className={styles.paletteActions}>
      <Button size="compact" variant="ghost" disabled={!editable || regenerate.isPending} onClick={() => regenerate.mutate()}>{regenerate.isPending ? "正在分析…" : "重新分析"}</Button>
      {regenerate.error === null ? null : <p className={styles.error}>{regenerate.error.message}</p>}
    </div>
  </div>;
}

export type AssetInspectorProps = {
  libraryId: LibraryId; asset: AssetRow | null; count: number; active: boolean;
  relations: ImagePromptRelations;
  editable: boolean; sections: InspectorSections | undefined;
  onSectionsChange: (sections: InspectorSections) => void;
  notes: AssetNotes;
  folders: readonly string[];
  onRestore: () => void;
  restorable: boolean;
  actions?: ReactNode;
};

export function AssetInspector({ libraryId, relations, asset, count, active, editable, sections, onSectionsChange, notes, folders, onRestore, restorable, actions }: AssetInspectorProps): ReactNode {
  const detail = useQuery({
    queryKey: asset === null ? [...assetKeys.details(libraryId), null] : assetKeys.detail(libraryId, parseAssetId(asset.hash)),
    queryFn: async ({ signal }) => {
      if (asset === null) throw new Error("无选择时不能请求图片详情");
      signal.throwIfAborted();
      const result = await imageDetail(asset.hash);
      signal.throwIfAborted();
      return result;
    },
    enabled: active && asset !== null,
    staleTime: Infinity,
  });
  if (detail.error !== null && !(detail.error instanceof IpcError)) throw detail.error;
  if (asset === null) return <div className={styles.empty}><h2 tabIndex={-1} data-inspector-heading>图片检查器</h2><p>{count > 1 ? `已选 ${count} 项。请从底部操作栏批量整理，单张信息仅在单选时显示。` : "选择一张图片，查看色卡、组织与来源信息。"}</p></div>;
  const contents: Record<InspectorSection, ReactNode> = {
    summary: <>{active && sections?.summary !== false ? <div className={styles.preview}><AssetThumbnail key={asset.hash} asset={asset} /></div> : null}<div className={styles.summaryHeading}><div><p className={styles.filename}>{asset.display_filename}</p><p className={styles.hint}>{asset.width} × {asset.height} · {asset.ext.toUpperCase()}{asset.deleted_at === null ? "" : " · 回收站"}</p></div>{actions}</div></>,
    colors: <Colors libraryId={libraryId} asset={asset} editable={editable} />,
    organization: <><AssetOrganization key={asset.hash} libraryId={libraryId} asset={asset} folders={folders} disabled={!editable} />{asset.deleted_at === null ? null : <Button size="compact" disabled={!restorable} onClick={onRestore}>还原图片</Button>}</>,
    note: <NoteEditor asset={asset} notes={notes} disabled={!editable} />,
    links: detail.isError ? <div><p role="alert" className={styles.error}>{detail.error.message}</p><Button size="compact" onClick={() => void detail.refetch()}>重试读取详情</Button></div> : detail.isPending ? <p role="status">正在读取关联…</p> : <AssetPromptLinks key={asset.hash} libraryId={libraryId} relations={relations} asset={asset} linked={detail.data.linked_prompts} disabled={!editable} active={active} />,
    files: <FileInformation asset={asset} />,
  };
  return <div className={styles.inspector}>
    {INSPECTOR_SECTIONS.map((name) => <Section key={name} name={name} expanded={sections?.[name] !== false} toggle={() => onSectionsChange({ ...sections, [name]: sections?.[name] === false })}>{contents[name]}</Section>)}
  </div>;
}

function NoteEditor({ asset, notes, disabled }: { asset: AssetRow; notes: AssetNotes; disabled: boolean }): ReactNode {
  const draft = notes.drafts.get(asset.hash);
  const statusId = useId();
  return <div className={styles.form}>
    <textarea name="asset-note" autoComplete="off" aria-label="图片备注" aria-describedby={statusId} rows={5} value={draft === undefined ? asset.note : draft.text} disabled={disabled}
      onChange={(event) => notes.edit(asset, event.target.value)}
      onBlur={() => { if (!disabled) notes.save(asset.hash); }}
      onKeyDown={(event) => {
        if (event.ctrlKey && event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); notes.save(asset.hash); }
      }} />
    <div id={statusId}>
      <p role="status" className={styles.hint}>{draft === undefined ? "纯文本 · 停止输入或失焦后自动保存" : draft.phase === "saving" ? "正在保存…" : draft.phase === "saved" ? "已保存" : "有未保存的修改"}</p>
      {draft?.error === null || draft === undefined ? null : <p role="alert" className={styles.error}>{draft.error.message}</p>}
    </div>
    <Button size="compact" disabled={disabled || draft === undefined || draft.phase === "saved" || draft.phase === "saving"} onClick={() => notes.save(asset.hash)}>保存备注</Button>
  </div>;
}
