import { useState } from "react";

import type { PromptRow } from "../../shared/types";
import { useSelection } from "../workspace/selectionContext";
import { PromptImageLinks } from "./PromptImageLinks";
import { PromptNoteEditor } from "./PromptNoteEditor";
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
  /** 请求进入聚焦编辑器并直接落在主字段编辑状态（任务 10.4）。 */
  onEditBodyFocus: (id: string) => void;
  /** 关联图片发生任何变更后刷新权威快照（任务 10.5）。 */
  onImagesChanged: () => void;
  /** 当前处于提示词回收站位置：组织编辑让位给还原入口（任务 10.6）。 */
  trashLocation: boolean;
  /** 把活动项移入提示词回收站；确认对话框由工作区承载。 */
  onDeletePrompt: (id: string) => void;
  /** 从提示词回收站还原活动项；缺失文件夹警告由工作区呈现。 */
  onRestorePrompt: (id: string) => void;
};

/**
 * 右侧固定提示词检查器（任务 10.3）。
 *
 * 单击卡片或列表行只更新这里，不替换中央集合视图；聚焦阅读由显式按钮进入。
 * 分区按规格可定位：当前正文与元数据（info）、组织（organization）、备注
 * （note）与全部关联图片（images）。选择权威在统一 SelectionModel——本组件
 * 只是活动项与多选摘要的呈现端。备注的独立自动保存与主字段显式保存在任务
 * 10.4 接入，关联图片的完整管理在任务 10.5 由 PromptImageLinks 承担。
 */
export function PromptInspector({
  prompts,
  folders,
  mutating,
  onSetFolders,
  onSetTags,
  onToggleFavorite,
  onOpenBodyFocus,
  onEditBodyFocus,
  onImagesChanged,
  trashLocation,
  onDeletePrompt,
  onRestorePrompt,
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
        {/*
          主字段的修改只在聚焦编辑器的明确编辑状态里发生（规格）；检查器只提供
          阅读入口与编辑入口，自身不承载主字段草稿。
        */}
        <div className="button-row">
          <button
            type="button"
            disabled={mutating}
            onClick={() => onOpenBodyFocus(active.id)}
          >
            聚焦阅读
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={mutating}
            onClick={() => onEditBodyFocus(active.id)}
          >
            编辑主字段
          </button>
        </div>
      </section>

      <section
        className="inspector-section"
        data-inspector-section="organization"
        aria-labelledby="prompt-inspector-organization-heading"
      >
        <p className="eyebrow">ORGANIZE</p>
        <h3 id="prompt-inspector-organization-heading">组织</h3>
        {trashLocation ? (
          <>
            {/* 回收站里的提示词保留全部内容与关联：这里只提供还原出路（任务 10.6）。 */}
            <p className="muted">回收站中的提示词保留正文、组织与全部图片关联，还原后即可继续编辑。</p>
            <button
              type="button"
              className="primary-button"
              disabled={mutating}
              onClick={() => onRestorePrompt(active.id)}
            >
              还原提示词
            </button>
          </>
        ) : (
          <>
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
            {/* 移入回收站是可逆操作，但仍经工作区的二次确认对话框发起。 */}
            <button
              type="button"
              className="danger-button"
              disabled={mutating}
              onClick={() => onDeletePrompt(active.id)}
            >
              移入回收站
            </button>
          </>
        )}
      </section>

      {/* 备注是独立自动保存流（任务 10.4）：不推进更新时间，失败保留草稿。 */}
      <section
        className="inspector-section"
        data-inspector-section="note"
        aria-labelledby="prompt-inspector-note-heading"
      >
        <p className="eyebrow">NOTE</p>
        <h3 id="prompt-inspector-note-heading">备注</h3>
        <PromptNoteEditor key={active.id} id={active.id} note={active.note} />
      </section>

      <section
        className="inspector-section"
        data-inspector-section="images"
        aria-labelledby="prompt-inspector-images-heading"
      >
        <p className="eyebrow">IMAGES</p>
        <h3 id="prompt-inspector-images-heading">关联图片</h3>
        {/*
          关联的建立/解除/封面/回收站标记全部由 PromptImageLinks 承担（任务 10.5）：
          它自取关联状态并在变更后经 onImagesChanged 触发工作区权威刷新。以活动
          项 id 作 key，换活动项即重新挂载。
        */}
        <PromptImageLinks key={active.id} active={active} onChanged={onImagesChanged} />
      </section>
    </>
  );
}
