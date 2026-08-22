/**
 * 工作台紧凑顶栏（任务 8.1，信息架构来自已验收原型"A — 平衡工作台"）。
 *
 * 原型确认的层级是：品牌与双库一级入口、库路径指示同处一行；素材与提示词是
 * 并列的一级入口，提示词不是素材详情的侧栏。这里只提取信息架构——具体颜色、
 * 字体属于后续视觉设计阶段，组件只消费语义 token。
 */

/** 一级导航入口：图片素材库与提示词库。 */
export type WorkspaceSection = "assets" | "prompts";

type Props = {
  section: WorkspaceSection;
  onSectionChange: (next: WorkspaceSection) => void;
  /** 当前库根路径；始终完整呈现（截断交给 CSS），供使用者确认操作对象。 */
  libraryPath: string;
  /** 顶栏动作区：全局搜索面板等跨库工具插在导航与库路径之间。 */
  actions?: React.ReactNode;
};

const SECTIONS: Array<{ id: WorkspaceSection; label: string }> = [
  { id: "assets", label: "素材" },
  { id: "prompts", label: "提示词库" },
];

export function WorkspaceTopBar({ section, onSectionChange, libraryPath, actions }: Props) {
  return (
    <header className="topbar">
      <h1 className="topbar-brand">Vistash</h1>
      <nav aria-label="主导航" className="topbar-nav">
        {SECTIONS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            aria-current={section === id ? "page" : undefined}
            onClick={() => onSectionChange(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      {actions}
      <p className="topbar-library" title={libraryPath}>
        当前库：{libraryPath}
      </p>
    </header>
  );
}
