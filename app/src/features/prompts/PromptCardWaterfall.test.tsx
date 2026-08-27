// @vitest-environment jsdom

import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

import { SelectionProvider, useSelection } from "../workspace/selectionContext";
import type { PromptRow } from "../../shared/types";
import { PromptCardWaterfall } from "./PromptCardWaterfall";

let thumbnailCalls: string[];

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  thumbnailCalls = [];
  mockIPC((command, payload) => {
    if (command === "asset_thumbnail") {
      if (typeof payload !== "object" || payload === null || !("hash" in payload)) {
        throw new TypeError("asset_thumbnail 缺少 hash");
      }
      thumbnailCalls.push(String(payload.hash));
      return new ArrayBuffer(8);
    }
    throw new Error(`未预期的 IPC：${command}`);
  });
});

afterEach(() => {
  clearMocks();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTop");
  Reflect.deleteProperty(navigator, "clipboard");
  document.body.replaceChildren();
});

/** 合成一条最小 PromptRow；带图变体按序号决定关联数量。 */
function makePrompt(index: number): PromptRow {
  const linked =
    index % 3 === 1
      ? ["a".repeat(64), "b".repeat(64), "c".repeat(64), "d".repeat(64), "e".repeat(64)]
      : [];
  return {
    id: `prompt-${index}`,
    body: index % 2 === 0 ? `正文首行 ${index}\n第二行细节` : `cinematic body ${index}`,
    title: index % 4 === 0 ? `显式标题 ${index}` : null,
    model: index % 3 === 0 ? "sd-xl" : null,
    parameters: null,
    note: "",
    favorite: false,
    folders: [],
    tags: [],
    linked_image_hashes: linked,
    cover_image_hash: linked.length > 0 ? linked[2] ?? null : null,
    resolved_cover_hash: linked.length > 0 ? linked[2] ?? null : null,
    created_at: "2026-08-20T00:00:00Z",
    updated_at: "2026-08-21T00:00:00Z",
    deleted_at: null,
  };
}

/**
 * 几何桩：卡片按内联样式报告尺寸，其余元素（视口）默认 1200×800。
 * jsdom 不做布局，TanStack 的窗口化完全靠这些读数。
 */
function stubGeometry() {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
    this: Element,
  ) {
    const style = this instanceof HTMLElement ? this.style : null;
    const width = Number.parseFloat(style?.width ?? "") || 1200;
    const height = Number.parseFloat(style?.height ?? "") || 800;
    return {
      x: 0,
      y: 0,
      width,
      height,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      toJSON: () => ({}),
    };
  });
}

/** jsdom 的 scrollTop 恒为 0：用可写访问器模拟真实滚动位置。 */
function stubScrollTop() {
  let value = 0;
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get: () => value,
    set: (next: number) => {
      value = next;
    },
  });
}

type SelectionSnapshot = { selected: string[]; active: string | null; focused: string | null };

/** 在 Provider 内挂载瀑布流，并经消费者探针暴露选择状态。 */
async function setupWaterfall(
  prompts: readonly PromptRow[],
  handlers: {
    onToggleFavorite?: (id: string, favorite: boolean) => void;
    onScrollOffset?: (offset: number) => void;
  } = {},
  savedOffset = 0,
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const latest: { selection?: SelectionSnapshot } = {};
  function Probe() {
    const { state } = useSelection();
    useEffect(() => {
      latest.selection = {
        selected: [...state.selectedIds],
        active: state.activeId,
        focused: state.focusedId,
      };
    });
    return null;
  }
  await act(async () => {
    root.render(
      <SelectionProvider ids={prompts.map((prompt) => prompt.id)}>
        <Probe />
        <PromptCardWaterfall
          onOpenFocused={() => {}}
          prompts={prompts}
          scrollKey="prompts-waterfall"
          savedOffset={savedOffset}
          onScrollOffset={handlers.onScrollOffset ?? (() => {})}
          onToggleFavorite={handlers.onToggleFavorite ?? (() => {})}
        />
      </SelectionProvider>,
    );
  });
  return {
    selection: () => {
      if (latest.selection === undefined) throw new Error("探针尚未完成首次渲染");
      return latest.selection;
    },
    scroller: () => {
      const el = container.querySelector<HTMLElement>(".prompt-waterfall");
      if (el === null) throw new Error("缺少提示词瀑布流滚动容器");
      return el;
    },
    items: () => [...container.querySelectorAll<HTMLElement>("[data-prompt-card]")],
    item: (index: number) => {
      const el = container.querySelector<HTMLElement>(`[data-index="${index}"]`);
      if (el === null) throw new Error(`缺少第 ${index} 个卡片`);
      return el;
    },
    unmount: () =>
      act(async () => {
        root.unmount();
      }),
  };
}

test("一万条提示词只渲染视口与过扫缓冲区内的卡片", async () => {
  stubGeometry();
  stubScrollTop();
  const harness = await setupWaterfall(Array.from({ length: 10_000 }, (_, i) => makePrompt(i)));

  const rendered = harness.items();
  expect(rendered.length).toBeGreaterThan(0);
  // 视口 800px 高的四列布局下，视口+过扫远到不了一百项。
  expect(rendered.length).toBeLessThanOrEqual(80);
  // 首屏从第 0 行开始。
  expect(Number.parseInt(harness.item(0).dataset.index ?? "", 10)).toBe(0);

  await harness.unmount();
});

test("无关联图片的提示词以可读纯文本卡片出现且不显示占位图", async () => {
  stubGeometry();
  stubScrollTop();
  // 序号 2：无标题、无关联图。
  const harness = await setupWaterfall([makePrompt(2)]);

  const card = harness.item(0);
  // 标题缺省：用正文首行作为可识别名称。
  expect(card.getAttribute("aria-label")).toBe("正文首行 2");
  expect(card.querySelector(".prompt-card-title")?.textContent).toBe("正文首行 2");
  // 正文可读，且没有任何虚假生成结果或占位图。
  expect(card.textContent).toContain("第二行细节");
  expect(card.querySelector(".prompt-cover-frame")).toBeNull();
  expect(card.querySelector("img")).toBeNull();

  await harness.unmount();
});

test("五张关联图与显式封面只展示该封面与 +4 计数", async () => {
  stubGeometry();
  stubScrollTop();
  const prompt = { ...makePrompt(1), cover_image_hash: "c".repeat(64) };
  const harness = await setupWaterfall([prompt]);

  const card = harness.item(0);
  expect(card.getAttribute("aria-label")).toBe(
    `${prompt.body}（关联 5 张图片）`,
  );
  const covers = card.querySelectorAll(".prompt-cover-frame");
  expect(covers).toHaveLength(1);
  expect(card.querySelector(".prompt-card-count")?.textContent).toBe("+4");

  await harness.unmount();
});

test("卡片只加载后端解析出的第一张正常关联图片", async () => {
  stubGeometry();
  stubScrollTop();
  vi.stubGlobal(
    "IntersectionObserver",
    class implements IntersectionObserver {
      readonly root = null;
      readonly rootMargin = "";
      readonly scrollMargin = "";
      readonly thresholds = [0];
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(target: Element): void {
        queueMicrotask(() => {
          const bounds = target.getBoundingClientRect();
          const entry: IntersectionObserverEntry = {
            boundingClientRect: bounds,
            intersectionRatio: 1,
            intersectionRect: bounds,
            isIntersecting: true,
            rootBounds: null,
            target,
            time: performance.now(),
          };
          this.callback([entry], this);
        });
      }
      disconnect(): void {}
      unobserve(): void {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    },
  );
  const prompt = {
    ...makePrompt(1),
    cover_image_hash: null,
    resolved_cover_hash: "b".repeat(64),
  };
  const harness = await setupWaterfall([prompt]);
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });

  expect(thumbnailCalls).toEqual(["b".repeat(64)]);
  await harness.unmount();
});

test("显式标题优先于正文首行作为卡片名称", async () => {
  stubGeometry();
  stubScrollTop();
  const harness = await setupWaterfall([makePrompt(4)]);

  const card = harness.item(0);
  expect(card.getAttribute("aria-label")).toBe("显式标题 4（关联 5 张图片）");
  expect(card.querySelector(".prompt-card-title")?.textContent).toBe("显式标题 4");

  await harness.unmount();
});

test("复制正文写入剪贴板，失败时显式说明出路", async () => {
  stubGeometry();
  stubScrollTop();
  const prompt = makePrompt(0);
  const harness = await setupWaterfall([prompt]);

  const writeText = vi.fn(async (_text: string) => {});
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });

  // 成功：完整当前正文进入剪贴板，并给出已复制状态。
  writeText.mockResolvedValueOnce(undefined);
  const shell = harness.item(0).parentElement;
  if (shell === null) throw new Error("缺少卡片外壳");
  const copyButton = shell.querySelector<HTMLButtonElement>('[aria-label^="复制正文"]');
  if (copyButton === null) throw new Error("缺少复制按钮");
  await act(async () => copyButton.click());
  expect(writeText).toHaveBeenCalledWith(prompt.body);
  expect(harness.scroller().querySelector('[role="status"]')?.textContent).toBe("已复制");

  // 失败：不假装成功，显式给出手动复制的出路。
  writeText.mockRejectedValueOnce(new Error("denied"));
  await act(async () => copyButton.click());
  expect(harness.scroller().querySelector('[role="alert"]')?.textContent).toContain(
    "无法写入剪贴板",
  );

  await harness.unmount();
});

test("收藏开关上报目标状态并如实反映当前值", async () => {
  stubGeometry();
  stubScrollTop();
  const toggles: Array<{ id: string; favorite: boolean }> = [];
  const favoritePrompt = { ...makePrompt(0), favorite: true };
  const harness = await setupWaterfall([makePrompt(2), favoritePrompt], {
    onToggleFavorite: (id, favorite) => toggles.push({ id, favorite }),
  });

  const starOf = (index: number) => {
    const shell = harness.item(index).parentElement;
    if (shell === null) throw new Error("缺少卡片外壳");
    const button = shell.querySelector<HTMLButtonElement>(".prompt-favorite-toggle");
    if (button === null) throw new Error("缺少收藏开关");
    return button;
  };

  expect(starOf(0).getAttribute("aria-pressed")).toBe("false");
  await act(async () => starOf(0).click());
  expect(toggles).toEqual([{ id: makePrompt(2).id, favorite: true }]);

  // 已收藏的卡片如实呈现按下态。
  expect(starOf(1).getAttribute("aria-pressed")).toBe("true");

  await harness.unmount();
});

test("单击选中、Ctrl 并入统一选择集合", async () => {
  stubGeometry();
  stubScrollTop();
  const harness = await setupWaterfall(Array.from({ length: 20 }, (_, i) => makePrompt(i)));

  act(() => harness.item(1).click());
  expect(harness.selection().selected).toEqual(["prompt-1"]);
  expect(harness.item(1).getAttribute("aria-selected")).toBe("true");

  // listbox 键盘模式语义（任务 11.3）：容器多选、卡片命中区是选项。
  const scroller = harness.scroller();
  expect(scroller.getAttribute("role")).toBe("listbox");
  expect(scroller.getAttribute("aria-multiselectable")).toBe("true");
  expect(harness.item(1).getAttribute("role")).toBe("option");

  act(() => {
    harness.item(3).dispatchEvent(new MouseEvent("click", { ctrlKey: true, bubbles: true }));
  });
  expect(new Set(harness.selection().selected)).toEqual(
    new Set(["prompt-1", "prompt-3"]),
  );

  await harness.unmount();
});
