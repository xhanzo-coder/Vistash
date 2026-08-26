// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

import type { AssetQuery, AssetRow, BatchReport, CatalogSnapshot } from "../../shared/types";
import { DEFAULT_LAYOUT } from "../workspace/libraryLayout";
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
  display_filename: "人物参考.png",
  source_path: null,
  deleted_at: null,
  color_card_status: "ok",
  color_card_algo_version: 1,
  color_card_failure_reason: null,
  color_card_sampled_pixel_count: 100,
  note: "",
  favorite: false,
  tags: ["人物"],
  folder: "参考",
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
/** 活动位置应答的覆盖：多选批量测试放入两张素材（任务 11.2）。 */
let activeSnapshotOverride: CatalogSnapshot | null;
/** 全部 batch_* 命令的统一应答；测试按需改写以驱动报告呈现。 */
let batchReply: BatchReport;
let savedLayout: unknown;
let delayedActiveSnapshot: Promise<CatalogSnapshot> | null;
let delayedLayoutRead: Promise<unknown> | null;

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
  activeSnapshotOverride = null;
  batchReply = { succeeded: 0, failures: [] };
  savedLayout = null;
  delayedActiveSnapshot = null;
  delayedLayoutRead = null;
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
      if (query.location === "active" && activeSnapshotOverride !== null) {
        return activeSnapshotOverride;
      }
      if (query.location === "active" && delayedActiveSnapshot !== null) {
        return delayedActiveSnapshot;
      }
      return query.location === "trash" ? TRASH_SNAPSHOT : SNAPSHOT;
    }
    if (command === "read_layout") return delayedLayoutRead ?? savedLayout;
    if (command === "write_layout") return undefined;
    // 多选分区的批量关联选择器自取提示词候选：工作区测试不关心候选明细。
    if (command === "prompt_snapshot") {
      return { prompts: [], folders: [], tags: [], trash_count: 0 };
    }
    // 批量组织命令（任务 11.2）：统一 BatchReport 应答，逐项失败由报告呈现。
    if (
      command === "batch_move_assets_to_folder" ||
      command === "batch_add_asset_tag" ||
      command === "batch_remove_asset_tag" ||
      command === "batch_set_asset_favorite" ||
      command === "batch_link_to_prompt" ||
      command === "batch_delete_assets"
    ) {
      return batchReply;
    }
    if (command === "asset_original") return new ArrayBuffer(8);
    if (command === "image_detail") {
      return { asset: {}, linked_prompts: [] };
    }
    if (command === "set_asset_tags" || command === "delete_asset") return undefined;
    if (command === "set_asset_note" || command === "set_asset_favorite") return undefined;
    if (command === "restore_asset") return { missing_folders: ["已删除的文件夹"] };
    if (command === "purge_trash") {
      purgeCalls += 1;
      return {
        purged: 1,
        failures: [
          {
            hash: "f".repeat(64),
            original_filename: "滞留文件.png",
            error: { code: "library.asset_metadata_write_failed", detail: "文件被占用" },
          },
        ],
      };
    }
    throw new Error(`未预期的 IPC：${command}`);
  });
});

afterEach(() => {
  clearMocks();
  vi.useRealTimers();
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
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

  // 收藏筛选（任务 9.4）：开启后查询只取 favorite=true 的正常图片。
  const favorite = container.querySelector<HTMLButtonElement>(".favorite-filter");
  if (favorite === null) throw new Error("缺少收藏筛选按钮");
  expect(favorite.getAttribute("aria-pressed")).toBe("false");
  await act(async () => favorite.click());
  await flush();
  expect(queries.at(-1)?.favorite).toBe(true);
  expect(favorite.getAttribute("aria-pressed")).toBe("true");

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

test("清空回收站后呈现逐项结果，失败项带文件名与错误码", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<AssetWorkspace refreshVersion={0} libraryId={null} />);
  });
  await flush();

  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="回收站"]')?.click(),
  );
  await flush();

  const purge = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "清空回收站",
  );
  if (purge === undefined) throw new Error("缺少清空回收站按钮");
  await act(async () => purge.click());
  const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
  if (dialog === null) throw new Error("缺少二次确认对话框");
  await act(async () => buttonWithText(dialog, "永久删除").click());
  await flush();

  // 逐项结果：成功计数与失败项（文件名 + 稳定错误码）并存，不以部分成功冒充全部成功。
  const status = container.querySelector<HTMLElement>(".operation-status");
  if (status === null) throw new Error("缺少逐项结果区");
  expect(status.textContent).toContain("已永久删除 1 个");
  expect(status.textContent).toContain("失败 1 个");
  expect(status.textContent).toContain("滞留文件.png");
  const failure = status.querySelector<HTMLElement>(
    '[data-error-code="library.asset_metadata_write_failed"]',
  );
  if (failure === null) throw new Error("缺少失败项错误码");

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

test("Ctrl+F 聚焦本库文件名搜索框", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<AssetWorkspace refreshVersion={0} libraryId={null} />);
  });
  await flush();

  // 无条件时不渲染条件芯片；Ctrl+F 把焦点送进本库搜索框并全选既有内容。
  expect(container.querySelector('[aria-label="已应用的搜索条件"]')).toBeNull();
  const search = container.querySelector<HTMLInputElement>('[aria-label="按文件名搜索"]');
  if (search === null) throw new Error("缺少文件名搜索框");
  await act(async () => setInput(search, "人物"));
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }),
    );
  });
  expect(document.activeElement).toBe(search);
  expect(search.selectionStart).toBe(0);
  expect(search.selectionEnd).toBe(search.value.length);

  await act(async () => root.unmount());
});

test("全局定位：查询重置到回收站并选中目标素材，nonce 防重复消费", async () => {
  const request = { section: "assets" as const, id: ASSET.hash, inTrash: true, nonce: 1 };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (locate: typeof request | null) => {
    root.render(<AssetWorkspace refreshVersion={0} libraryId={null} locate={locate} />);
  };
  await act(async () => {
    render(request);
  });
  await flush();

  // 回收站归属驱动位置切换，其余条件回到默认。
  expect(queries.at(-1)?.location).toBe("trash");
  expect(queries.at(-1)?.text).toBe("");
  // 目标素材经统一选择模型进入检查器信息分区。
  const info = container.querySelector<HTMLElement>('[data-inspector-section="info"]');
  if (info === null) throw new Error("缺少检查器信息分区");
  expect(info.textContent).toContain("人物参考.png");

  const before = queries.length;
  await act(async () => {
    render({ ...request });
  });
  await flush();
  expect(queries.length).toBe(before);

  await act(async () => root.unmount());
});

test("已应用条件呈现为可移除芯片：移除文件夹保留其余条件", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<AssetWorkspace refreshVersion={0} libraryId={null} />);
  });
  await flush();

  const folder = container.querySelector<HTMLButtonElement>('[data-folder="参考"]');
  if (folder === null) throw new Error("缺少参考文件夹");
  await act(async () => folder.click());
  await flush();
  const favorite = container.querySelector<HTMLButtonElement>(".favorite-filter");
  if (favorite === null) throw new Error("缺少收藏筛选按钮");
  await act(async () => favorite.click());
  await flush();

  const chips = container.querySelector<HTMLElement>('[aria-label="已应用的搜索条件"]');
  if (chips === null) throw new Error("缺少已应用条件区");
  expect(chips.textContent).toContain("文件夹：参考");
  expect(chips.textContent).toContain("只看收藏");

  const removeFolder = chips.querySelector<HTMLButtonElement>('[aria-label="移除文件夹条件 参考"]');
  if (removeFolder === null) throw new Error("缺少文件夹条件移除按钮");
  await act(async () => removeFolder.click());
  await flush();
  await flush();
  expect(queries.at(-1)?.folder).toEqual({ kind: "all" });
  expect(queries.at(-1)?.favorite).toBe(true);
  expect(container.querySelectorAll(".filter-chip").length).toBe(1);

  await act(async () => root.unmount());
});

test("多选呈现批量工具条与检查器批量分区，批量移动文件夹走后端批量命令", async () => {
  const second: AssetRow = {
    ...ASSET,
    hash: "c".repeat(64),
    original_filename: "另一张.png",
  };
  activeSnapshotOverride = { ...SNAPSHOT, assets: [ASSET, second] };
  batchReply = { succeeded: 2, failures: [] };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<AssetWorkspace refreshVersion={0} libraryId={null} />);
  });
  await flush();

  // Ctrl+单击并入选择：工具条计数出现，检查器切换为多选批量分区。
  const cards = container.querySelectorAll<HTMLButtonElement>("[data-waterfall-item]");
  const firstCard = cards[0];
  const secondCard = cards[1];
  if (
    firstCard === undefined ||
    secondCard === undefined ||
    firstCard.dataset.hash === undefined
  ) {
    throw new Error("缺少两张素材卡片");
  }
  await act(async () => firstCard.click());
  await act(async () => {
    secondCard.dispatchEvent(new MouseEvent("click", { ctrlKey: true, bubbles: true }));
  });
  const toolbar = container.querySelector<HTMLElement>(".batch-toolbar");
  if (toolbar === null) throw new Error("缺少批量工具条");
  expect(toolbar.textContent).toContain(`已选 2 / 共 ${SNAPSHOT.assets.length + 1} 项`);
  const batchSection = container.querySelector<HTMLElement>(
    '[data-inspector-section="batch"]',
  );
  if (batchSection === null) throw new Error("缺少检查器批量分区");
  expect(container.querySelector('[data-inspector-section="info"]')).toBeNull();

  // 批量移动文件夹：单归属下点选目标即整体移动，意图经检查器上报，
  // 写入走统一的后端批量命令并回显报告。
  const moveTarget = batchSection.querySelector<HTMLInputElement>(
    '[aria-label="批量移动到文件夹 参考/构图"]',
  );
  if (moveTarget === null) throw new Error("缺少批量移动文件夹单选钮");
  await act(async () => moveTarget.click());
  await flush();

  const call = ipcCalls.find((entry) => entry.command === "batch_move_assets_to_folder");
  expect(call?.payload).toEqual(
    expect.objectContaining({
      hashes: [ASSET.hash, second.hash],
      folder: "参考/构图",
    }),
  );
  const status = container.querySelector<HTMLElement>(".operation-status");
  if (status === null) throw new Error("缺少批量报告区");
  expect(status.textContent).toContain("批量完成：成功 2 项");

  await act(async () => root.unmount());
});

test("批量移入回收站经二次确认，报告逐项呈现失败与稳定错误码", async () => {
  const second: AssetRow = {
    ...ASSET,
    hash: "c".repeat(64),
    original_filename: "另一张.png",
  };
  activeSnapshotOverride = { ...SNAPSHOT, assets: [ASSET, second] };
  batchReply = {
    succeeded: 1,
    failures: [
      {
        id: second.hash,
        display_name: "另一张.png",
        error: { code: "library.asset_metadata_write_failed", detail: "文件被占用" },
      },
    ],
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<AssetWorkspace refreshVersion={0} libraryId={null} />);
  });
  await flush();

  const cards = container.querySelectorAll<HTMLButtonElement>("[data-waterfall-item]");
  const firstCard = cards[0];
  const secondCard = cards[1];
  if (firstCard === undefined || secondCard === undefined) {
    throw new Error("缺少两张素材卡片");
  }
  await act(async () => firstCard.click());
  await act(async () => {
    secondCard.dispatchEvent(new MouseEvent("click", { ctrlKey: true, bubbles: true }));
  });

  // 危险区入口先经工作区的二次确认对话框。
  const dangerButton = container.querySelector<HTMLButtonElement>(
    '[data-inspector-section="batch-danger"] button',
  );
  if (dangerButton === null) throw new Error("缺少批量移入回收站按钮");
  await act(async () => dangerButton.click());
  const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
  if (dialog === null) throw new Error("缺少二次确认对话框");
  expect(dialog.textContent).toContain("选中的 2 张图片");

  const confirmDelete = [...dialog.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === "移入回收站",
  );
  if (confirmDelete === undefined) throw new Error("缺少对话框确认按钮");
  await act(async () => confirmDelete.click());
  await flush();

  expect(ipcCalls.some((entry) => entry.command === "batch_delete_assets")).toBe(true);
  const call = ipcCalls.find((entry) => entry.command === "batch_delete_assets");
  expect(call?.payload).toEqual(
    expect.objectContaining({ hashes: [ASSET.hash, second.hash] }),
  );

  // 部分失败不以全部成功冒充：失败项带文件名与稳定错误码（设计第六条）。
  const status = container.querySelector<HTMLElement>(".operation-status");
  if (status === null) throw new Error("缺少批量报告区");
  expect(status.textContent).toContain("成功 1 项");
  expect(status.textContent).toContain("失败 1 项");
  expect(status.textContent).toContain("另一张.png");
  expect(
    status.querySelector('[data-error-code="library.asset_metadata_write_failed"]'),
  ).not.toBeNull();

  await act(async () => root.unmount());
});

test("宽屏图片工作台恢复自身栏位折叠状态并允许分别展开", async () => {
  savedLayout = {
    assets: {
      ...DEFAULT_LAYOUT,
      railCollapsed: true,
      inspectorCollapsed: true,
    },
    prompts: DEFAULT_LAYOUT,
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <AssetWorkspace
        refreshVersion={0}
        libraryId="018f3c9e-6c00-7000-8000-00000000000e"
      />,
    );
  });
  await flush();

  expect(container.querySelector(".catalog-rail")).toBeNull();
  expect(container.querySelector(".inspector-rail")).toBeNull();
  await act(async () => buttonWithText(container, "展开分类栏").click());
  await act(async () => buttonWithText(container, "展开检查器").click());
  expect(container.querySelector(".catalog-rail")).not.toBeNull();
  expect(container.querySelector(".inspector-rail")).not.toBeNull();
  await act(async () => root.unmount());
});

test("冷启动布局读取完成前阻止工作台交互", async () => {
  savedLayout = {
    assets: { ...DEFAULT_LAYOUT, view: "list" },
    prompts: { ...DEFAULT_LAYOUT, tags: ["提示词偏好"] },
  };
  const delayed = deferred<unknown>();
  delayedLayoutRead = delayed.promise;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <AssetWorkspace
        refreshVersion={0}
        libraryId="018f3c9e-6c00-7000-8000-00000000000f"
      />,
    );
  });

  expect(container.textContent).toContain("正在恢复工作台布局…");
  expect(container.querySelector('[aria-label="集合视图"]')).toBeNull();

  await act(async () => delayed.resolve(savedLayout));
  await flush();
  expect(buttonWithText(container, "详情列表").getAttribute("aria-pressed")).toBe("true");
  await act(async () => root.unmount());
});

test("冷启动布局读取期间延迟全局定位且消费后确认 nonce", async () => {
  vi.useFakeTimers();
  savedLayout = {
    assets: { ...DEFAULT_LAYOUT, view: "list", tags: ["图片偏好"] },
    prompts: { ...DEFAULT_LAYOUT, tags: ["提示词偏好"] },
  };
  const delayed = deferred<unknown>();
  delayedLayoutRead = delayed.promise;
  const handled: number[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <AssetWorkspace
        refreshVersion={0}
        libraryId="018f3c9e-6c00-7000-8000-000000000010"
        locate={{ section: "assets", id: ASSET.hash, inTrash: true, nonce: 7 }}
        onLocateHandled={(nonce) => handled.push(nonce)}
      />,
    );
  });
  await act(async () => vi.advanceTimersByTime(300));
  expect(ipcCalls.some((call) => call.command === "write_layout")).toBe(false);
  expect(handled).toEqual([]);

  await act(async () => {
    delayed.resolve(savedLayout);
    await Promise.resolve();
  });
  expect(handled).toEqual([7]);
  await act(async () => root.unmount());
});

test("迟到的正常库刷新不得覆盖已经切换到的回收站快照", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<AssetWorkspace refreshVersion={0} libraryId={null} />);
  });
  await flush();

  const delayed = deferred<CatalogSnapshot>();
  delayedActiveSnapshot = delayed.promise;

  const card = container.querySelector<HTMLButtonElement>("[data-waterfall-item]");
  if (card === null) throw new Error("缺少正常库素材卡片");
  await act(async () => card.click());
  await act(async () => buttonWithText(container, "移入回收站").click());
  const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
  if (dialog === null) throw new Error("缺少删除确认对话框");
  await act(async () => buttonWithText(dialog, "移入回收站").click());

  const trash = container.querySelector<HTMLButtonElement>('button[aria-label="回收站"]');
  if (trash === null) throw new Error("缺少回收站入口");
  await act(async () => trash.click());
  await flush();
  expect(container.querySelector(".result-count")?.textContent).toBe("1 项");

  const staleActive: CatalogSnapshot = {
    ...SNAPSHOT,
    assets: [ASSET, { ...ASSET, hash: "b".repeat(64), original_filename: "迟到.png" }],
  };
  await act(async () => delayed.resolve(staleActive));
  await flush();

  expect(container.querySelector(".query-bar h2")?.textContent).toBe("回收站");
  expect(container.querySelector(".result-count")?.textContent).toBe("1 项");
  await act(async () => root.unmount());
});
