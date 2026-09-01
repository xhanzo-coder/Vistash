// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
// 对话框在组件里经 shared/ipc 间接调用；这里把插件模块整个换掉。
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(async () => null),
}));
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import type { AssetRow, LinkedImageState, PromptRow } from "../../shared/types";
import {
  handleFileDragEvent,
  promptDropClaimsLatestPoint,
} from "./promptDropZone";
import { PromptImageLinks } from "./PromptImageLinks";
import { parseLibraryId } from "../../app/common";
import { createWorkspaceNavigation } from "../../app/navigation";
import { createImagePromptRelations, createTauriImagePromptRelationAdapter } from "../../modules/image-prompt-relations";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const LIBRARY_ID = parseLibraryId("018f3c9e-6c00-7000-8000-0000000000d4");

function makeAsset(hash: string, filename: string): AssetRow {
  return {
    hash,
    hash_algo: "blake3",
    media_type: "image",
    ext: "png",
    byte_size: 1024,
    width: 800,
    height: 600,
    imported_at: "2026-08-20T00:00:00Z",
    original_filename: filename,
    display_filename: filename,
    source_path: null,
    deleted_at: null,
    color_card_status: "ok",
    color_card_algo_version: 1,
    color_card_failure_reason: null,
    color_card_sampled_pixel_count: 1024,
    note: "",
    favorite: false,
    tags: [],
    folder: null,
    colors: [],
  };
}

function makePrompt(overrides: Partial<PromptRow> = {}): PromptRow {
  return {
    id: "prompt-0",
    body: "正文第一行\n第二行",
    title: null,
    model: null,
    parameters: null,
    note: "",
    favorite: false,
    folders: [],
    tags: [],
    linked_image_hashes: [HASH_A, HASH_B],
    cover_image_hash: null,
    resolved_cover_hash: null,
    created_at: "2026-08-20T00:00:00Z",
    updated_at: "2026-08-21T00:00:00Z",
    deleted_at: null,
    ...overrides,
  };
}

let ipcCalls: Array<{ command: string; payload: unknown }>;
/** linked_image_states 的应答；每条测试自行设定。 */
let states: LinkedImageState[] | Error;
/** catalog_snapshot 的活动库应答。 */
let candidates: AssetRow[];

function linkedState(hash: string, deleted: boolean): LinkedImageState {
  return { hash, deleted, display_filename: `${hash.slice(0, 4)}.png`, folder: null, width: 800, height: 600 };
}

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  ipcCalls = [];
  states = [
    linkedState(HASH_A, false),
    linkedState(HASH_B, true),
  ];
  candidates = [];
  mockWindows("main");
  Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", {
    configurable: true,
    value: { unregisterListener: vi.fn() },
  });
  mockIPC((command, payload) => {
    if (command === "plugin:event|listen" || command === "plugin:event|unlisten") {
      // 模拟原生事件注册与释放；不可依赖生产代码吞掉缺失的测试环境。
      return 1;
    }
    ipcCalls.push({ command, payload });
    if (command === "linked_image_states") {
      if (states instanceof Error) throw states;
      return states;
    }
    if (command === "asset_thumbnail") return new ArrayBuffer(8);
    if (command === "image_detail") {
      if (typeof payload !== "object" || payload === null || !("hash" in payload) || typeof payload.hash !== "string") {
        throw new TypeError("图片详情测试收到非法载荷");
      }
      const hash = payload.hash;
      const state = states instanceof Error ? undefined : states.find((item) => item.hash === hash);
      if (state === undefined) throw { code: "prompt.linked_image_not_found", detail: "目标已永久删除" };
      return { asset: { ...makeAsset(hash, state.display_filename), deleted_at: state.deleted ? "2026-08-22T00:00:00Z" : null }, linked_prompts: [] };
    }
    if (command === "catalog_snapshot") return { assets: candidates };
    if (
      command === "link_images" ||
      command === "set_prompt_cover"
    ) {
      return undefined;
    }
    if (command === "unlink_image") {
      if (!(states instanceof Error) && typeof payload === "object" && payload !== null && "hash" in payload && typeof payload.hash === "string") {
        states = states.filter((state) => state.hash !== payload.hash);
      }
      return undefined;
    }
    if (command === "import_and_link") {
      return {
        items: [
          {
            source_path: "E:\\素材\\逆光.png",
            original_filename: "逆光.png",
            outcome: { kind: "linked_imported", hash: HASH_A },
          },
        ],
      };
    }
    throw new Error(`未预期的 IPC：${command}`);
  });
});

afterEach(() => {
  clearMocks();
  Reflect.deleteProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function setupLinks(
  prompt: PromptRow = makePrompt(),
): Promise<{
  container: HTMLElement;
  navigation: ReturnType<typeof createWorkspaceNavigation>;
  buttonByText: (text: string) => HTMLButtonElement;
  unmount: () => Promise<void>;
}> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const navigation = createWorkspaceNavigation("prompts");
  const relations = createImagePromptRelations({ adapter: createTauriImagePromptRelationAdapter(), navigation });
  await act(async () => {
    root.render(<PromptImageLinks active={prompt} libraryId={LIBRARY_ID} relations={relations} />);
  });
  await flush();
  return {
    container,
    navigation,
    buttonByText: (text: string) => {
      const el = [...container.querySelectorAll("button")].find(
        (candidate) => candidate.textContent?.trim() === text,
      );
      if (el === undefined) throw new Error(`缺少按钮：${text}`);
      return el;
    },
    unmount: () =>
      act(async () => {
        root.unmount();
      }),
  };
}

test("缩略图单击只切换主预览，显式打开当前图片才定位删除态图片", async () => {
  const harness = await setupLinks();
  expect(harness.container.querySelector<HTMLElement>('[data-preview-hash]')?.dataset.previewHash).toBe(HASH_A);
  const deleted = harness.container.querySelector<HTMLButtonElement>('button[aria-label="预览关联图片 bbbb.png"]');
  if (deleted === null) throw new Error("缺少关联图片预览入口");
  await act(async () => deleted.click());
  expect(harness.container.querySelector<HTMLElement>('[data-preview-hash]')?.dataset.previewHash).toBe(HASH_B);
  expect(harness.container.textContent).toContain("bbbb.png · 800 × 600 · 第 2 / 2 张 · 已删除");
  expect(harness.navigation.active).toBe("prompts");
  expect(harness.navigation.entryFor("assets")).toEqual({ kind: "resume" });
  await act(async () => harness.buttonByText("打开当前图片").click());
  await flush();
  expect(harness.navigation.entryFor("assets")).toMatchObject({ kind: "locate_asset", hash: HASH_B, location: "trash" });
  await harness.unmount();
});

async function chooseLinkedImageAction(container: HTMLElement, filename: string, action: string): Promise<void> {
  const trigger = container.querySelector<HTMLButtonElement>(`button[aria-label="关联图片操作 ${filename}"]`);
  if (trigger === null) throw new Error(`缺少关联图片操作入口：${filename}`);
  trigger.focus();
  await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" })));
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((candidate) => candidate.textContent?.trim() === action);
  if (item === undefined) throw new Error(`关联图片菜单缺少：${action}`);
  await act(async () => item.click());
}

test("拖放订阅失败持续呈现原因且不再宣称可拖入", async () => {
  mockWindows("main");
  mockIPC((command) => {
    if (command === "linked_image_states") return [];
    if (command === "plugin:event|listen") throw new Error("拖放事件权限被拒绝");
    throw new Error(`未预期的 IPC：${command}`);
  });
  const harness = await setupLinks(makePrompt({ linked_image_hashes: [] }));
  try {
    expect(harness.container.textContent).toContain("拖放不可用");
    expect(harness.container.textContent).toContain("拖放事件权限被拒绝");
    expect(harness.container.textContent).not.toContain("把本地图片拖到这里");
    expect(harness.buttonByText("从本地导入").disabled).toBe(false);
  } finally {
    await harness.unmount();
  }
});

test("挂载读取关联状态：回收站项显式标记已删除，缺省封面落在第一张正常图", async () => {
  const harness = await setupLinks();

  const items = harness.container.querySelectorAll<HTMLElement>("[data-linked-hash]");
  expect(items).toHaveLength(2);

  // 第一张正常：缺省封面徽标，且不再提供"设为封面"。
  expect(items[0]?.dataset.linkedHash).toBe(HASH_A);
  expect(items[0]?.querySelector('[data-relation-badge="cover"]')?.textContent).toBe("封面");
  expect(items[0]?.querySelector('[data-relation-badge="deleted"]')).toBeNull();
  expect(items[0]?.textContent).toContain("800 × 600");
  expect(items[0]?.querySelector('button[aria-label="把第 1 张图片设为封面"]')).toBeNull();

  // 第二张在回收站：关联保留并显式标记，绝不冒充正常项。
  expect(items[1]?.dataset.linkedHash).toBe(HASH_B);
  expect(items[1]?.querySelector('[data-relation-badge="deleted"]')?.textContent).toBe("已删除");
  expect(items[1]?.querySelector('[data-relation-badge="cover"]')).toBeNull();
  // 已删除的图不能被设为封面（封面必须来自正常关联图片）。
  expect(
    harness.container.querySelector('button[aria-label="把第 2 张图片设为封面"]'),
  ).toBeNull();

  await harness.unmount();
});

test("关联图片缩略图卸载时释放全部媒体租约", async () => {
  let nextUrl = 0;
  const createUrl = vi.fn(() => `blob:linked-${++nextUrl}`);
  const revokeUrl = vi.fn();
  vi.stubGlobal("URL", { createObjectURL: createUrl, revokeObjectURL: revokeUrl });
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

  const harness = await setupLinks();
  // 两张缩略图各持有一份租约，当前主预览再持有一份；三者卸载时必须全部释放。
  await vi.waitFor(() => expect(createUrl).toHaveBeenCalledTimes(3));
  await harness.unmount();
  expect(revokeUrl).toHaveBeenCalledWith("blob:linked-1");
  expect(revokeUrl).toHaveBeenCalledWith("blob:linked-2");
  expect(revokeUrl).toHaveBeenCalledWith("blob:linked-3");
});

test("显式封面优先于缺省解析：取消封面回到缺省", async () => {
  const harness = await setupLinks(makePrompt({ cover_image_hash: HASH_B }));

  // 已删除图片可以保留关联与显式偏好供还原，但不能继续充当当前有效封面。
  const items = harness.container.querySelectorAll<HTMLElement>("[data-linked-hash]");
  expect(items[0]?.querySelector('[data-relation-badge="cover"]')?.textContent).toBe("封面");
  expect(items[1]?.querySelector('[data-relation-badge="cover"]')).toBeNull();
  expect(items[1]?.querySelector('[data-relation-badge="deleted"]')).not.toBeNull();

  await chooseLinkedImageAction(harness.container, "bbbb.png", "取消封面");
  await flush();
  expect(ipcCalls).toContainEqual({
    command: "set_prompt_cover",
    payload: { promptId: "prompt-0", cover: null },
  });

  await harness.unmount();
});

test("从图片库多选建立关联：已关联项显式禁用，确认走批量 link_images", async () => {
  const thirdHash = "c".repeat(64);
  const fourthHash = "d".repeat(64);
  candidates = [
    makeAsset(HASH_A, "已在关联里.png"),
    makeAsset(thirdHash, "候选三.png"),
    makeAsset(fourthHash, "候选四.png"),
  ];
  const harness = await setupLinks();

  await act(async () => harness.buttonByText("从图片库选择").click());
  await flush();

  // 已关联项保留身份与状态，避免使用者误以为搜索遗漏。
  const labels = [...document.querySelectorAll('[data-link-candidates] label span')].map(
    (el) => el.textContent,
  );
  expect(labels).toEqual([
    "已在关联里.png · 未分类 · 800 × 600 · 已关联",
    "候选三.png · 未分类 · 800 × 600",
    "候选四.png · 未分类 · 800 × 600",
  ]);
  expect(document.querySelector<HTMLInputElement>(`[data-link-candidates] input[value="${HASH_A}"]`)?.disabled).toBe(true);

  const third = document.querySelector<HTMLInputElement>(
    `[data-link-candidates] input[value="${thirdHash}"]`,
  );
  const fourth = document.querySelector<HTMLInputElement>(
    `[data-link-candidates] input[value="${fourthHash}"]`,
  );
  if (third === null || fourth === null) throw new Error("缺少候选复选框");
  await act(async () => {
    third.click();
    fourth.click();
  });
  const confirm = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "确认关联 2 张");
  if (confirm === undefined) throw new Error("缺少确认关联按钮");
  await act(async () => confirm.click());
  await flush();

  expect(ipcCalls).toContainEqual({
    command: "link_images",
    payload: { promptId: "prompt-0", hashes: [thirdHash, fourthHash] },
  });
  // 建立后选择器收起并重读关联格位；工作区刷新由关系 revision 统一驱动。
  expect(document.querySelector("[data-link-candidates]")).toBeNull();
  expect(ipcCalls.filter((call) => call.command === "linked_image_states")).toHaveLength(2);

  await harness.unmount();
});

test("解除关联走 unlink_image 并刷新权威", async () => {
  const harness = await setupLinks();

  await chooseLinkedImageAction(harness.container, "aaaa.png", "解除关联");
  await flush();

  expect(ipcCalls).toContainEqual({
    command: "unlink_image",
    payload: { promptId: "prompt-0", hash: HASH_A },
  });

  await harness.unmount();
});

test("关联图片缩略图提供独立直接解除入口且不触发预览主命中", async () => {
  const harness = await setupLinks();
  const preview = harness.container.querySelector<HTMLButtonElement>('button[aria-label="预览关联图片 aaaa.png"]');
  const directUnlink = harness.container.querySelector<HTMLButtonElement>('button[aria-label="解除与图片 aaaa.png 的关联"]');
  expect(preview).not.toBeNull();
  expect(directUnlink).not.toBeNull();
  expect(directUnlink).not.toBe(preview);

  await act(async () => directUnlink!.click());
  await flush();
  expect(ipcCalls).toContainEqual({
    command: "unlink_image",
    payload: { promptId: "prompt-0", hash: HASH_A },
  });
  expect(harness.navigation.active).toBe("prompts");
  await harness.unmount();
});

test("解除当前预览关系后回落到剩余有效封面", async () => {
  states = [linkedState(HASH_A, false), linkedState(HASH_B, false)];
  const harness = await setupLinks(makePrompt({ cover_image_hash: HASH_B, resolved_cover_hash: HASH_B }));
  expect(harness.container.querySelector<HTMLElement>('[data-preview-hash]')?.dataset.previewHash).toBe(HASH_B);
  await chooseLinkedImageAction(harness.container, "bbbb.png", "解除关联");
  await flush();
  expect(harness.container.querySelector<HTMLElement>('[data-preview-hash]')?.dataset.previewHash).toBe(HASH_A);
  expect(harness.container.textContent).toContain("aaaa.png · 800 × 600 · 第 1 / 1 张");
  await harness.unmount();
});

test("从本地导入：对话框路径进 import_and_link，逐项结果显式呈现", async () => {
  vi.mocked(openDialog).mockResolvedValue(["E:\\素材\\逆光.png"]);
  const harness = await setupLinks();

  await act(async () => harness.buttonByText("从本地导入").click());
  await flush();

  expect(ipcCalls).toContainEqual({
    command: "import_and_link",
    payload: { promptId: "prompt-0", sources: ["E:\\素材\\逆光.png"] },
  });
  const reportItem = harness.container.querySelector("[data-import-report] li");
  if (reportItem === null) throw new Error("缺少导入结果条目");
  expect(reportItem.textContent).toContain("逆光.png");
  expect(reportItem.textContent).toContain("已导入并关联");
  expect(ipcCalls.filter((call) => call.command === "linked_image_states").length).toBeGreaterThanOrEqual(2);

  await harness.unmount();
});

test("导入成功但关联失败：图片保留的说明带稳定错误码，绝不冒充已关联", async () => {
  ipcCalls = [];
  mockIPC((command, payload) => {
    if (command === "plugin:event|listen" || command === "plugin:event|unlisten") {
      return undefined;
    }
    ipcCalls.push({ command, payload });
    if (command === "linked_image_states") return [];
    if (command === "catalog_snapshot") return { assets: [] };
    if (command === "import_and_link") {
      return {
        items: [
          {
            source_path: "E:\\素材\\坏图.png",
            original_filename: "坏图.png",
            outcome: {
              kind: "imported_but_not_linked",
              hash: HASH_A,
              error: { code: "library.asset_metadata_write_failed", detail: null },
            },
          },
        ],
      };
    }
    throw new Error(`未预期的 IPC：${command}`);
  });
  vi.mocked(openDialog).mockResolvedValue(["E:\\素材\\坏图.png"]);
  const harness = await setupLinks();

  await act(async () => harness.buttonByText("从本地导入").click());
  await flush();

  const reportItem = harness.container.querySelector("[data-import-report] li");
  if (reportItem === null) throw new Error("缺少导入结果条目");
  expect(reportItem.textContent).toContain("已入库但未关联");
  expect(
    reportItem.querySelector('[data-error-code="library.asset_metadata_write_failed"]'),
  ).not.toBeNull();

  await harness.unmount();
});

test("拖入命中关联区才接管落点；悬停高亮随位置切换", async () => {
  const harness = await setupLinks();
  const zone = harness.container.querySelector<HTMLElement>('[data-drop-zone="prompt-images"]');
  if (zone === null) throw new Error("缺少拖入目标");
  vi.spyOn(zone, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    top: 0,
    left: 0,
    right: 200,
    bottom: 100,
    toJSON: () => ({}),
  });

  // 悬停在目标上：出现命中高亮，App 的认领查询同时为真。
  await act(async () => {
    handleFileDragEvent({ type: "enter", paths: ["E:\\a.png"], x: 50, y: 30 });
  });
  expect(zone.dataset.hover).toBe("true");
  expect(promptDropClaimsLatestPoint()).toBe(true);

  // 落下：路径交给 import_and_link，而不是整库导入。
  await act(async () => {
    handleFileDragEvent({ type: "drop", paths: ["E:\\a.png"], x: 50, y: 30 });
  });
  await flush();
  expect(
    ipcCalls.some((call) => call.command === "import_and_link"),
  ).toBe(true);
  expect(ipcCalls.filter((call) => call.command === "linked_image_states").length).toBeGreaterThanOrEqual(2);

  // 移出后落下：不认领，也不再次触发导入。
  const callsBefore = ipcCalls.filter((call) => call.command === "import_and_link").length;
  await act(async () => {
    handleFileDragEvent({ type: "move", paths: ["E:\\a.png"], x: 900, y: 700 });
    handleFileDragEvent({ type: "drop", paths: ["E:\\a.png"], x: 900, y: 700 });
  });
  expect(zone.dataset.hover).toBeUndefined();
  expect(promptDropClaimsLatestPoint()).toBe(false);
  expect(ipcCalls.filter((call) => call.command === "import_and_link")).toHaveLength(
    callsBefore,
  );

  await harness.unmount();
});
