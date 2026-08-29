import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useRef, type KeyboardEvent, type UIEvent } from "react";

import { noteSummary } from "./noteSummary";
import { promptDisplayTitle } from "./promptDisplay";
import { useRovingFocus } from "../workspace/rovingFocus";
import { useScrollRestore } from "../workspace/scrollRestore";
import { useSelection } from "../workspace/selectionContext";
import type { PromptRow } from "../../shared/types";
import type { PromptSortColumn, PromptSort } from "./promptSort";

/** 固定行高（CSS px）：列表行高一致，估算值即真实值，滚动恢复因此稳定。 */
const ROW_HEIGHT = 56;

type PromptDetailListProps = {
  /** 当前查询的有序结果：选择模型与窗口化的定义域。 */
  prompts: readonly PromptRow[];
  /** 布局偏好里保存的滚动偏移键，挂载时据此恢复。 */
  scrollKey: string;
  savedOffset: number;
  /** 滚动经此上报；防抖持久化由分库布局偏好模型负责。 */
  onScrollOffset: (offset: number) => void;
  /** 当前排序值（与卡片瀑布流共享同一顺序）。 */
  sort: PromptSort;
  /** 点击可排序列头时报告列；升/降切换由持有排序状态的父级决定。 */
  onSortChange: (column: PromptSortColumn) => void;
  /** 双击或项目上的 Enter 显式进入聚焦阅读。 */
  onOpenFocused: (id: string) => void;
  /** 外壳切换可见性时通知虚拟器重新测量隐藏容器的真实高度。 */
  workspaceActive?: boolean;
};

/** 标题之外的可排序列。多值列与派生列不排序。 */
const SORTABLE_COLUMNS: ReadonlyArray<{ label: string; column: PromptSortColumn }> = [
  { label: "模型", column: "model" },
];

/**
 * 虚拟化提示词详情列表（任务 10.2）。
 *
 * 以标题/正文摘要、提示词文件夹、共享标签、关联图片数、模型/平台、收藏与更新
 * 时间为主要列（规格）。窗口化交给锁定的 @tanstack/react-virtual 单车道虚拟化；
 * 选择权威在统一 SelectionModel，与卡片瀑布流共用同一个 Provider——视图等价：
 * 切换不清空查询、排序、选择与活动项。表头与行样式复用图片侧详情列表的通用类，
 * 仅在 `.prompt-detail-list` 下替换栅格列定义。
 */
export function PromptDetailList({
  prompts,
  scrollKey,
  savedOffset,
  onScrollOffset,
  sort,
  onSortChange,
  onOpenFocused,
  workspaceActive = true,
}: PromptDetailListProps) {
  const { state, onItemClick, handleKeyDown } = useSelection();
  const scrollRef = useRef<HTMLDivElement>(null);

  // 定点豁免：设计第八条把位置与可见项锁定给 @tanstack/react-virtual；它返回的
  // 函数只在本组件内消费，不进 memo 化子组件。
  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({
    count: prompts.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 6,
    getItemKey: (index) => prompts[index]?.id ?? String(index),
  });

  useEffect(() => {
    if (workspaceActive) virtualizer.measure();
  }, [workspaceActive, virtualizer]);

  useScrollRestore(scrollRef, scrollKey, savedOffset);

  const findById = useCallback(
    (id: string) => prompts.findIndex((prompt) => prompt.id === id),
    [prompts],
  );
  const scrollToIndex = useCallback(
    (index: number) => {
      virtualizer.scrollToIndex(index, { align: "auto" });
    },
    [virtualizer],
  );
  const findItem = useCallback(
    (id: string) =>
      scrollRef.current?.querySelector<HTMLElement>(`[data-list-item][data-id="${id}"]`) ??
      null,
    [],
  );
  useRovingFocus(scrollRef, state.focusedId, findById, scrollToIndex, findItem);

  const ariaSortOf = (column: PromptSortColumn): "ascending" | "descending" | undefined => {
    if (sort.column !== column) return undefined;
    return sort.direction === "asc" ? "ascending" : "descending";
  };

  const sortArrowOf = (column: PromptSortColumn): string => {
    if (sort.column !== column) return "";
    return sort.direction === "asc" ? " ↑" : " ↓";
  };

  return (
    <div
      ref={scrollRef}
      className="prompt-detail-list"
      role="grid"
      aria-rowcount={prompts.length}
      onScroll={(event: UIEvent<HTMLDivElement>) => onScrollOffset(event.currentTarget.scrollTop)}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        if (handleKeyDown(event)) {
          event.preventDefault();
        }
      }}
    >
      <div className="detail-head">
        <span role="columnheader" aria-sort={ariaSortOf("title")} className="detail-col-title">
          <button type="button" onClick={() => onSortChange("title")}>
            标题 / 正文摘要
            <span aria-hidden="true">{sortArrowOf("title")}</span>
          </button>
        </span>
        {/* 多值列不参与排序：文件夹与标签的字典序没有稳定的使用者预期。 */}
        <span role="columnheader" aria-sort={undefined} className="detail-col-folders">文件夹</span>
        <span role="columnheader" aria-sort={undefined} className="detail-col-tags">标签</span>
        <span role="columnheader" aria-sort={undefined} className="detail-col-images">关联图片数</span>
        {SORTABLE_COLUMNS.map(({ label, column }) => (
          <span key={column} role="columnheader" aria-sort={ariaSortOf(column)} className={`detail-col-${column}`}>
            <button type="button" onClick={() => onSortChange(column)}>
              {label}
              <span aria-hidden="true">{sortArrowOf(column)}</span>
            </button>
          </span>
        ))}
        <span role="columnheader" aria-sort={undefined} className="detail-col-favorite">收藏</span>
        <span role="columnheader" aria-sort={ariaSortOf("updatedAt")} className="detail-col-updated">
          <button type="button" onClick={() => onSortChange("updatedAt")}>
            更新时间
            <span aria-hidden="true">{sortArrowOf("updatedAt")}</span>
          </button>
        </span>
      </div>
      <div className="asset-detail-canvas" style={{ height: virtualizer.getTotalSize() }}>
        {(workspaceActive ? virtualizer.getVirtualItems() : []).map((item) => {
          const prompt = prompts[item.index];
          if (prompt === undefined) return null;
          const selected = state.selectedIds.has(prompt.id);
          const active = state.activeId === prompt.id;
          return (
            <button
              key={item.key}
              type="button"
              role="row"
              data-list-item=""
              data-index={item.index}
              data-id={prompt.id}
              aria-selected={selected}
              aria-rowindex={item.index + 1}
              tabIndex={state.focusedId === prompt.id ? 0 : -1}
              className={`detail-row${selected ? " is-selected" : ""}${active ? " is-active" : ""}`}
              onDoubleClick={() => onOpenFocused(prompt.id)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                event.stopPropagation();
                onOpenFocused(prompt.id);
              }}
              style={{ height: item.size, transform: `translateY(${item.start}px)` }}
              onClick={(event) => {
                // 显式移交焦点：Safari 点击按钮不产生原生聚焦，键盘巡游依赖它。
                event.currentTarget.focus();
                onItemClick(prompt.id, event);
              }}
            >
              <span className="detail-value prompt-title-cell">
                <span className="prompt-title-line">{promptDisplayTitle(prompt)}</span>
                {/* 正文摘要是纯展示变换；权威正文原文永远在素材元数据里。 */}
                <span className="prompt-summary-line">{noteSummary(prompt.body, 60)}</span>
              </span>
              <span className="detail-value">{prompt.folders.join("、")}</span>
              <span className="detail-value">{prompt.tags.join("、")}</span>
              <span className="detail-value detail-mono">{prompt.linked_image_hashes.length}</span>
              <span className="detail-value detail-mono">{prompt.model ?? "—"}</span>
              <span className="detail-value">{prompt.favorite ? "★ 已收藏" : "☆ 未收藏"}</span>
              <span className="detail-value detail-mono">{prompt.updated_at.slice(0, 10)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
