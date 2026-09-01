// @vitest-environment jsdom

import { act, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";

import { SearchField } from "./SearchField";

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

function ControlledSearch(): ReactNode {
  const [value, setValue] = useState("雨夜");
  return <SearchField label="搜索图片" name="asset-search" placeholder="按文件名搜索…" value={value} onValueChange={setValue} />;
}

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

test("SearchField 提供真实标签、搜索语义和可访问的清除操作", () => {
  const onValueChange = vi.fn<(value: string) => void>();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <SearchField
        label="搜索图片"
        name="asset-search"
        placeholder="按文件名搜索…"
        value="雨夜"
        onValueChange={onValueChange}
        shortcut="Ctrl F"
      />,
    );
  });

  const input = container.querySelector<HTMLInputElement>("input");
  const clear = container.querySelector<HTMLButtonElement>('button[aria-label="清除搜索"]');
  expect(input?.type).toBe("search");
  expect(input?.name).toBe("asset-search");
  expect(input?.getAttribute("autocomplete")).toBe("off");
  expect(container.querySelector(`label[for="${input?.id}"]`)?.textContent).toBe("搜索图片");

  act(() => {
    clear?.click();
  });
  expect(onValueChange).toHaveBeenCalledWith("");
});

test("Escape 清空搜索并把焦点留在输入框", () => {
  const onValueChange = vi.fn<(value: string) => void>();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <SearchField
        label="搜索图片"
        name="asset-search"
        placeholder="按文件名搜索…"
        value="雨夜"
        onValueChange={onValueChange}
      />,
    );
  });

  const input = container.querySelector<HTMLInputElement>("input");
  input?.focus();
  act(() => {
    input?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
  });

  expect(onValueChange).toHaveBeenCalledWith("");
  expect(document.activeElement).toBe(input);
});

test("清除按钮卸载后焦点回到搜索框", () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(<ControlledSearch />));
  const input = container.querySelector<HTMLInputElement>("input");
  const clear = container.querySelector<HTMLButtonElement>('button[aria-label="清除搜索"]');
  if (input === null || clear === null) throw new Error("搜索测试缺少输入框或清除按钮");
  clear.focus();
  act(() => clear.click());

  expect(input.value).toBe("");
  expect(container.querySelector('button[aria-label="清除搜索"]')).toBeNull();
  expect(document.activeElement).toBe(input);
});

test("禁用搜索不能输入或清除，也不发出值变更", () => {
  const onValueChange = vi.fn<(value: string) => void>();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(
    <SearchField disabled label="搜索图片" name="asset-search" placeholder="按文件名搜索…" value="雨夜" onValueChange={onValueChange} />,
  ));
  const input = container.querySelector<HTMLInputElement>("input");
  const clear = container.querySelector<HTMLButtonElement>('button[aria-label="清除搜索"]');
  if (input === null || clear === null) throw new Error("搜索测试缺少输入框或清除按钮");
  expect(input.disabled).toBe(true);
  expect(clear.disabled).toBe(true);
  act(() => clear.click());
  expect(input.value).toBe("雨夜");
  expect(onValueChange).not.toHaveBeenCalled();
});
