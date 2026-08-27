/**
 * 已应用筛选条件的可移除呈现（任务 11.1）。
 *
 * 规格要求当前库把已应用条件呈现为"可移除的明确状态"：每条条件是一枚带移除
 * 按钮的芯片，移除即回到该维度的默认查询。没有条件时不渲染任何东西。
 */
export type AppliedFilterChip = {
  key: string;
  label: string;
  removeLabel: string;
  onRemove: () => void;
};

export function AppliedFilterChips({ chips }: { chips: readonly AppliedFilterChip[] }) {
  if (chips.length === 0) return null;
  return (
    <div className="filter-chips" role="list" aria-label="已应用的搜索条件">
      {chips.map((chip) => (
        <span key={chip.key} className="filter-chip" role="listitem">
          <span>{chip.label}</span>
          <button type="button" aria-label={chip.removeLabel} onClick={chip.onRemove}>
            ×
          </button>
        </span>
      ))}
    </div>
  );
}
