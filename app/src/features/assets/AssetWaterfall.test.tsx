// @vitest-environment jsdom

import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { SelectionProvider, useSelection } from "../workspace/selectionContext";
import type { AssetRow } from "../../shared/types";
import { AssetWaterfall } from "./AssetWaterfall";

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTop");
  document.body.replaceChildren();
});

/** 合成一条最小 AssetRow，画幅按序号变化以覆盖不同高度。 */
function makeAsset(index: number): AssetRow {
  const short = index % 3 === 0;
  return {
    hash: `${index}`.padStart(64, "0"),
    hash_algo: "sha256",
    media_type: "png",
    ext: "png",
    byte_size: 68,
    width: short ? 900 : 1600,
    height: short ? 1200 : 900,
    imported_at: "2026-08-19T00:00:00Z",
    original_filename: `图片-${index}.png`,
    source_path: null,
    deleted_at: null,
    color_card_status: "ok",
    color_card_algo_version: 1,
    color_card_failure_reason: null,
    color_card_sampled_pixel_count: 100,
    note: "",
    favorite: false,
    tags: [],
    folders: [],
    colors: [],
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
  assets: readonly AssetRow[],
  handlers: { onOpenFocused?: (hash: string) => void; onScrollOffset?: (offset: number) => void } = {},
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
      <SelectionProvider ids={assets.map((asset) => asset.hash)}>
        <Probe />
        <AssetWaterfall
          assets={assets}
          scrollKey="assets-waterfall"
          savedOffset={savedOffset}
          onScrollOffset={handlers.onScrollOffset ?? (() => {})}
          onOpenFocused={handlers.onOpenFocused ?? (() => {})}
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
      const el = container.querySelector<HTMLElement>(".asset-waterfall");
      if (el === null) throw new Error("缺少瀑布流滚动容器");
      return el;
    },
    items: () => [...container.querySelectorAll<HTMLElement>("[data-waterfall-item]")],
    item: (index: number) => {
      const el = container.querySelector<HTMLElement>(`[data-index="${index}"]`);
      if (el === null) throw new Error(`缺少第 ${index} 个瀑布流项`);
      return el;
    },
    unmount: () =>
      act(() => {
        root.unmount();
      }),
  };
}

test("一万条查询只渲染视口与过扫缓冲区内的集合项", async () => {
  stubGeometry();
  stubScrollTop();
  const harness = await setupWaterfall(Array.from({ length: 10_000 }, (_, i) => makeAsset(i)));

  const rendered = harness.items();
  expect(rendered.length).toBeGreaterThan(0);
  // 视口 800px 高、每列约 280px 宽的四列布局下，视口+过扫远到不了一百项。
  expect(rendered.length).toBeLessThanOrEqual(80);
  // 首屏从第 0 行开始。
  expect(Number.parseInt(harness.item(0).dataset.index ?? "", 10)).toBe(0);

  harness.unmount();
});

test("滚动更新可见窗口且 DOM 数量保持有界", async () => {
  stubGeometry();
  stubScrollTop();
  const harness = await setupWaterfall(Array.from({ length: 10_000 }, (_, i) => makeAsset(i)));

  // 直接把滚动位置推到深处并派发 scroll：TanStack 据此重算可见窗口。
  const scroller = harness.scroller();
  act(() => {
    scroller.scrollTop = 60_000;
    scroller.dispatchEvent(new Event("scroll"));
  });

  const rendered = harness.items();
  expect(rendered.length).toBeGreaterThan(0);
  expect(rendered.length).toBeLessThanOrEqual(80);
  // 深处滚动后首屏项不再来自第 0 行。
  const firstIndex = Number.parseInt(rendered[0]?.dataset.index ?? "0", 10);
  expect(firstIndex).toBeGreaterThan(50);

  harness.unmount();
});

test("挂载时恢复已保存的滚动偏移，滚动经回调上报", async () => {
  stubGeometry();
  stubScrollTop();
  const offsets: number[] = [];
  const harness = await setupWaterfall(
    Array.from({ length: 2_000 }, (_, i) => makeAsset(i)),
    { onScrollOffset: (offset) => offsets.push(offset) },
    5_000,
  );

  expect(harness.scroller().scrollTop).toBe(5_000);

  act(() => {
    const scroller = harness.scroller();
    scroller.scrollTop = 6_400;
    scroller.dispatchEvent(new Event("scroll"));
  });
  expect(offsets.at(-1)).toBe(6_400);

  harness.unmount();
});

test("单击选中、Ctrl 并入、Shift 范围与双击打开回调", async () => {
  stubGeometry();
  stubScrollTop();
  const opened: string[] = [];
  const harness = await setupWaterfall(
    Array.from({ length: 40 }, (_, i) => makeAsset(i)),
    { onOpenFocused: (hash) => opened.push(hash) },
  );

  act(() => harness.item(1).click());
  expect(harness.selection().selected).toEqual([makeAsset(1).hash]);

  // Ctrl+单击并入。
  act(() => {
    harness.item(3).dispatchEvent(new MouseEvent("click", { ctrlKey: true, bubbles: true }));
  });
  expect(new Set(harness.selection().selected)).toEqual(
    new Set([makeAsset(1).hash, makeAsset(3).hash]),
  );

  // Shift+单击范围：锚点是上次点击的第 3 项，扩到第 5 项。
  act(() => {
    harness.item(5).dispatchEvent(new MouseEvent("click", { shiftKey: true, bubbles: true }));
  });
  expect(harness.selection().selected).toEqual([
    makeAsset(3).hash,
    makeAsset(4).hash,
    makeAsset(5).hash,
  ]);

  // 双击请求聚焦原图。
  act(() => {
    harness.item(2).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  expect(opened).toEqual([makeAsset(2).hash]);

  harness.unmount();
});

test("方向键移动活动项并把焦点交给对应卡片", async () => {
  stubGeometry();
  stubScrollTop();
  const harness = await setupWaterfall(Array.from({ length: 40 }, (_, i) => makeAsset(i)));

  // 单击第 1 项建立活动项（原生聚焦落在该卡片上）。
  act(() => harness.item(1).click());
  expect(harness.selection().active).toBe(makeAsset(1).hash);

  // ArrowDown：活动与聚焦推进到第 2 项，焦点随之移交。
  act(() => {
    harness.scroller().dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
  });
  expect(harness.selection().active).toBe(makeAsset(2).hash);
  expect(document.activeElement?.getAttribute("data-hash")).toBe(makeAsset(2).hash);

  // Ctrl+A 全选不受视图影响。
  act(() => {
    harness.scroller().dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true }),
    );
  });
  expect(harness.selection().selected).toHaveLength(40);

  harness.unmount();
});

test("Enter 把活动项显式交给聚焦原图回调，无活动项时不动", async () => {
  stubGeometry();
  stubScrollTop();
  const opened: string[] = [];
  const harness = await setupWaterfall(Array.from({ length: 10 }, (_, i) => makeAsset(i)), {
    onOpenFocused: (hash) => opened.push(hash),
  });

  // 没有活动项时 Enter 不触发任何打开。
  act(() => {
    harness.scroller().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(opened).toEqual([]);

  // 单击建立活动项后，Enter 显式进入聚焦原图。
  act(() => harness.item(4).click());
  act(() => {
    harness.scroller().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(opened).toEqual([makeAsset(4).hash]);

  harness.unmount();
});
