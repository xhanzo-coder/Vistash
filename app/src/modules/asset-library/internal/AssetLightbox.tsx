import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { parseAssetId, type AssetId } from "../../../app/common";
import { appPlatform } from "../../../app/runtime";
import type { ImageLease } from "../../../app/platform";
import type { AssetRow } from "../../../shared/types";
import { formatError, IpcError } from "../../../shared/errors";
import { Button } from "../../../ui/button/Button";
import styles from "./AssetLightbox.module.css";

const clamp = (value: number, limit: number): number => Math.max(-limit, Math.min(limit, value));
type OriginalState = { key: string; lease: ImageLease; error: null } | { key: string; lease: null; error: Error };

/** 请求身份包含本次访问序号；返回同一哈希也不能复用已经释放的旧 URL。 */
function useOriginal(hash: string, revision: number): OriginalState | null {
  const key = `${revision}:${hash}`;
  const [source, setSource] = useState<OriginalState | null>(null);
  useEffect(() => {
    let mounted = true;
    let owned: ImageLease | null = null;
    void appPlatform.acquireOriginal(hash).then((lease) => {
      if (!mounted) { lease.release(); return undefined; }
      owned = lease;
      setSource({ key, lease, error: null });
      return undefined;
    }, (error: unknown) => {
      if (!mounted) return;
      if (!(error instanceof Error)) throw error;
      setSource({ key, lease: null, error });
    });
    return () => { mounted = false; owned?.release(); };
  }, [hash, key]);
  return source?.key === key ? source : null;
}

export type LightboxSession = { assets: readonly AssetRow[]; initialId: AssetId; scrollTop: number };

/** 灯箱保持独立浏览位置；只在关闭时把最后查看身份交回集合。 */
export function AssetLightbox({ session, onClose }: { session: LightboxSession; onClose: (hash: AssetId) => void }): ReactNode {
  const [frame, setFrame] = useState(() => {
    const index = session.assets.findIndex((asset) => asset.hash === session.initialId);
    if (index === -1) throw new Error("灯箱目标不在当前查询中");
    return { index, revision: 0 };
  });
  const asset = session.assets[frame.index];
  if (asset === undefined) throw new RangeError("灯箱图片索引超界");
  const original = useOriginal(asset.hash, frame.revision);
  const stage = useRef<HTMLDivElement>(null);
  const [stageElement, setStageElement] = useState<HTMLDivElement | null>(null);
  const attachStage = useCallback((element: HTMLDivElement | null): void => { stage.current = element; setStageElement(element); }, []);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<{ scale: number | null; x: number; y: number }>({ scale: null, x: 0, y: 0 });
  const [background, setBackground] = useState<"dark" | "light" | "checker">("dark");
  const [decoded, setDecoded] = useState<number | null>(null);
  const [decodeFailure, setDecodeFailure] = useState<number | null>(null);
  const drag = useRef<{ pointerId: number; startX: number; startY: number; x: number; y: number } | null>(null);
  const pendingPan = useRef<{ x: number; y: number } | null>(null);
  const panFrame = useRef<number | null>(null);
  useLayoutEffect(() => {
    // Portal 在外层组件之后挂载；观察实际取得的节点，不猜测弹层提交时序。
    const element = stageElement;
    if (element === null) return undefined;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) if (entry.target === element) setViewport({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [stageElement]);
  useEffect(() => () => { if (panFrame.current !== null) cancelAnimationFrame(panFrame.current); }, []);
  if (asset.width <= 0 || asset.height <= 0) throw new TypeError("原图尺寸必须为正");
  const fit = Math.min(1, viewport.width / asset.width, viewport.height / asset.height);
  const scale = view.scale === null ? fit : view.scale;
  const minScale = Math.min(0.1, fit);
  const limitX = Math.max(0, (asset.width * scale - viewport.width) / 2);
  const limitY = Math.max(0, (asset.height * scale - viewport.height) / 2);
  const x = clamp(view.x, limitX);
  const y = clamp(view.y, limitY);
  const ready = fit > 0 && original !== null && original.error === null && decoded === frame.revision && decodeFailure !== frame.revision;
  const stopPan = useCallback((flush: boolean): void => {
    if (panFrame.current !== null) { cancelAnimationFrame(panFrame.current); panFrame.current = null; }
    const position = pendingPan.current;
    pendingPan.current = null;
    if (flush && position !== null) setView((current) => ({ ...current, ...position }));
    const gesture = drag.current;
    drag.current = null;
    if (gesture !== null && stage.current?.hasPointerCapture(gesture.pointerId)) stage.current.releasePointerCapture(gesture.pointerId);
  }, []);
  const zoomAt = useCallback((requested: number, anchorX = 0, anchorY = 0): void => {
    if (scale <= 0) return;
    stopPan(false);
    const next = Math.max(minScale, Math.min(8, requested));
    setView({ scale: next, x: clamp(anchorX - (anchorX - x) * next / scale, Math.max(0, (asset.width * next - viewport.width) / 2)), y: clamp(anchorY - (anchorY - y) * next / scale, Math.max(0, (asset.height * next - viewport.height) / 2)) });
  }, [scale, minScale, x, y, asset.width, asset.height, viewport.width, viewport.height, stopPan]);
  useEffect(() => {
    const element = stageElement;
    if (element === null) return undefined;
    const wheel = (event: WheelEvent): void => {
      event.preventDefault();
      if (!ready) return;
      const rect = element.getBoundingClientRect();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.height : 1;
      zoomAt(scale * Math.exp(-event.deltaY * unit * 0.0015), event.clientX - rect.left - viewport.width / 2, event.clientY - rect.top - viewport.height / 2);
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [ready, scale, viewport.width, viewport.height, zoomAt, stageElement]);
  if (original !== null && original.error !== null && !(original.error instanceof IpcError)) throw original.error;
  const loadError = original === null ? null : original.error;
  const errorMessage = decodeFailure === frame.revision ? formatError({ code: "viewer.decode_failed", detail: null }) : loadError === null ? null : loadError.message;
  const fitImage = (): void => { stopPan(false); setView({ scale: null, x: 0, y: 0 }); };
  const close = (): void => onClose(parseAssetId(asset.hash));
  const navigate = (offset: number): void => {
    const index = frame.index + offset;
    if (index < 0 || index >= session.assets.length) return;
    fitImage();
    setFrame({ index, revision: frame.revision + 1 });
  };
  return <DialogPrimitive.Root open onOpenChange={(open) => { if (!open) close(); }}>
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={styles.overlay} />
      <DialogPrimitive.Content data-lightbox="true" className={styles.viewer}
        onOpenAutoFocus={(event) => { event.preventDefault(); stage.current?.focus(); }}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => { event.preventDefault(); event.stopPropagation(); close(); }}
        onKeyDown={(event) => {
          if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
          if (event.target instanceof Element && event.target.closest("input, select, textarea, [contenteditable=true]") !== null) return;
          if (event.shiftKey && event.key.startsWith("Arrow")) {
            if (ready) { event.preventDefault(); stopPan(false); setView({ scale, x: clamp(x + (event.key === "ArrowRight" ? 40 : event.key === "ArrowLeft" ? -40 : 0), limitX), y: clamp(y + (event.key === "ArrowDown" ? 40 : event.key === "ArrowUp" ? -40 : 0), limitY) }); }
            return;
          }
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); navigate(event.key === "ArrowLeft" ? -1 : 1); }
          if (!ready) return;
          if (event.key === "Home") { event.preventDefault(); fitImage(); }
          else if (event.key === "1") { event.preventDefault(); zoomAt(1); }
          else if (event.key === "+" || event.key === "=") { event.preventDefault(); zoomAt(scale * 1.25); }
          else if (event.key === "-" || event.key === "_") { event.preventDefault(); zoomAt(scale / 1.25); }
        }}>
        <header className={styles.header}>
          <div className={styles.identity}><DialogPrimitive.Title className={styles.title}>{asset.display_filename}</DialogPrimitive.Title><span>{asset.width} × {asset.height} · {frame.index + 1} / {session.assets.length}</span></div>
          <div className={styles.controls}><Button size="compact" disabled={frame.index === 0} onClick={() => navigate(-1)}>上一张</Button><Button size="compact" disabled={frame.index === session.assets.length - 1} onClick={() => navigate(1)}>下一张</Button><Button size="compact" onClick={close}>关闭灯箱</Button></div>
          <div className={styles.controls} role="toolbar" aria-label="灯箱视图">
            <Button size="compact" disabled={!ready} aria-pressed={view.scale === null} onClick={fitImage}>适合窗口</Button>
            <Button size="compact" disabled={!ready} aria-pressed={view.scale === 1} onClick={() => zoomAt(1)}>100%</Button>
            <Button size="compact" disabled={!ready || scale <= minScale} onClick={() => zoomAt(scale / 1.25)}>缩小</Button>
            <output className={styles.zoom} aria-label="缩放比例">{Math.round(scale * 1000) / 10}%</output>
            <Button size="compact" disabled={!ready || scale >= 8} onClick={() => zoomAt(scale * 1.25)}>放大</Button>
            <select className={styles.background} aria-label="灯箱背景" name="lightbox-background" value={background} onChange={(event) => {
              const value = event.target.value;
              if (value !== "dark" && value !== "light" && value !== "checker") throw new Error("未知灯箱背景");
              setBackground(value);
            }}>
              <option value="dark">深色背景</option><option value="light">浅色背景</option><option value="checker">棋盘格</option>
            </select>
          </div>
        </header>
        <div ref={attachStage} className={styles.stage} tabIndex={0} aria-label="原图画布" data-background={background} data-pannable={ready && (limitX > 0 || limitY > 0)}
          onPointerDown={(event) => {
            if (!ready || event.button !== 0 || !event.isPrimary || (limitX === 0 && limitY === 0)) return;
            event.preventDefault();
            event.currentTarget.focus({ preventScroll: true });
            drag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x, y };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const gesture = drag.current;
            if (gesture === null || gesture.pointerId !== event.pointerId) return;
            pendingPan.current = { x: clamp(gesture.x + event.clientX - gesture.startX, limitX), y: clamp(gesture.y + event.clientY - gesture.startY, limitY) };
            if (panFrame.current !== null) return;
            panFrame.current = requestAnimationFrame(() => { panFrame.current = null; const position = pendingPan.current; if (position !== null) setView((current) => ({ ...current, ...position })); });
          }} onPointerUp={() => stopPan(true)} onPointerCancel={() => stopPan(false)} onLostPointerCapture={() => stopPan(false)}>
          {original !== null && original.lease !== null && decodeFailure !== frame.revision ? <img key={frame.revision} className={styles.image} src={original.lease.url} width={asset.width} height={asset.height} alt={asset.display_filename} draggable={false}
            style={{ width: asset.width, height: asset.height, marginLeft: -asset.width / 2, marginTop: -asset.height / 2, transform: `translate(${x}px, ${y}px) scale(${scale})`, visibility: ready ? "visible" : "hidden" }}
            onLoad={() => setDecoded(frame.revision)} onError={() => setDecodeFailure(frame.revision)} /> : null}
          {errorMessage !== null ? <div className={styles.message}><p role="alert">{errorMessage}</p><Button onClick={() => { fitImage(); setFrame({ ...frame, revision: frame.revision + 1 }); }}>重试读取原图</Button></div> : !ready ? <p role="status" className={styles.message}>正在读取原图…</p> : null}
        </div>
        <DialogPrimitive.Description className={styles.footer}>左右键切图 · Shift+方向键平移 · Home 适合窗口 · 1 为 100% · 加减键缩放 · Esc 返回</DialogPrimitive.Description>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>;
}
