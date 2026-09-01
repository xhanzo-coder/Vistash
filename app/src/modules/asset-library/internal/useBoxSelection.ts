import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";

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

type BoxSelectionArgs = {
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  laneWidth: number;
  gap: number;
  orderedIds: readonly string[];
  selectedIds: ReadonlySet<string>;
  onBoxSelect: (ids: readonly string[], additive: boolean) => void;
};

/**
 * 集合画布的框选手势。
 *
 * 在空白处按下主键并拖出矩形：命中矩形与虚拟几何相交的全部素材（含离屏项，
 * 位置只读虚拟化器的完整布局缓存，绝不按 DOM 可见项决定选择）。Ctrl 框选在
 * 既有选择上增减；进行中的手势可被 Esc 取消恢复，pointercancel 同样收束。
 * 拖动结束的合成 click 被吞掉，避免误清选择。
 */
export function useBoxSelection({ virtualizer, laneWidth, gap, orderedIds, selectedIds, onBoxSelect }: BoxSelectionArgs): {
  box: Rectangle | null;
  onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (event: PointerEvent<HTMLDivElement>) => void;
  onKeyDownCapture: (event: KeyboardEvent<HTMLDivElement>) => void;
  onScroll: () => void;
  onClickCapture: (event: MouseEvent<HTMLDivElement>) => void;
} {
  const [box, setBox] = useState<Rectangle | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const frameRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);

  const update = useCallback((): void => {
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
      x: Math.min(drag.start.x, end.x),
      y: Math.min(drag.start.y, end.y),
      width: Math.abs(end.x - drag.start.x),
      height: Math.abs(end.y - drag.start.y),
    };
    const selected = new Set(drag.additive ? drag.base : []);
    // 触发完整布局计算，确保测量缓存覆盖当前查询；缓存只读。
    virtualizer.getTotalSize();
    for (const item of virtualizer.measurementsCache) {
      const left = item.lane * (laneWidth + gap);
      if (
        rectangle.width > 0 &&
        rectangle.height > 0 &&
        left < rectangle.x + rectangle.width &&
        left + laneWidth > rectangle.x &&
        item.start < rectangle.y + rectangle.height &&
        item.end > rectangle.y
      ) {
        if (typeof item.key !== "string") throw new Error("素材虚拟项必须使用字符串身份");
        selected.add(item.key);
      }
    }
    setBox(rectangle);
    // selected 已包含按下时的基底；不能再与上一次预览求并集，否则缩框无法取消旧命中。
    onBoxSelect([...selected], false);
  }, [gap, laneWidth, onBoxSelect, virtualizer]);

  const scheduleUpdate = useCallback((): void => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      update();
    });
  }, [update]);

  const onPointerDown = useCallback((event: PointerEvent<HTMLDivElement>): void => {
    suppressClickRef.current = false;
    if (event.button !== 0 || event.pointerType === "touch" || !event.isPrimary) return;
    // React Portal 的菜单事件仍沿组件树冒泡，但并不属于画布 DOM，不能启动框选。
    if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
    if (
      event.target instanceof Element &&
      event.target.closest('button, input, textarea, select, a, [contenteditable="true"]')
    ) {
      return;
    }
    const surface = event.currentTarget;
    const viewport = surface.getBoundingClientRect();
    event.preventDefault();
    surface.focus({ preventScroll: true });
    surface.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      surface,
      start: { x: event.clientX - viewport.left + surface.scrollLeft, y: event.clientY - viewport.top + surface.scrollTop },
      client: { x: event.clientX, y: event.clientY },
      base: [...selectedIds],
      additive: event.ctrlKey || event.metaKey,
      active: false,
      laneWidth,
      orderedIds,
    };
  }, [laneWidth, orderedIds, selectedIds]);

  const onPointerMove = useCallback((event: PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    drag.client = { x: event.clientX, y: event.clientY };
    scheduleUpdate();
  }, [scheduleUpdate]);

  const onPointerUp = useCallback((event: PointerEvent<HTMLDivElement>): void => {
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
  }, [update]);

  const cancel = useCallback((): void => {
    const drag = dragRef.current;
    if (drag === null) return;
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    dragRef.current = null;
    if (drag.active) onBoxSelect(drag.base, false);
    setBox(null);
    if (drag.surface.hasPointerCapture(drag.pointerId)) drag.surface.releasePointerCapture(drag.pointerId);
  }, [onBoxSelect]);

  const onPointerCancel = useCallback((event: PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.pointerId === event.pointerId) cancel();
  }, [cancel]);

  const onKeyDownCapture = useCallback((event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Escape" || dragRef.current === null) return;
    event.preventDefault();
    event.stopPropagation();
    cancel();
  }, [cancel]);

  const onScroll = useCallback((): void => {
    if (dragRef.current !== null) scheduleUpdate();
  }, [scheduleUpdate]);

  const onClickCapture = useCallback((event: MouseEvent<HTMLDivElement>): void => {
    if (suppressClickRef.current && event.detail > 0) {
      event.preventDefault();
      event.stopPropagation();
    }
    suppressClickRef.current = false;
  }, []);

  useEffect(() => {
    // 旧几何和旧查询不再有效，不能把进行中的矩形套到另一组素材上。
    const drag = dragRef.current;
    if (drag !== null && (drag.laneWidth !== laneWidth || drag.orderedIds !== orderedIds)) cancel();
  }, [cancel, laneWidth, orderedIds]);

  useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag !== null && drag.surface.hasPointerCapture(drag.pointerId)) drag.surface.releasePointerCapture(drag.pointerId);
  }, []);

  return {
    box,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onKeyDownCapture,
    onScroll,
    onClickCapture,
  };
}
