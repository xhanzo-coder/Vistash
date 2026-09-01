import { useId, useMemo, useState, type ReactNode } from "react";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowCounterClockwise";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CopyIcon } from "@phosphor-icons/react/dist/csr/Copy";
import { LinkSimpleIcon } from "@phosphor-icons/react/dist/csr/LinkSimple";
import { PencilSimpleIcon } from "@phosphor-icons/react/dist/csr/PencilSimple";
import { StarIcon } from "@phosphor-icons/react/dist/csr/Star";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";

import type { PromptRow } from "../../shared/types";
import type { LibraryId } from "../../app/common";
import type { ImagePromptRelations } from "../../modules/image-prompt-relations";
import { Button, IconButton } from "../../ui/button/Button";
import { Tooltip } from "../../ui/overlays/Tooltip";
import { summarizePromptCommon } from "../workspace/inspectorSummary";
import { useSelection } from "../workspace/selectionContext";
import { PromptImageLinks } from "./PromptImageLinks";
import { PromptNoteEditor } from "./PromptNoteEditor";
import { formatPromptDate, promptDisplayTitle } from "./promptDisplay";
import styles from "./PromptInspector.module.css";

type PromptInspectorProps = {
  prompts: readonly PromptRow[];
  libraryId: LibraryId;
  relations: ImagePromptRelations;
  folders: readonly string[];
  mutating: boolean;
  onSetFolders: (id: string, folders: string[]) => void;
  onSetTags: (id: string, tags: string[]) => void;
  onToggleFavorite: (id: string, favorite: boolean) => void;
  onOpenBodyFocus: (id: string) => void;
  onEditBodyFocus: (id: string) => void;
  trashLocation: boolean;
  onDeletePrompt: (id: string) => void;
  onRestorePrompt: (id: string) => void;
};

type SectionName = "summary" | "body" | "organization" | "note" | "images";
const SECTION_TITLES: Record<SectionName, string> = {
  summary: "摘要",
  body: "正文",
  organization: "组织",
  note: "备注",
  images: "关联图片",
};

function Section({ name, expanded, onToggle, children }: {
  name: SectionName;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}): ReactNode {
  const id = useId();
  return <section className={styles.section} data-prompt-inspector-section={name} data-inspector-section={name === "summary" ? "info" : name} aria-labelledby={`${id}-heading`}>
    <h2><button id={`${id}-heading`} type="button" aria-expanded={expanded} aria-controls={`${id}-content`} onClick={onToggle}>
      <span>{SECTION_TITLES[name]}</span><CaretDownIcon className={styles.caret} aria-hidden="true" />
    </button></h2>
    <div id={`${id}-content`} className={styles.sectionBody} hidden={!expanded}>{children}</div>
  </section>;
}

function listSummary(kind: "empty" | "common" | "mixed", values: readonly string[]): string {
  if (kind === "empty" || values.length === 0) return kind === "mixed" ? "不一致，无共同项" : "无";
  return `${values.join("、")}${kind === "mixed" ? "（部分共同）" : ""}`;
}

function MultiSummary({ prompts }: { prompts: readonly PromptRow[] }): ReactNode {
  const summary = summarizePromptCommon(prompts);
  const model = prompts.every((prompt) => prompt.model === prompts[0]?.model) ? (prompts[0]?.model ?? "未填写") : "不一致";
  const linkedCount = prompts.every((prompt) => prompt.linked_image_hashes.length === prompts[0]?.linked_image_hashes.length)
    ? `${prompts[0]?.linked_image_hashes.length ?? 0} 张`
    : "不一致";
  const favorite = summary.favorite.kind === "common" ? (summary.favorite.value ? "全部已收藏" : "全部未收藏") : "不一致";
  return <div className={styles.multi}>
    <h2>已选 {prompts.length} 条提示词</h2>
    <p>共同值与差异仅供确认；批量修改请使用底部操作栏。</p>
    <dl className={styles.facts}>
      <dt>文件夹</dt><dd>{listSummary(summary.folders.kind, summary.folders.kind === "empty" ? [] : summary.folders.values)}</dd>
      <dt>标签</dt><dd>{listSummary(summary.tags.kind, summary.tags.kind === "empty" ? [] : summary.tags.values)}</dd>
      <dt>收藏</dt><dd>{favorite}</dd>
      <dt>模型/平台</dt><dd>{model}</dd>
      <dt>关联图片数</dt><dd>{linkedCount}</dd>
    </dl>
  </div>;
}

/** 提示词单选检查器是连续可折叠文档；多选只呈现共同/混合只读摘要。 */
export function PromptInspector({
  prompts,
  libraryId,
  relations,
  folders,
  mutating,
  onSetFolders,
  onSetTags,
  onToggleFavorite,
  onOpenBodyFocus,
  onEditBodyFocus,
  trashLocation,
  onDeletePrompt,
  onRestorePrompt,
}: PromptInspectorProps): ReactNode {
  const { state } = useSelection();
  const [tagDraft, setTagDraft] = useState("");
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<SectionName, boolean>>({ summary: true, body: true, organization: true, note: true, images: true });
  const selected = useMemo(() => prompts.filter((prompt) => state.selectedIds.has(prompt.id)), [prompts, state.selectedIds]);

  if (selected.length > 1) return <MultiSummary prompts={selected} />;
  const active = state.activeId === null ? null : (prompts.find((prompt) => prompt.id === state.activeId) ?? null);
  if (active === null) return <div className={`${styles.placeholder} inspector-placeholder`}><h2>选择一条提示词</h2><p>查看正文、组织、备注和关联图片。</p></div>;

  const toggle = (name: SectionName): void => setExpanded((current) => ({ ...current, [name]: !current[name] }));
  const revealImages = (): void => {
    setExpanded((current) => ({ ...current, images: true }));
    window.setTimeout(() => document.querySelector<HTMLButtonElement>('[data-prompt-inspector-section="images"] > h2 > button')?.focus(), 0);
  };
  const copyBody = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(active.body);
      setCopyStatus("已复制正文");
    } catch {
      setCopyStatus("无法写入剪贴板，请进入正文分区手动复制。");
    }
  };

  return <div className={styles.inspector}>
    <Section name="summary" expanded={expanded.summary} onToggle={() => toggle("summary")}>
      <div className={styles.summaryHeading}>
        <div><h3>{promptDisplayTitle(active)}</h3><span>{active.model ?? "未填写模型"} · 更新于 {formatPromptDate(active.updated_at)}</span></div>
        <div className={styles.actions} role="group" aria-label="当前提示词操作">
          <Tooltip content="复制正文"><IconButton size="compact" label="复制提示词正文" icon={<CopyIcon />} disabled={mutating} onClick={() => void copyBody()} /></Tooltip>
          <Tooltip content="编辑提示词"><IconButton size="compact" label="编辑提示词" icon={<PencilSimpleIcon />} disabled={mutating || trashLocation} onClick={() => onEditBodyFocus(active.id)} /></Tooltip>
          <Tooltip content={active.favorite ? "取消收藏" : "收藏提示词"}>
            <IconButton
              size="compact"
              label={active.favorite ? "取消收藏提示词" : "收藏提示词"}
              icon={<StarIcon weight={active.favorite ? "fill" : "regular"} />}
              aria-pressed={active.favorite}
              disabled={mutating || trashLocation}
              onClick={() => onToggleFavorite(active.id, !active.favorite)}
            />
          </Tooltip>
          <Tooltip content="关联图片"><IconButton size="compact" label="关联图片" icon={<LinkSimpleIcon />} disabled={mutating || trashLocation} onClick={revealImages} /></Tooltip>
          {trashLocation
            ? <Tooltip content="还原提示词"><IconButton size="compact" label="还原提示词" icon={<ArrowCounterClockwiseIcon />} disabled={mutating} onClick={() => onRestorePrompt(active.id)} /></Tooltip>
            : <Tooltip content="移入回收站"><IconButton size="compact" label="移入回收站" icon={<TrashIcon />} disabled={mutating} onClick={() => onDeletePrompt(active.id)} /></Tooltip>}
        </div>
      </div>
      <dl className={styles.facts}><dt>参数说明</dt><dd>{active.parameters ?? "未填写"}</dd><dt>文件夹</dt><dd>{active.folders.length === 0 ? "提示词根位置" : active.folders.join("、")}</dd><dt>标签</dt><dd>{active.tags.length === 0 ? "无" : active.tags.join("、")}</dd><dt>关联图片</dt><dd>{active.linked_image_hashes.length} 张</dd></dl>
      {copyStatus === null ? null : <p role="status" className={styles.status}>{copyStatus}</p>}
    </Section>

    <Section name="body" expanded={expanded.body} onToggle={() => toggle("body")}>
      <pre className={`${styles.body} inspector-body-full`}>{active.body}</pre>
      <div className={styles.buttonRow}><Button size="compact" onClick={() => onOpenBodyFocus(active.id)}>聚焦阅读</Button><Button size="compact" variant="primary" disabled={mutating || trashLocation} onClick={() => onEditBodyFocus(active.id)}>编辑主字段</Button></div>
    </Section>

    <Section name="organization" expanded={expanded.organization} onToggle={() => toggle("organization")}>
      {trashLocation ? <p className={styles.hint}>回收站记录保留原组织；还原后才可继续编辑。</p> : <div className={styles.organization}>
        <fieldset><legend>提示词文件夹</legend>{folders.length === 0 ? <p className={styles.hint}>尚无提示词文件夹。</p> : folders.map((folder) => <label key={folder}><input type="checkbox" value={folder} checked={active.folders.includes(folder)} disabled={mutating} onChange={() => onSetFolders(active.id, active.folders.includes(folder) ? active.folders.filter((item) => item !== folder) : [...active.folders, folder])} /><span>{folder}</span></label>)}</fieldset>
        <div><h3>共享标签</h3><div className={styles.tags}>{active.tags.map((tag) => <Button key={tag} size="compact" variant="ghost" aria-label={`移除标签 ${tag}`} disabled={mutating} onClick={() => onSetTags(active.id, active.tags.filter((item) => item !== tag))}>{tag} ×</Button>)}</div>
          <form className={styles.compactForm} onSubmit={(event) => { event.preventDefault(); onSetTags(active.id, [...active.tags, tagDraft]); setTagDraft(""); }}><label htmlFor="new-prompt-tag">添加标签</label><div><input id="new-prompt-tag" name="new-prompt-tag" autoComplete="off" value={tagDraft} onChange={(event) => setTagDraft(event.currentTarget.value)} required /><Button size="compact" type="submit" disabled={mutating || tagDraft.trim().length === 0}>添加</Button></div></form>
        </div>
      </div>}
    </Section>

    <Section name="note" expanded={expanded.note} onToggle={() => toggle("note")}><PromptNoteEditor key={active.id} id={active.id} note={active.note} /></Section>
    <Section name="images" expanded={expanded.images} onToggle={() => toggle("images")}><PromptImageLinks key={active.id} libraryId={libraryId} relations={relations} active={active} /></Section>
  </div>;
}
