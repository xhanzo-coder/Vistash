import { useRef } from "react";

type WorkspacePaneResizeHandleProps = {
  side: "start" | "end";
  label: string;
  width: number;
  min: number;
  max: number;
  onResize: (width: number) => void;
};

const KEYBOARD_STEP = 16;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 宽屏工作台栏位的可访问调整柄。
 *
 * 指针拖动按物理方向换算栏宽；键盘左右键每次调整 16 CSS px，Home/End 直接
 * 到边界。持久化由父工作台的 section layout 负责。
 */
export function WorkspacePaneResizeHandle({
  side,
  label,
  width,
  min,
  max,
  onResize,
}: WorkspacePaneResizeHandleProps) {
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);

  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(width)}
      className={`workspace-pane-resizer workspace-pane-resizer-${side}`}
      tabIndex={0}
      onPointerDown={(event) => {
        dragRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startWidth: width,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (drag === null || drag.pointerId !== event.pointerId) return;
        const delta = event.clientX - drag.startX;
        const next = drag.startWidth + (side === "start" ? delta : -delta);
        onResize(clamp(next, min, max));
      }}
      onPointerUp={(event) => {
        if (dragRef.current?.pointerId !== event.pointerId) return;
        dragRef.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onLostPointerCapture={() => {
        dragRef.current = null;
      }}
      onKeyDown={(event) => {
        let next: number | null = null;
        if (event.key === "Home") next = min;
        if (event.key === "End") next = max;
        if (event.key === "ArrowLeft") {
          next = width + (side === "start" ? -KEYBOARD_STEP : KEYBOARD_STEP);
        }
        if (event.key === "ArrowRight") {
          next = width + (side === "start" ? KEYBOARD_STEP : -KEYBOARD_STEP);
        }
        if (next === null) return;
        event.preventDefault();
        onResize(clamp(next, min, max));
      }}
    />
  );
}
