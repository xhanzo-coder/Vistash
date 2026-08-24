import type { CSSProperties, ReactNode } from "react";

import type { WorkspaceLayout } from "./libraryLayout";
import { WorkspacePaneResizeHandle } from "./WorkspacePaneResizeHandle";
import { WorkspaceDrawer } from "./workspaceDrawer";

export type WorkspacePaneMode = "inline" | "drawer";

type WorkspaceGridStyle = CSSProperties & {
  "--workspace-rail-width": string;
  "--workspace-inspector-width": string;
};

/** 双工作台共享的 grid class 与栏宽 CSS 变量。 */
export function workspacePanePresentation(
  baseClass: string,
  mode: WorkspacePaneMode,
  layout: WorkspaceLayout,
): { className: string; style: WorkspaceGridStyle } {
  return {
    className: `${baseClass}${mode === "drawer" ? " rail-drawer" : ""}${
      mode === "inline" && !layout.inspectorCollapsed ? " with-inspector" : ""
    }${mode === "inline" && layout.railCollapsed ? " rail-collapsed" : ""}`,
    style: {
      "--workspace-rail-width": `${layout.railWidth}px`,
      "--workspace-inspector-width": `${layout.inspectorWidth}px`,
    },
  };
}

type WorkspacePaneFrameProps = {
  mode: WorkspacePaneMode;
  side: "start" | "end";
  label: string;
  open: boolean;
  onClose: () => void;
  panelId: string;
  asideClassName: string;
  collapsed: boolean;
  width: number;
  minWidth: number;
  maxWidth: number;
  resizeLabel: string;
  collapseLabel: string;
  onCollapse: () => void;
  onResize: (width: number) => void;
  children: ReactNode;
};

/** 抽屉/宽屏原位栏位的统一外壳：折叠、调整柄与条件挂载只实现一次。 */
export function WorkspacePaneFrame({
  mode,
  side,
  label,
  open,
  onClose,
  panelId,
  asideClassName,
  collapsed,
  width,
  minWidth,
  maxWidth,
  resizeLabel,
  collapseLabel,
  onCollapse,
  onResize,
  children,
}: WorkspacePaneFrameProps) {
  if (mode === "inline" && collapsed) return null;
  return (
    <WorkspaceDrawer
      mode={mode}
      side={side}
      label={label}
      open={open}
      onClose={onClose}
      panelId={panelId}
    >
      <aside className={asideClassName} aria-label={side === "end" ? label : undefined}>
        {mode === "inline" && (
          <div className="workspace-pane-heading">
            <button type="button" onClick={onCollapse}>{collapseLabel}</button>
          </div>
        )}
        {children}
        {mode === "inline" && (
          <WorkspacePaneResizeHandle
            side={side}
            label={resizeLabel}
            width={width}
            min={minWidth}
            max={maxWidth}
            onResize={onResize}
          />
        )}
      </aside>
    </WorkspaceDrawer>
  );
}

/** 宽屏栏位折叠后留在中央工具条的可恢复入口。 */
export function WorkspacePaneExpandButtons({
  mode,
  layout,
  onExpandRail,
  onExpandInspector,
}: {
  mode: WorkspacePaneMode;
  layout: WorkspaceLayout;
  onExpandRail: () => void;
  onExpandInspector: () => void;
}) {
  if (mode !== "inline") return null;
  return (
    <>
      {layout.railCollapsed && (
        <button type="button" className="rail-toggle" onClick={onExpandRail}>
          展开分类栏
        </button>
      )}
      {layout.inspectorCollapsed && (
        <button type="button" className="rail-toggle" onClick={onExpandInspector}>
          展开检查器
        </button>
      )}
    </>
  );
}
