// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";

import { Select } from "./Select";

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

test("Select 以有标签的 combobox 呈现当前值与完整选项", () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <Select
        defaultOpen
        label="排序方式"
        name="asset-sort"
        value="imported-desc"
        onValueChange={() => {}}
        options={[
          { value: "imported-desc", label: "最近导入" },
          { value: "filename-asc", label: "文件名" },
        ]}
      />,
    );
  });

  const trigger = container.querySelector<HTMLElement>('[role="combobox"]');
  expect(trigger?.getAttribute("aria-label")).toBe("排序方式");
  expect(trigger?.textContent).toContain("最近导入");
  expect([...document.body.querySelectorAll('[role="option"]')].map((item) => item.textContent)).toEqual([
    "最近导入",
    "文件名",
  ]);
});
