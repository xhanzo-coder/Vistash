// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import { Button, IconButton } from "./Button";

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

beforeAll(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
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

function render(node: ReactNode): HTMLDivElement {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(node));
  return container;
}

describe("Button", () => {
  test("默认是不会意外提交表单的真实按钮，并转交点击意图", () => {
    const onClick = vi.fn<() => void>();
    const view = render(<Button onClick={onClick}>导入图片</Button>);
    const button = view.querySelector("button");

    expect(button?.type).toBe("button");
    act(() => button?.click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test("加载时保留明确文案、标记忙碌并阻止重复提交", () => {
    const view = render(<Button loading loadingLabel="正在导入…">导入图片</Button>);
    const button = view.querySelector("button");

    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute("aria-busy")).toBe("true");
    expect(button?.textContent).toContain("正在导入…");
  });
});

describe("IconButton", () => {
  test("图标仅作装饰，按钮必须具有调用方提供的可访问名称", () => {
    const view = render(
      <IconButton label="关闭" icon={<span data-testid="icon">×</span>} />,
    );
    const button = view.querySelector("button");

    expect(button?.getAttribute("aria-label")).toBe("关闭");
    expect(view.querySelector('[data-testid="icon"]')?.closest('[aria-hidden="true"]')).not.toBeNull();
  });
});
