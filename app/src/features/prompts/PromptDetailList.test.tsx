// @vitest-environment jsdom

import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

import { SelectionProvider, useSelection } from "../workspace/selectionContext";
import type { PromptRow } from "../../shared/types";
import { PromptCardWaterfall } from "./PromptCardWaterfall";
import { PromptDetailList } from "./PromptDetailList";
import type { PromptSort, PromptSortColumn } from "./promptSort";

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  mockIPC((command) => {
    if (command === "asset_thumbnail") return new ArrayBuffer(8);
    throw new Error(`未预期的 IPC：${command}`);
  });
});

afterEach(() => {
  clearMocks();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTop");
  document.body.replaceChildren();
});

/** 合成一条最小 PromptRow；字段按测试需要覆盖。 */
function makePrompt(id: string, overrides: Partial<PromptRow> = {}): PromptRow {
  return {
    id,
    body: `${id} 的正文首行\n第二行细节`,
    title: null,
    model: null,
    parameters: null,
    note: "",
    favorite: false,
    folders: [],
    tags: [],
    linked_image_hashes: [],
    cover_image_hash: null,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-20T00:00:00Z",
    deleted_at: null,
    ...overrides,
  };
}

/**
 * 几何桩：行按内联样式报告尺寸，其余元素（视口）默认 1200×800。
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

async function setupList(
  prompts: readonly PromptRow[],
  options: {
    sort?: PromptSort;
    onSortChange?: (column: PromptSortColumn) => void;
  } = {},
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
        <PromptDetailList
          prompts={prompts}
          scrollKey="prompts-list"
          savedOffset={0}
          onScrollOffset={() => {}}
          sort={options.sort ?? { column: "updatedAt", direction: "desc" }}
          onSortChange={options.onSortChange ?? (() => {})}
        />
      </SelectionProvider>,
    );
  });
  return {
    selection: () => {
      if (latest.selection === undefined) throw new Error("探针尚未完成首次渲染");
      return latest.selection;
    },
    rows: () => [...container.querySelectorAll<HTMLElement>("[data-list-item]")],
    row: (index: number) => {
      const el = container.querySelector<HTMLElement>(`[data-index="${index}"]`);
      if (el === null) throw new Error(`缺少第 ${index} 行`);
      return el;
    },
    header: () => {
      const el = container.querySelector<HTMLElement>(".detail-head");
      if (el === null) throw new Error("缺少表头");
      return el;
    },
    unmount: () =>
      act(async () => {
        root.unmount();
      }),
  };
}

test("一万条提示词只渲染视口与过扫缓冲区内的行", async () => {
  stubGeometry();
  stubScrollTop();
  const prompts = Array.from({ length: 10_000 }, (_, i) => makePrompt(`prompt-${i}`));
  const harness = await setupList(prompts);

  const rendered = harness.rows();
  expect(rendered.length).toBeGreaterThan(0);
  expect(rendered.length).toBeLessThanOrEqual(80);
  expect(Number.parseInt(harness.row(0).dataset.index ?? "", 10)).toBe(0);

  await harness.unmount();
});

test("行呈现规格列：标题/摘要、文件夹、标签、图片数、模型、收藏与更新时间", async () => {
  stubGeometry();
  stubScrollTop();
  const prompt = makePrompt("full", {
    title: "电影感夜景",
    body: "cinematic night, rim light\nmore detail",
    folders: ["人像", "人像/室内"],
    tags: ["夜景"],
    linked_image_hashes: ["a".repeat(64), "b".repeat(64), "c".repeat(64)],
    model: "sd-xl",
    favorite: true,
    updated_at: "2026-08-21T12:00:00Z",
  });
  const harness = await setupList([prompt]);

  const row = harness.row(0);
  // 标题行 + 正文摘要行同格呈现。
  expect(row.querySelector(".prompt-title-line")?.textContent).toBe("电影感夜景");
  expect(row.querySelector(".prompt-summary-line")?.textContent).toContain("cinematic night");
  expect(row.textContent).toContain("人像、人像/室内");
  expect(row.textContent).toContain("夜景");
  expect(row.textContent).toContain("3");
  expect(row.textContent).toContain("sd-xl");
  expect(row.textContent).toContain("★ 已收藏");
  expect(row.textContent).toContain("2026-08-21");

  await harness.unmount();
});

test("无标题行用正文首行作展示标题，模型缺省显示占位符", async () => {
  stubGeometry();
  stubScrollTop();
  const harness = await setupList([makePrompt("bare")]);

  const row = harness.row(0);
  expect(row.querySelector(".prompt-title-line")?.textContent).toBe("bare 的正文首行");
  expect(row.querySelector(".detail-col-model, .detail-value.detail-mono")).not.toBeNull();
  expect(row.textContent).toContain("—");

  await harness.unmount();
});

test("表头排序回调报告列且 aria-sort 反映当前方向", async () => {
  stubGeometry();
  stubScrollTop();
  const requested: string[] = [];
  const harness = await setupList([makePrompt("a"), makePrompt("b")], {
    onSortChange: (column) => requested.push(column),
  });

  const titleHeader = harness.header().querySelector<HTMLButtonElement>(
    ".detail-col-title button",
  );
  if (titleHeader === null) throw new Error("缺少标题排序按钮");
  await act(async () => titleHeader.click());
  expect(requested).toEqual(["title"]);

  // 排序值由父级持有：传入 desc 后对应表头声明降序。
  await harness.unmount();
  const sortedHarness = await setupList([makePrompt("a"), makePrompt("b")], {
    sort: { column: "model", direction: "desc" },
  });
  const modelHeader = sortedHarness.header().querySelector<HTMLSpanElement>(
    '.detail-col-model[role="columnheader"]',
  );
  if (modelHeader === null) throw new Error("缺少模型列表头");
  expect(modelHeader.getAttribute("aria-sort")).toBe("descending");

  await sortedHarness.unmount();
});

test("卡片瀑布流与详情列表在同一 Provider 下选择等价互通", async () => {
  stubGeometry();
  stubScrollTop();
  const prompts = Array.from({ length: 8 }, (_, i) => makePrompt(`prompt-${i}`));
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
          prompts={prompts}
          scrollKey="equivalence-card"
          savedOffset={0}
          onScrollOffset={() => {}}
          onToggleFavorite={() => {}}
        />
        <PromptDetailList
          prompts={prompts}
          scrollKey="equivalence-list"
          savedOffset={0}
          onScrollOffset={() => {}}
          sort={{ column: "updatedAt", direction: "desc" }}
          onSortChange={() => {}}
        />
      </SelectionProvider>,
    );
  });

  // 在卡片瀑布流里选中 prompt-3：详情列表的同一行立即呈现选中态。
  const card = container.querySelector<HTMLElement>('[data-prompt-card][data-id="prompt-3"]');
  if (card === null) throw new Error("缺少 prompt-3 卡片");
  act(() => card.click());

  const row = container.querySelector<HTMLElement>('[data-list-item][data-id="prompt-3"]');
  if (row === null) throw new Error("缺少 prompt-3 列表行");
  expect(row.getAttribute("aria-selected")).toBe("true");
  expect(latest.selection?.selected).toEqual(["prompt-3"]);

  await act(async () => {
    root.unmount();
  });
});
