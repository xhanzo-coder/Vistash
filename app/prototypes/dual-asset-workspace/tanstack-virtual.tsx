// PROTOTYPE — TanStack Virtual 适配器，仅用于与自有定位器做可丢弃实测。
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import type { VirtualCollectionProps } from "./virtual";

const GAP = 10;
const ROW_HEIGHT = 68;

export function TanStackVirtualCollection<T>({
  items,
  view,
  getId,
  estimateCardHeight,
  renderCard,
  renderRow,
  activeId,
  selectedIds,
  onActivate,
  onFocusItem,
  onBoxSelect,
  onRenderedCount,
}: VirtualCollectionProps<T>) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(900);
  const [box, setBox] = useState<{
    pointerId: number;
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
  } | null>(null);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller === null) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      if (entry === undefined) return;
      setViewportWidth(entry.contentRect.width);
    });
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  const desiredWidth = viewportWidth > 1500 ? 250 : viewportWidth > 900 ? 220 : 180;
  const lanes = view === "details"
    ? 1
    : Math.max(1, Math.floor((viewportWidth + GAP) / (desiredWidth + GAP)));
  const columnWidth = view === "details"
    ? viewportWidth
    : Math.max(150, (viewportWidth - GAP * (lanes - 1)) / lanes);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollerRef.current,
    estimateSize: (index) => view === "details"
      ? ROW_HEIGHT
      : estimateCardHeight(items[index] as T, columnWidth),
    getItemKey: (index) => getId(items[index] as T),
    lanes,
    gap: view === "details" ? 0 : GAP,
    overscan: 6,
  });
  const virtualItems = virtualizer.getVirtualItems();

  useEffect(() => onRenderedCount(virtualItems.length), [onRenderedCount, virtualItems.length]);

  useEffect(() => {
    const scroller = scrollerRef.current as (HTMLDivElement & {
      prototypeScrollToIndex?: (index: number) => void;
    }) | null;
    if (scroller === null) return undefined;
    scroller.prototypeScrollToIndex = (index) => virtualizer.scrollToIndex(index, { align: "center" });
    return () => {
      delete scroller.prototypeScrollToIndex;
    };
  }, [virtualizer]);

  const visiblePositions = useMemo(() => virtualItems.map((virtualItem) => ({
    id: getId(items[virtualItem.index] as T),
    x: virtualItem.lane * (columnWidth + GAP),
    y: virtualItem.start,
    width: columnWidth,
    height: view === "details" ? ROW_HEIGHT : virtualItem.size,
  })), [columnWidth, getId, items, view, virtualItems]);

  function beginBoxSelection(event: ReactPointerEvent<HTMLDivElement>) {
    if (view !== "masonry" || event.button !== 0) return;
    const target = event.target;
    if (target instanceof Element && target.closest("[data-prototype-item]")) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const scrollTop = scrollerRef.current?.scrollTop;
    if (scrollTop === undefined) throw new Error("TanStack 原型滚动容器不存在");
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top + scrollTop;
    event.currentTarget.setPointerCapture(event.pointerId);
    setBox({ pointerId: event.pointerId, startX: x, startY: y, currentX: x, currentY: y });
  }

  function moveBoxSelection(event: ReactPointerEvent<HTMLDivElement>) {
    if (box === null || event.pointerId !== box.pointerId) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const scrollTop = scrollerRef.current?.scrollTop;
    if (scrollTop === undefined) throw new Error("TanStack 原型滚动容器不存在");
    setBox((current) => current === null ? null : {
      ...current,
      currentX: event.clientX - rect.left,
      currentY: event.clientY - rect.top + scrollTop,
    });
  }

  function finishBoxSelection(event: ReactPointerEvent<HTMLDivElement>) {
    if (box === null || event.pointerId !== box.pointerId) return;
    const left = Math.min(box.startX, box.currentX);
    const right = Math.max(box.startX, box.currentX);
    const top = Math.min(box.startY, box.currentY);
    const bottom = Math.max(box.startY, box.currentY);
    const ids = visiblePositions
      .filter((position) => (
        position.x < right &&
        position.x + position.width > left &&
        position.y < bottom &&
        position.y + position.height > top
      ))
      .map((position) => position.id);
    setBox(null);
    if (ids.length > 0) onBoxSelect(ids);
  }

  const boxStyle = box === null ? null : {
    left: Math.min(box.startX, box.currentX),
    top: Math.min(box.startY, box.currentY),
    width: Math.abs(box.currentX - box.startX),
    height: Math.abs(box.currentY - box.startY),
  };

  return (
    <div
      ref={scrollerRef}
      data-virtual-engine="tanstack"
      className={`virtual-collection ${view === "details" ? "is-details" : "is-masonry"}`}
    >
      <div
        className="virtual-canvas"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
        onPointerDown={beginBoxSelection}
        onPointerMove={moveBoxSelection}
        onPointerUp={finishBoxSelection}
        onPointerCancel={() => setBox(null)}
      >
        {virtualItems.map((virtualItem) => {
          const item = items[virtualItem.index] as T;
          const id = getId(item);
          const x = virtualItem.lane * (columnWidth + GAP);
          const height = view === "details" ? ROW_HEIGHT : virtualItem.size;
          return (
            <button
              type="button"
              key={virtualItem.key}
              data-index={virtualItem.index}
              data-prototype-item={id}
              className={`virtual-item ${selectedIds.has(id) ? "is-selected" : ""} ${activeId === id ? "is-active" : ""}`}
              style={{
                transform: `translate3d(${x}px, ${virtualItem.start}px, 0)`,
                width: `${columnWidth}px`,
                height: `${height}px`,
              }}
              tabIndex={activeId === id ? 0 : -1}
              aria-selected={selectedIds.has(id)}
              onClick={(event) => onActivate(id, {
                ctrl: event.ctrlKey || event.metaKey,
                shift: event.shiftKey,
              })}
              onDoubleClick={() => onFocusItem(id)}
            >
              {view === "details" ? renderRow(item) : renderCard(item)}
            </button>
          );
        })}
        {boxStyle !== null && <div className="selection-box" style={boxStyle} />}
      </div>
    </div>
  );
}
