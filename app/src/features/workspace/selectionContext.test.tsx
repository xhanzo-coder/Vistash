// @vitest-environment jsdom

import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";

import {
  SelectionProvider,
  useSelection,
  type Keyboardish,
} from "./selectionContext";

const IDS = ["a", "b", "c", "d", "e"];

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
});

afterEach(() => {
  document.body.replaceChildren();
});

type Hook = ReturnType<typeof useSelection>;

/** 挂载 Provider 并经消费者探针暴露上下文值。 */
function setupProvider() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const latest: { hook?: Hook } = {};
  function Probe() {
    const value = useSelection();
    useEffect(() => {
      latest.hook = value;
    });
    return null;
  }
  const render = (ids: readonly string[]) =>
    act(async () => {
      root.render(
        <SelectionProvider ids={ids}>
          <Probe />
        </SelectionProvider>,
      );
    });
  return {
    current: () => {
      if (latest.hook === undefined) throw new Error("探针尚未完成首次渲染");
      return latest.hook;
    },
    render,
    unmount: () =>
      act(() => {
        root.unmount();
      }),
  };
}

/** 构造最小键盘事件形状。 */
function key(
  which: string,
  modifiers: Partial<Pick<Keyboardish, "ctrlKey" | "metaKey" | "shiftKey">> = {},
  target: EventTarget | null = null,
): Keyboardish {
  return { key: which, ctrlKey: false, metaKey: false, shiftKey: false, target, ...modifiers };
}

/** 在 act 内按键，返回语法层是否声明处理。 */
function press(hook: Hook, event: Keyboardish): boolean {
  let handled = false;
  act(() => {
    handled = hook.handleKeyDown(event);
  });
  return handled;
}

test("Provider 暴露初始状态，单击经修饰键分派到正确的动作", async () => {
  const harness = setupProvider();
  await harness.render(IDS);

  expect(harness.current().state.orderedIds).toEqual(IDS);
  expect(harness.current().state.selectedIds.size).toBe(0);

  // 普通单击：单选替换。
  act(() => harness.current().onItemClick("b", key("")));
  expect(harness.current().state.selectedIds).toEqual(new Set(["b"]));

  // Ctrl+单击：并入。
  act(() => harness.current().onItemClick("d", key("", { ctrlKey: true })));
  expect(harness.current().state.selectedIds).toEqual(new Set(["b", "d"]));

  // 再 Cmd+单击：移出。锚点随最后一次点击落在 d。
  act(() => harness.current().onItemClick("d", key("", { metaKey: true })));
  expect(harness.current().state.selectedIds).toEqual(new Set(["b"]));

  // Shift+单击：从锚点 d 到 e 的范围。
  act(() => harness.current().onItemClick("e", key("", { shiftKey: true })));
  expect(harness.current().state.selectedIds).toEqual(new Set(["d", "e"]));

  harness.unmount();
});

test("ids 属性更新同步进状态机；同一查询域不扰动既有选择", async () => {
  const harness = setupProvider();
  await harness.render(IDS);
  act(() => harness.current().onItemClick("b", key("")));

  // 视图切换重新下发同一批 ID：选择原样保留。
  await harness.render([...IDS]);
  expect(harness.current().state.selectedIds).toEqual(new Set(["b"]));
  expect(harness.current().state.activeId).toBe("b");

  // 查询缩小：交集保留，越界活动清空。
  await harness.render(["a", "c"]);
  expect(harness.current().state.selectedIds).toEqual(new Set());
  expect(harness.current().state.activeId).toBeNull();

  harness.unmount();
});

test("键盘语法：Ctrl+A 全选、Esc 清选、方向键与 Home/End 移动活动项", async () => {
  const harness = setupProvider();
  await harness.render(IDS);
  act(() => harness.current().onItemClick("b", key("")));

  // Ctrl+A（含 Cmd 变体）。
  expect(press(harness.current(), key("a", { ctrlKey: true }))).toBe(true);
  expect(harness.current().state.selectedIds.size).toBe(5);

  // 方向键在 Shift 下扩展范围，锚点不动（Ctrl+A 后锚点仍是 b）。
  expect(press(harness.current(), key("ArrowDown", { shiftKey: true }))).toBe(true);
  expect(harness.current().state.activeId).toBe("c");
  expect(harness.current().state.selectedIds).toEqual(new Set(["b", "c"]));

  expect(press(harness.current(), key("Home"))).toBe(true);
  expect(harness.current().state.activeId).toBe("a");

  expect(press(harness.current(), key("End"))).toBe(true);
  expect(harness.current().state.activeId).toBe("e");

  // Esc 清空选中但保留活动与聚焦。
  expect(press(harness.current(), key("Escape"))).toBe(true);
  expect(harness.current().state.selectedIds.size).toBe(0);
  expect(harness.current().state.activeId).toBe("e");
  expect(harness.current().state.focusedId).toBe("e");

  // 未映射的键返回 false，由视图继续处理。
  expect(press(harness.current(), key("x"))).toBe(false);

  harness.unmount();
});

test("焦点在输入框内时键盘语法不劫持打字", async () => {
  const harness = setupProvider();
  await harness.render(IDS);

  const input = document.createElement("input");
  document.body.append(input);
  expect(press(harness.current(), key("a", { ctrlKey: true }, input))).toBe(false);
  expect(press(harness.current(), key("Escape", {}, input))).toBe(false);
  expect(harness.current().state.selectedIds.size).toBe(0);

  harness.unmount();
});
