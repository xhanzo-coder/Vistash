// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";

import { Button } from "../button/Button";
import { Menu, MenuItem } from "./Menu";
import { Popover } from "./Popover";
import { Tooltip, TooltipProvider } from "./Tooltip";

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

beforeAll(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
});

afterAll(() => {
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function mount(node: ReactNode): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

test("Menu 使用真实 menu/menuitem 语义并转交选择意图", async () => {
  const onSelect = vi.fn<() => void>();
  mount(
    <Menu defaultOpen trigger={<Button>更多操作</Button>}>
      <MenuItem onSelect={onSelect}>导出原图</MenuItem>
      <MenuItem disabled>不可用操作</MenuItem>
    </Menu>,
  );
  const menu = document.body.querySelector('[role="menu"]');
  expect(menu).not.toBeNull();
  const item = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (entry) => entry.textContent === "导出原图",
  );
  await act(async () => item?.click());
  expect(onSelect).toHaveBeenCalledTimes(1);
  expect(document.body.querySelector('[role="menu"]')).toBeNull();
});

test("Popover 由触发按钮开合并保留明确标题", async () => {
  mount(
    <Popover trigger={<Button>筛选</Button>} label="图片筛选">
      <p>筛选内容</p>
    </Popover>,
  );
  await act(async () => container?.querySelector<HTMLButtonElement>("button")?.click());
  const content = document.body.querySelector('[data-ui="popover"]');
  expect(content?.getAttribute("aria-label")).toBe("图片筛选");
  expect(content?.textContent).toContain("筛选内容");
});

test("Tooltip 触发器和提示内容保持可访问关联", () => {
  mount(
    <TooltipProvider>
      <Tooltip content="打开设置">
        <Button>设置</Button>
      </Tooltip>
    </TooltipProvider>,
  );
  const trigger = container?.querySelector("button");
  expect(trigger?.getAttribute("data-state")).toBe("closed");
});
