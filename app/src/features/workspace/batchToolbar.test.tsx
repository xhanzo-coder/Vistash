// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";

import { BatchToolbar } from "./batchToolbar";

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
});

afterEach(() => {
  document.body.replaceChildren();
});

/** 挂载工具条并返回容器，供按文本查询元素。 */
function mount(ui: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return {
    unmount: () =>
      act(() => {
        root.unmount();
      }),
  };
}

function queryButton(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (button === null || button === undefined || !(button instanceof HTMLButtonElement)) {
    throw new Error(`找不到按钮「${label}」`);
  }
  return button;
}

test("渲染已选计数、全选与清除按钮和视图专属动作插槽", async () => {
  const calls: string[] = [];
  const harness = mount(
    <BatchToolbar
      count={3}
      totalCount={10}
      onSelectAll={() => calls.push("all")}
      onClear={() => calls.push("clear")}
    >
      <button type="button" onClick={() => calls.push("custom")}>
        移入回收站
      </button>
    </BatchToolbar>,
  );

  // 工具条地标与计数文案。
  const toolbar = document.querySelector('[role="toolbar"]');
  expect(toolbar?.getAttribute("aria-label")).toBe("批量操作");
  expect(toolbar?.textContent).toContain("已选 3 / 共 10 项");

  // 全选与清除。
  act(() => queryButton("全选").click());
  act(() => queryButton("清除选择").click());
  // 插槽里的视图专属按钮原样可用。
  act(() => queryButton("移入回收站").click());
  expect(calls).toEqual(["all", "clear", "custom"]);

  harness.unmount();
});

test("count 为 0 时不渲染任何内容", async () => {
  const harness = mount(
    <BatchToolbar count={0} totalCount={10} onSelectAll={() => {}} onClear={() => {}} />,
  );
  expect(document.querySelector('[role="toolbar"]')).toBeNull();
  harness.unmount();
});
