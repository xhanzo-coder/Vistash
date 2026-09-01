/**
 * 提示词的批量组织操作区。
 *
 * 规格钉死：多选时右检查器只呈现共同值/混合值与批量操作。v3 只把图片侧收敛为
 * 单归属；提示词仍可同时属于多个文件夹，因此这里保留三态控件表达——全有（勾选）、
 * 部分拥有（半选并标注"部分"）、全无；点击即发起该维度的批量加入或移出，混合态
 * 一律按"加入全部"处理。收藏是二值字段，不一致时提供"全部收藏"出路。本组件只
 * 翻译意图，不直接发起 IPC——写入、报告与权威刷新由工作区统一协调。
 */

import { useState } from "react";

import { summarizePromptCommon, type PromptOrgFacts } from "../workspace/inspectorSummary";

type Props = {
  /** 选中项的组织事实；由检查器从当前查询行里解析。 */
  items: readonly PromptOrgFacts[];
  /** 库内全部逻辑文件夹：勾选列表按它渲染。 */
  folders: readonly string[];
  mutating: boolean;
  onBatchFolders: (folder: string, add: boolean) => void;
  onBatchTags: (tag: string, add: boolean) => void;
  onBatchFavorite: (favorite: boolean) => void;
};

export function PromptBatchOrganizer({
  items,
  folders,
  mutating,
  onBatchFolders,
  onBatchTags,
  onBatchFavorite,
}: Props) {
  const [tagDraft, setTagDraft] = useState("");
  const summary = summarizePromptCommon(items);

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
        <legend>逻辑文件夹</legend>
        {folders.length === 0 ? (
          <p className="muted">尚未创建文件夹。</p>
        ) : (
          folders.map((folder) => {
            const inAll =
              summary.folders.kind !== "empty" && summary.folders.values.includes(folder);
            const inSome = items.some((item) => item.folders.includes(folder));
            return (
              <label key={folder} className="check-row">
                <input
                  type="checkbox"
                  checked={inAll}
                  ref={(el) => {
                    if (el !== null) el.indeterminate = !inAll && inSome;
                  }}
                  disabled={mutating}
                  aria-label={
                    inAll ? `批量移出文件夹 ${folder}` : `批量加入文件夹 ${folder}`
                  }
                  onChange={() => onBatchFolders(folder, !inAll)}
                />
                <span>
                  {folder}
                  {!inAll && inSome ? "（部分）" : ""}
                </span>
              </label>
            );
          })
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
