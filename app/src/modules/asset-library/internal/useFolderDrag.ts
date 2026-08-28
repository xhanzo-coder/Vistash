import { useEffect, useRef, useState, type PointerEvent, type KeyboardEvent, type MouseEvent } from "react";
import { parseAssetId, type AssetId } from "../../../app/common";

type Drag = {
  root: HTMLElement;
  pointerId: number;
  source: AssetId;
  hashes: readonly string[];
  base: readonly string[];
  x: number;
  y: number;
  active: boolean;
};

function releaseCapture(drag: Drag): void {
  if (drag.root.hasPointerCapture(drag.pointerId)) drag.root.releasePointerCapture(drag.pointerId);
}

function hitTarget(root: HTMLElement, x: number, y: number): string | null | undefined {
  const target = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-folder-drop]");
  if (target === null || target === undefined || !root.contains(target)) return undefined;
  const path = target.getAttribute("data-folder-drop");
  if (path === null) throw new Error("文件夹落点缺少路径");
  return path === "" ? null : path;
}

/** 内部拖动只携带素材身份，避免与 Tauri 的外部文件拖放传输混为一体。 */
export function useFolderDrag({ selectedIds, disabled, selectSource, restore, move }: {
  selectedIds: ReadonlySet<string>;
  disabled: boolean;
  selectSource: (id: AssetId) => void;
  restore: (ids: readonly string[]) => void;
  move: (ids: string[], folder: string | null) => void;
}) {
  const dragRef = useRef<Drag | null>(null);
  const suppressClick = useRef(false);
  const [preview, setPreview] = useState<{ x: number; y: number; count: number; target: string | null | undefined } | null>(null);

  function cancel(): void {
    const drag = dragRef.current;
    if (drag === null) return;
    dragRef.current = null;
    if (drag.active) { restore(drag.base); suppressClick.current = true; }
    setPreview(null);
    releaseCapture(drag);
  }

  useEffect(() => () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag !== null) releaseCapture(drag);
  }, []);

  return {
    preview,
    handlers: {
      onPointerDownCapture(event: PointerEvent<HTMLElement>): void {
        suppressClick.current = false;
        if (disabled || event.button !== 0 || !event.isPrimary || event.pointerType === "touch") return;
        if (!(event.target instanceof Element) || !event.currentTarget.contains(event.target)) return;
        const item = event.target.closest<HTMLElement>("[data-hash]");
        if (item === null) return;
        const hash = item.dataset.hash;
        if (hash === undefined) throw new Error("拖动素材缺少身份");
        dragRef.current = { root: event.currentTarget, pointerId: event.pointerId, source: parseAssetId(hash), hashes: selectedIds.has(hash) ? [...selectedIds] : [hash], base: [...selectedIds], x: event.clientX, y: event.clientY, active: false };
      },
      onPointerMoveCapture(event: PointerEvent<HTMLElement>): void {
        const drag = dragRef.current;
        if (drag === null || drag.pointerId !== event.pointerId) return;
        if (disabled) { cancel(); return; }
        if (!drag.active) {
          if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) return;
          drag.active = true;
          if (!drag.base.includes(drag.source)) selectSource(drag.source);
          drag.root.setPointerCapture(drag.pointerId);
        }
        event.preventDefault();
        event.stopPropagation();
        setPreview({ x: event.clientX, y: event.clientY, count: drag.hashes.length, target: hitTarget(drag.root, event.clientX, event.clientY) });
      },
      onPointerUpCapture(event: PointerEvent<HTMLElement>): void {
        const drag = dragRef.current;
        if (drag === null || drag.pointerId !== event.pointerId) return;
        if (!drag.active) { dragRef.current = null; return; }
        const target = hitTarget(drag.root, event.clientX, event.clientY);
        if (disabled || target === undefined) { cancel(); return; }
        event.preventDefault();
        event.stopPropagation();
        dragRef.current = null;
        suppressClick.current = true;
        setPreview(null);
        releaseCapture(drag);
        move([...drag.hashes], target);
      },
      onPointerCancelCapture(event: PointerEvent<HTMLElement>): void {
        if (dragRef.current?.pointerId === event.pointerId) cancel();
      },
      onLostPointerCapture(event: PointerEvent<HTMLElement>): void {
        if (dragRef.current?.pointerId === event.pointerId) cancel();
      },
      onKeyDownCapture(event: KeyboardEvent<HTMLElement>): void {
        if (event.key !== "Escape" || dragRef.current === null) return;
        event.preventDefault(); event.stopPropagation(); cancel();
      },
      onClickCapture(event: MouseEvent<HTMLElement>): void {
        if (suppressClick.current && event.detail > 0) { event.preventDefault(); event.stopPropagation(); }
        suppressClick.current = false;
      },
    },
  };
}
