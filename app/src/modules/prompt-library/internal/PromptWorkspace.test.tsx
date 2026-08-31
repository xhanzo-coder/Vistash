// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

import type { GlobalLocateRequest } from "../../../features/workspace/locate";
import type {
  AssetRow,
  BatchReport,
  CatalogSnapshot,
  LinkedImageState,
  PromptQuery,
  PromptRow,
  PromptSnapshot,
} from "../../../shared/types";
import { PromptLibraryWorkspace, blockIfPromptDraftDirty, type PromptLibraryEntry } from "../index";
import { parseLibraryId, type LibraryId } from "../../../app/common";
import { DEFAULT_LAYOUT } from "../../../features/workspace/libraryLayout";
import { UiProvider } from "../../../ui/UiProvider";
import { createWorkspaceNavigation } from "../../../app/navigation";
import { createImagePromptRelations, createTauriImagePromptRelationAdapter } from "../../image-prompt-relations";

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
    resolved_cover_hash: linked.length > 0 ? linked[0] ?? null : null,
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

const LIB_TEST = parseLibraryId("018f3c9e-6c00-7000-8000-0000000000f0");
const LIB_A = parseLibraryId("018f3c9e-6c00-7000-8000-0000000000fa");
const LIB_B = parseLibraryId("018f3c9e-6c00-7000-8000-0000000000fb");

function libraryIdOf(value: string | null): LibraryId {
  if (value === null) return LIB_TEST;
  if (value === "library-a") return LIB_A;
  if (value === "library-b") return LIB_B;
  return parseLibraryId(value);
}

let queries: PromptQuery[];
let ipcCalls: Array<{ command: string; payload: unknown }>;
/** 回收站位置应答的条目：默认空库，回收站动作测试按需放入。 */
let trashPrompts: PromptRow[];
/** restore_prompt 与 purge_prompt_trash 的应答；回收站测试按需改写。 */
let restoreOutcome: { missing_folders: string[] };
let purgeReply: {
  purged: number;
  failures: Array<{ id: string; title: string | null; error: { code: string; detail: string | null } }>;
};
/** 全部 batch_* 命令的统一应答；多选批量测试按需改写（任务 11.2）。 */
let batchReply: BatchReport;
/** link_images 对这些提示词 id 抛错：驱动批量关联的逐项失败聚合。 */
let linkFailureIds: string[];
/** catalog_snapshot 的应答：批量关联选择器的图片候选，默认空库。 */
let catalogReply: CatalogSnapshot | null;
/** 分库布局偏好存储：read_layout 的应答源，write_layout 原样写入（任务 11.2）。 */
let savedLayouts: Record<string, unknown>;
let excludeFilteredPrompts: boolean;
let failPromptSave: boolean;
let failPromptCreate: boolean;
let simulateFolderMutation: boolean;
let liveFolder: string | null;
/** 正常区快照条目；空状态测试按需设为空，不修改共享 fixture。 */
let activePrompts: PromptRow[];
let linkedStatesReply: LinkedImageState[];

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

/**
 * jsdom 的 scrollTop 恒为 0：用可写访问器模拟真实滚动位置。
 * 按元素存储（WeakMap）：双库切换会重挂载集合视图，共享单值会让新 DOM
 * 读到上一库的偏移，掩盖真实的恢复语义。
 */
function stubScrollTop(): void {
  const offsets = new WeakMap<HTMLElement, number>();
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get(this: HTMLElement) {
      return offsets.get(this) ?? 0;
    },
    set(this: HTMLElement, next: number) {
      offsets.set(this, next);
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
  trashPrompts = [];
  restoreOutcome = { missing_folders: [] };
  purgeReply = { purged: 0, failures: [] };
  batchReply = { succeeded: 0, failures: [] };
  linkFailureIds = [];
  catalogReply = null;
  savedLayouts = {};
  excludeFilteredPrompts = false;
  failPromptSave = false;
  failPromptCreate = false;
  simulateFolderMutation = false;
  liveFolder = "人像";
  activePrompts = [...SNAPSHOT.prompts];
  linkedStatesReply = [];
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
      if (simulateFolderMutation && query.folder.kind === "path" && query.folder.path !== liveFolder) {
        return { ...SNAPSHOT, prompts: [] };
      }
      if (excludeFilteredPrompts && (query.favorite === true || query.text !== "" || query.tags.length > 0 || query.folder.kind !== "all")) {
        return { ...SNAPSHOT, prompts: [] };
      }
      return query.location === "trash"
        ? { ...SNAPSHOT, prompts: trashPrompts, trash_count: SNAPSHOT.trash_count }
        : { ...SNAPSHOT, prompts: activePrompts };
    }
    if (
      command === "set_prompt_favorite" ||
      command === "set_prompt_folders" ||
      command === "set_prompt_tags" ||
      command === "set_prompt_note" ||
      command === "delete_prompt"
    ) {
      return undefined;
    }
    if (command === "create_prompt_folder") return "人像/室外";
    if (command === "rename_prompt_folder") { liveFolder = "肖像"; return "肖像"; }
    if (command === "move_prompt_folder") return "室内";
    if (command === "delete_prompt_folder") { liveFolder = null; return undefined; }
    if (command === "create_prompt") {
      if (failPromptCreate) throw { code: "library.prompt_write_failed", detail: "提示词目录只读" };
      if (!isRecordPayload(payload) || !isRecordPayload(payload.prompt) || typeof payload.prompt.body !== "string") throw new TypeError("create_prompt 缺少正文");
      const created: PromptRow = {
        ...makePrompt(99),
        id: "prompt-created",
        body: payload.prompt.body,
        title: typeof payload.prompt.title === "string" ? payload.prompt.title : null,
        model: typeof payload.prompt.model === "string" ? payload.prompt.model : null,
        parameters: typeof payload.prompt.parameters === "string" ? payload.prompt.parameters : null,
        folders: Array.isArray(payload.prompt.folders) && payload.prompt.folders.every((folder) => typeof folder === "string") ? payload.prompt.folders : [],
      };
      activePrompts = [created, ...activePrompts];
      return { ...created, format_version: 2, deleted_from_folders: null };
    }
    if (command === "restore_prompt") return restoreOutcome;
    if (command === "purge_prompt_trash") return purgeReply;
    // 多选分区的批量关联选择器自取图片候选（任务 11.2）：默认空库。
    if (command === "catalog_snapshot") {
      return catalogReply ?? { assets: [], folders: [], tags: [], trash_count: 0 };
    }
    // 批量组织命令：统一 BatchReport 应答，逐项失败由报告呈现。
    if (
      command === "batch_add_prompt_folder" ||
      command === "batch_remove_prompt_folder" ||
      command === "batch_add_prompt_tag" ||
      command === "batch_remove_prompt_tag" ||
      command === "batch_set_prompt_favorite" ||
      command === "batch_delete_prompts"
    ) {
      return batchReply;
    }
    // 批量建立图片关联在后端没有批量命令：工作区逐条调用 link_images，
    // 这里按 id 抛出结构化错误驱动逐项失败的聚合呈现。
    if (command === "link_images") {
      if (
        isRecordPayload(payload) &&
        typeof payload.promptId === "string" &&
        linkFailureIds.includes(payload.promptId)
      ) {
        throw { code: "library.prompt_write_failed", detail: "关联写入失败" };
      }
      return undefined;
    }
    // 分库布局偏好（任务 11.2）：按库隔离的读写，驱动双库布局恢复 seam 测试。
    if (command === "read_layout") {
      if (isRecordPayload(payload) && typeof payload.libraryId === "string") {
        return savedLayouts[payload.libraryId] ?? null;
      }
      return null;
    }
    if (command === "write_layout") {
      if (
        isRecordPayload(payload) &&
        typeof payload.libraryId === "string"
      ) {
        savedLayouts[payload.libraryId] = payload.layout;
      }
      return undefined;
    }
    if (command === "update_prompt") {
      if (failPromptSave) throw { code: "library.prompt_write_failed", detail: "磁盘只读" };
      return { format_version: 2, ...makePrompt(2) };
    }
    if (command === "asset_thumbnail") return new ArrayBuffer(8);
    if (command === "plugin:event|listen" || command === "plugin:event|unlisten") {
      // 关联图片分区尝试订阅 Tauri 拖放事件：mock 环境没有真实事件流，静默应答。
      return undefined;
    }
    if (command === "linked_image_states") {
      return linkedStatesReply;
    }
    throw new Error(`未预期的 IPC：${command}`);
  });
});

test("收藏筛选先解决正文草稿：取消不切换，保存失败保留原文，重试成功才继续", async () => {
  excludeFilteredPrompts = true;
  const harness = await setupWorkspace();
  try {
    const card = harness.container.querySelector<HTMLButtonElement>('[data-prompt-card][data-id="prompt-2"]');
    if (card === null) throw new Error("缺少提示词卡片");
    await act(async () => card.click());
    await act(async () => buttonWithText(harness.container, "编辑主字段").click());
    const editor = harness.container.querySelector<HTMLTextAreaElement>('textarea[name="prompt-body"]');
    if (editor === null) throw new Error("缺少正文编辑器");
    await act(async () => setInputValue(editor, "筛选前尚未保存的正文"));
    const queryCount = queries.length;
    const favoriteFilter = () => {
      const button = harness.container.querySelector<HTMLButtonElement>(
        'button[aria-label="收藏提示词"]',
      );
      if (button === null) throw new Error("缺少收藏提示词入口");
      return button;
    };
    await act(async () => favoriteFilter().click());
    await flush();
    expect(harness.container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(editor.isConnected).toBe(true);
    expect(queries).toHaveLength(queryCount);
    await act(async () => buttonWithText(harness.container, "留在当前页").click());
    expect(editor.value).toBe("筛选前尚未保存的正文");
    expect(queries).toHaveLength(queryCount);

    await act(async () => favoriteFilter().click());
    failPromptSave = true;
    await act(async () => buttonWithText(harness.container, "保存并离开").click());
    expect(harness.container.querySelector('[data-error-code="library.prompt_write_failed"]')).not.toBeNull();
    expect(editor.isConnected).toBe(true);
    expect(editor.value).toBe("筛选前尚未保存的正文");
    expect(queries).toHaveLength(queryCount);

    failPromptSave = false;
    await act(async () => favoriteFilter().click());
    await act(async () => buttonWithText(harness.container, "保存并离开").click());
    await flush();
    expect(harness.container.querySelector('textarea[name="prompt-body"]')).toBeNull();
    expect(queries.at(-1)?.favorite).toBe(true);
  } finally {
    await harness.unmount();
  }
});

test.each(["搜索", "文件夹", "标签", "回收站"])("%s 查询入口放弃草稿后才执行原始意图", async (entry) => {
  const harness = await setupWorkspace();
  try {
    const search = harness.container.querySelector<HTMLInputElement>('input[name="prompt-search"]');
    if (search === null) throw new Error("缺少搜索框");
    const card = harness.container.querySelector<HTMLButtonElement>('[data-prompt-card][data-id="prompt-2"]');
    if (card === null) throw new Error("缺少提示词卡片");
    await act(async () => card.click());
    await act(async () => buttonWithText(harness.container, "编辑主字段").click());
    const editor = harness.container.querySelector<HTMLTextAreaElement>('textarea[name="prompt-body"]');
    if (editor === null) throw new Error("缺少正文编辑器");
    await act(async () => setInputValue(editor, "待确认的草稿"));
    const queryCount = queries.length;
    excludeFilteredPrompts = true;
    await act(async () => {
      if (entry === "搜索") setInput(search, "新搜索");
      else {
        const selector = entry === "文件夹" ? 'button[data-folder="人像"]'
          : entry === "标签" ? '[aria-label="标签筛选"] [data-tag]'
          : 'button[aria-label="回收站"]';
        const trigger = harness.container.querySelector<HTMLButtonElement>(selector);
        if (trigger === null) throw new Error(`缺少 ${entry} 入口`);
        trigger.click();
      }
    });
    await flush();
    expect(harness.container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(editor.isConnected).toBe(true);
    expect(queries).toHaveLength(queryCount);
    await act(async () => buttonWithText(harness.container, "放弃修改").click());
    await flush();
    expect(harness.container.querySelector('textarea[name="prompt-body"]')).toBeNull();
    const nextQuery = queries.at(-1);
    if (entry === "搜索") expect(nextQuery?.text).toBe("新搜索");
    if (entry === "文件夹") expect(nextQuery?.folder).toEqual({ kind: "path", path: "人像" });
    if (entry === "标签") expect(nextQuery?.tags).toEqual(["夜景"]);
    if (entry === "回收站") expect(nextQuery?.location).toBe("trash");
  } finally {
    await harness.unmount();
  }
});

test.each(["卡片瀑布流", "详情列表"])("%s 支持双击和 Enter 聚焦，Esc 恢复原集合选择", async (viewName) => {
  const harness = await setupWorkspace();
  try {
    if (viewName === "详情列表") await act(async () => buttonWithText(harness.container, viewName).click());
    const selector = viewName === "详情列表" ? '[data-list-item][data-id="prompt-2"]' : '[data-prompt-card][data-id="prompt-2"]';
    const item = harness.container.querySelector<HTMLButtonElement>(selector);
    if (item === null) throw new Error("缺少提示词项目");
    await act(async () => item.click());
    await act(async () => item.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    const focus = harness.container.querySelector<HTMLElement>('[aria-label="聚焦阅读"]');
    if (focus === null) throw new Error("双击没有进入聚焦阅读");
    expect(focus.textContent).toContain(makePrompt(2).body);
    await act(async () => focus.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    const restored = harness.container.querySelector<HTMLButtonElement>(selector);
    if (restored === null) throw new Error("退出聚焦后没有恢复集合");
    expect(restored.getAttribute("aria-selected")).toBe("true");
    await act(async () => restored.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(harness.container.querySelector('[aria-label="聚焦阅读"]')).not.toBeNull();
  } finally {
    await harness.unmount();
  }
});

test("卡片复制和收藏按钮的 Enter 不连带进入聚焦阅读", async () => {
  const harness = await setupWorkspace();
  try {
    const item = harness.container.querySelector<HTMLButtonElement>('[data-prompt-card][data-id="prompt-2"]');
    if (item === null) throw new Error("缺少提示词项目");
    await act(async () => item.click());
    const controls = item.parentElement?.querySelectorAll<HTMLButtonElement>('.prompt-card-actions button');
    if (controls === undefined) throw new Error("缺少卡片附属操作");
    expect(controls.length).toBe(2);
    for (const control of controls) {
      await act(async () => control.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
      expect(harness.container.querySelector('[aria-label="聚焦阅读"]')).toBeNull();
    }
  } finally {
    await harness.unmount();
  }
});

test.each(["重命名", "删除"])("%s 当前文件夹在任何权威写入之前解决正文草稿", async (operation) => {
  simulateFolderMutation = true;
  const harness = await setupWorkspace();
  try {
    const folder = harness.container.querySelector<HTMLButtonElement>('button[data-folder="人像"]');
    if (folder === null) throw new Error("缺少文件夹");
    await act(async () => folder.click());
    await flush();
    const card = harness.container.querySelector<HTMLButtonElement>('[data-prompt-card][data-id="prompt-2"]');
    if (card === null) throw new Error("缺少提示词项目");
    await act(async () => card.click());
    await act(async () => buttonWithText(harness.container, "编辑主字段").click());
    const editor = harness.container.querySelector<HTMLTextAreaElement>('textarea[name="prompt-body"]');
    if (editor === null) throw new Error("缺少正文编辑器");
    await act(async () => setInputValue(editor, "文件夹变更前的草稿"));
    const trigger = async () => {
      if (operation === "重命名") {
        const openRename = await promptFolderMenuItem("人像", "重命名");
        await act(async () => openRename.click());
        const name = document.querySelector<HTMLInputElement>('input[name="rename-prompt-folder"]');
        if (name === null) throw new Error("缺少名称输入框");
        await act(async () => setInput(name, "肖像"));
        await act(async () => buttonWithText(document, "保存名称").click());
      } else {
        const deleteFolder = await promptFolderMenuItem("人像", "删除");
        await act(async () => deleteFolder.click());
        const dialog = harness.container.querySelector('[role="dialog"]');
        if (dialog === null) throw new Error("缺少危险操作确认");
        await act(async () => buttonWithText(dialog, "删除文件夹").click());
      }
      await flush();
    };
    const command = operation === "重命名" ? "rename_prompt_folder" : "delete_prompt_folder";
    await trigger();
    expect(ipcCalls.some((call) => call.command === command)).toBe(false);
    expect(editor.isConnected).toBe(true);
    await act(async () => buttonWithText(harness.container, "留在当前页").click());
    expect(liveFolder).toBe("人像");
    await trigger();
    failPromptSave = true;
    await act(async () => buttonWithText(harness.container, "保存并离开").click());
    expect(liveFolder).toBe("人像");
    expect(editor.value).toBe("文件夹变更前的草稿");
    await trigger();
    await act(async () => buttonWithText(harness.container, "放弃修改").click());
    await flush();
    expect(ipcCalls.filter((call) => call.command === command)).toHaveLength(1);
    expect(liveFolder).toBe(operation === "重命名" ? "肖像" : null);
  } finally {
    await harness.unmount();
  }
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

function setSelect(select: HTMLSelectElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
  if (descriptor?.set === undefined) throw new Error("HTMLSelectElement.value setter 不存在");
  descriptor.set.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

/** mock 处理器里的载荷收窄：不用类型断言，运行时真的检查形状。 */
function isRecordPayload(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

async function promptFolderMenuItem(path: string, label: string): Promise<HTMLElement> {
  const folder = document.querySelector<HTMLElement>(`[data-folder="${path}"]`);
  if (folder === null) throw new Error(`缺少提示词文件夹：${path}`);
  await act(async () => folder.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 })));
  await flush();
  const item = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((candidate) => candidate.textContent?.trim() === label);
  if (item === undefined) throw new Error(`提示词文件夹快捷菜单缺少入口：${label}`);
  return item;
}

function installPointerStubs(): void {
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", { configurable: true, value: () => true });
}

async function pointer(target: HTMLElement, type: string, x: number, y: number): Promise<void> {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    pointerType: { value: "mouse" },
    isPrimary: { value: true },
  });
  await act(async () => {
    target.dispatchEvent(event);
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
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

async function setupWorkspace(
  locate: (GlobalLocateRequest & { nonce: number }) | null = null,
  libraryId: string | null = null,
): Promise<{
  container: HTMLElement;
  rerender: (
    next: (GlobalLocateRequest & { nonce: number }) | null,
    nextLibraryId?: string | null,
  ) => Promise<void>;
  unmount: () => Promise<void>;
}> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const relations = createImagePromptRelations({ adapter: createTauriImagePromptRelationAdapter(), navigation: createWorkspaceNavigation() });
  const render = (
    next: (GlobalLocateRequest & { nonce: number }) | null,
    id: string | null,
  ) => {
    const sessionId = libraryIdOf(id);
    const entry: PromptLibraryEntry = next === null
      ? { kind: "resume" }
      : { kind: "locate", requestId: `prompt-locate-${next.nonce}`, id: next.id, inTrash: next.inTrash };
    root.render(
      <UiProvider>
        <PromptLibraryWorkspace session={{ id: sessionId, displayName: "测试提示词库" }} relations={relations} active entry={entry} />
      </UiProvider>,
    );
  };
  await act(async () => {
    render(locate, libraryId);
  });
  await flush();
  return {
    container,
    rerender: (next, nextLibraryId = libraryId) =>
      act(async () => {
        render(next, nextLibraryId);
      }),
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

  const favorite = harness.container.querySelector<HTMLButtonElement>(
    'button[aria-label="收藏提示词"]',
  );
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

test("Archive Desk 提示词骨架使用扁平导航与单行查询栏，不保留旧标签和文字折叠按钮", async () => {
  const harness = await setupWorkspace();
  try {
    expect(harness.container.querySelector('[data-ui="prompt-workbench"]')).not.toBeNull();
    const navigation = harness.container.querySelector('[aria-label="提示词导航"]');
    expect(navigation).not.toBeNull();
    expect(navigation?.querySelector('[aria-label="提示词文件夹操作"]')).not.toBeNull();
    const toolbar = harness.container.querySelector('[aria-label="提示词查询与视图"]');
    expect(toolbar).not.toBeNull();
    expect(toolbar?.querySelector('button[aria-label="卡片瀑布流"]')).not.toBeNull();
    expect(toolbar?.querySelector('button[aria-label="详情列表"]')).not.toBeNull();
    expect(harness.container.querySelector('button[aria-label="收起提示词导航"]')?.textContent).toBe("");
    expect(harness.container.querySelector('button[aria-label="收起提示词检查器"]')?.textContent).toBe("");
    for (const obsolete of ["PROMPTS", "PROMPT LIBRARY", "INSPECTOR", "NO PROMPTS", "折叠分类栏", "折叠检查器"]) {
      expect(harness.container.textContent).not.toContain(obsolete);
    }
  } finally {
    await harness.unmount();
  }
});

test("提示词空状态区分空库、筛选为空、文件夹为空和回收站为空，不提供虚假入口", async () => {
  activePrompts = [];
  excludeFilteredPrompts = true;
  const harness = await setupWorkspace();
  try {
    const emptyState = () => {
      const state = harness.container.querySelector<HTMLElement>("h3");
      if (state === null) throw new Error("缺少提示词空状态");
      return state;
    };
    expect(emptyState().textContent).toBe("提示词库还是空的");
    expect(harness.container.textContent).not.toContain("从检查器新建");

    const search = harness.container.querySelector<HTMLInputElement>('input[name="prompt-search"]');
    if (search === null) throw new Error("缺少提示词搜索框");
    await act(async () => setInput(search, "不存在"));
    await flush();
    await flush();
    expect(emptyState().textContent).toBe("没有符合条件的提示词");

    await act(async () => setInput(search, ""));
    await flush();
    await flush();
    const rootFolder = buttonWithText(harness.container, "提示词根位置");
    await act(async () => rootFolder.click());
    await flush();
    expect(emptyState().textContent).toBe("这个位置还没有提示词");

    const trash = harness.container.querySelector<HTMLButtonElement>('button[aria-label="回收站"]');
    if (trash === null) throw new Error("缺少提示词回收站入口");
    await act(async () => trash.click());
    await flush();
    expect(emptyState().textContent).toBe("提示词回收站为空");
  } finally {
    await harness.unmount();
  }
});

test("提示词文件夹在树内即时新建子文件夹，不弹出父位置对话框", async () => {
  const harness = await setupWorkspace();
  const currentFolder = harness.container.querySelector<HTMLButtonElement>(
    '[data-folder="人像"]',
  );
  if (currentFolder === null) throw new Error("缺少人像文件夹入口");
  await act(async () => currentFolder.click());

  await act(async () =>
    harness.container
      .querySelector<HTMLButtonElement>('button[aria-label="新建提示词文件夹"]')
      ?.click(),
  );
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  const creator = harness.container.querySelector<HTMLElement>('[data-inline-folder-creator]');
  expect(creator?.dataset.parent).toBe("人像");
  const input = creator?.querySelector<HTMLInputElement>('input[name="inline-prompt-folder-name"]') ?? null;
  if (input === null) throw new Error("提示词分类栏缺少新建文件夹输入框");
  setInput(input, "室外");
  const form = input.closest("form");
  if (form === null) throw new Error("新建提示词文件夹输入框不在表单内");
  await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await flush();

  expect(ipcCalls).toContainEqual({
    command: "create_prompt_folder",
    payload: { parent: "人像", name: "室外" },
  });
  await harness.unmount();
});

test("提示词分类栏可以重命名当前文件夹", async () => {
  const harness = await setupWorkspace();
  const currentFolder = harness.container.querySelector<HTMLButtonElement>(
    '[data-folder="人像"]',
  );
  if (currentFolder === null) throw new Error("缺少人像文件夹入口");
  await act(async () => currentFolder.click());

  const rename = await promptFolderMenuItem("人像", "重命名");
  await act(async () => rename.click());
  const input = document.querySelector<HTMLInputElement>("#rename-prompt-folder");
  if (input === null) throw new Error("提示词分类栏缺少重命名输入框");
  setInput(input, "肖像");
  await act(async () => buttonWithText(document, "保存名称").click());
  await flush();

  expect(ipcCalls).toContainEqual({
    command: "rename_prompt_folder",
    payload: { path: "人像", newName: "肖像" },
  });
  await harness.unmount();
});

test("提示词分类栏删除当前文件夹前要求确认", async () => {
  const harness = await setupWorkspace();
  const currentFolder = harness.container.querySelector<HTMLButtonElement>(
    '[data-folder="人像"]',
  );
  if (currentFolder === null) throw new Error("缺少人像文件夹入口");
  await act(async () => currentFolder.click());
  const deleteFolder = await promptFolderMenuItem("人像", "删除");
  await act(async () => deleteFolder.click());

  const dialog = harness.container.querySelector<HTMLElement>('[role="dialog"]');
  if (dialog === null) throw new Error("删除提示词文件夹没有二次确认");
  await act(async () => buttonWithText(dialog, "删除文件夹").click());
  await flush();

  expect(ipcCalls).toContainEqual({
    command: "delete_prompt_folder",
    payload: { path: "人像" },
  });
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
  const body = harness.container.querySelector('[data-prompt-inspector-section="body"] .inspector-body-full');
  if (body === null) throw new Error("缺少完整正文呈现");
  expect(body.textContent).toBe(makePrompt(2).body);

  // 收藏开关从检查器发起，走独立的二值收藏 IPC。
  const favoriteToggle = harness.container.querySelector<HTMLButtonElement>('[aria-label="当前提示词操作"] button[aria-label="收藏提示词"]');
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

test("单选检查器使用五个连续可折叠分区，动作只集中在摘要", async () => {
  const harness = await setupWorkspace();
  const card = harness.container.querySelector<HTMLButtonElement>('[data-prompt-card][data-id="prompt-2"]');
  if (card === null) throw new Error("缺少提示词卡片");
  await act(async () => card.click());
  const inspector = harness.container.querySelector<HTMLElement>('[aria-label="提示词检查器"]');
  if (inspector === null) throw new Error("缺少提示词检查器");
  const headings = [...inspector.querySelectorAll<HTMLButtonElement>('[data-prompt-inspector-section] > h2 > button')];
  expect(headings.map((button) => button.textContent?.trim())).toEqual([
    "摘要", "正文", "组织", "备注", "关联图片",
  ]);
  expect(headings.every((button) => button.getAttribute("aria-expanded") === "true")).toBe(true);
  const summary = inspector.querySelector<HTMLElement>('[data-prompt-inspector-section="summary"]');
  if (summary === null) throw new Error("缺少提示词摘要分区");
  for (const label of ["复制提示词正文", "编辑提示词", "收藏提示词", "关联图片", "移入回收站"]) {
    expect(summary.querySelector(`button[aria-label="${label}"]`)).not.toBeNull();
  }
  await act(async () => headings[1]?.click());
  expect(headings[1]?.getAttribute("aria-expanded")).toBe("false");
  await harness.unmount();
});

test("提示词公共工作区在检查器原地切换关联图片主预览", async () => {
  linkedStatesReply = [
    { hash: "a".repeat(64), deleted: false, display_filename: "封面.png", folder: "构图", width: 1600, height: 900 },
    { hash: "b".repeat(64), deleted: false, display_filename: "侧光.png", folder: "光线", width: 1200, height: 1600 },
  ];
  const harness = await setupWorkspace();
  const card = harness.container.querySelector<HTMLButtonElement>('[data-prompt-card][data-id="prompt-1"]');
  if (card === null) throw new Error("缺少带关联图片的提示词卡片");
  await act(async () => card.click());
  await vi.waitFor(() => expect(harness.container.querySelector<HTMLElement>('[data-preview-hash]')?.dataset.previewHash).toBe("a".repeat(64)));
  const second = harness.container.querySelector<HTMLButtonElement>('button[aria-label="预览关联图片 侧光.png"]');
  if (second === null) throw new Error("检查器缺少第二张关联图片预览入口");
  await act(async () => second.click());
  expect(harness.container.querySelector<HTMLElement>('[data-preview-hash]')?.dataset.previewHash).toBe("b".repeat(64));
  expect(harness.container.querySelector('[data-ui="prompt-workbench"]')).not.toBeNull();
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

test("清空提示词回收站经二次确认：呈现数量、取消默认聚焦、确认后逐项报告", async () => {
  purgeReply = { purged: 3, failures: [] };
  const harness = await setupWorkspace();

  const trash = harness.container.querySelector<HTMLButtonElement>('[aria-label="回收站"]');
  if (trash === null) throw new Error("缺少回收站入口");
  await act(async () => trash.click());
  await flush();

  // 回收站工具条出现；trash_count=3 时清空按钮可用。
  const purgeButton = buttonWithText(harness.container, "清空回收站");
  expect(purgeButton.disabled).toBe(false);
  expect(purgeButton.className).toContain("danger-button");

  await act(async () => purgeButton.click());
  const dialog = harness.container.querySelector<HTMLDivElement>('[role="dialog"]');
  if (dialog === null) throw new Error("缺少二次确认对话框");
  // 数量必须显式呈现；默认焦点落在取消（失手落在安全侧）。
  expect(dialog.textContent).toContain("3 条提示词");
  expect(dialog.ownerDocument.activeElement?.textContent).toBe("取消");

  // 取消绝不执行写入。
  await act(async () => buttonWithText(dialog, "取消").click());
  expect(ipcCalls.some((call) => call.command === "purge_prompt_trash")).toBe(false);

  // 确认后走 purge_prompt_trash 并呈现逐项结果，随后权威刷新当前查询。
  const queriesAtStart = queries.length;
  await act(async () => buttonWithText(harness.container, "清空回收站").click());
  const dialogAgain = harness.container.querySelector<HTMLDivElement>('[role="dialog"]');
  if (dialogAgain === null) throw new Error("缺少二次确认对话框");
  await act(async () => buttonWithText(dialogAgain, "永久删除").click());
  await flush();
  // 无参命令的载荷形状由 IPC 层决定，这里只断言命令确实发出。
  expect(ipcCalls.some((call) => call.command === "purge_prompt_trash")).toBe(true);
  const report = harness.container.querySelector(".operation-status");
  if (report === null) throw new Error("缺少清理报告");
  expect(report.textContent).toContain("已永久删除 3 条");
  // 一次无筛选 trash 快照确定 purge 全目标，一次关系协调刷新当前工作区。
  expect(queries.length).toBe(queriesAtStart + 2);

  // 图片不变呈现：整个清空流程没有发出任何图片写命令。
  const imageWrites = ipcCalls.filter((call) =>
    /^(delete_asset|purge_trash|set_asset_|batch_set_asset|batch_delete_assets)/.test(call.command),
  );
  expect(imageWrites).toEqual([]);

  await harness.unmount();
});

test("检查器在回收站位置让位给还原入口，缺失文件夹以稳定警告码呈现且不阻断还原", async () => {
  restoreOutcome = { missing_folders: ["人像/室内"] };
  trashPrompts = [makePrompt(5)];
  const harness = await setupWorkspace();

  const trash = harness.container.querySelector<HTMLButtonElement>('[aria-label="回收站"]');
  if (trash === null) throw new Error("缺少回收站入口");
  await act(async () => trash.click());
  await flush();

  const card = harness.container.querySelector<HTMLButtonElement>("[data-prompt-card]");
  if (card === null) throw new Error("回收站里缺少提示词卡片");
  await act(async () => card.click());

  // 组织分区被还原入口替换：不再提供文件夹勾选与移入回收站。
  const organization = harness.container.querySelector<HTMLElement>(
    '[data-inspector-section="organization"]',
  );
  if (organization === null) throw new Error("缺少组织分区");
  expect(organization.textContent).toContain("回收站记录保留原组织");
  expect(organization.querySelector('input[type="checkbox"]')).toBeNull();
  expect(buttonWithTextExists(organization, "移入回收站")).toBe(false);

  const restore = harness.container.querySelector<HTMLButtonElement>('button[aria-label="还原提示词"]');
  if (restore === null) throw new Error("缺少还原提示词入口");
  await act(async () => restore.click());
  await flush();
  expect(ipcCalls).toContainEqual({
    command: "restore_prompt",
    payload: { id: "prompt-5" },
  });
  // 还原不被缺失文件夹阻断：稳定警告码 + 缺失路径显式列出。
  const notice = harness.container.querySelector<HTMLElement>(
    '[data-error-code="trash.restore_target_folder_missing"]',
  );
  if (notice === null) throw new Error("缺少缺失文件夹警告");
  expect(notice.textContent).toContain("人像/室内");

  await harness.unmount();
});

test("正常区的检查器提供移入回收站入口，经确认对话框发起 delete_prompt", async () => {
  const harness = await setupWorkspace();

  const card = harness.container.querySelector<HTMLButtonElement>(
    '[data-prompt-card][data-id="prompt-2"]',
  );
  if (card === null) throw new Error("缺少提示词卡片");
  await act(async () => card.click());
  const remove = harness.container.querySelector<HTMLButtonElement>('button[aria-label="移入回收站"]');
  if (remove === null) throw new Error("缺少移入回收站入口");
  await act(async () => remove.click());

  const dialog = harness.container.querySelector<HTMLDivElement>('[role="dialog"]');
  if (dialog === null) throw new Error("缺少二次确认对话框");
  // 正文首行命名的提示词在确认文案中以可识别标题呈现。
  expect(dialog.textContent).toContain("正文首行 2");

  await act(async () => buttonWithText(dialog, "移入回收站").click());
  await flush();
  expect(ipcCalls).toContainEqual({
    command: "delete_prompt",
    payload: { id: "prompt-2" },
  });

  await harness.unmount();
});

function buttonWithTextExists(scope: ParentNode, text: string): boolean {
  return [...scope.querySelectorAll("button")].some(
    (candidate) => candidate.textContent?.trim() === text,
  );
}

test("Ctrl+F 聚焦本库搜索框且无条件时不渲染条件芯片", async () => {
  const harness = await setupWorkspace();
  expect(harness.container.querySelector('[aria-label="已应用的搜索条件"]')).toBeNull();

  const search = harness.container.querySelector<HTMLInputElement>(
    '[aria-label="按标题或正文搜索"]',
  );
  if (search === null) throw new Error("缺少提示词搜索框");
  await act(async () => setInput(search, "人像"));
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }),
    );
  });
  expect(document.activeElement).toBe(search);
  expect(search.selectionStart).toBe(0);
  expect(search.selectionEnd).toBe(search.value.length);

  await harness.unmount();
});

test("全局定位：查询重置到回收站并选中目标提示词，同一次请求不重复消费", async () => {
  trashPrompts = [makePrompt(4)];
  const request: GlobalLocateRequest & { nonce: number } = {
    section: "prompts",
    id: "prompt-4",
    inTrash: true,
    nonce: 1,
  };
  const harness = await setupWorkspace(request);
  await flush();

  // 定位把位置切到回收站、其余条件回到默认（global_search 跨两个位置）。
  expect(queries.at(-1)?.location).toBe("trash");
  expect(queries.at(-1)?.text).toBe("");
  // 目标项经统一选择模型进入检查器。
  const info = harness.container.querySelector<HTMLElement>('[data-inspector-section="info"]');
  if (info === null) throw new Error("缺少检查器信息分区");
  expect(info.querySelector("h3")?.textContent).toContain("显式标题 4");

  const before = queries.length;
  await harness.rerender({ ...request });
  await flush();
  // nonce 未变：同一请求不再触发新的消费与快照请求。
  expect(queries.length).toBe(before);

  await harness.unmount();
});

test("浏览范围互斥且不把收藏、文件夹或搜索重复显示成中央条件胶囊", async () => {
  const harness = await setupWorkspace();

  const search = harness.container.querySelector<HTMLInputElement>(
    '[aria-label="按标题或正文搜索"]',
  );
  if (search === null) throw new Error("缺少提示词搜索框");
  await act(async () => setInput(search, "人像"));
  await flush();
  const favorite = harness.container.querySelector<HTMLButtonElement>(
    'button[aria-label="收藏提示词"]',
  );
  if (favorite === null) throw new Error("缺少收藏筛选按钮");
  await act(async () => favorite.click());
  await flush();
  expect(queries.at(-1)).toMatchObject({ text: "", tags: [], folder: { kind: "all" }, favorite: true, location: "active" });
  expect(harness.container.querySelector('[aria-label="已应用的搜索条件"]')).toBeNull();
  const root = buttonWithText(harness.container, "提示词根位置");
  await act(async () => root.click());
  await flush();
  expect(queries.at(-1)).toMatchObject({ text: "", tags: [], folder: { kind: "root" }, favorite: null, location: "active" });
  expect(root.getAttribute("aria-current")).toBe("page");
  expect(favorite.getAttribute("aria-current")).toBeNull();
  expect(queries.at(-1)?.text).toBe("");

  await harness.unmount();
});

test("提示词文件夹右键可移到顶层，指针拖动复用同一移动命令", async () => {
  installPointerStubs();
  const harness = await setupWorkspace();
  const moveToTop = await promptFolderMenuItem("人像/室内", "移到顶层");
  await act(async () => moveToTop.click());
  await flush();
  expect(ipcCalls).toContainEqual({
    command: "move_prompt_folder",
    payload: { path: "人像/室内", destinationParent: null },
  });

  const root = harness.container.querySelector<HTMLElement>('[data-folder-tree-root]');
  const child = harness.container.querySelector<HTMLElement>('[data-folder="人像/室内"]');
  if (root === null || child === null) throw new Error("提示词文件夹树不完整");
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => root });
  try {
    await pointer(child, "pointerdown", 30, 120);
    await pointer(root, "pointermove", 90, 180);
    const rootDrop = harness.container.querySelector<HTMLElement>('[data-folder-root-drop]');
    expect(rootDrop?.textContent).toContain("移到顶层");
    expect(rootDrop?.dataset.dropActive).toBe("true");
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => rootDrop });
    await pointer(root, "pointermove", 90, 190);
    await pointer(root, "pointerup", 90, 190);
    await flush();
    expect(ipcCalls.filter((call) => call.command === "move_prompt_folder")).toHaveLength(2);
  } finally {
    Reflect.deleteProperty(document, "elementFromPoint");
  }
  await harness.unmount();
});

test("当前文件夹可以聚焦新建提示词，正文保存后沿用该文件夹并聚焦新条目", async () => {
  const harness = await setupWorkspace();
  const currentFolder = harness.container.querySelector<HTMLButtonElement>('[data-folder="人像"]');
  if (currentFolder === null) throw new Error("缺少人像文件夹入口");
  await act(async () => currentFolder.click());
  await flush();
  const create = harness.container.querySelector<HTMLButtonElement>('button[aria-label="新建提示词"]');
  if (create === null) throw new Error("缺少新建提示词入口");
  await act(async () => create.click());
  const composer = harness.container.querySelector<HTMLElement>('[aria-label="新建提示词编辑器"]');
  if (composer === null) throw new Error("缺少聚焦新建提示词编辑器");
  const body = composer.querySelector<HTMLTextAreaElement>('textarea[name="prompt-create-body"]');
  if (body === null) throw new Error("缺少新提示词正文");
  await act(async () => setInputValue(body, "柔和侧光，克制的胶片颗粒"));
  await act(async () => buttonWithText(composer, "保存提示词").click());
  await flush();
  await flush();

  expect(ipcCalls).toContainEqual({
    command: "create_prompt",
    payload: { prompt: { body: "柔和侧光，克制的胶片颗粒", title: null, model: null, parameters: null, folders: ["人像"], tags: [] } },
  });
  expect(queries.at(-1)).toMatchObject({ folder: { kind: "path", path: "人像" }, favorite: null, location: "active" });
  expect(harness.container.querySelector('[aria-label="新建提示词编辑器"]')).toBeNull();
  const focused = harness.container.querySelector<HTMLElement>('[aria-label="聚焦阅读"]');
  expect(focused?.textContent).toContain("柔和侧光，克制的胶片颗粒");
  await harness.unmount();
});

test("收藏范围用 Ctrl+S 新建到根位置，失败保留草稿并在重试成功后退出收藏", async () => {
  const harness = await setupWorkspace();
  const favorite = harness.container.querySelector<HTMLButtonElement>('button[aria-label="收藏提示词"]');
  if (favorite === null) throw new Error("缺少收藏入口");
  await act(async () => favorite.click());
  await flush();
  const create = harness.container.querySelector<HTMLButtonElement>('button[aria-label="新建提示词"]');
  if (create === null) throw new Error("缺少新建提示词入口");
  await act(async () => create.click());
  const composer = harness.container.querySelector<HTMLElement>('[aria-label="新建提示词编辑器"]');
  const body = composer?.querySelector<HTMLTextAreaElement>('textarea[name="prompt-create-body"]');
  if (composer === null || body === null || body === undefined) throw new Error("新建提示词编辑器不完整");
  await act(async () => setInputValue(body, "高反差边缘光与深色背景"));
  failPromptCreate = true;
  await act(async () => composer.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true })));
  await flush();
  expect(harness.container.querySelector('[data-error-code="library.prompt_write_failed"]')).not.toBeNull();
  expect(body.value).toBe("高反差边缘光与深色背景");

  failPromptCreate = false;
  await act(async () => composer.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true })));
  await flush();
  await flush();
  expect(ipcCalls.filter((call) => call.command === "create_prompt").at(-1)).toEqual({
    command: "create_prompt",
    payload: { prompt: { body: "高反差边缘光与深色背景", title: null, model: null, parameters: null, folders: [], tags: [] } },
  });
  expect(queries.at(-1)).toMatchObject({ folder: { kind: "root" }, favorite: null, location: "active" });
  await harness.unmount();
});

test("新建提示词非空草稿接入全局守卫，留在当前页保留内容，放弃后才继续导航", async () => {
  const harness = await setupWorkspace();
  const create = harness.container.querySelector<HTMLButtonElement>('button[aria-label="新建提示词"]');
  if (create === null) throw new Error("缺少新建提示词入口");
  await act(async () => create.click());
  const body = harness.container.querySelector<HTMLTextAreaElement>('textarea[name="prompt-create-body"]');
  if (body === null) throw new Error("缺少新提示词正文");
  await act(async () => setInputValue(body, "尚未保存的提示词草稿"));
  const continued: string[] = [];

  let blocked = false;
  await act(async () => { blocked = blockIfPromptDraftDirty(() => continued.push("switch-library")); });
  expect(blocked).toBe(true);
  await vi.waitFor(() => expect(harness.container.querySelector('[role="dialog"]')).not.toBeNull());
  await act(async () => buttonWithText(harness.container, "留在当前页").click());
  expect(body.value).toBe("尚未保存的提示词草稿");
  expect(continued).toEqual([]);

  await act(async () => { blocked = blockIfPromptDraftDirty(() => continued.push("switch-library")); });
  expect(blocked).toBe(true);
  await vi.waitFor(() => expect(harness.container.querySelector('[role="dialog"]')).not.toBeNull());
  await act(async () => buttonWithText(harness.container, "放弃草稿").click());
  await vi.waitFor(() => expect(harness.container.querySelector('[aria-label="新建提示词编辑器"]')).toBeNull());
  expect(continued).toEqual(["switch-library"]);
  await harness.unmount();
});

/** Ctrl+单击选中两张卡片的公共步骤：返回批量分区断言所需的工具条。 */
async function selectTwoCards(
  container: HTMLElement,
  firstId: string,
  secondId: string,
): Promise<HTMLElement> {
  const first = container.querySelector<HTMLButtonElement>(
    `[data-prompt-card][data-id="${firstId}"]`,
  );
  const second = container.querySelector<HTMLButtonElement>(
    `[data-prompt-card][data-id="${secondId}"]`,
  );
  if (first === null || second === null) throw new Error("缺少待多选的提示词卡片");
  await act(async () => first.click());
  await act(async () => {
    second.dispatchEvent(new MouseEvent("click", { ctrlKey: true, bubbles: true }));
  });
  const toolbar = container.querySelector<HTMLElement>(".batch-toolbar");
  if (toolbar === null) throw new Error("缺少批量工具条");
  return toolbar;
}

test("多选呈现批量工具条与检查器批量分区，批量标签经后端批量命令", async () => {
  batchReply = { succeeded: 2, failures: [] };
  const harness = await setupWorkspace();

  const toolbar = await selectTwoCards(harness.container, "prompt-0", "prompt-2");
  expect(toolbar.textContent).toContain("已选 2 / 共 8 项");
  expect(harness.container.querySelector('[data-inspector-section="info"]')).toBeNull();

  const editTags = toolbar.querySelector<HTMLButtonElement>('button[aria-label="批量编辑标签"]');
  if (editTags === null) throw new Error("缺少批量标签入口");
  await act(async () => editTags.click());
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  if (dialog === null) throw new Error("缺少批量标签对话框");
  const tagInput = dialog.querySelector<HTMLInputElement>("#prompt-batch-tag");
  if (tagInput === null) throw new Error("缺少批量标签输入框");
  const addTagButton = [...dialog.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === "添加标签",
  );
  if (addTagButton === undefined) throw new Error("缺少批量添加标签按钮");
  await act(async () => {
    setInput(tagInput, "夜景");
    addTagButton.click();
  });
  await flush();

  const call = ipcCalls.find((entry) => entry.command === "batch_add_prompt_tag");
  expect(call?.payload).toEqual(
    expect.objectContaining({ ids: ["prompt-0", "prompt-2"], tag: "夜景" }),
  );
  const status = harness.container.querySelector<HTMLElement>(".operation-status");
  if (status === null) throw new Error("缺少批量报告区");
  expect(status.textContent).toContain("批量完成：成功 2 项");

  await harness.unmount();
});

test("多选检查器只读，文件夹标签收藏和更多动作全部位于底部栏", async () => {
  const harness = await setupWorkspace();
  const toolbar = await selectTwoCards(harness.container, "prompt-0", "prompt-2");
  for (const label of ["批量编辑文件夹", "批量编辑标签", "批量收藏", "更多批量操作"]) {
    expect(toolbar.querySelector(`button[aria-label="${label}"]`)).not.toBeNull();
  }
  const inspector = harness.container.querySelector<HTMLElement>('[aria-label="提示词检查器"]');
  if (inspector === null) throw new Error("缺少提示词检查器");
  expect(inspector.textContent).toContain("共同值");
  expect(inspector.querySelector("form")).toBeNull();
  expect(inspector.querySelector('[data-inspector-section="batch-links"]')).toBeNull();
  expect(inspector.querySelector('[data-inspector-section="batch-danger"]')).toBeNull();
  await harness.unmount();
});

test("批量建立图片关联逐条建立普通关联并聚合逐项失败", async () => {
  linkFailureIds = ["prompt-2"];
  const candidate: AssetRow = {
    hash: "a".repeat(64),
    hash_algo: "sha256",
    media_type: "png",
    ext: "png",
    byte_size: 2048,
    width: 1920,
    height: 1080,
    imported_at: "2026-08-21T08:30:00Z",
    original_filename: "窗台.png",
    display_filename: "窗台.png",
    source_path: null,
    deleted_at: null,
    color_card_status: "ok",
    color_card_algo_version: 1,
    color_card_failure_reason: null,
    color_card_sampled_pixel_count: 100,
    note: "",
    favorite: false,
    tags: [],
    folder: null,
    colors: [],
  };
  catalogReply = { assets: [candidate], folders: [], tags: [], trash_count: 0 };
  const harness = await setupWorkspace();

  const toolbar = await selectTwoCards(harness.container, "prompt-0", "prompt-2");

  const more = toolbar.querySelector<HTMLButtonElement>('button[aria-label="更多批量操作"]');
  if (more === null) throw new Error("缺少更多批量操作入口");
  more.focus();
  await act(async () => more.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" })));
  const linkItem = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.trim() === "关联图片");
  if (linkItem === undefined) throw new Error("缺少批量关联图片菜单项");
  await act(async () => linkItem.click());
  await flush();
  const linksDialog = document.querySelector<HTMLElement>('[role="dialog"]');
  if (linksDialog === null) throw new Error("缺少批量关联对话框");
  const select = linksDialog.querySelector<HTMLSelectElement>("#prompt-batch-image");
  if (select === null) throw new Error("缺少目标图片选择器");
  await act(async () => setSelect(select, candidate.hash));

  const submit = [...linksDialog.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === "建立关联",
  );
  if (submit === undefined) throw new Error("缺少建立关联按钮");
  await act(async () => submit.click());
  await flush();

  // 后端没有批量关联命令：工作区逐条调用 link_images，两条都发起。
  const linkCalls = ipcCalls.filter((entry) => entry.command === "link_images");
  expect(linkCalls.map((entry) => entry.payload)).toEqual([
    { promptId: "prompt-0", hashes: [candidate.hash] },
    { promptId: "prompt-2", hashes: [candidate.hash] },
  ]);

  // 单条失败不阻断其余条目（设计第六条）：失败项以可识别标题与稳定错误码呈现。
  const status = harness.container.querySelector<HTMLElement>(".operation-status");
  if (status === null) throw new Error("缺少批量报告区");
  expect(status.textContent).toContain("成功 1 项");
  expect(status.textContent).toContain("失败 1 项");
  expect(status.textContent).toContain("正文首行 2");
  expect(status.querySelector('[data-error-code="library.prompt_write_failed"]')).not.toBeNull();

  await harness.unmount();
});

test("批量移入回收站经二次确认发起 batch_delete_prompts 并回显报告", async () => {
  batchReply = { succeeded: 2, failures: [] };
  const harness = await setupWorkspace();

  const toolbar = await selectTwoCards(harness.container, "prompt-0", "prompt-2");
  const more = toolbar.querySelector<HTMLButtonElement>('button[aria-label="更多批量操作"]');
  if (more === null) throw new Error("缺少更多批量操作入口");
  more.focus();
  await act(async () => more.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" })));
  const dangerItem = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.trim() === "移入回收站");
  if (dangerItem === undefined) throw new Error("缺少批量移入回收站菜单项");
  await act(async () => dangerItem.click());
  const dialog = harness.container.querySelector<HTMLElement>('[role="dialog"]');
  if (dialog === null) throw new Error("缺少二次确认对话框");
  expect(dialog.textContent).toContain("选中的 2 条提示词");

  const confirmDelete = [...dialog.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === "移入回收站",
  );
  if (confirmDelete === undefined) throw new Error("缺少对话框确认按钮");
  await act(async () => confirmDelete.click());
  await flush();

  const call = ipcCalls.find((entry) => entry.command === "batch_delete_prompts");
  expect(call?.payload).toEqual(
    expect.objectContaining({ ids: ["prompt-0", "prompt-2"] }),
  );
  const status = harness.container.querySelector<HTMLElement>(".operation-status");
  if (status === null) throw new Error("缺少批量报告区");
  expect(status.textContent).toContain("批量完成：成功 2 项");

  await harness.unmount();
});

test("双库布局恢复：滚动偏移按库隔离，切换库各自恢复自己的位置", async () => {
  savedLayouts = {
    // 库 A 已保存过详情列表偏移；库 B 从未保存过。
    [LIB_A]: {
      assets: DEFAULT_LAYOUT,
      prompts: {
        ...DEFAULT_LAYOUT,
        view: "list",
        scrollOffsets: { "prompts-list": 240 },
      },
    },
    [LIB_B]: {
      assets: DEFAULT_LAYOUT,
      prompts: { ...DEFAULT_LAYOUT, view: "list" },
    },
  };
  const harness = await setupWorkspace(null, "library-a");
  await flush();

  await act(async () => buttonWithText(harness.container, "详情列表").click());
  await flush();

  // 库 A 的已存偏移在挂载时恢复。
  const list = () => {
    const el = harness.container.querySelector<HTMLElement>(".prompt-detail-list");
    if (el === null) throw new Error("缺少详情列表滚动容器");
    return el;
  };
  expect(list().scrollTop).toBe(240);

  // 使用者滚到新位置并切到库 B：旧库待写先落盘，B 呈现自己的默认（无记忆）。
  await act(async () => {
    list().scrollTop = 500;
    list().dispatchEvent(new Event("scroll"));
  });
  await act(async () => harness.rerender(null, "library-b"));
  await flush();
  await flush();
  const savedA = savedLayouts[LIB_A];
  if (!isRecordPayload(savedA) || !isRecordPayload(savedA.prompts)) {
    throw new TypeError("库 A 没有保存提示词 section");
  }
  expect(savedA.prompts.scrollOffsets).toEqual({ "prompts-list": 500 });
  expect(list().scrollTop).toBe(0);

  // 切回库 A：恢复的是 A 自己的偏移，而不是 B 的残留或全局值。
  await act(async () => harness.rerender(null, "library-a"));
  await flush();
  await flush();
  expect(list().scrollTop).toBe(500);

  await harness.unmount();
});

test("提示词工作台从自身 section 恢复视图、文件夹、标签、收藏与局部搜索", async () => {
  const libraryId = "018f3c9e-6c00-7000-8000-00000000000c";
  savedLayouts[libraryId] = {
    assets: DEFAULT_LAYOUT,
    prompts: {
      ...DEFAULT_LAYOUT,
      view: "list",
      text: "cinematic",
      folder: { kind: "path", path: "人像" },
      tags: ["夜景"],
      favorite: true,
    },
  };
  const harness = await setupWorkspace(null, libraryId);
  await flush();

  expect(queries.at(-1)).toEqual({
    text: "cinematic",
    folder: { kind: "path", path: "人像" },
    tags: ["夜景"],
    favorite: true,
    location: "active",
  });
  expect(buttonWithText(harness.container, "详情列表").getAttribute("aria-pressed")).toBe("true");
  await harness.unmount();
});

test("宽屏提示词工作台恢复折叠栏位并允许分别展开", async () => {
  const libraryId = "018f3c9e-6c00-7000-8000-00000000000d";
  savedLayouts[libraryId] = {
    assets: DEFAULT_LAYOUT,
    prompts: {
      ...DEFAULT_LAYOUT,
      railCollapsed: true,
      inspectorCollapsed: true,
    },
  };
  const harness = await setupWorkspace(null, libraryId);
  await flush();

  const collapsedNavigation = harness.container.querySelector<HTMLElement>(
    '[aria-label="提示词导航"]',
  );
  const collapsedInspector = harness.container.querySelector<HTMLElement>(
    'aside[aria-label="提示词检查器"]',
  );
  expect(collapsedNavigation?.closest("aside")?.dataset.collapsed).toBe("true");
  expect(collapsedInspector?.dataset.collapsed).toBe("true");
  const expandNavigation = harness.container.querySelector<HTMLButtonElement>(
    'button[aria-label="展开提示词导航"]',
  );
  const expandInspector = harness.container.querySelector<HTMLButtonElement>(
    'button[aria-label="展开提示词检查器"]',
  );
  if (expandNavigation === null || expandInspector === null) {
    throw new Error("缺少提示词栏位展开按钮");
  }
  await act(async () => expandNavigation.click());
  await act(async () => expandInspector.click());

  expect(harness.container.querySelector('[aria-label="提示词导航"]')).not.toBeNull();
  expect(harness.container.querySelector('aside[aria-label="提示词检查器"]')).not.toBeNull();
  await harness.unmount();
});
