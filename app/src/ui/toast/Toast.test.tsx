// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";

import { Button } from "../button/Button";
import { ToastProvider, useToast } from "./Toast";

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

function ToastHarness() {
  const toast = useToast();
  return (
    <Button
      onClick={() =>
        toast.publish({ tone: "success", title: "已复制图像", description: "可以粘贴到其他应用。" })
      }
    >
      显示通知
    </Button>
  );
}

test("Toast 通过 polite live region 告知短暂结果，并可由使用者关闭", () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(<ToastProvider><ToastHarness /></ToastProvider>));

  act(() => {
    container?.querySelector<HTMLButtonElement>("button")?.click();
  });
  const liveRegion = document.body.querySelector('[aria-live="polite"]');
  const toast = liveRegion?.querySelector('[role="status"]');
  expect(toast?.textContent).toContain("已复制图像");
  expect(toast?.textContent).toContain("可以粘贴到其他应用。");

  act(() => {
    toast?.querySelector<HTMLButtonElement>('button[aria-label="关闭通知"]')?.click();
  });
  expect(liveRegion?.querySelector('[role="status"]')).toBeNull();
});
