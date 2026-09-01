/**
 * 批量组织操作区（任务 11.2，8.5 预留的检查器多选落点）。
 *
 * 规格钉死：多选时右检查器只呈现共同值/混合值与批量操作。单归属（v3）下批量
 * 文件夹只有"整体移动"一个方向：按文件夹逐个给出"移动到"动作，另有"移回未
 * 分类"。标签仍用三态控件表达——全有、部分拥有、全无；点击即发起该维度的批量
 * 加入或移出，混合态一律按"加入全部"处理。收藏是二值字段，不一致时提供"全部
 * 收藏"出路。本组件只翻译意图，不直接发起 IPC——写入、报告与权威刷新由工作区
 * 统一协调。
 */

import { useState } from "react";

import { summarizeCommon, type OrgFacts } from "./inspectorSummary";

type Props = {
  /** 选中项的组织事实；由检查器从当前查询行里解析。 */
  items: readonly OrgFacts[];
  /** 库内全部逻辑文件夹：移动目标列表按它渲染。 */
  folders: readonly string[];
  mutating: boolean;
  onBatchMove: (folder: string | null) => void;
  onBatchTags: (tag: string, add: boolean) => void;
  onBatchFavorite: (favorite: boolean) => void;
};

export function BatchOrganizer({
  items,
  folders,
  mutating,
  onBatchMove,
  onBatchTags,
  onBatchFavorite,
}: Props) {
  const [tagDraft, setTagDraft] = useState("");
  const summary = summarizeCommon(items);

  // 出现在至少一项里的标签并集：共同子集之外的是"部分拥有"，呈现为待补齐。
  // 完全没有选中项拥有的标签经下方表单按名称添加。
  const tagUnion: string[] = [];
  for (const item of items) {
    for (const tag of item.tags) {
      if (!tagUnion.includes(tag)) tagUnion.push(tag);
    }
  }

  const favorite = summary.favorite;
  const favoriteAction = favorite.kind === "common" ? !favorite.value : true;
  const favoriteLabel =
    favorite.kind === "common"
      ? favorite.value
        ? "全部取消收藏"
        : "全部收藏"
      : "全部收藏（当前不一致）";

  return (
    <div className="batch-organizer">
      <fieldset>
        {/* 单归属批量：移动是替换语义，逐个文件夹给出目标动作；
            摘要行只作呈现（共同归属/不一致），不承担三态切换。 */}
        <legend>移动到文件夹</legend>
        {folders.length === 0 ? (
          <p className="muted">尚未创建文件夹。</p>
        ) : (
          <>
            <p className="muted">
              {summary.folder.kind === "common"
                ? `当前共同归属：${summary.folder.value ?? "未分类"}`
                : "选中项的归属不一致。"}
            </p>
            {folders.map((folder) => (
              <label key={folder} className="check-row">
                <input
                  type="radio"
                  name="batch-move-folder"
                  value={folder}
                  disabled={mutating}
                  aria-label={`批量移动到文件夹 ${folder}`}
                  onChange={() => onBatchMove(folder)}
                />
                <span>{folder}</span>
              </label>
            ))}
            <label className="check-row">
              <input
                type="radio"
                name="batch-move-folder"
                value=""
                disabled={mutating}
                aria-label="批量移回未分类"
                onChange={() => onBatchMove(null)}
              />
              <span>未分类</span>
            </label>
          </>
        )}
      </fieldset>

      <div className="tag-editor">
        <h4>共享标签</h4>
        <div className="tag-list">
          {tagUnion.map((tag) => {
            const inAll = summary.tags.kind !== "empty" && summary.tags.values.includes(tag);
            return (
              <button
                type="button"
                key={tag}
                aria-pressed={inAll}
                disabled={mutating}
                aria-label={inAll ? `批量移除标签 ${tag}` : `批量添加标签 ${tag}`}
                onClick={() => onBatchTags(tag, !inAll)}
              >
                {tag}
                {inAll ? "" : "（部分）"}
              </button>
            );
          })}
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onBatchTags(tagDraft, true);
            setTagDraft("");
          }}
        >
          <label htmlFor="batch-new-tag">为全部选中项添加标签</label>
          <div className="compact-form">
            <input
              id="batch-new-tag"
              name="batch-new-tag"
              autoComplete="off"
              value={tagDraft}
              onChange={(event) => setTagDraft(event.target.value)}
              required
            />
            <button type="submit" disabled={mutating}>添加</button>
          </div>
        </form>
      </div>

      <div>
        <h4>收藏</h4>
        <button
          type="button"
          className="primary-button"
          disabled={mutating}
          onClick={() => onBatchFavorite(favoriteAction)}
        >
          {favoriteLabel}
        </button>
      </div>
    </div>
  );
}
