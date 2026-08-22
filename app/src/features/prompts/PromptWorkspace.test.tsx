// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

import type { PromptQuery, PromptRow, PromptSnapshot } from "../../shared/types";
import { PromptWorkspace } from "./PromptWorkspace";

/** 合成一条最小 PromptRow；带图变体按序号决定关联数量，与瀑布流测试同构。 */
function makePrompt(index: number): PromptRow {
  const linked =
    index % 3 === 1 ? ["a".repeat(64), "b".repeat(64), "c".repeat(64)] : [];
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
    cover_image_hash: linked.length > 0 ? linked[0] ?? null : null,
    created_at: "2026-08-20T00:00:00Z",
    updated_at: "2026-08-21T00:00:00Z",
    deleted_at: null,
  };
}

const SNAPSHOT: PromptSnapshot = {
  prompts: Array.from({ length: 8 }, (_, i) => makePrompt(i)),
  folders: ["人像", "人像/室内"],
  tags: [{ tag: "夜景", count: 2 }],
  trash_count: 3,
};

let queries: PromptQuery[];
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
 * 几何桩：卡片按内联样式报告尺寸，其余元素（滚动视口）默认 1200×800。
 * TanStack 的窗口化在 jsdom 里完全依赖这些读数。
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

/** jsdom 的 scrollTop 恒为 0：用可写访问器模拟真实滚动位置。 */
function stubScrollTop(): void {
  let value = 0;
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get: () => value,
    set: (next: number) => {
      value = next;
    },
  });
}

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  setWindowWidth(1440);
  stubGeometry();
  stubScrollTop();
  queries = [];
  ipcCalls = [];
  vi.stubGlobal("IntersectionObserver", DormantIntersectionObserver);
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => "blob:vistash-test"),
    revokeObjectURL: vi.fn(),
  });
  mockIPC((command, payload) => {
    ipcCalls.push({ command, payload });
    if (command === "prompt_snapshot") {
      if (typeof payload !== "object" || payload === null || !("query" in payload)) {
        throw new TypeError("prompt_snapshot 缺少 query");
      }
      const query = payload.query;
      if (!isPromptQuery(query)) throw new TypeError("query 不是合法对象");
      queries.push(query);
      return query.location === "trash"
        ? { ...SNAPSHOT, prompts: [], trash_count: SNAPSHOT.trash_count }
        : SNAPSHOT;
    }
    if (
      command === "set_prompt_favorite" ||
      command === "set_prompt_folders" ||
      command === "set_prompt_tags" ||
      command === "set_prompt_note"
    ) {
      return undefined;
    }
    if (command === "update_prompt") {
      return { format_version: 2, ...makePrompt(2) };
    }
    if (command === "asset_thumbnail") return new ArrayBuffer(8);
    throw new Error(`未预期的 IPC：${command}`);
  });
});

afterEach(() => {
  clearMocks();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTop");
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

/** 兼容 textarea 的输入模拟（聚焦编辑器的正文用 textarea 承载）。 */
function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const descriptor =
    el instanceof HTMLTextAreaElement
      ? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")
      : Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  if (descriptor?.set === undefined) throw new Error("value setter 不存在");
  descriptor.set.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function buttonWithText(container: ParentNode, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (button === undefined) throw new Error(`缺少按钮：${text}`);
  return button;
}

function isPromptQuery(value: unknown): value is PromptQuery {
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

async function setupWorkspace(): Promise<{
  container: HTMLElement;
  unmount: () => Promise<void>;
}> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<PromptWorkspace refreshVersion={0} libraryId={null} />);
  });
  await flush();
  return {
    container,
    unmount: () =>
      act(async () => {
        root.unmount();
      }),
  };
}

test("工作区组合查询：搜索、文件夹、标签、收藏与回收站都进入快照请求", async () => {
  const harness = await setupWorkspace();

  // 搜索经 useDeferredValue 延迟一拍后进入查询。
  const search = harness.container.querySelector<HTMLInputElement>(
    '[aria-label="按标题或正文搜索"]',
  );
  if (search === null) throw new Error("缺少提示词搜索框");
  await act(async () => setInput(search, "人像"));
  await flush();
  await flush();
  expect(queries.at(-1)?.text).toBe("人像");

  const folder = harness.container.querySelector<HTMLButtonElement>('[data-folder="人像/室内"]');
  if (folder === null) throw new Error("缺少提示词文件夹入口");
  await act(async () => folder.click());
  await flush();
  expect(queries.at(-1)?.folder).toEqual({ kind: "path", path: "人像/室内" });

  const tag = harness.container.querySelector<HTMLButtonElement>('[aria-label="标签筛选"] button');
  if (tag === null) throw new Error("缺少标签筛选按钮");
  await act(async () => tag.click());
  await flush();
  expect(queries.at(-1)?.tags).toEqual(["夜景"]);

  const favorite = harness.container.querySelector<HTMLButtonElement>(".favorite-filter");
  if (favorite === null) throw new Error("缺少收藏筛选按钮");
  await act(async () => favorite.click());
  await flush();
  expect(queries.at(-1)?.favorite).toBe(true);

  // 回收站切换清空标签筛选并改查 trash 位置（任务 10.6 前先占住位置语义）。
  const trash = harness.container.querySelector<HTMLButtonElement>('[aria-label="回收站"]');
  if (trash === null) throw new Error("缺少回收站入口");
  await act(async () => trash.click());
  await flush();
  expect(queries.at(-1)?.location).toBe("trash");
  expect(queries.at(-1)?.tags).toEqual([]);

  await harness.unmount();
});

test("单击更新检查器、聚焦阅读替换中央区、收藏开关走独立 IPC", async () => {
  const harness = await setupWorkspace();

  // 单击只选中并把活动项交给右检查器；集合视图不被替换。
  // 选 prompt-2（无显式标题、无关联图）以便核对缺省命名。
  const card = harness.container.querySelector<HTMLButtonElement>(
    '[data-prompt-card][data-id="prompt-2"]',
  );
  if (card === null) throw new Error("缺少提示词卡片");
  await act(async () => card.click());
  expect(harness.container.querySelector("[data-prompt-card]")).not.toBeNull();
  const info = harness.container.querySelector<HTMLElement>('[data-inspector-section="info"]');
  if (info === null) throw new Error("缺少检查器信息分区");

  // 无显式标题时以正文首行命名，完整正文逐字呈现。
  expect(info.querySelector("h3")?.textContent).toContain("正文首行 2");
  const body = info.querySelector(".inspector-body-full");
  if (body === null) throw new Error("缺少完整正文呈现");
  expect(body.textContent).toBe(makePrompt(2).body);

  // 收藏开关从检查器发起，走独立的二值收藏 IPC。
  const favoriteToggle = harness.container.querySelector<HTMLButtonElement>(".favorite-toggle");
  if (favoriteToggle === null) throw new Error("缺少收藏开关");
  await act(async () => favoriteToggle.click());
  await flush();
  expect(ipcCalls).toContainEqual({
    command: "set_prompt_favorite",
    payload: { id: "prompt-2", favorite: true },
  });

  // 聚焦阅读显式进入：中央区被替换为长文视图；返回列表退出。
  await act(async () => buttonWithText(harness.container, "聚焦阅读").click());
  await flush();
  expect(harness.container.querySelector(".prompt-body-focus")).not.toBeNull();
  expect(harness.container.querySelector("[data-prompt-card]")).toBeNull();
  await act(async () => buttonWithText(harness.container, "返回列表").click());
  await flush();
  expect(harness.container.querySelector("[data-prompt-card]")).not.toBeNull();

  await harness.unmount();
});

test("切换详情列表保留选择与排序且不重新查询", async () => {
  const harness = await setupWorkspace();
  const queriesAtStart = queries.length;

  const card = harness.container.querySelector<HTMLButtonElement>("[data-prompt-card]");
  if (card === null) throw new Error("缺少提示词卡片");
  const selectedId = card.dataset.id ?? "";
  await act(async () => card.click());
  expect(card.getAttribute("aria-selected")).toBe("true");

  // 切到详情列表：同一活动项仍选中，查询没有重新发出。
  await act(async () => buttonWithText(harness.container, "详情列表").click());
  await flush();
  const row = harness.container.querySelector<HTMLElement>("[data-list-item]");
  if (row === null) throw new Error("切换后缺少详情列表行");
  expect(row.dataset.id).toBe(selectedId);
  expect(row.getAttribute("aria-selected")).toBe("true");
  expect(queries.length).toBe(queriesAtStart);

  // 排序由表头驱动且同样不重新查询（顺序变化由 promptSort 纯模块测试覆盖）。
  const sortButton = harness.container.querySelector<HTMLButtonElement>(
    ".prompt-detail-list .detail-col-updated button",
  );
  if (sortButton === null) throw new Error("缺少更新时间排序表头");
  await act(async () => sortButton.click());
  expect(queries.length).toBe(queriesAtStart);

  // 切回瀑布流：选择集合继续保留。
  await act(async () => buttonWithText(harness.container, "卡片瀑布流").click());
  await flush();
  const again = harness.container.querySelector<HTMLButtonElement>(
    `[data-prompt-card][data-id="${selectedId}"]`,
  );
  if (again === null) throw new Error("切回后缺少原提示词卡片");
  expect(again.getAttribute("aria-selected")).toBe("true");
  expect(queries.length).toBe(queriesAtStart);

  await harness.unmount();
});

test("编辑主字段进入聚焦编辑器，显式保存后刷新权威快照", async () => {
  const harness = await setupWorkspace();
  const queriesAtStart = queries.length;

  const card = harness.container.querySelector<HTMLButtonElement>(
    '[data-prompt-card][data-id="prompt-2"]',
  );
  if (card === null) throw new Error("缺少提示词卡片");
  await act(async () => card.click());

  // 检查器的编辑入口直接落在编辑状态，而不是只读聚焦阅读。
  await act(async () => buttonWithText(harness.container, "编辑主字段").click());
  await flush();
  const bodyArea = harness.container.querySelector<HTMLTextAreaElement>(
    'textarea[name="prompt-body"]',
  );
  if (bodyArea === null) throw new Error("缺少正文编辑框");
  expect(bodyArea.value).toBe(makePrompt(2).body);

  await act(async () => setInputValue(bodyArea, "显式保存的新正文"));
  await act(async () => buttonWithText(harness.container, "保存").click());
  await flush();

  expect(ipcCalls).toContainEqual({
    command: "update_prompt",
    payload: {
      id: "prompt-2",
      edit: {
        body: "显式保存的新正文",
        title: null,
        model: makePrompt(2).model,
        parameters: null,
      },
    },
  });
  // 保存成功触发权威刷新：快照查询恰好多发出一次。
  expect(queries.length).toBe(queriesAtStart + 1);
  expect(harness.container.textContent).toContain("已保存");

  await harness.unmount();
});

test("聚焦阅读退出后详情列表恢复原滚动位置", async () => {
  const harness = await setupWorkspace();

  // 先切到详情列表并滚动：偏移上报进分库布局偏好。
  await act(async () => buttonWithText(harness.container, "详情列表").click());
  await flush();
  const scroller = harness.container.querySelector<HTMLElement>(".prompt-detail-list");
  if (scroller === null) throw new Error("缺少详情列表滚动容器");
  await act(async () => {
    scroller.scrollTop = 240;
    scroller.dispatchEvent(new Event("scroll"));
  });

  // 进入聚焦阅读（集合视图卸载），再退出：重新挂载的列表按保存偏移定位。
  const row = harness.container.querySelector<HTMLButtonElement>("[data-list-item]");
  if (row === null) throw new Error("缺少详情列表行");
  await act(async () => row.click());
  await act(async () => buttonWithText(harness.container, "聚焦阅读").click());
  await flush();
  expect(harness.container.querySelector(".prompt-detail-list")).toBeNull();

  // 滚动桩的全局值在聚焦视图里归零：退出后若恢复没发生，断言会读到 0 而不是 240。
  const focusView = harness.container.querySelector<HTMLElement>(".prompt-body-focus");
  if (focusView === null) throw new Error("缺少聚焦阅读视图");
  focusView.scrollTop = 0;

  await act(async () => buttonWithText(harness.container, "返回列表").click());
  await flush();
  const restored = harness.container.querySelector<HTMLElement>(".prompt-detail-list");
  if (restored === null) throw new Error("退出聚焦阅读后缺少详情列表");
  expect(restored.scrollTop).toBe(240);

  await harness.unmount();
});
