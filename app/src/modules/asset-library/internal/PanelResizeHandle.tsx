import { useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";

import styles from "./AssetLibraryWorkspace.module.css";

type PanelResizeHandleProps = {
  panel: "navigation" | "inspector";
  label: string;
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  pointerDirection: 1 | -1;
  onPreview: (value: number) => void;
  onCommit: (value: number) => void;
};

type DragState = { pointerId: number; startX: number; startValue: number; currentValue: number };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 宽屏栏位的鼠标/触控拖动与键盘等价入口；拖动结束才提交持久化。 */
export function PanelResizeHandle({ panel, label, value, min, max, defaultValue, pointerDirection, onPreview, onCommit }: PanelResizeHandleProps): ReactNode {
  const drag = useRef<DragState | null>(null);
  const commitDrag = (element: HTMLElement): void => {
    const active = drag.current;
    if (active === null) return;
    drag.current = null;
    if (element.hasPointerCapture(active.pointerId)) element.releasePointerCapture(active.pointerId);
    onCommit(active.currentValue);
  };
  const changeFromKeyboard = (event: KeyboardEvent<HTMLDivElement>): void => {
    let next: number;
    switch (event.key) {
      case "ArrowLeft": next = value - 8; break;
      case "ArrowRight": next = value + 8; break;
      case "Home": next = min; break;
      case "End": next = max; break;
      default: return;
    }
    event.preventDefault();
    onCommit(clamp(next, min, max));
  };
  return <div
    className={styles.panelResizeHandle}
    data-resize-panel={panel}
    role="separator"
    aria-label={label}
    aria-orientation="vertical"
    aria-valuemin={min}
    aria-valuemax={max}
    aria-valuenow={Math.round(value)}
    aria-valuetext={`${Math.round(value)} 像素`}
    tabIndex={0}
    onKeyDown={changeFromKeyboard}
    onDoubleClick={() => onCommit(defaultValue)}
    onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { pointerId: event.pointerId, startX: event.clientX, startValue: value, currentValue: value };
    }}
    onPointerMove={(event: PointerEvent<HTMLDivElement>) => {
      const active = drag.current;
      if (active === null || active.pointerId !== event.pointerId) return;
      active.currentValue = clamp(active.startValue + (event.clientX - active.startX) * pointerDirection, min, max);
      onPreview(active.currentValue);
    }}
    onPointerUp={(event) => commitDrag(event.currentTarget)}
    onPointerCancel={(event) => commitDrag(event.currentTarget)}
    onLostPointerCapture={(event) => commitDrag(event.currentTarget)}
  />;
}
