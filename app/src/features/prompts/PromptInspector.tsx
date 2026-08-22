import { useRef, useState } from "react";

import type { PromptRow } from "../../shared/types";
import { ErrorLine } from "../library/ErrorLine";
import { useSelection } from "../workspace/selectionContext";
import { useLazyThumbnailUrl } from "../workspace/thumbnailUrl";
import { promptDisplayTitle } from "./promptDisplay";

type PromptInspectorProps = {
  /** 当前查询的有序结果：活动项在这里解析成提示词。 */
  prompts: readonly PromptRow[];
  /** 库内全部提示词文件夹路径：组织分区按它渲染复选框。 */
  folders: readonly string[];
  mutating: boolean;
  onSetFolders: (id: string, folders: string[]) => void;
  onSetTags: (id: string, tags: string[]) => void;
  /** 收藏快捷开关：只表示二值状态，不扩展为评级。 */
  onToggleFavorite: (id: string, favorite: boolean) => void;
  /** 请求进入长文本聚焦阅读（中央区替换，退出回原列表位置）。 */
  onOpenBodyFocus: (id: string) => void;
};

/**
 * 关联图片的一格缩略图（任务 10.3）。
 *
 * 检查器手里只有哈希没有素材行，因此不复用吃 AssetRow 的 Thumbnail，而是共用
 * 同一套懒加载生命周期；格位固定方形，超出部分裁剪。加载失败必须显式呈现原因，
 * 不留一个与"空关联"无法区分的空白。
 */
function LinkedThumb({ hash }: { hash: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { started, url, error } = useLazyThumbnailUrl(containerRef, hash);

  return (
    <div ref={containerRef} className="linked-thumb" aria-busy={started && url === null && error === null}>
      {error !== null ? (
        <ErrorLine error={error} />
      ) : url !== null ? (
        <img src={url} alt="" loading="lazy" />
      ) : started ? (
        <p>正在载入…</p>
      ) : (
        <p>等待载入…</p>
      )}
    </div>
  );
}

/**
 * 右侧固定提示词检查器（任务 10.3）。
 *
 * 单击卡片或列表行只更新这里，不替换中央集合视图；聚焦阅读由显式按钮进入。
 * 分区按规格可定位：当前正文与元数据（info）、组织（organization）、备注
 * （note）与全部关联图片（images）。选择权威在统一 SelectionModel——本组件
 * 只是活动项与多选摘要的呈现端。备注的独立自动保存与主字段显式保存在任务
 * 10.4 接入。
 */
export function PromptInspector({
  prompts,
  folders,
  mutating,
  onSetFolders,
  onSetTags,
  onToggleFavorite,
  onOpenBodyFocus,
}: PromptInspectorProps) {
  const { state } = useSelection();
  const [tagDraft, setTagDraft] = useState("");
  const [folderDraft, setFolderDraft] = useState("");

  // 多选优先于单件分区：检查器此时只呈现数量摘要（批量操作由批量工具条接线）。
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
      : (prompts.find((prompt) => prompt.id === state.activeId) ?? null);

  if (active === null) {
    return (
      <div className="inspector-placeholder">
        <p className="eyebrow">INSPECTOR</p>
        <h3>提示词检查器</h3>
        <p className="muted">单击一张卡片查看正文、组织归属与关联图片。</p>
      </div>
    );
  }

  // 用 const 箭头函数而不是提升的函数声明：active 的非空收窄只对声明点之后的
  // 闭包生效，函数声明会被视为可能在前置检查之前调用。
  const submitNewFolder = () => {
    const path = folderDraft.trim();
    if (path === "" || active.folders.includes(path)) return;
    onSetFolders(active.id, [...active.folders, path]);
    setFolderDraft("");
  };

  return (
    <>
      <section
        className="inspector-section"
        data-inspector-section="info"
        aria-labelledby="prompt-inspector-info-heading"
      >
        <p className="eyebrow">PROMPT</p>
        <div className="inspector-heading-row">
          <h3 id="prompt-inspector-info-heading">{promptDisplayTitle(active)}</h3>
          <button
            type="button"
            className={`favorite-toggle${active.favorite ? " is-on" : ""}`}
            aria-pressed={active.favorite}
            disabled={mutating}
            onClick={() => onToggleFavorite(active.id, !active.favorite)}
          >
            {active.favorite ? "★ 已收藏" : "☆ 收藏"}
          </button>
        </div>
        <dl className="info-grid">
          <dt>模型/平台</dt>
          <dd>{active.model ?? "—"}</dd>
          <dt>参数说明</dt>
          <dd>{active.parameters ?? "—"}</dd>
          <dt>更新时间</dt>
          <dd className="detail-mono">{active.updated_at.slice(0, 10)}</dd>
          <dt>关联图片数</dt>
          <dd className="detail-mono">{active.linked_image_hashes.length}</dd>
        </dl>
        <h4>当前正文</h4>
        {/* 规格要求呈现完整当前正文；这里是唯一权威正文的只读呈现。 */}
        <pre className="inspector-body-full">{active.body}</pre>
        <button
          type="button"
          className="primary-button"
          disabled={mutating}
          onClick={() => onOpenBodyFocus(active.id)}
        >
          聚焦阅读
        </button>
      </section>

      <section
        className="inspector-section"
        data-inspector-section="organization"
        aria-labelledby="prompt-inspector-organization-heading"
      >
        <p className="eyebrow">ORGANIZE</p>
        <h3 id="prompt-inspector-organization-heading">组织</h3>
        {/*
          提示词文件夹树与图片彼此独立、同路径字面值可各自存在（规格）。库内没有
          预建空文件夹的命令——文件夹由成员关系派生，因此除勾选既有路径外还提供
          新路径输入，提交时并入归属数组，后端按需建立路径。
        */}
        <fieldset>
          <legend>提示词文件夹</legend>
          {folders.length === 0 ? (
            <p className="muted">尚无文件夹路径。</p>
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
                    onSetFolders(active.id, next);
                  }}
                />
                <span>{folder}</span>
              </label>
            ))
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              submitNewFolder();
            }}
          >
            <label htmlFor="new-prompt-folder">新建文件夹路径</label>
            <div className="compact-form">
              <input
                id="new-prompt-folder"
                name="new-prompt-folder"
                autoComplete="off"
                placeholder="如 人像/室内"
                value={folderDraft}
                onChange={(event) => setFolderDraft(event.target.value)}
                required
              />
              <button type="submit" disabled={mutating}>添加</button>
            </div>
          </form>
        </fieldset>
        <div className="tag-editor">
          <h4>共享标签</h4>
          <div className="tag-list">
            {active.tags.map((tag) => (
              <button
                type="button"
                key={tag}
                aria-label={`移除标签 ${tag}`}
                disabled={mutating}
                onClick={() => onSetTags(active.id, active.tags.filter((item) => item !== tag))}
              >
                {tag} ×
              </button>
            ))}
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              onSetTags(active.id, [...active.tags, tagDraft]);
              setTagDraft("");
            }}
          >
            <label htmlFor="new-prompt-tag">添加标签</label>
            <div className="compact-form">
              <input
                id="new-prompt-tag"
                name="new-prompt-tag"
                autoComplete="off"
                value={tagDraft}
                onChange={(event) => setTagDraft(event.target.value)}
                required
              />
              <button type="submit" disabled={mutating}>添加</button>
            </div>
          </form>
        </div>
      </section>

      {/* 备注的独立自动保存状态机在任务 10.4 接入；本切片先只读呈现权威值。 */}
      <section
        className="inspector-section"
        data-inspector-section="note"
        aria-labelledby="prompt-inspector-note-heading"
      >
        <p className="eyebrow">NOTE</p>
        <h3 id="prompt-inspector-note-heading">备注</h3>
        {active.note === "" ? (
          <p className="muted">尚无备注。</p>
        ) : (
          <pre className="inspector-note-text">{active.note}</pre>
        )}
      </section>

      <section
        className="inspector-section"
        data-inspector-section="images"
        aria-labelledby="prompt-inspector-images-heading"
      >
        <p className="eyebrow">IMAGES</p>
        <h3 id="prompt-inspector-images-heading">关联图片</h3>
        {active.linked_image_hashes.length === 0 ? (
          <p className="muted">还没有关联图片。可在图片侧建立普通关联，或从本检查器导入。</p>
        ) : (
          <ul className="linked-thumbs" aria-label={`关联 ${active.linked_image_hashes.length} 张图片`}>
            {active.linked_image_hashes.map((hash) => (
              <li key={hash} data-linked-hash={hash}>
                <LinkedThumb hash={hash} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
