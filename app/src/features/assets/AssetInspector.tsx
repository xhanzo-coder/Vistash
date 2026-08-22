import { useState } from "react";

import type { AssetRow } from "../../shared/types";
import { ErrorLine } from "../library/ErrorLine";
import { useSelection } from "../workspace/selectionContext";
import { ROLE_TEXT } from "./AssetPreview";
import { AssetNoteEditor } from "./AssetNoteEditor";
import { AssetPromptLinks } from "./AssetPromptLinks";

type AssetInspectorProps = {
  /** 当前查询的有序结果：活动项在这里解析成素材。 */
  assets: readonly AssetRow[];
  /** 库内全部逻辑文件夹：组织分区按它渲染复选框。 */
  folders: readonly string[];
  mutating: boolean;
  /** 当前处于回收站位置：组织编辑让位给还原入口。 */
  trashLocation: boolean;
  onSetFolders: (hash: string, folders: string[]) => void;
  onSetTags: (hash: string, tags: string[]) => void;
  onDeleteAsset: (hash: string) => void;
  onRestoreAsset: (hash: string) => void;
  /** 收藏快捷开关（任务 9.4）：只表示二值状态，不扩展为评级。 */
  onToggleFavorite: (hash: string, favorite: boolean) => void;
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
  onSetFolders,
  onSetTags,
  onDeleteAsset,
  onRestoreAsset,
  onToggleFavorite,
}: AssetInspectorProps) {
  const { state } = useSelection();
  const [tagDraft, setTagDraft] = useState("");

  // 多选优先于单件分区：检查器此时只呈现数量摘要（批量操作由后续任务接线）。
  if (state.selectedIds.size > 1) {
    return (
      <div className="inspector-multi">
        <p className="eyebrow">MULTI SELECT</p>
        <h3>已选 {state.selectedIds.size} 项</h3>
        <p className="muted">批量组织操作将在批量工具条就绪后在此提供。</p>
      </div>
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
          <dd>{active.original_filename}</dd>
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
              <legend>逻辑文件夹</legend>
              {folders.length === 0 ? (
                <p className="muted">尚未创建文件夹。</p>
              ) : (
                folders.map((folder) => (
                  <label key={folder} className="check-row">
                    <input
                      type="checkbox"
                      value={folder}
                      checked={active.folders.includes(folder)}
                      disabled={mutating}
                      onChange={() => {
                        const next = active.folders.includes(folder)
                          ? active.folders.filter((item) => item !== folder)
                          : [...active.folders, folder];
                        onSetFolders(active.hash, next);
                      }}
                    />
                    <span>{folder}</span>
                  </label>
                ))
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
