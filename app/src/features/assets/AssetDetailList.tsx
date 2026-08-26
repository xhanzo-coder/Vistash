import { useVirtualizer } from "@tanstack/react-virtual";
import {
  useCallback,
  useRef,
  type KeyboardEvent,
  type UIEvent,
} from "react";

import { noteSummary } from "./noteSummary";
import { Thumbnail } from "./Thumbnail";
import { useRovingFocus } from "../workspace/rovingFocus";
import { useScrollRestore } from "../workspace/scrollRestore";
import { useSelection } from "../workspace/selectionContext";
import type { AssetRow } from "../../shared/types";
import type { AssetSortColumn } from "./assetSort";

/** 固定行高（CSS px）：列表行高一致，估算值即真实值，滚动恢复因此稳定。 */
const ROW_HEIGHT = 56;

type AssetDetailListProps = {
  /** 当前查询的有序结果：选择模型与窗口化的定义域。 */
  assets: readonly AssetRow[];
  /** 布局偏好里保存的滚动偏移键，挂载时据此恢复。 */
  scrollKey: string;
  savedOffset: number;
  /** 滚动经此上报；防抖持久化由分库布局偏好模型负责。 */
  onScrollOffset: (offset: number) => void;
  /** 双击进入聚焦原图模式（检查器落地前暂接旧详情页）。 */
  onOpenFocused: (hash: string) => void;
  /** 当前排序值（与瀑布流共享同一顺序）。 */
  sort: { readonly column: AssetSortColumn; readonly direction: "asc" | "desc" };
  /** 点击可排序列头时报告列；升/降切换由持有排序状态的父级决定。 */
  onSortChange: (column: AssetSortColumn) => void;
};

/** 文件名之外的可排序列（文件名列在表头里单独书写）。多值列不排序。 */
const SORTABLE_COLUMNS: ReadonlyArray<{ label: string; column: AssetSortColumn }> = [
  { label: "尺寸", column: "dimensions" },
  { label: "格式", column: "format" },
  { label: "导入时间", column: "importedAt" },
];

/**
 * 虚拟化详情列表（任务 9.2）。
 *
 * 以缩略图、文件名、图片文件夹、标签、尺寸、格式、导入时间与备注摘要为列
 * （规格：图片瀑布流、详情列表与固定检查器）。窗口化交给锁定的
 * @tanstack/react-virtual 单车道虚拟化；选择权威在统一 SelectionModel，
 * 与瀑布流共用同一个 Provider——切换视图不清空查询、排序、选择与活动项。
 */
export function AssetDetailList({
  assets,
  scrollKey,
  savedOffset,
  onScrollOffset,
  onOpenFocused,
  sort,
  onSortChange,
}: AssetDetailListProps) {
  const { state, onItemClick, handleKeyDown } = useSelection();
  const scrollRef = useRef<HTMLDivElement>(null);

  // 定点豁免：设计第八条把位置与可见项锁定给 @tanstack/react-virtual；它返回的
  // 函数只在本组件内消费，不进 memo 化子组件。
  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({
    count: assets.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 6,
    getItemKey: (index) => assets[index]?.hash ?? String(index),
  });

  useScrollRestore(scrollRef, scrollKey, savedOffset);

  const findById = useCallback(
    (id: string) => assets.findIndex((asset) => asset.hash === id),
    [assets],
  );
  const scrollToIndex = useCallback(
    (index: number) => {
      virtualizer.scrollToIndex(index, { align: "auto" });
    },
    [virtualizer],
  );
  const findItem = useCallback(
    (id: string) =>
      scrollRef.current?.querySelector<HTMLElement>(`[data-list-item][data-hash="${id}"]`) ??
      null,
    [],
  );
  useRovingFocus(scrollRef, state.focusedId, findById, scrollToIndex, findItem);

  const ariaSortOf = (column: AssetSortColumn): "ascending" | "descending" | undefined => {
    if (sort.column !== column) return undefined;
    return sort.direction === "asc" ? "ascending" : "descending";
  };

  return (
    <div
      ref={scrollRef}
      className="asset-detail-list"
      role="grid"
      aria-rowcount={assets.length}
      onScroll={(event: UIEvent<HTMLDivElement>) => onScrollOffset(event.currentTarget.scrollTop)}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        if (handleKeyDown(event)) {
          event.preventDefault();
          return;
        }
        // Enter 显式进入聚焦原图（规格：聚焦查看不得是单击的默认结果）。
        if (event.key === "Enter" && state.activeId !== null) {
          event.preventDefault();
          onOpenFocused(state.activeId);
        }
      }}
    >
      <div className="detail-head">
        <span role="columnheader" aria-sort={undefined} className="detail-col-thumb">缩略图</span>
        <span role="columnheader" aria-sort={ariaSortOf("filename")} className="detail-col-filename">
          <button type="button" onClick={() => onSortChange("filename")}>
            文件名
            <span aria-hidden="true">{ariaSortOf("filename") === "ascending" ? " ↑" : ariaSortOf("filename") === "descending" ? " ↓" : ""}</span>
          </button>
        </span>
        {/* 多值列不参与排序：文件夹与标签的字典序没有稳定的使用者预期。 */}
        <span role="columnheader" aria-sort={undefined} className="detail-col-folders">文件夹</span>
        <span role="columnheader" aria-sort={undefined} className="detail-col-tags">标签</span>
        {SORTABLE_COLUMNS.map(({ label, column }) => (
          <span key={column} role="columnheader" aria-sort={ariaSortOf(column)} className={`detail-col-${column}`}>
            <button type="button" onClick={() => onSortChange(column)}>
              {label}
              <span aria-hidden="true">{ariaSortOf(column) === "ascending" ? " ↑" : ariaSortOf(column) === "descending" ? " ↓" : ""}</span>
            </button>
          </span>
        ))}
        <span role="columnheader" aria-sort={undefined} className="detail-col-note">备注</span>
      </div>
      <div className="asset-detail-canvas" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const asset = assets[item.index];
          if (asset === undefined) return null;
          const selected = state.selectedIds.has(asset.hash);
          const active = state.activeId === asset.hash;
          return (
            <button
              key={item.key}
              type="button"
              role="row"
              data-list-item=""
              data-index={item.index}
              data-hash={asset.hash}
              aria-selected={selected}
              aria-rowindex={item.index + 1}
              tabIndex={state.focusedId === asset.hash ? 0 : -1}
              className={`detail-row${selected ? " is-selected" : ""}${active ? " is-active" : ""}`}
              style={{ height: item.size, transform: `translateY(${item.start}px)` }}
              onClick={(event) => {
                // 显式移交焦点：Safari 点击按钮不产生原生聚焦，键盘巡游依赖它。
                event.currentTarget.focus();
                onItemClick(asset.hash, event);
              }}
              onDoubleClick={() => onOpenFocused(asset.hash)}
            >
              <span className="detail-thumb">
                <Thumbnail asset={asset} />
              </span>
              <span className="detail-value detail-name">{asset.original_filename}</span>
              <span className="detail-value">{asset.folder ?? "未分类"}</span>
              <span className="detail-value">{asset.tags.join("、")}</span>
              <span className="detail-value detail-mono">
                {asset.width} × {asset.height}
              </span>
              <span className="detail-value detail-mono">{asset.media_type}</span>
              <span className="detail-value detail-mono">{asset.imported_at.slice(0, 10)}</span>
              <span className="detail-value detail-note">{noteSummary(asset.note, 60)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
