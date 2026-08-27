// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";

import { ConfirmDialog } from "./ConfirmDialog";

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
});

afterEach(() => {
  document.body.replaceChildren();
});

/** 在容器内挂载对话框；container 留在外部以便卸载时验证焦点归还。 */
function mount(busy = false, onCancel: () => void = () => {}, onConfirm: () => void = () => {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <ConfirmDialog
        title="移入回收站？"
        body="这条记录将进入回收站。"
        confirmLabel="移入回收站"
        busy={busy}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );
  });
  return {
    unmount: () =>
      act(() => {
        root.unmount();
      }),
  };
}

function dialog(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[role="dialog"]');
  if (el === null) throw new Error("缺少对话框");
  return el;
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (!(found instanceof HTMLButtonElement)) throw new Error(`找不到按钮「${label}」`);
  return found;
}

/** 以给定按键从当前活跃元素派发一次键盘事件（冒泡到对话框监听）。 */
function pressKey(key: string, shift = false): void {
  const event = new KeyboardEvent("keydown", { key: key, shiftKey: shift, bubbles: true });
  document.activeElement?.dispatchEvent(event);
}

test("模态语义齐全，默认焦点落在安全侧的取消按钮", () => {
  mount();
  const box = dialog();
  expect(box.getAttribute("aria-modal")).toBe("true");
  expect(box.getAttribute("aria-labelledby")).toBe("confirm-title");
  expect(document.activeElement).toBe(button("取消"));
});

test("Tab 在两个动作间循环，Shift+Tab 反向，不泄漏到底层页面", () => {
  mount();
  // 默认焦点在取消（圈首）：Shift+Tab 绕到确认（圈尾）。
  pressKey("Tab", true);
  expect(document.activeElement).toBe(button("移入回收站"));
  // 再 Shift+Tab 回圈首。
  pressKey("Tab", true);
  expect(document.activeElement).toBe(button("取消"));
  // 从圈首正向 Tab 绕回圈尾，再回到圈首。
  pressKey("Tab");
  expect(document.activeElement).toBe(button("移入回收站"));
  pressKey("Tab");
  expect(document.activeElement).toBe(button("取消"));
});

test("Escape 触发取消这一安全侧；busy 时 Esc 被忽略", () => {
  const calls: string[] = [];
  const first = mount(false, () => calls.push("cancel"), () => calls.push("confirm"));
  pressKey("Escape");
  expect(calls).toEqual(["cancel"]);
  first.unmount();

  const second = mount(true, () => calls.push("cancel"));
  pressKey("Escape");
  expect(calls).toEqual(["cancel"]);
  second.unmount();
});

test("关闭后焦点归还打开前的触发元素", () => {
  // 打开前聚焦的"外部"按钮模拟工作区里的触发点。
  const outside = document.createElement("button");
  outside.type = "button";
  outside.textContent = "批量删除";
  document.body.append(outside);
  outside.focus();
  expect(document.activeElement).toBe(outside);

  const harness = mount();
  // 对话框抢走焦点；卸载（即关闭）后还给触发器。
  harness.unmount();
  expect(document.activeElement).toBe(outside);
});
