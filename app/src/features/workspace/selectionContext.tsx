/**
 * 统一选择 Context。
 *
 * 图片瀑布流/列表与提示词卡片/列表共用同一个 Provider：状态机来自 selection.ts，
 * 这里只负责把修饰键单击翻译成动作、把键盘语法挂到 handleKeyDown 上，并以局部
 * Context 下发（不用全局状态库）。视图在查询域变化时重新下发 ids，同一批 ID 在
 * 状态机内部原样返回，跨视图切换因此不打扰既有选择。
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode,
} from "react";

import { type SelectionState, initialSelection, selectionReducer } from "./selection";

/** 单击分派需要的最小事件形状：只有修饰键，鼠标与键盘事件都满足。 */
export type Clickish = {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
};

/** 键盘语法需要的最小事件形状：在修饰键之外还要按键名与打字焦点目标。 */
export type Keyboardish = Clickish & {
  key: string;
  target: EventTarget | null;
};

type SelectionContextValue = {
  readonly state: SelectionState;
  /** 单击分派：Shift 范围、Ctrl/Cmd 并入、普通单击替换。 */
  onItemClick: (id: string, event: Clickish) => void;
  /**
   * 键盘语法：Ctrl+A 全选、Esc 清选、方向键/Home/End 移动活动项（Shift 扩展范围）。
   * 返回是否已处理——true 时视图应 preventDefault 阻止滚动等默认行为。
   */
  handleKeyDown: (event: Keyboardish) => boolean;
  /** 显式全选：批量工具条的"全选"按钮与 Ctrl+A 同一动作。 */
  selectAll: () => void;
  /** 显式清选：批量工具条的"清除选择"按钮与 Esc 同一动作（保留活动项）。 */
  clearSelection: () => void;
  /** 框选提交完整命中集合；活动项、范围锚点和键盘焦点保持不变。 */
  selectBox: (ids: readonly string[]) => void;
};

const SelectionContext = createContext<SelectionContextValue | null>(null);

/** 打字焦点在这些元素内时不劫持按键。 */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.isContentEditable
  );
}

export function SelectionProvider({
  ids,
  children,
}: {
  ids: readonly string[];
  children: ReactNode;
}) {
  const [state, dispatch] = useReducer(selectionReducer, ids, initialSelection);

  // 查询域变化（筛选、视图切换、增删）同步进状态机；同一批 ID 由 idsReplaced
  // 的快速路径原样返回，不会引发多余渲染。
  useEffect(() => {
    dispatch({ kind: "idsReplaced", ids });
  }, [ids]);

  const value = useMemo<SelectionContextValue>(() => {
    return {
      state,
      onItemClick: (id, event) => {
        if (event.shiftKey) {
          dispatch({ kind: "rangeTo", id });
        } else if (event.ctrlKey || event.metaKey) {
          dispatch({ kind: "toggleOne", id });
        } else {
          dispatch({ kind: "selectOne", id });
        }
      },
      handleKeyDown: (event) => {
        if (isTextEntry(event.target)) return false;
        // Windows/Linux 的 Ctrl 与 macOS 的 Cmd 在选择语法里等价。
        const mod = event.ctrlKey || event.metaKey;
        switch (event.key) {
          case "a":
          case "A":
            if (!mod) return false;
            dispatch({ kind: "selectAll" });
            return true;
          case "Escape":
            dispatch({ kind: "clear" });
            return true;
          case "ArrowDown":
          case "ArrowRight":
            dispatch({ kind: "moveActive", step: "next", extend: event.shiftKey });
            return true;
          case "ArrowUp":
          case "ArrowLeft":
            dispatch({ kind: "moveActive", step: "prev", extend: event.shiftKey });
            return true;
          case "Home":
            dispatch({ kind: "moveActive", step: "first", extend: event.shiftKey });
            return true;
          case "End":
            dispatch({ kind: "moveActive", step: "last", extend: event.shiftKey });
            return true;
          default:
            return false;
        }
      },
      selectAll: () => {
        dispatch({ kind: "selectAll" });
      },
      clearSelection: () => {
        dispatch({ kind: "clear" });
      },
      selectBox: (selectedIds) => {
        dispatch({ kind: "boxSelect", ids: selectedIds, additive: false });
      },
    };
  }, [state]);

  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

export function useSelection(): SelectionContextValue {
  const value = useContext(SelectionContext);
  if (value === null) {
    throw new Error("useSelection 必须在 SelectionProvider 内使用");
  }
  return value;
}
