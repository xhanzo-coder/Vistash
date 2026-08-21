/**
 * 统一 SelectionModel（任务 8.4，设计第七条）。
 *
 * 图片瀑布流/列表与提示词卡片/列表共用这一台状态机与同一套键盘语法；渲染器各自
 * 优化，但都不持有选择权威——虚拟化依赖只负责位置与可见项（设计第八条）。状态保存
 * 五类事实：查询有序 ID、活动 ID、选中集合、范围锚点与聚焦 ID。
 *
 * 纯 reducer：不触碰 React、不触碰 IPC，Context 接线属于任务 8.5。
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
      if (indexOf(state, action.id) === -1) return state;
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
      // 活动/锚点跟随被点项：随后的 Shift+单击以它为范围起点。
      return { ...state, activeId: action.id, selectedIds, anchorId: action.id, focusedId: action.id };
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
      // 框选只改变选中集合：键盘活动项、锚点与聚焦不属于指针手势的语义。
      const boxed = new Set(action.ids.filter((id) => indexOf(state, id) !== -1));
      const selectedIds = action.additive === true
        ? new Set([...state.selectedIds, ...boxed])
        : boxed;
      return { ...state, selectedIds };
    }

    case "selectAll": {
      return { ...state, selectedIds: new Set(state.orderedIds) };
    }

    case "clear": {
      // Esc 只清空选中：活动与聚焦保留，键盘导航不因清选而失位。
      return { ...state, selectedIds: new Set() };
    }

    case "moveActive": {
      const total = state.orderedIds.length;
      if (total === 0) return state;
      const currentIndex = state.activeId === null ? -1 : indexOf(state, state.activeId);
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
      return {
        orderedIds: nextIds,
        selectedIds: new Set([...state.selectedIds].filter((id) => domain.has(id))),
        activeId: state.activeId !== null && domain.has(state.activeId) ? state.activeId : null,
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
