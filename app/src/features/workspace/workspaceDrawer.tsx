/**
 * 工作台抽屉（任务 8.6）。
 *
 * 同一套机制服务两侧：左分类栏在中等/窄窗口收起为从起始边滑出的抽屉，第 9 章的
 * 右检查器以 side="end" 接入同一组件。宽屏（inline 模式）内容原位渲染、忽略 open；
 * 抽屉模式打开时聚焦面板、Esc 与点击背景请求关闭、关闭后把焦点归还给打开前的
 * 元素。完整的焦点陷阱属于任务 11.3 的对话框键盘模式。
 */

import { useEffect, useRef, type ReactNode } from "react";

type WorkspaceDrawerProps = {
  /** inline：宽屏原位渲染；drawer：覆盖式抽屉。 */
  mode: "inline" | "drawer";
  /** 抽屉滑出的侧边：start=左栏，end=右检查器。 */
  side: "start" | "end";
  /** 无障碍名称，同时是对话框的 aria-label。 */
  label: string;
  /** 仅 drawer 模式生效；inline 模式始终渲染。 */
  open: boolean;
  onClose: () => void;
  /** 面板 id，供边缘入口按钮的 aria-controls 指向。 */
  panelId?: string;
  children: ReactNode;
};

export function WorkspaceDrawer({
  mode,
  side,
  label,
  open,
  onClose,
  panelId,
  children,
}: WorkspaceDrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // 焦点管理只在抽屉模式：打开时记录先前焦点并移入面板；卸载或关闭时经清理函数归还。
  useEffect(() => {
    if (mode !== "drawer" || !open) return undefined;
    const previous =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    if (panel === null) throw new Error("抽屉面板尚未挂载");
    panel.focus();
    return () => previous?.focus();
  }, [mode, open]);

  if (mode === "inline") {
    return <>{children}</>;
  }
  if (!open) return null;

  return (
    <>
      <div className="drawer-backdrop" aria-hidden="true" onClick={onClose} />
      <div
        ref={panelRef}
        id={panelId}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={`workspace-drawer workspace-drawer-${side}`}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        {children}
      </div>
    </>
  );
}
