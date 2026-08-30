import { useRef, useState, type HTMLAttributes, type PointerEvent } from "react";

const DRAG_THRESHOLD = 6;

export type FolderDropTarget =
  | { kind: "folder"; path: string }
  | { kind: "top" }
  | { kind: "invalid" };

type DragState = {
  pointerId: number;
  source: string;
  startX: number;
  startY: number;
  active: boolean;
  target: FolderDropTarget;
};

export type FolderTreeDragPreview = {
  source: string;
  target: FolderDropTarget;
  x: number;
  y: number;
};

type FolderTreeDragHandlers = Pick<
  HTMLAttributes<HTMLElement>,
  "onPointerDown" | "onPointerMove" | "onPointerUp" | "onPointerCancel" | "onLostPointerCapture" | "onKeyDown" | "onClickCapture"
>;

function dropTargetAt(source: string, x: number, y: number): FolderDropTarget {
  const element = document.elementFromPoint(x, y);
  const folder = element?.closest<HTMLElement>("[data-folder]")?.dataset.folder;
  if (folder !== undefined) {
    if (folder === source || folder.startsWith(`${source}/`)) return { kind: "invalid" };
    return { kind: "folder", path: folder };
  }
  return element?.closest("[data-folder-tree-root]") === null ? { kind: "invalid" } : { kind: "top" };
}

/** 文件夹树拖动协议；载荷只有逻辑路径，不复用图片或提示词选择载荷。 */
export function useFolderTreeDrag(
  disabled: boolean,
  onMove: (source: string, destinationParent: string | null) => void,
): { preview: FolderTreeDragPreview | null; handlers: FolderTreeDragHandlers } {
  const drag = useRef<DragState | null>(null);
  const suppressClick = useRef(false);
  const [preview, setPreview] = useState<FolderTreeDragPreview | null>(null);

  const finish = (event: PointerEvent<HTMLElement>, commit: boolean): void => {
    const current = drag.current;
    drag.current = null;
    setPreview(null);
    if (current === null) return;
    if (event.currentTarget.hasPointerCapture(current.pointerId)) {
      event.currentTarget.releasePointerCapture(current.pointerId);
    }
    if (!current.active) return;
    suppressClick.current = true;
    window.setTimeout(() => {
      suppressClick.current = false;
    }, 0);
    if (!commit || current.target.kind === "invalid") return;
    onMove(current.source, current.target.kind === "top" ? null : current.target.path);
  };

  return {
    preview,
    handlers: {
      onPointerDown: (event) => {
        if (disabled || event.button !== 0 || !event.isPrimary) return;
        if (!(event.target instanceof Element)) return;
        const source = event.target.closest<HTMLElement>("[data-folder]")?.dataset.folder;
        if (source === undefined) return;
        drag.current = {
          pointerId: event.pointerId,
          source,
          startX: event.clientX,
          startY: event.clientY,
          active: false,
          target: { kind: "invalid" },
        };
      },
      onPointerMove: (event) => {
        const current = drag.current;
        if (current === null || current.pointerId !== event.pointerId) return;
        if (!current.active && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < DRAG_THRESHOLD) return;
        event.preventDefault();
        if (!current.active) {
          event.currentTarget.setPointerCapture(current.pointerId);
          current.active = true;
        }
        current.target = dropTargetAt(current.source, event.clientX, event.clientY);
        setPreview({ source: current.source, target: current.target, x: event.clientX, y: event.clientY });
      },
      onPointerUp: (event) => finish(event, true),
      onPointerCancel: (event) => finish(event, false),
      onLostPointerCapture: (event) => finish(event, false),
      onKeyDown: (event) => {
        if (event.key !== "Escape" || drag.current === null) return;
        event.preventDefault();
        drag.current = null;
        setPreview(null);
      },
      onClickCapture: (event) => {
        if (!suppressClick.current) return;
        event.preventDefault();
        event.stopPropagation();
        suppressClick.current = false;
      },
    },
  };
}
