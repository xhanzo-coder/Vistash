import { useEffect, useState } from "react";

import { asAppError } from "../../shared/errors";
import { promptSnapshot } from "../../shared/ipc";
import type { AppError, AssetRow, PromptRow } from "../../shared/types";
import { ErrorLine } from "../library/ErrorLine";
import { promptDisplayTitle } from "../prompts/promptDisplay";
import { BatchOrganizer } from "../workspace/BatchOrganizer";
import { useSelection } from "../workspace/selectionContext";
import { ROLE_TEXT } from "./AssetPreview";
import { AssetNoteEditor } from "./AssetNoteEditor";
import { AssetPromptLinks } from "./AssetPromptLinks";

type AssetInspectorProps = {
  /** 当前查询的有序结果：活动项在这里解析成素材。 */
  assets: readonly AssetRow[];
  /** 库内全部逻辑文件夹：组织分区按它渲染单选列表。 */
  folders: readonly string[];
  mutating: boolean;
  /** 当前处于回收站位置：组织编辑让位给还原入口。 */
  trashLocation: boolean;
  /** 单归属移动（v3）：folder 为 null 表示移回未分类。 */
  onMoveAsset: (hash: string, folder: string | null) => void;
  onSetTags: (hash: string, tags: string[]) => void;
  onDeleteAsset: (hash: string) => void;
  onRestoreAsset: (hash: string) => void;
  /** 收藏快捷开关（任务 9.4）：只表示二值状态，不扩展为评级。 */
  onToggleFavorite: (hash: string, favorite: boolean) => void;
  // 批量动作（任务 11.2）：选中集合由本组件经 SelectionModel 解析后随回调上报，
  // 写入、报告与权威刷新由工作区统一协调。批量文件夹在单归属下只有"整体移动"。
  onBatchMove: (hashes: string[], folder: string | null) => void;
  onBatchTags: (hashes: string[], tag: string, add: boolean) => void;
  onBatchFavorite: (hashes: string[], favorite: boolean) => void;
  onBatchLinkToPrompt: (promptId: string, hashes: string[]) => void;
  onBatchDelete: (hashes: string[]) => void;
};

/**
 * 右侧固定检查器（任务 9.3）。
 *
 * 单击图片只更新这里，不替换中央集合视图；聚焦原图必须由双击或 Enter 显式进入。
 * 分区按规格可定位：图片信息/色卡、组织、备注（关联提示词分区随后续切片接入）。
 * 选择权威在统一 SelectionModel——本组件只是活动项与多选摘要的呈现端。
 */
export function AssetInspector({
  assets,
  folders,
  mutating,
  trashLocation,
  onMoveAsset,
  onSetTags,
  onDeleteAsset,
  onRestoreAsset,
  onToggleFavorite,
  onBatchMove,
  onBatchTags,
  onBatchFavorite,
  onBatchLinkToPrompt,
  onBatchDelete,
}: AssetInspectorProps) {
  const { state } = useSelection();
  const [tagDraft, setTagDraft] = useState("");

  // 多选优先于单件分区（任务 11.2）：共同/混合摘要 + 批量组织动作。
  // 回收站位置不提供批量组织——那里的语义是还原，逐项操作见单选检查器。
  if (state.selectedIds.size > 1) {
    const selected = assets.filter((asset) => state.selectedIds.has(asset.hash));
    const hashes = selected.map((asset) => asset.hash);
    if (trashLocation) {
      return (
        <div className="inspector-multi">
          <p className="eyebrow">MULTI SELECT</p>
          <h3>已选 {selected.length} 项</h3>
          <p className="muted">回收站中的批量操作只提供还原；逐项还原见单选检查器。</p>
        </div>
      );
    }
    return (
      <>
        <section
          className="inspector-section"
          data-inspector-section="batch"
          aria-labelledby="inspector-batch-heading"
        >
          <p className="eyebrow">MULTI SELECT</p>
          <div className="inspector-heading-row">
            <h3 id="inspector-batch-heading">已选 {selected.length} 项</h3>
          </div>
          <BatchOrganizer
            items={selected}
            folders={folders}
            mutating={mutating}
            onBatchMove={(folder) => onBatchMove(hashes, folder)}
            onBatchTags={(tag, add) => onBatchTags(hashes, tag, add)}
            onBatchFavorite={(favorite) => onBatchFavorite(hashes, favorite)}
          />
        </section>

        <section
          className="inspector-section"
          data-inspector-section="batch-links"
          aria-labelledby="inspector-batch-links-heading"
        >
          <p className="eyebrow">LINKS</p>
          <h3 id="inspector-batch-links-heading">批量建立提示词关联</h3>
          <BatchLinkToPrompt
            count={hashes.length}
            disabled={mutating}
            onLink={(promptId) => onBatchLinkToPrompt(promptId, hashes)}
          />
        </section>

        <section className="inspector-section" data-inspector-section="batch-danger">
          <button
            type="button"
            className="danger-button"
            disabled={mutating}
            onClick={() => onBatchDelete(hashes)}
          >
            移入回收站
          </button>
        </section>
      </>
    );
  }

  const active =
    state.activeId === null
      ? null
      : (assets.find((asset) => asset.hash === state.activeId) ?? null);

  if (active === null) {
    return (
      <div className="inspector-placeholder">
        <p className="eyebrow">INSPECTOR</p>
        <h3>图片检查器</h3>
        <p className="muted">单击一张图片查看信息、色卡与组织归属。</p>
      </div>
    );
  }

  return (
    <>
      <section
        className="inspector-section"
        data-inspector-section="info"
        aria-labelledby="inspector-info-heading"
      >
        <p className="eyebrow">INFO</p>
        <div className="inspector-heading-row">
          <h3 id="inspector-info-heading">信息与色卡</h3>
          {/* 二值收藏（规格：不扩展为星级/旗标/颜色评级）。 */}
          <button
            type="button"
            className={`favorite-toggle${active.favorite ? " is-on" : ""}`}
            aria-pressed={active.favorite}
            disabled={mutating}
            onClick={() => onToggleFavorite(active.hash, !active.favorite)}
          >
            {active.favorite ? "★ 已收藏" : "☆ 收藏"}
          </button>
        </div>
        <dl className="info-grid">
          <dt>文件名</dt>
          <dd>{active.display_filename}</dd>
          <dt>尺寸</dt>
          <dd className="detail-mono">
            {active.width} × {active.height}
          </dd>
          <dt>格式</dt>
          <dd>{active.media_type}</dd>
          <dt>大小</dt>
          <dd className="detail-mono">{Math.round(active.byte_size / 1024)} KB</dd>
          <dt>导入时间</dt>
          <dd className="detail-mono">{active.imported_at.slice(0, 10)}</dd>
        </dl>
        <h4>色卡</h4>
        {active.color_card_status === "ok" ? (
          <ul className="color-strip">
            {active.colors.map((color, ordinal) => (
              <li key={`${ordinal}-${color.hex}`}>
                <span
                  aria-hidden="true"
                  className="color-swatch"
                  style={{ backgroundColor: color.hex }}
                />
                <code>{color.hex}</code>
                <span>{ROLE_TEXT[color.role] ?? color.role}</span>
                <span className="detail-mono">{Math.round(color.share * 1000) / 10}%</span>
              </li>
            ))}
          </ul>
        ) : (
          <ErrorLine
            error={{
              code: active.color_card_failure_reason ?? "color_card.cluster_failed",
              detail: `参与聚类的像素数：${active.color_card_sampled_pixel_count}`,
            }}
          />
        )}
      </section>

      <section
        className="inspector-section"
        data-inspector-section="organization"
        aria-labelledby="inspector-organization-heading"
      >
        <p className="eyebrow">ORGANIZE</p>
        <h3 id="inspector-organization-heading">组织</h3>
        {trashLocation ? (
          <>
            <p className="muted">回收站中的素材保留全部组织信息，还原后即可继续编辑。</p>
            <button
              type="button"
              className="primary-button"
              disabled={mutating}
              onClick={() => onRestoreAsset(active.hash)}
            >
              还原素材
            </button>
          </>
        ) : (
          <>
            <fieldset>
              {/* 单归属（v3）：一张图至多属于一个文件夹，单选组 + 未分类。
                  点选即移动；选中当前值再次点击不产生多余写入。 */}
              <legend>所在文件夹</legend>
              {folders.length === 0 ? (
                <p className="muted">尚未创建文件夹。</p>
              ) : (
                <div role="radiogroup" aria-label="选择素材所在的文件夹">
                  <label className="check-row">
                    <input
                      type="radio"
                      name={`asset-folder-${active.hash}`}
                      value=""
                      checked={active.folder === null}
                      disabled={mutating}
                      onChange={() => onMoveAsset(active.hash, null)}
                    />
                    <span>未分类</span>
                  </label>
                  {folders.map((folder) => (
                    <label key={folder} className="check-row">
                      <input
                        type="radio"
                        name={`asset-folder-${active.hash}`}
                        value={folder}
                        checked={active.folder === folder}
                        disabled={mutating}
                        onChange={() => onMoveAsset(active.hash, folder)}
                      />
                      <span>{folder}</span>
                    </label>
                  ))}
                </div>
              )}
            </fieldset>
            <div className="tag-editor">
              <h4>标签</h4>
              <div className="tag-list">
                {active.tags.map((tag) => (
                  <button
                    type="button"
                    key={tag}
                    aria-label={`移除标签 ${tag}`}
                    disabled={mutating}
                    onClick={() => onSetTags(active.hash, active.tags.filter((item) => item !== tag))}
                  >
                    {tag} ×
                  </button>
                ))}
              </div>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  onSetTags(active.hash, [...active.tags, tagDraft]);
                  setTagDraft("");
                }}
              >
                <label htmlFor="new-tag">添加标签</label>
                <div className="compact-form">
                  <input
                    id="new-tag"
                    name="new-tag"
                    autoComplete="off"
                    value={tagDraft}
                    onChange={(event) => setTagDraft(event.target.value)}
                    required
                  />
                  <button type="submit" disabled={mutating}>添加</button>
                </div>
              </form>
            </div>
            <button
              type="button"
              className="danger-button"
              disabled={mutating}
              onClick={() => onDeleteAsset(active.hash)}
            >
              移入回收站
            </button>
          </>
        )}
      </section>

      {/* 任务 9.4：延迟/失焦/Ctrl+Enter 自动保存；失败时草稿留在编辑框。 */}
      <section
        className="inspector-section"
        data-inspector-section="note"
        aria-labelledby="inspector-note-heading"
      >
        <p className="eyebrow">NOTE</p>
        <h3 id="inspector-note-heading">备注</h3>
        <AssetNoteEditor key={active.hash} hash={active.hash} note={active.note} />
      </section>

      <section
        className="inspector-section"
        data-inspector-section="links"
        aria-labelledby="inspector-links-heading"
      >
        <p className="eyebrow">LINKS</p>
        <h3 id="inspector-links-heading">关联提示词</h3>
        <AssetPromptLinks key={active.hash} hash={active.hash} />
      </section>
    </>
  );
}

/**
 * 批量关联的目标选择器（任务 11.2）：候选提示词自取活动区快照（分区自管只读
 * 请求，与关联分区的先例一致），写入经 onLink 上报工作区统一协调。
 */
function BatchLinkToPrompt({
  count,
  disabled,
  onLink,
}: {
  count: number;
  disabled: boolean;
  onLink: (promptId: string) => void;
}) {
  const [candidates, setCandidates] = useState<PromptRow[] | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [choice, setChoice] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const snapshot = await promptSnapshot({
          text: "",
          tags: [],
          folder: { kind: "all" },
          favorite: null,
          location: "active",
        });
        if (!cancelled) {
          setCandidates(snapshot.prompts);
          setError(null);
        }
      } catch (raw) {
        if (!cancelled) setError(asAppError(raw));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="batch-link-picker">
      {error !== null && <ErrorLine error={error} />}
      {candidates === null ? (
        <p role="status" className="muted">正在读取提示词候选…</p>
      ) : candidates.length === 0 ? (
        <p className="muted">提示词库还没有可用记录。</p>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (choice !== "") onLink(choice);
          }}
        >
          <label htmlFor="batch-link-prompt">目标提示词</label>
          <div className="compact-form">
            <select
              id="batch-link-prompt"
              value={choice}
              onChange={(event) => setChoice(event.target.value)}
            >
              <option value="" disabled>选择提示词…</option>
              {candidates.map((prompt) => (
                <option key={prompt.id} value={prompt.id}>
                  {promptDisplayTitle(prompt)}
                </option>
              ))}
            </select>
            <button type="submit" disabled={disabled || choice === ""}>建立关联</button>
          </div>
        </form>
      )}
      <p className="muted">将把 {count} 张图片普通关联到该提示词。</p>
    </div>
  );
}
