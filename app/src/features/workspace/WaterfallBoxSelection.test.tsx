// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PromptCardWaterfall } from "../prompts/PromptCardWaterfall";
import type { PromptRow } from "../../shared/types";
import { SelectionProvider, useSelection } from "./selectionContext";

const roots: ReturnType<typeof createRoot>[] = [];

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 600, 500));
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(500);
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", { configurable: true, value: () => true });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value(this: HTMLElement, options: ScrollToOptions) { this.scrollTop = options.top ?? 0; },
  });
});

afterEach(() => {
  act(() => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren();
  vi.restoreAllMocks();
  for (const key of ["setPointerCapture", "releasePointerCapture", "hasPointerCapture", "scrollTo"]) {
    Reflect.deleteProperty(HTMLElement.prototype, key);
  }
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

function prompt(index: number): PromptRow {
  return {
    id: `item-${index}`, body: `正文 ${index}`, title: `提示词 ${index}`, model: null, parameters: null,
    note: "", favorite: false, folders: [], tags: [], linked_image_hashes: [], cover_image_hash: null,
    resolved_cover_hash: null, created_at: "2026-08-20T00:00:00Z", updated_at: "2026-08-20T00:00:00Z", deleted_at: null,
  };
}

function SelectionSummary() {
  const { state } = useSelection();
  return <output data-selection-summary="" data-active={state.activeId}>{[...state.selectedIds].join(",")}</output>;
}

async function mount(_kind: "提示词", count = 100) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const render = (nextCount: number, tileWidth: number) => {
    const ids = Array.from({ length: nextCount }, (_, index) => `item-${index}`);
    root.render(
    <SelectionProvider ids={ids}>
      <SelectionSummary />
      <PromptCardWaterfall prompts={ids.map((_, index) => prompt(index))} scrollKey="box-prompts" savedOffset={0}
        onScrollOffset={() => {}} onToggleFavorite={() => {}} onOpenFocused={() => {}} targetTileWidth={tileWidth} />
    </SelectionProvider>,
    );
  };
  await act(async () => render(count, 200));
  const surface = container.querySelector<HTMLDivElement>('[role="listbox"]');
  const first = container.querySelector<HTMLButtonElement>('[data-index="0"]');
  const summary = container.querySelector<HTMLOutputElement>('output');
  if (surface === null || first === null || summary === null) throw new Error("瀑布流测试未完成挂载");
  return { container, surface, first, summary, rerender: async (nextCount: number, tileWidth: number) => act(async () => render(nextCount, tileWidth)) };
}

async function pointer(target: HTMLElement, type: string, x: number, y: number, ctrlKey = false) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, ctrlKey });
  Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: "mouse" }, isPrimary: { value: true } });
  await act(async () => {
    target.dispatchEvent(event);
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
}

test.each(["提示词"] as const)("%s 从空白处拖框替换选择且保留键盘活动项", async (kind) => {
  const { surface, first, summary, container } = await mount(kind);
  await act(async () => first.click());
  await pointer(surface, "pointerdown", 300, 0);
  await pointer(surface, "pointermove", 590, 80);
  expect(summary.textContent).toBe("item-1");
  expect(summary.dataset.active).toBe("item-0");
  expect(container.querySelector('[data-selection-box]')).not.toBeNull();
  await pointer(surface, "pointerup", 590, 80);
  expect(summary.textContent).toBe("item-1");
  expect(container.querySelector('[data-selection-box]')).toBeNull();
});

test.each(["提示词"] as const)("%s Ctrl 框选可收缩，Esc 与 pointercancel 恢复原选择", async (kind) => {
  const { surface, first, summary, container } = await mount(kind);
  await act(async () => first.click());
  await pointer(surface, "pointerdown", 300, 0, true);
  await pointer(surface, "pointermove", 590, 80, true);
  expect(summary.textContent).toBe("item-0,item-1");
  await pointer(surface, "pointermove", 300, 0, true);
  expect(summary.textContent).toBe("item-0");
  await pointer(surface, "pointermove", 590, 80, true);
  await act(async () => surface.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(summary.textContent).toBe("item-0");
  expect(container.querySelector('[data-selection-box]')).toBeNull();

  await pointer(surface, "pointerdown", 300, 0);
  await pointer(surface, "pointermove", 590, 80);
  await pointer(surface, "pointercancel", 590, 80);
  expect(summary.textContent).toBe("item-0");
  expect(container.querySelector('[data-selection-box]')).toBeNull();
});

test.each(["提示词"] as const)("%s 万项框选跨滚动包含离屏项且 DOM 保持有界", async (kind) => {
  const { surface, summary, container } = await mount(kind, 10_000);
  await pointer(surface, "pointerdown", 300, 0);
  await pointer(surface, "pointermove", 590, 80);
  await act(async () => {
    surface.scrollTop = 5_000;
    surface.dispatchEvent(new Event("scroll", { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
  const selected = summary.textContent?.split(",");
  expect(selected).toContain("item-1");
  expect(selected?.length).toBeGreaterThan(8);
  expect(container.querySelectorAll('[data-index]').length).toBeLessThan(80);
  expect(container.querySelector('[data-index="1"]')).toBeNull();
  await pointer(surface, "pointerup", 590, 80);
});

test.each(["提示词"] as const)("%s 查询和列宽改变时取消手势，单列仍按虚拟几何命中", async (kind) => {
  const { surface, first, summary, container, rerender } = await mount(kind);
  await act(async () => first.click());
  await pointer(surface, "pointerdown", 300, 0);
  await pointer(surface, "pointermove", 590, 80);
  await rerender(20, 200);
  expect(container.querySelector('[data-selection-box]')).toBeNull();
  expect(summary.textContent).toBe("item-0");

  await pointer(surface, "pointerdown", 300, 0);
  await pointer(surface, "pointermove", 590, 80);
  await rerender(20, 1_000);
  expect(container.querySelector('[data-selection-box]')).toBeNull();
  expect(summary.textContent).toBe("item-0");
  await pointer(surface, "pointerdown", 0, 0);
  await pointer(surface, "pointermove", 590, 80);
  expect(summary.textContent).toBe("item-0");
  await pointer(surface, "pointerup", 590, 80);
});
