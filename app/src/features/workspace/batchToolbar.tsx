/**
 * 批量工具条。
 *
 * 有选中项时贴在集合底部：计数、全选与清除是所有视图共有的动作。视图专属的
 * 批量组织动作按规格放在右检查器的多选分区，不经这里的 children 插槽——插槽
 * 保留给未来确需随视图注入的动作。本组件只负责外壳与语义，不发起任何 IPC。
 */

import type { ReactNode } from "react";

type BatchToolbarProps = {
  /** 当前选中数；为 0 时整个工具条不渲染。 */
  count: number;
  /** 当前查询域的总项数，用于计数文案。 */
  totalCount: number;
  onSelectAll: () => void;
  onClear: () => void;
  children?: ReactNode;
};

export function BatchToolbar({
  count,
  totalCount,
  onSelectAll,
  onClear,
  children,
}: BatchToolbarProps) {
  if (count === 0) return null;
  return (
    <div className="batch-toolbar" role="toolbar" aria-label="批量操作">
      <span className="batch-toolbar-count">
        已选 {count} / 共 {totalCount} 项
      </span>
      <button type="button" className="batch-toolbar-action" onClick={onSelectAll}>
        全选
      </button>
      <button type="button" className="batch-toolbar-action" onClick={onClear}>
        清除选择
      </button>
      {children}
    </div>
  );
}
