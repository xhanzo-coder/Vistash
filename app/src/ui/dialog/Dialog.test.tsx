// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import { Button } from "../button/Button";
import { ConfirmDialog, Dialog } from "./Dialog";

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
  document.body.querySelectorAll('[data-radix-portal]').forEach((portal) => portal.remove());
  root = null;
  container = null;
});

function mount(node: ReactNode): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

describe("Dialog", () => {
  test("打开后提供标题与描述语义，Escape 关闭并把焦点还给触发器", async () => {
    mount(
      <Dialog
        trigger={<Button>打开设置</Button>}
        title="设置"
        description="调整当前工作区外观。"
      >
        <p>设置内容</p>
      </Dialog>,
    );
    const trigger = container?.querySelector<HTMLButtonElement>("button");
    trigger?.focus();
    await act(async () => trigger?.click());

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("aria-labelledby")).not.toBeNull();
    expect(dialog?.getAttribute("aria-describedby")).not.toBeNull();
    expect(dialog?.textContent).toContain("设置");

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

describe("ConfirmDialog", () => {
  test("危险动作只有点击明确确认按钮才会执行", async () => {
    const onConfirm = vi.fn<() => void>();
    mount(
      <ConfirmDialog
        trigger={<Button variant="danger">清空回收站</Button>}
        title="永久删除回收站内容？"
        description="删除后无法恢复。"
        confirmLabel="永久删除"
        onConfirm={onConfirm}
      />,
    );
    await act(async () => container?.querySelector<HTMLButtonElement>("button")?.click());
    const confirm = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "永久删除",
    );
    expect(confirm).toBeDefined();
    await act(async () => confirm?.click());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
  });
});
