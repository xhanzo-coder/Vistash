import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { parseAssetId, type AssetId } from "../../../app/common";
import { createTauriPlatform } from "../../../app/platformTauri";
import type { ImageLease } from "../../../app/platform";
import type { AssetRow } from "../../../shared/types";
import { IpcError } from "../../../shared/errors";
import type { ThumbnailSize } from "./preferences";
import { useBoxSelection } from "./useBoxSelection";
import styles from "./AssetLibraryWorkspace.module.css";

const media = createTauriPlatform();
const GAP = 12;
/** 各缩略图档位对应的卡片基准宽度；实际列宽按容器宽度均分剩余空间。 */
const TILE_WIDTHS: Record<ThumbnailSize, number> = { small: 200, medium: 280, large: 380 };
/** 滚动偏移回写的防抖间隔；键名与落盘表由上层拥有。 */
const SCROLL_SAVE_DEBOUNCE_MS = 300;

export function AssetThumbnail({ asset }: { asset: AssetRow }): ReactNode {
  const [lease, setLease] = useState<ImageLease | null>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    let mounted = true;
    let owned: ImageLease | null = null;
    void media.acquireThumbnail(asset.hash).then((acquired) => {
      if (!mounted) { acquired.release(); return undefined; }
      owned = acquired;
      setLease(acquired);
      return undefined;
    }, (reason: unknown) => {
      if (!mounted) return;
      if (!(reason instanceof Error)) throw reason;
      setError(reason);
    });
    return () => { mounted = false; owned?.release(); };
  }, [asset.hash]);
  if (error !== null) {
    if (!(error instanceof IpcError)) throw error;
    return <span className={styles.thumbnailError} title={error.message}>缩略图读取失败<br />{error.appError.code}</span>;
  }
  return lease === null ? <span className={styles.thumbnailPending} aria-label="正在读取缩略图" /> : <img src={lease.url} alt="" width={asset.width} height={asset.height} draggable={false} />;
}

export type AssetContextMenuActions = {
  onFavorite: (id: AssetId, value: boolean) => void;
  onTrash: (id: AssetId) => void;
};

type CollectionProps = {
  assets: readonly AssetRow[];
  view: "waterfall" | "list";
  /** 唯一活动项；aria-current 与键盘位置语义由上层选择模型拥有。 */
  activeId: AssetId | null;
  focusedId: string | null;
  onNavigate: (step: "next" | "prev" | "first" | "last", extend: boolean) => void;
  selectedIds: ReadonlySet<string>;
  /** 单项点击：修饰键由集合透传，选择语义由上层选择模型裁决。 */
  onItemSelect: (id: AssetId, modifiers: { ctrl: boolean; shift: boolean }) => void;
  /** 框选提交：命中 ID 已按当前查询域过滤。 */
  onBoxSelect: (ids: readonly string[], additive: boolean) => void;
  tileSize: ThumbnailSize;
  /** 会话恢复用的初始滚动偏移；仅在本次挂载内消费一次。 */
  initialScrollTop?: number | undefined;
  /** 滚动防抖后的偏移回写入口；由上层并入布局偏好统一持久化。 */
  onScrollOffset?: ((offset: number) => void) | undefined;
  /** 右键快捷菜单动作；缺省（回收站）时不渲染菜单。 */
  contextMenu?: AssetContextMenuActions | undefined;
};

/** 两种呈现复用同一查询、排序与选择；窗口化、密度、框选与图片租约留在集合内部。 */
export function AssetCollection(props: CollectionProps): ReactNode {
  const { assets, view, activeId, focusedId, onNavigate, selectedIds, onItemSelect, onBoxSelect, tileSize, initialScrollTop, onScrollOffset, contextMenu } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element === null) throw new Error("集合滚动容器尚未挂载");
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) if (entry.target === element) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const tileWidth = TILE_WIDTHS[tileSize];
  const lanes = view === "list" ? 1 : Math.max(1, Math.floor((width + GAP) / (tileWidth + GAP)));
  const itemWidth = (width - (lanes - 1) * GAP) / lanes;
  const orderedIds = useMemo(() => assets.map((asset) => asset.hash), [assets]);
  const getAsset = useCallback((index: number): AssetRow => {
    const asset = assets[index];
    if (asset === undefined) throw new RangeError(`集合索引超界：${index}`);
    if (asset.width <= 0 || asset.height <= 0) throw new TypeError(`图片尺寸必须为正：${asset.hash}`);
    return asset;
  }, [assets]);
  const getItemKey = useCallback((index: number) => getAsset(index).hash, [getAsset]);
  // 虚拟化已由 OpenSpec 固定选型；实例只在本集合内部使用。
  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({
    count: assets.length,
    getScrollElement: () => scrollRef.current,
    getItemKey,
    estimateSize: (index) => view === "list" ? 68 : itemWidth * getAsset(index).height / getAsset(index).width + 42,
    lanes,
    gap: GAP,
    overscan: 2,
  });
  const lastFocusedId = useRef<string | null>(null);
  useEffect(() => {
    if (focusedId === null || width === 0 || lastFocusedId.current === focusedId) return undefined;
    const index = assets.findIndex((asset) => asset.hash === focusedId);
    if (index === -1) return undefined;
    virtualizer.scrollToIndex(index, { align: "auto" });
    let frame: number;
    const focusVisibleItem = (): void => {
      // 使用者已经进入检查器或其他输入区时，旧选择请求不再拥有焦点。
      const currentFocus = document.activeElement;
      if (currentFocus !== null && currentFocus !== document.body && !scrollRef.current?.contains(currentFocus)) {
        lastFocusedId.current = focusedId;
        return;
      }
      const element = scrollRef.current?.querySelector<HTMLElement>(`[data-hash="${focusedId}"]`);
      if (element === undefined || element === null) { frame = requestAnimationFrame(focusVisibleItem); return; }
      lastFocusedId.current = focusedId;
      element.focus({ preventScroll: true });
    };
    frame = requestAnimationFrame(focusVisibleItem);
    return () => cancelAnimationFrame(frame);
  }, [focusedId, assets, virtualizer, width]);

  const box = useBoxSelection({
    virtualizer,
    laneWidth: itemWidth,
    gap: GAP,
    orderedIds,
    selectedIds,
    onBoxSelect,
  });
  const boxHandlers = useMemo(
    () => ({
      onPointerDown: box.onPointerDown,
      onPointerMove: box.onPointerMove,
      onPointerUp: box.onPointerUp,
      onPointerCancel: box.onPointerCancel,
      onLostPointerCapture: box.onPointerCancel,
      onScroll: box.onScroll,
      onClickCapture: box.onClickCapture,
    }),
    [box.onClickCapture, box.onPointerCancel, box.onPointerDown, box.onPointerMove, box.onPointerUp, box.onScroll],
  );

  // 恢复只发生一次：数据首次就绪后把保存的偏移写回容器，之后的滚动归使用者。
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || width === 0 || assets.length === 0) return undefined;
    restoredRef.current = true;
    const target = initialScrollTop ?? 0;
    if (target > 0 && scrollRef.current !== null) {
      // 直接赋值而非 scrollTo：行为一致，且不依赖运行环境补齐滚动方法。
      scrollRef.current.scrollTop = target;
    }
    return undefined;
  }, [assets.length, initialScrollTop, width]);

  // 滚动按防抖节流回写：频繁拖动不产生偏好写入风暴。
  const latestOffsetRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  useEffect(() => {
    const element = scrollRef.current;
    if (element === null || onScrollOffset === undefined) return undefined;
    const onScroll = (): void => {
      latestOffsetRef.current = element.scrollTop;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        onScrollOffset(latestOffsetRef.current);
      }, SCROLL_SAVE_DEBOUNCE_MS);
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      element.removeEventListener("scroll", onScroll);
      // 卸载（切库/离开工作区）时把最后一次偏移立刻落盘，避免防抖吞尾。
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
        onScrollOffset(latestOffsetRef.current);
      }
    };
  }, [onScrollOffset]);

  const renderItem = (asset: AssetRow, index: number, size: number, lane: number, start: number): ReactNode => {
    const isSelected = selectedIds.has(asset.hash);
    const isActive = activeId === asset.hash;
    const button = (
      <button
        key={asset.hash}
        type="button"
        role="option"
        tabIndex={focusedId === asset.hash ? 0 : -1}
        className={view === "list" ? styles.listItem : styles.tile}
        data-hash={asset.hash}
        data-waterfall-item={view === "waterfall" ? "" : undefined}
        data-list-item={view === "list" ? "" : undefined}
        aria-label={asset.display_filename}
        aria-selected={isSelected}
        aria-current={isActive ? "true" : undefined}
        aria-setsize={assets.length}
        aria-posinset={index + 1}
        style={{
          width: itemWidth,
          height: size,
          transform: `translate(${lane * (itemWidth + GAP)}px, ${start}px)`,
        }}
        onClick={(event) =>
          onItemSelect(parseAssetId(asset.hash), { ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey })
        }
      >
        <div className={styles.thumbnail}><AssetThumbnail asset={asset} /></div>
        <div className={styles.caption}><span>{asset.display_filename}</span><span>{asset.width} × {asset.height}</span></div>
        {view === "list" ? <span className={styles.fileKind}>{asset.ext.toUpperCase()}</span> : null}
      </button>
    );
    if (contextMenu === undefined) return button;
    return (
      <ContextMenu.Root key={asset.hash}>
        <ContextMenu.Trigger asChild>{button}</ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className={styles.contextMenu} aria-label="素材快捷菜单">
            <ContextMenu.Item
              className={styles.contextMenuItem}
              onSelect={() => contextMenu.onFavorite(parseAssetId(asset.hash), !asset.favorite)}
            >
              {asset.favorite ? "取消收藏" : "收藏"}
            </ContextMenu.Item>
            <ContextMenu.Item
              className={styles.contextMenuItem}
              onSelect={() => contextMenu.onTrash(parseAssetId(asset.hash))}
            >
              移入回收站
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    );
  };

  return (
    <div className={styles.collectionFrame}>
      <div
        ref={scrollRef}
        className={styles.collection}
        role="listbox"
        aria-label="图片集合"
        aria-multiselectable="true"
        tabIndex={virtualizer.getVirtualItems().some((item) => item.key === focusedId) ? -1 : 0}
        {...boxHandlers}
        onKeyDownCapture={box.onKeyDownCapture}
        onKeyDown={(event) => {
          if (event.defaultPrevented || event.altKey || event.metaKey || event.ctrlKey) return;
          let step: "next" | "prev" | "first" | "last";
          switch (event.key) {
            case "ArrowDown": case "ArrowRight": step = "next"; break;
            case "ArrowUp": case "ArrowLeft": step = "prev"; break;
            case "Home": step = "first"; break;
            case "End": step = "last"; break;
            default: return;
          }
          event.preventDefault();
          onNavigate(step, event.shiftKey);
        }}
      >
        <div className={styles.canvas} style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const asset = getAsset(item.index);
            return renderItem(asset, item.index, item.size, item.lane, item.start);
          })}
          {box.box !== null ? (
            <div
              data-selection-box=""
              style={{
                position: "absolute",
                left: box.box.x,
                top: box.box.y,
                width: box.box.width,
                height: box.box.height,
                pointerEvents: "none",
              }}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
