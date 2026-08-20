import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";

import type { ViewKind } from "./data";

type PositionedItem<T> = {
  item: T;
  id: string;
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type VirtualCollectionProps<T> = {
  items: T[];
  view: ViewKind;
  getId: (item: T) => string;
  estimateCardHeight: (item: T, width: number) => number;
  renderCard: (item: T) => ReactNode;
  renderRow: (item: T) => ReactNode;
  activeId: string | null;
  selectedIds: ReadonlySet<string>;
  onActivate: (id: string, event: { ctrl: boolean; shift: boolean }) => void;
  onFocusItem: (id: string) => void;
  onBoxSelect: (ids: string[]) => void;
  onRenderedCount: (count: number) => void;
};

const GAP = 10;
const OVERSCAN = 720;
const ROW_HEIGHT = 68;

export function VirtualCollection<T>({
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
  const [viewport, setViewport] = useState({ width: 900, height: 700, scrollTop: 0 });
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
      setViewport((current) => ({
        ...current,
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      }));
    });
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  const layout = useMemo(() => {
    if (view === "details") {
      const positions: PositionedItem<T>[] = items.map((item, index) => ({
        item,
        id: getId(item),
        index,
        x: 0,
        y: index * ROW_HEIGHT,
        width: viewport.width,
        height: ROW_HEIGHT,
      }));
      return { positions, totalHeight: positions.length * ROW_HEIGHT };
    }

    const desiredWidth = viewport.width > 1500 ? 250 : viewport.width > 900 ? 220 : 180;
    const columnCount = Math.max(1, Math.floor((viewport.width + GAP) / (desiredWidth + GAP)));
    const columnWidth = Math.max(150, (viewport.width - GAP * (columnCount - 1)) / columnCount);
    const columns = Array.from({ length: columnCount }, () => 0);
    const positions: PositionedItem<T>[] = [];
    for (const [index, item] of items.entries()) {
      let column = 0;
      for (let candidate = 1; candidate < columns.length; candidate += 1) {
        if ((columns[candidate] ?? 0) < (columns[column] ?? 0)) column = candidate;
      }
      const y = columns[column] ?? 0;
      const height = estimateCardHeight(item, columnWidth);
      positions.push({
        item,
        id: getId(item),
        index,
        x: column * (columnWidth + GAP),
        y,
        width: columnWidth,
        height,
      });
      columns[column] = y + height + GAP;
    }
    return { positions, totalHeight: Math.max(0, ...columns) };
  }, [estimateCardHeight, getId, items, view, viewport.width]);

  const visible = useMemo(() => {
    const top = Math.max(0, viewport.scrollTop - OVERSCAN);
    const bottom = viewport.scrollTop + viewport.height + OVERSCAN;
    return layout.positions.filter((position) => position.y + position.height >= top && position.y <= bottom);
  }, [layout.positions, viewport.height, viewport.scrollTop]);

  useEffect(() => onRenderedCount(visible.length), [onRenderedCount, visible.length]);

  function beginBoxSelection(event: ReactPointerEvent<HTMLDivElement>) {
    if (view !== "masonry" || event.button !== 0) return;
    const target = event.target;
    if (target instanceof Element && target.closest("[data-prototype-item]")) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top + viewport.scrollTop;
    event.currentTarget.setPointerCapture(event.pointerId);
    setBox({ pointerId: event.pointerId, startX: x, startY: y, currentX: x, currentY: y });
  }

  function moveBoxSelection(event: ReactPointerEvent<HTMLDivElement>) {
    if (box === null || event.pointerId !== box.pointerId) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setBox((current) => current === null ? null : {
      ...current,
      currentX: event.clientX - rect.left,
      currentY: event.clientY - rect.top + viewport.scrollTop,
    });
  }

  function finishBoxSelection(event: ReactPointerEvent<HTMLDivElement>) {
    if (box === null || event.pointerId !== box.pointerId) return;
    const left = Math.min(box.startX, box.currentX);
    const right = Math.max(box.startX, box.currentX);
    const top = Math.min(box.startY, box.currentY);
    const bottom = Math.max(box.startY, box.currentY);
    const ids = layout.positions
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
      className={`virtual-collection ${view === "details" ? "is-details" : "is-masonry"}`}
      onScroll={(event) => {
        const scrollTop = event.currentTarget.scrollTop;
        setViewport((current) => ({ ...current, scrollTop }));
      }}
    >
      <div
        className="virtual-canvas"
        style={{ height: `${layout.totalHeight}px` }}
        onPointerDown={beginBoxSelection}
        onPointerMove={moveBoxSelection}
        onPointerUp={finishBoxSelection}
        onPointerCancel={() => setBox(null)}
      >
        {visible.map((position) => (
          <button
            type="button"
            key={position.id}
            data-prototype-item={position.id}
            className={`virtual-item ${selectedIds.has(position.id) ? "is-selected" : ""} ${activeId === position.id ? "is-active" : ""}`}
            style={{
              transform: `translate3d(${position.x}px, ${position.y}px, 0)`,
              width: `${position.width}px`,
              height: `${position.height}px`,
            }}
            tabIndex={activeId === position.id ? 0 : -1}
            aria-selected={selectedIds.has(position.id)}
            onClick={(event) => onActivate(position.id, {
              ctrl: event.ctrlKey || event.metaKey,
              shift: event.shiftKey,
            })}
            onDoubleClick={() => onFocusItem(position.id)}
          >
            {view === "details" ? renderRow(position.item) : renderCard(position.item)}
          </button>
        ))}
        {boxStyle !== null && <div className="selection-box" style={boxStyle} />}
      </div>
    </div>
  );
}
