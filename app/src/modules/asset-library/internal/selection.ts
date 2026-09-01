/**
 * 图片集合的选择模型（任务 8.5，设计第十五条）。
 *
 * 状态保存五类事实：查询有序 ID、活动 ID、选中集合、范围锚点与聚焦 ID。
 * 纯 reducer：不触碰 React、不触碰 IPC；Context/组合接线属于工作区组件。
 * 活动项必须属于选择集合；Esc 清空选择与活动项，独立 focusedId 保留键盘位置。
 */

export type SelectionState = {
  /** 当前查询的有序 ID：选择、范围与键盘导航的定义域。 */
  readonly orderedIds: readonly string[];
  /** 活动项：键盘导航的落点，通常也是最后一次直接点击的项。 */
  readonly activeId: string | null;
  /** 选中集合。 */
  readonly selectedIds: ReadonlySet<string>;
  /** Shift 范围选择的锚点；范围动作不移动它。 */
  readonly anchorId: string | null;
  /** roving focus 的聚焦 ID。 */
  readonly focusedId: string | null;
};

export type SelectionAction =
  | { kind: "selectOne"; id: string }
  | { kind: "toggleOne"; id: string }
  | { kind: "rangeTo"; id: string }
  | { kind: "boxSelect"; ids: readonly string[]; additive?: boolean }
  | { kind: "selectAll" }
  | { kind: "clear" }
  | { kind: "moveActive"; step: "next" | "prev" | "first" | "last"; extend?: boolean }
  | { kind: "idsReplaced"; ids: readonly string[] };

/** 以一份有序 ID 开出初始状态：无选中、无活动、无锚点、无聚焦。 */
export function initialSelection(orderedIds: readonly string[]): SelectionState {
  return {
    orderedIds: [...orderedIds],
    activeId: null,
    selectedIds: new Set(),
    anchorId: null,
    focusedId: null,
  };
}

function indexOf(state: SelectionState, id: string): number {
  return state.orderedIds.indexOf(id);
}

/** 活动身份取自选择集合；键盘焦点与范围锚点不参与这一约束。 */
function activeWithin(selected: ReadonlySet<string>, preferred: string | null, ordered: readonly string[]): string | null {
  if (preferred !== null && selected.has(preferred)) return preferred;
  for (const id of ordered) if (selected.has(id)) return id;
  return null;
}

/** 锚点下标到目标下标之间的闭区间（方向任意）。 */
function rangeBetween(
  orderedIds: readonly string[],
  anchorIndex: number,
  targetIndex: number,
): Set<string> {
  const [start, end] =
    anchorIndex <= targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
  return new Set(orderedIds.slice(start, end + 1));
}

export function selectionReducer(state: SelectionState, action: SelectionAction): SelectionState {
  switch (action.kind) {
    case "selectOne": {
      // 允许先于集合数据消费（如全局定位在快照到达前投递）：越界 ID 会由
      // 随后的 idsReplaced 按查询域收敛，活动项最终仍属于选择集合。
      return {
        ...state,
        activeId: action.id,
        selectedIds: new Set([action.id]),
        anchorId: action.id,
        focusedId: action.id,
      };
    }

    case "toggleOne": {
      if (indexOf(state, action.id) === -1) return state;
      const selectedIds = new Set(state.selectedIds);
      if (selectedIds.has(action.id)) {
        selectedIds.delete(action.id);
      } else {
        selectedIds.add(action.id);
      }
      return { ...state, activeId: activeWithin(selectedIds, action.id, state.orderedIds), selectedIds, anchorId: action.id, focusedId: action.id };
    }

    case "rangeTo": {
      const targetIndex = indexOf(state, action.id);
      if (targetIndex === -1) return state;
      const anchorIndex = state.anchorId === null ? -1 : indexOf(state, state.anchorId);
      if (anchorIndex === -1) {
        // 没有可用锚点时退化为普通单击。
        return selectionReducer(state, { kind: "selectOne", id: action.id });
      }
      return {
        ...state,
        activeId: action.id,
        selectedIds: rangeBetween(state.orderedIds, anchorIndex, targetIndex),
        focusedId: action.id,
      };
    }

    case "boxSelect": {
      // 框选更新选择和活动身份，但不移动键盘位置与范围锚点。
      const domain = new Set(state.orderedIds);
      const boxed = new Set(action.ids.filter((id) => domain.has(id)));
      const selectedIds = action.additive === true
        ? new Set([...state.selectedIds, ...boxed])
        : boxed;
      return { ...state, selectedIds, activeId: activeWithin(selectedIds, state.activeId, state.orderedIds) };
    }

    case "selectAll": {
      const selectedIds = new Set(state.orderedIds);
      return { ...state, selectedIds, activeId: activeWithin(selectedIds, state.activeId, state.orderedIds) };
    }

    case "clear": {
      return { ...state, selectedIds: new Set(), activeId: null };
    }

    case "moveActive": {
      const total = state.orderedIds.length;
      if (total === 0) return state;
      const currentIndex = state.focusedId === null ? -1 : indexOf(state, state.focusedId);
      let nextIndex: number;
      switch (action.step) {
        case "first":
          nextIndex = 0;
          break;
        case "last":
          nextIndex = total - 1;
          break;
        case "next":
          nextIndex = currentIndex < 0 ? 0 : Math.min(currentIndex + 1, total - 1);
          break;
        case "prev":
          nextIndex = currentIndex < 0 ? total - 1 : Math.max(currentIndex - 1, 0);
          break;
      }
      const nextId = state.orderedIds[nextIndex];
      if (nextId === undefined) return state;

      const anchorIndex =
        action.extend === true && state.anchorId !== null
          ? indexOf(state, state.anchorId)
          : -1;
      if (anchorIndex !== -1) {
        // Shift 扩展：锚点不动，范围随活动项生长或收缩。
        return {
          ...state,
          activeId: nextId,
          selectedIds: rangeBetween(state.orderedIds, anchorIndex, nextIndex),
          focusedId: nextId,
        };
      }
      // 无修饰移动等价于把新活动项变成唯一选中并重置锚点。
      return {
        ...state,
        activeId: nextId,
        selectedIds: new Set([nextId]),
        anchorId: nextId,
        focusedId: nextId,
      };
    }

    case "idsReplaced": {
      const nextIds = [...action.ids];
      // 同一查询域（视图切换重新下发）原样返回：选择、滚动上下文都不被打扰。
      if (
        nextIds.length === state.orderedIds.length &&
        nextIds.every((id, index) => state.orderedIds[index] === id)
      ) {
        return state;
      }
      const domain = new Set(nextIds);
      const selectedIds = new Set([...state.selectedIds].filter((id) => domain.has(id)));
      return {
        orderedIds: nextIds,
        selectedIds,
        activeId: activeWithin(selectedIds, state.activeId, nextIds),
        anchorId: state.anchorId !== null && domain.has(state.anchorId) ? state.anchorId : null,
        focusedId:
          state.focusedId !== null && domain.has(state.focusedId) ? state.focusedId : null,
      };
    }

    default: {
      // 穷尽性哨兵：新增动作种类时这里先编译失败，逼出对应分支。
      const unhandled: never = action;
      throw new Error(`未知的选择动作：${JSON.stringify(unhandled)}`);
    }
  }
}
