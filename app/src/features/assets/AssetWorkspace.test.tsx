// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

import type { AssetQuery, AssetRow, CatalogSnapshot } from "../../shared/types";
import { AssetWorkspace } from "./AssetWorkspace";

const ASSET: AssetRow = {
  hash: "a".repeat(64),
  hash_algo: "sha256",
  media_type: "png",
  ext: "png",
  byte_size: 68,
  width: 640,
  height: 960,
  imported_at: "2026-08-19T00:00:00Z",
  original_filename: "人物参考.png",
  source_path: null,
  deleted_at: null,
  color_card_status: "ok",
  color_card_algo_version: 1,
  color_card_failure_reason: null,
  color_card_sampled_pixel_count: 100,
  note: "",
  favorite: false,
  tags: ["人物"],
  folders: ["参考"],
  colors: [],
};

const SNAPSHOT: CatalogSnapshot = {
  assets: [ASSET],
  folders: ["参考", "参考/构图"],
  tags: [{ tag: "人物", count: 1 }],
  trash_count: 2,
};

const TRASHED_ASSET: AssetRow = {
  ...ASSET,
  deleted_at: "2026-08-19T01:00:00Z",
};

const TRASH_SNAPSHOT: CatalogSnapshot = {
  assets: [TRASHED_ASSET],
  folders: SNAPSHOT.folders,
  tags: SNAPSHOT.tags,
  trash_count: 1,
};

let queries: AssetQuery[];
let purgeCalls: number;
let ipcCalls: Array<{ command: string; payload: unknown }>;

class DormantIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = "0px";
  readonly scrollMargin = "0px";
  readonly thresholds = [0];

  disconnect(): void {}
  observe(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  unobserve(): void {}
}

/** jsdom 不做布局，窗口层级由显式设定的视口宽度决定（任务 8.6）。 */
function setWindowWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
}

/**
 * 几何桩：瀑布流卡片按内联样式报告尺寸，其余元素（滚动视口）默认 1200×800。
 * TanStack 的窗口化在 jsdom 里完全依赖这些读数，否则视口高度为 0、什么都不渲染。
 */
function stubGeometry(): void {
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

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  // 既有测试面向宽屏三栏行为：左栏原位展开。
  setWindowWidth(1440);
  stubGeometry();
  queries = [];
  purgeCalls = 0;
  ipcCalls = [];
  vi.stubGlobal("IntersectionObserver", DormantIntersectionObserver);
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => "blob:vistash-test"),
    revokeObjectURL: vi.fn(),
  });
  mockIPC((command, payload) => {
    ipcCalls.push({ command, payload });
    if (command === "catalog_snapshot") {
      if (typeof payload !== "object" || payload === null || !("query" in payload)) {
        throw new TypeError("catalog_snapshot 缺少 query");
      }
      const query = payload.query;
      if (!isAssetQuery(query)) {
        throw new TypeError("query 不是对象");
      }
      queries.push(query);
      return query.location === "trash" ? TRASH_SNAPSHOT : SNAPSHOT;
    }
    if (command === "asset_original") return new ArrayBuffer(8);
    if (command === "set_asset_tags" || command === "delete_asset") return undefined;
    if (command === "restore_asset") return { missing_folders: ["已删除的文件夹"] };
    if (command === "purge_trash") {
      purgeCalls += 1;
      return { purged: 1, failures: [] };
    }
    throw new Error(`未预期的 IPC：${command}`);
  });
});

afterEach(() => {
  clearMocks();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setWindowWidth(1024);
  document.body.replaceChildren();
});

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function setInput(input: HTMLInputElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  if (descriptor?.set === undefined) throw new Error("HTMLInputElement.value setter 不存在");
  descriptor.set.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function buttonWithText(container: ParentNode, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (button === undefined) throw new Error(`缺少按钮：${text}`);
  return button;
}

function isAssetQuery(value: unknown): value is AssetQuery {
  if (typeof value !== "object" || value === null) return false;
  if (!("text" in value) || typeof value.text !== "string") return false;
  if (!("location" in value) || (value.location !== "active" && value.location !== "trash")) {
    return false;
  }
  if (!("tags" in value) || !Array.isArray(value.tags)) return false;
  if (!value.tags.every((tag) => typeof tag === "string")) return false;
  if (!("folder" in value) || typeof value.folder !== "object" || value.folder === null) {
    return false;
  }
  if (!("kind" in value.folder)) return false;
  if (value.folder.kind === "all" || value.folder.kind === "root") return true;
  return (
    value.folder.kind === "path" &&
    "path" in value.folder &&
    typeof value.folder.path === "string"
  );
}

test("工作区组合查询并在清空回收站前二次确认", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<AssetWorkspace refreshVersion={0} libraryId={null} />);
  });
  await flush();

  const search = container.querySelector<HTMLInputElement>('[aria-label="按文件名搜索"]');
  if (search === null) throw new Error("缺少文件名搜索框");
  await act(async () => {
    setInput(search, "人物");
  });
  await flush();
  await flush();
  expect(queries.at(-1)?.text).toBe("人物");

  const folder = container.querySelector<HTMLButtonElement>('[data-folder="参考"]');
  if (folder === null) throw new Error("缺少参考文件夹");
  await act(async () => folder.click());
  await flush();
  expect(queries.at(-1)?.folder).toEqual({ kind: "path", path: "参考" });

  const tag = container.querySelector<HTMLButtonElement>('[aria-label="标签筛选"] button');
  if (tag === null) throw new Error("缺少标签筛选按钮");
  await act(async () => tag.click());
  await flush();
  expect(queries.at(-1)?.tags).toEqual(["人物"]);

  const trash = container.querySelector<HTMLButtonElement>('[aria-label="回收站"]');
  if (trash === null) throw new Error("缺少回收站入口");
  await act(async () => trash.click());
  await flush();
  expect(queries.at(-1)?.tags).toEqual([]);
  const purge = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "清空回收站",
  );
  if (purge === undefined) throw new Error("缺少清空回收站按钮");
  await act(async () => purge.click());

  const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
  if (dialog === null) throw new Error("缺少二次确认对话框");
  expect(dialog.textContent).toContain("永久删除 1 个素材");
  expect(document.activeElement?.textContent).toBe("取消");
  expect(purgeCalls).toBe(0);

  await act(async () => buttonWithText(dialog, "取消").click());
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(purgeCalls).toBe(0);

  await act(async () => purge.click());
  const confirmDialog = container.querySelector<HTMLElement>('[role="dialog"]');
  if (confirmDialog === null) throw new Error("缺少再次打开的二次确认对话框");
  await act(async () => buttonWithText(confirmDialog, "永久删除").click());
  await flush();
  expect(purgeCalls).toBe(1);

  await act(async () => {
    root.unmount();
  });
});

test("单击只更新检查器、双击进入聚焦原图、组织编辑在检查器完成", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<AssetWorkspace refreshVersion={0} libraryId={null} />);
  });
  await flush();

  // 单击只选中并把活动项交给右检查器，瀑布流不被替换（规格场景）。
  const assetButton = container.querySelector<HTMLButtonElement>("[data-waterfall-item]");
  if (assetButton === null) throw new Error("缺少素材卡片");
  await act(async () => assetButton.click());
  expect(container.querySelector(".asset-details")).toBeNull();
  expect(container.querySelector("[data-waterfall-item]")).not.toBeNull();
  const info = container.querySelector<HTMLElement>('[data-inspector-section="info"]');
  if (info === null) throw new Error("缺少检查器信息分区");
  expect(info.textContent).toContain(ASSET.original_filename);
  await flush();

  // 组织编辑直接发生在检查器里，不打断集合视图。
  const tagInput = container.querySelector<HTMLInputElement>("#new-tag");
  if (tagInput === null) throw new Error("缺少标签输入框");
  await act(async () => {
    setInput(tagInput, "夜景");
    buttonWithText(container, "添加").click();
  });
  await flush();
  expect(ipcCalls).toContainEqual({
    command: "set_asset_tags",
    payload: { hash: ASSET.hash, tags: ["人物", "夜景"] },
  });

  // 双击显式进入聚焦原图，中央区被替换；退出后回到集合视图。
  await act(async () =>
    assetButton.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
  );
  await flush();
  expect(container.querySelector(".asset-preview")).not.toBeNull();
  expect(container.querySelector("[data-waterfall-item]")).toBeNull();
  await act(async () => buttonWithText(container, "退出聚焦").click());
  await flush();
  expect(container.querySelector("[data-waterfall-item]")).not.toBeNull();

  // 删除动作同样来自检查器，仍需二次确认。
  await act(async () => buttonWithText(container, "移入回收站").click());
  const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
  if (dialog === null) throw new Error("缺少删除确认对话框");
  expect(dialog.textContent).toContain("可从回收站还原");
  await act(async () => buttonWithText(dialog, "移入回收站").click());
  await flush();
  expect(ipcCalls).toContainEqual({ command: "delete_asset", payload: { hash: ASSET.hash } });

  await act(async () => root.unmount());
});

test("切换详情列表保留查询、选择集合与排序共享", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<AssetWorkspace refreshVersion={0} libraryId={null} />);
  });
  await flush();
  const queriesAtStart = queries.length;

  // 瀑布流里单击选中第一项。
  const item = container.querySelector<HTMLButtonElement>("[data-waterfall-item]");
  if (item === null) throw new Error("缺少瀑布流项");
  const selectedHash = item.dataset.hash ?? "";
  await act(async () => item.click());
  expect(item.getAttribute("aria-selected")).toBe("true");

  // 切到详情列表：同一素材仍处于选中集合，且查询没有重新发出。
  await act(async () => buttonWithText(container, "详情列表").click());
  await flush();
  const row = container.querySelector<HTMLElement>("[data-list-item]");
  if (row === null) throw new Error("切换后缺少详情列表行");
  expect(row.dataset.hash).toBe(selectedHash);
  expect(row.getAttribute("aria-selected")).toBe("true");
  expect(container.querySelector('[role="columnheader"]')).not.toBeNull();
  expect(queries.length).toBe(queriesAtStart);

  // 排序由表头驱动且同样不重新查询（顺序变化由 assetSort 纯模块的测试覆盖）。
  await act(async () =>
    row.closest(".asset-detail-list")
      ?.querySelector<HTMLButtonElement>(".detail-col-dimensions button")
      ?.click(),
  );
  expect(queries.length).toBe(queriesAtStart);

  // 切回瀑布流：选择集合继续保留。
  await act(async () => buttonWithText(container, "瀑布流").click());
  await flush();
  const again = container.querySelector<HTMLButtonElement>(
    `[data-waterfall-item][data-hash="${selectedHash}"]`,
  );
  if (again === null) throw new Error("切回后缺少原瀑布流项");
  expect(again.getAttribute("aria-selected")).toBe("true");
  expect(queries.length).toBe(queriesAtStart);

  await act(async () => {
    root.unmount();
  });
});

test("从回收站还原并保留缺失文件夹警告", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<AssetWorkspace refreshVersion={0} libraryId={null} />);
  });
  await flush();

  const trash = container.querySelector<HTMLButtonElement>('[aria-label="回收站"]');
  if (trash === null) throw new Error("缺少回收站入口");
  await act(async () => trash.click());
  await flush();
  // 回收站里单击即可在检查器看到还原入口（任务 9.3 后不再有整页详情）。
  const assetButton = container.querySelector<HTMLButtonElement>("[data-waterfall-item]");
  if (assetButton === null) throw new Error("缺少回收站素材卡片");
  await act(async () => assetButton.click());
  await flush();
  await act(async () => buttonWithText(container, "还原素材").click());
  await flush();

  expect(ipcCalls).toContainEqual({ command: "restore_asset", payload: { hash: ASSET.hash } });
  const warning = container.querySelector<HTMLElement>(
    '[data-error-code="trash.restore_target_folder_missing"]',
  );
  if (warning === null) throw new Error("缺少还原缺失文件夹警告");
  expect(warning.textContent).toContain("已删除的文件夹");

  await act(async () => root.unmount());
});

test("中等窗口左栏收起为抽屉，边缘入口打开且 Esc 关闭", async () => {
  // 跨过 1080 断点：左栏默认收起，栅格让出整行。
  setWindowWidth(1000);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<AssetWorkspace refreshVersion={0} libraryId={null} />);
  });
  await flush();

  // 收起状态下栏内容不在文档里，但边缘入口可见且声明它控制的面板。
  expect(document.querySelector(".catalog-rail")).toBeNull();
  const toggle = container.querySelector<HTMLButtonElement>(".rail-toggle");
  if (toggle === null) throw new Error("缺少分类边缘入口");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(toggle.getAttribute("aria-controls")).toBe("catalog-rail-panel");

  // 打开：栏内容出现在对话框面板中。
  await act(async () => toggle.click());
  const panel = document.querySelector<HTMLElement>("#catalog-rail-panel");
  if (panel === null) throw new Error("缺少抽屉面板");
  expect(panel.getAttribute("role")).toBe("dialog");
  expect(panel.querySelector(".catalog-rail")).not.toBeNull();
  expect(toggle.getAttribute("aria-expanded")).toBe("true");

  // Esc 关闭：面板与栏内容一并移除。
  await act(async () => {
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(document.querySelector("#catalog-rail-panel")).toBeNull();
  expect(document.querySelector(".catalog-rail")).toBeNull();

  await act(async () => root.unmount());
});

test("中等窗口右检查器收起为抽屉并经边缘入口打开", async () => {
  setWindowWidth(1000);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<AssetWorkspace refreshVersion={0} libraryId={null} />);
  });
  await flush();

  // 收起状态下检查器不在文档里，边缘入口声明它控制的面板。
  expect(container.querySelector(".inspector-rail")).toBeNull();
  const toggle = [...container.querySelectorAll<HTMLButtonElement>(".rail-toggle")].find(
    (candidate) => candidate.getAttribute("aria-controls") === "asset-inspector-panel",
  );
  if (toggle === undefined) throw new Error("缺少检查器边缘入口");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");

  await act(async () => toggle.click());
  const panel = document.querySelector<HTMLElement>("#asset-inspector-panel");
  if (panel === null) throw new Error("缺少检查器抽屉面板");
  expect(panel.getAttribute("role")).toBe("dialog");
  // 尚无活动项：检查器呈现操作引导占位。
  expect(panel.querySelector(".inspector-placeholder")).not.toBeNull();

  await act(async () => {
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(document.querySelector("#asset-inspector-panel")).toBeNull();

  await act(async () => root.unmount());
});
