// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";

import { Button } from "../button/Button";
import { ScrollArea } from "./ScrollArea";
import { EmptyState, Panel, Toolbar } from "./Surface";

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

test("基础容器保持明确区域语义，空状态提供可执行入口", () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <Panel label="素材集合">
        <Toolbar label="集合工具"><Button>筛选</Button></Toolbar>
        <ScrollArea label="素材列表">
          <EmptyState
            title="还没有图片"
            description="导入图片或文件夹开始整理。"
            primaryAction={<Button variant="primary">导入图片</Button>}
          />
        </ScrollArea>
      </Panel>,
    );
  });

  expect(container.querySelector('section[aria-label="素材集合"]')).not.toBeNull();
  expect(container.querySelector('[role="toolbar"][aria-label="集合工具"]')).not.toBeNull();
  expect(container.querySelector('[role="region"][aria-label="素材列表"]')).not.toBeNull();
  expect(container.querySelector("h2")?.textContent).toBe("还没有图片");
  expect(container.textContent).toContain("导入图片或文件夹开始整理。");
});
