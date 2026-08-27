import { useEffect, useEffectEvent, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";
import { useSelection } from "./selectionContext";

type Point = { x: number; y: number };
type Rectangle = Point & { width: number; height: number };
type Drag = {
  pointerId: number;
  surface: HTMLDivElement;
  start: Point;
  client: Point;
  base: readonly string[];
  additive: boolean;
  active: boolean;
  laneWidth: number;
  orderedIds: readonly string[];
};

/** 两类瀑布流共用手势，位置只读虚拟化器，选择只写 SelectionModel。 */
export function useWaterfallBoxSelection(
  virtualizer: Virtualizer<HTMLDivElement, Element>,
  laneWidth: number,
  gap: number,
) {
  const { state, selectBox } = useSelection();
  const [box, setBox] = useState<Rectangle | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const frameRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);

  function update() {
    const drag = dragRef.current;
    if (drag === null) return;
    const viewport = drag.surface.getBoundingClientRect();
    const end = {
      x: drag.client.x - viewport.left + drag.surface.scrollLeft,
      y: drag.client.y - viewport.top + drag.surface.scrollTop,
    };
    if (!drag.active && Math.hypot(end.x - drag.start.x, end.y - drag.start.y) < 4) return;
    drag.active = true;
    const rectangle = {
      x: Math.min(drag.start.x, end.x), y: Math.min(drag.start.y, end.y),
      width: Math.abs(end.x - drag.start.x), height: Math.abs(end.y - drag.start.y),
    };
    const selected = new Set(drag.additive ? drag.base : []);
    // 公开计算入口确保完整布局已更新；缓存只读，绝不按 DOM 可见项决定选择。
    virtualizer.getTotalSize();
    for (const item of virtualizer.measurementsCache) {
      const left = item.lane * (laneWidth + gap);
      if (rectangle.width > 0 && rectangle.height > 0 && left < rectangle.x + rectangle.width &&
          left + laneWidth > rectangle.x && item.start < rectangle.y + rectangle.height &&
          item.end - gap > rectangle.y) {
        if (typeof item.key !== "string") throw new Error("素材虚拟项必须使用字符串身份");
        selected.add(item.key);
      }
    }
    setBox(rectangle);
    selectBox([...selected]);
  }

  function scheduleUpdate() {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      update();
    });
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    suppressClickRef.current = false;
    if (event.button !== 0 || event.pointerType === "touch" || !event.isPrimary) return;
    if (event.target instanceof Element && event.target.closest('button, input, textarea, select, a, [contenteditable="true"]')) return;
    const surface = event.currentTarget;
    const viewport = surface.getBoundingClientRect();
    event.preventDefault();
    surface.focus({ preventScroll: true });
    surface.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId, surface,
      start: { x: event.clientX - viewport.left + surface.scrollLeft, y: event.clientY - viewport.top + surface.scrollTop },
      client: { x: event.clientX, y: event.clientY },
      base: [...state.selectedIds], additive: event.ctrlKey || event.metaKey, active: false,
      laneWidth, orderedIds: state.orderedIds,
    };
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    drag.client = { x: event.clientX, y: event.clientY };
    scheduleUpdate();
  }

  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    drag.client = { x: event.clientX, y: event.clientY };
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    update();
    suppressClickRef.current = drag.active;
    dragRef.current = null;
    setBox(null);
    if (drag.surface.hasPointerCapture(drag.pointerId)) drag.surface.releasePointerCapture(drag.pointerId);
  }

  function cancel() {
    const drag = dragRef.current;
    if (drag === null) return;
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    dragRef.current = null;
    if (drag.active) selectBox(drag.base);
    setBox(null);
    if (drag.surface.hasPointerCapture(drag.pointerId)) drag.surface.releasePointerCapture(drag.pointerId);
  }

  function onPointerCancel(event: PointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId === event.pointerId) cancel();
  }

  function onKeyDownCapture(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Escape" || dragRef.current === null) return;
    event.preventDefault();
    event.stopPropagation();
    cancel();
  }

  function onScroll() {
    if (dragRef.current !== null) scheduleUpdate();
  }

  function onClickCapture(event: MouseEvent<HTMLDivElement>) {
    if (suppressClickRef.current && event.detail > 0) {
      event.preventDefault();
      event.stopPropagation();
    }
    suppressClickRef.current = false;
  }

  const cancelChangedLayout = useEffectEvent((width: number, orderedIds: readonly string[]) => {
    const drag = dragRef.current;
    if (drag !== null && (drag.laneWidth !== width || drag.orderedIds !== orderedIds)) cancel();
  });
  useEffect(() => {
    // 旧几何和旧查询不再有效，不能把进行中的矩形套到另一组素材上。
    cancelChangedLayout(laneWidth, state.orderedIds);
  }, [laneWidth, state.orderedIds]);

  useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag !== null && drag.surface.hasPointerCapture(drag.pointerId)) drag.surface.releasePointerCapture(drag.pointerId);
  }, []);

  return { box, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onKeyDownCapture, onScroll, onClickCapture };
}
