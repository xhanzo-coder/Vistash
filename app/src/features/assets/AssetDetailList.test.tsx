// @vitest-environment jsdom

import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { SelectionProvider, useSelection } from "../workspace/selectionContext";
import type { AssetRow } from "../../shared/types";
import { AssetDetailList } from "./AssetDetailList";
import type { AssetSort } from "./assetSort";

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

/** 合成一条最小 AssetRow；可选覆盖信息列取值。 */
function makeAsset(index: number, overrides: Partial<AssetRow> = {}): AssetRow {
  return {
    hash: `${index}`.padStart(64, "0"),
    hash_algo: "sha256",
    media_type: "png",
    ext: "png",
    byte_size: 68,
    width: 1600,
    height: 900,
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
    ...overrides,
  };
}

/**
 * 几何桩：行按内联样式报告尺寸，其余元素（视口）默认 1200×800。
 * 行高固定，因此窗口化只依赖视口高度读数。
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
  assets: readonly AssetRow[],
  options: {
    sort?: AssetSort;
    onSortChange?: (column: AssetSort["column"]) => void;
    onOpenFocused?: (hash: string) => void;
    savedOffset?: number;
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
      <SelectionProvider ids={assets.map((asset) => asset.hash)}>
        <Probe />
        <AssetDetailList
          assets={assets}
          scrollKey="assets-list"
          savedOffset={options.savedOffset ?? 0}
          sort={options.sort ?? { column: "importedAt", direction: "desc" }}
          onSortChange={
            options.onSortChange ?? (() => {})
          }
          onOpenFocused={options.onOpenFocused ?? (() => {})}
          onScrollOffset={() => {}}
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
      const el = container.querySelector<HTMLElement>(".asset-detail-list");
      if (el === null) throw new Error("缺少详情列表滚动容器");
      return el;
    },
    headers: () => [...container.querySelectorAll<HTMLElement>('[role="columnheader"]')],
    sortableHeader: (label: string) => {
      const cell = [...container.querySelectorAll<HTMLElement>('[role="columnheader"]')].find(
        (candidate) => candidate.textContent?.includes(label),
      );
      if (cell === undefined) throw new Error(`缺少信息列：${label}`);
      return cell;
    },
    rows: () => [...container.querySelectorAll<HTMLElement>("[data-list-item]")],
    row: (index: number) => {
      const el = container.querySelector<HTMLElement>(`[data-index="${index}"]`);
      if (el === null) throw new Error(`缺少第 ${index} 个列表行`);
      return el;
    },
    unmount: () =>
      act(() => {
        root.unmount();
      }),
  };
}

test("一万条查询只渲染视口与过扫缓冲区内的行", async () => {
  stubGeometry();
  stubScrollTop();
  const harness = await setupList(Array.from({ length: 10_000 }, (_, i) => makeAsset(i)));

  const rendered = harness.rows();
  expect(rendered.length).toBeGreaterThan(0);
  // 视口 800px 高、固定行高下，视口+过扫远到不了一百行。
  expect(rendered.length).toBeLessThanOrEqual(80);

  harness.unmount();
});

test("八个信息列齐备，可排序列经回调报告且 aria-sort 随排序值渲染", async () => {
  stubGeometry();
  stubScrollTop();
  const requested: string[] = [];
  const harness = await setupList([makeAsset(0)], {
    sort: { column: "filename", direction: "asc" },
    onSortChange: (column) => requested.push(column),
  });

  // 规格：缩略图、文件名、图片文件夹、标签、尺寸、格式、导入时间、备注摘要。
  // 方向箭头是 aria-hidden 装饰，比较时剥掉。
  expect(
    harness.headers().map((cell) => cell.textContent?.replace(/\s*[↑↓]$/, "") ?? ""),
  ).toEqual([
    "缩略图",
    "文件名",
    "文件夹",
    "标签",
    "尺寸",
    "格式",
    "导入时间",
    "备注",
  ]);

  const nameHeader = harness.sortableHeader("文件名");
  expect(nameHeader.getAttribute("aria-sort")).toBe("ascending");
  expect(harness.sortableHeader("尺寸").getAttribute("aria-sort")).toBeNull();

  const sortButton = nameHeader.querySelector("button");
  if (sortButton === null) throw new Error("文件名列缺少排序按钮");
  await act(async () => sortButton.click());
  expect(requested).toEqual(["filename"]);

  // 尺寸列同样可排序。
  await act(async () =>
    harness.sortableHeader("尺寸").querySelector("button")?.click(),
  );
  expect(requested).toEqual(["filename", "dimensions"]);

  harness.unmount();
});

test("多值列与备注摘要按规格取值呈现", async () => {
  stubGeometry();
  stubScrollTop();
  const asset = makeAsset(0, {
    original_filename: "人物参考.png",
    width: 1920,
    height: 1080,
    media_type: "jpg",
    imported_at: "2026-08-21T08:30:00Z",
    tags: ["人物", "夜景"],
    folders: ["参考", "参考/构图"],
    note: "第一行说明\n第二行补充",
  });
  const harness = await setupList([asset]);

  const row = harness.row(0);
  const cells = [...row.querySelectorAll<HTMLElement>(".detail-value")];
  expect(cells.map((cell) => cell.textContent)).toEqual([
    "人物参考.png",
    "参考、参考/构图",
    "人物、夜景",
    "1920 × 1080",
    "jpg",
    "2026-08-21",
    "第一行说明",
  ]);

  harness.unmount();
});

test("单击选中、Ctrl 并入、Shift 范围与双击打开回调", async () => {
  stubGeometry();
  stubScrollTop();
  const opened: string[] = [];
  const harness = await setupList(Array.from({ length: 40 }, (_, i) => makeAsset(i)), {
    onOpenFocused: (hash) => opened.push(hash),
  });

  await act(async () => harness.row(1).click());
  expect(harness.selection().selected).toEqual([makeAsset(1).hash]);

  await act(async () => {
    harness.row(3).dispatchEvent(new MouseEvent("click", { ctrlKey: true, bubbles: true }));
  });
  expect(new Set(harness.selection().selected)).toEqual(
    new Set([makeAsset(1).hash, makeAsset(3).hash]),
  );

  await act(async () => {
    harness.row(5).dispatchEvent(new MouseEvent("click", { shiftKey: true, bubbles: true }));
  });
  expect(harness.selection().selected).toEqual([
    makeAsset(3).hash,
    makeAsset(4).hash,
    makeAsset(5).hash,
  ]);

  await act(async () => {
    harness.row(2).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
  expect(opened).toEqual([makeAsset(2).hash]);

  // Enter 把活动项显式交给聚焦原图回调。jsdom 的 dblclick 不派发前置 click，
  // 活动项仍是上一次 Shift 单击的目标（rangeTo 把活动项移到范围终点）。
  await act(async () => {
    harness
      .scroller()
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(opened).toEqual([makeAsset(2).hash, makeAsset(5).hash]);

  harness.unmount();
});
