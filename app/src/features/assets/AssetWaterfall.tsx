import { useVirtualizer } from "@tanstack/react-virtual";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type UIEvent,
} from "react";

import { estimatedTileHeight, waterfallMetrics } from "./waterfallMetrics";
import { Thumbnail } from "./Thumbnail";
import { useRovingFocus } from "../workspace/rovingFocus";
import { useScrollRestore } from "../workspace/scrollRestore";
import { useSelection } from "../workspace/selectionContext";
import type { AssetRow } from "../../shared/types";

/** 列间与行间距（CSS px）。 */
const GAP = 12;

type AssetWaterfallProps = {
  /** 当前查询的有序结果：选择模型与窗口化的定义域。 */
  assets: readonly AssetRow[];
  /** 布局偏好里保存的滚动偏移键，挂载时据此恢复。 */
  scrollKey: string;
  savedOffset: number;
  /** 滚动经此上报；防抖持久化由分库布局偏好模型负责。 */
  onScrollOffset: (offset: number) => void;
  /** 双击进入聚焦原图模式（检查器落地前暂接旧详情页）。 */
  onOpenFocused: (hash: string) => void;
  /** 密度旋钮：期望瓦片宽度。 */
  targetTileWidth?: number;
};

/**
 * 虚拟化原画幅瀑布流（任务 9.1）。
 *
 * 选择权威在统一 SelectionModel（设计第七条），本组件只把指针与键盘事件翻译成
 * 动作；位置与可见项交给 @tanstack/react-virtual 的 lanes 窗口化（设计第八条），
 * 列数密度由容器宽度决定、瓦片高度按原画幅估算——比例来自编目元数据，无需测量
 * 即可稳定恢复滚动。
 */
export function AssetWaterfall({
  assets,
  scrollKey,
  savedOffset,
  onScrollOffset,
  onOpenFocused,
  targetTileWidth = 280,
}: AssetWaterfallProps) {
  const { state, onItemClick, handleKeyDown } = useSelection();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  // 容器宽度驱动列数密度；jsdom 无布局时保持 0，组件退化为单列等待真实读数。
  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) throw new Error("瀑布流滚动容器在挂载后不存在");
    const observer = new ResizeObserver((entries) => {
      const width = entries.at(-1)?.contentRect.width;
      if (width !== undefined) setContainerWidth(width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const { columnCount, laneWidth } = waterfallMetrics(containerWidth, targetTileWidth, GAP);

  // 定点豁免：设计第八条把位置与可见项锁定给 @tanstack/react-virtual；它返回的
  // 函数只在本组件内消费，不进 memo 化子组件。
  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({
    count: assets.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const asset = assets[index];
      return asset === undefined ? laneWidth : estimatedTileHeight(laneWidth, asset) + GAP;
    },
    overscan: 6,
    lanes: columnCount,
    getItemKey: (index) => assets[index]?.hash ?? String(index),
  });

  useScrollRestore(scrollRef, scrollKey, savedOffset);

  // 键盘导航后把活动项滚进窗口并把焦点交给对应卡片；回调随资产数组与虚拟化
  // 实例保持稳定，避免无关渲染反复触发聚焦。
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
      scrollRef.current?.querySelector<HTMLElement>(
        `[data-waterfall-item][data-hash="${id}"]`,
      ) ?? null,
    [],
  );
  useRovingFocus(scrollRef, state.focusedId, findById, scrollToIndex, findItem);

  return (
    <div
      ref={scrollRef}
      className="asset-waterfall"
      onScroll={(event: UIEvent<HTMLDivElement>) => onScrollOffset(event.currentTarget.scrollTop)}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        if (handleKeyDown(event)) event.preventDefault();
      }}
    >
      <div className="asset-waterfall-canvas" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const asset = assets[item.index];
          if (asset === undefined) return null;
          const selected = state.selectedIds.has(asset.hash);
          const active = state.activeId === asset.hash;
          return (
            <button
              key={item.key}
              type="button"
              data-waterfall-item=""
              data-index={item.index}
              data-hash={asset.hash}
              aria-selected={selected}
              aria-label={asset.original_filename}
              tabIndex={state.focusedId === asset.hash ? 0 : -1}
              className={`asset-waterfall-item${selected ? " is-selected" : ""}${active ? " is-active" : ""}`}
              style={{
                width: laneWidth,
                height: item.size - GAP,
                transform: `translate(${item.lane * (laneWidth + GAP)}px, ${item.start}px)`,
              }}
              onClick={(event) => {
                // 显式移交焦点：Safari 点击按钮不产生原生聚焦，键盘巡游依赖它。
                event.currentTarget.focus();
                onItemClick(asset.hash, event);
              }}
              onDoubleClick={() => onOpenFocused(asset.hash)}
            >
              <span className="asset-waterfall-frame">
                <Thumbnail asset={asset} />
              </span>
              <span className="asset-name">{asset.original_filename}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
