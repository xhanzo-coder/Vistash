// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";

import { Progress } from "./Progress";

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

function render(progress: ReactNode): HTMLElement {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(progress));
  const element = container.querySelector<HTMLElement>('[role="progressbar"]');
  if (element === null) throw new Error("未渲染进度条");
  return element;
}

test("确定进度暴露当前值、总量和可读百分比", () => {
  const progress = render(<Progress label="正在导入" value={42} max={100} />);
  expect(progress.getAttribute("aria-label")).toBe("正在导入");
  expect(progress.getAttribute("aria-valuenow")).toBe("42");
  expect(progress.getAttribute("aria-valuemax")).toBe("100");
  expect(progress.textContent).toContain("42%");
});

test("不确定进度不伪造数值，非法范围显式抛错", () => {
  const progress = render(<Progress label="正在扫描" value={null} />);
  expect(progress.hasAttribute("aria-valuenow")).toBe(false);
  expect(() => render(<Progress label="无效" value={8} max={4} />)).toThrow(RangeError);
});
