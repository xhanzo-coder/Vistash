// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";

import { WorkspaceDrawer } from "./workspaceDrawer";

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
});

afterEach(() => {
  document.body.replaceChildren();
});

type DrawerProps = Parameters<typeof WorkspaceDrawer>[0];

/** 挂载抽屉并支持按新属性重渲染。 */
function setupDrawer(overrides: Partial<DrawerProps> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let current: DrawerProps = {
    mode: "drawer",
    side: "start",
    label: "素材分类",
    open: false,
    onClose: () => {},
    children: <p>栏内容</p>,
    ...overrides,
  };
  const render = (next: Partial<DrawerProps>) =>
    act(async () => {
      current = { ...current, ...next };
      root.render(<WorkspaceDrawer {...current} />);
    });
  return {
    render,
    unmount: () =>
      act(() => {
        root.unmount();
      }),
  };
}

test("inline 模式直接渲染内容，不出现对话框语义", async () => {
  const harness = setupDrawer({ mode: "inline", open: true });
  await harness.render({});
  expect(document.querySelector("p")?.textContent).toBe("栏内容");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.querySelector(".drawer-backdrop")).toBeNull();
  harness.unmount();
});

test("drawer 模式关闭时不渲染任何内容", async () => {
  const harness = setupDrawer({ mode: "drawer", open: false });
  await harness.render({});
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.querySelector("p")).toBeNull();
  harness.unmount();
});

test("drawer 打开：对话框语义、背景层、Esc 与点击背景都请求关闭", async () => {
  const closed: string[] = [];
  const harness = setupDrawer({
    mode: "drawer",
    open: true,
    onClose: () => closed.push("close"),
    panelId: "catalog-rail-panel",
  });
  await harness.render({});

  const panel = document.querySelector<HTMLDivElement>('[role="dialog"]');
  expect(panel?.getAttribute("aria-label")).toBe("素材分类");
  expect(panel?.getAttribute("aria-modal")).toBe("true");
  expect(panel?.id).toBe("catalog-rail-panel");
  expect(document.querySelector(".drawer-backdrop")).not.toBeNull();

  // Esc 关闭。
  act(() => {
    panel?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(closed).toEqual(["close"]);

  // 点击背景层关闭。
  act(() => {
    document
      .querySelector(".drawer-backdrop")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(closed).toEqual(["close", "close"]);

  harness.unmount();
});

test("打开时焦点移入面板，关闭后归还给之前的焦点元素", async () => {
  const opener = document.createElement("button");
  opener.textContent = "边缘入口";
  document.body.append(opener);
  opener.focus();
  expect(document.activeElement).toBe(opener);

  const harness = setupDrawer({ mode: "drawer", open: false });
  await harness.render({});

  // 打开：焦点进入面板（tabIndex=-1 的程序化聚焦）。
  await harness.render({ open: true });
  const panel = document.querySelector('[role="dialog"]');
  expect(document.activeElement).toBe(panel);

  // 关闭：焦点归还给触发按钮。
  await harness.render({ open: false });
  expect(document.activeElement).toBe(opener);

  harness.unmount();
});
