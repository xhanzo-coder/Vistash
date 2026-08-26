// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
// 对话框在组件里经 shared/ipc 间接调用；这里把插件模块整个换掉。
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(async () => null),
}));
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import type { AssetRow, PromptRow } from "../../shared/types";
import {
  handleFileDragEvent,
  promptDropClaimsLatestPoint,
} from "./promptDropZone";
import { PromptImageLinks } from "./PromptImageLinks";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

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
let states: Array<{ hash: string; deleted: boolean }> | Error;
/** catalog_snapshot 的活动库应答。 */
let candidates: AssetRow[];
let changedCount: number;

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  ipcCalls = [];
  states = [
    { hash: HASH_A, deleted: false },
    { hash: HASH_B, deleted: true },
  ];
  candidates = [];
  changedCount = 0;
  mockIPC((command, payload) => {
    if (command === "plugin:event|listen" || command === "plugin:event|unlisten") {
      // 组件尝试订阅 Tauri 拖放事件：mock 环境没有真实事件流，静默应答即可。
      return undefined;
    }
    ipcCalls.push({ command, payload });
    if (command === "linked_image_states") {
      if (states instanceof Error) throw states;
      return states;
    }
    if (command === "catalog_snapshot") return { assets: candidates };
    if (
      command === "link_images" ||
      command === "unlink_image" ||
      command === "set_prompt_cover"
    ) {
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
  buttonByText: (text: string) => HTMLButtonElement;
  unmount: () => Promise<void>;
}> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<PromptImageLinks active={prompt} onChanged={() => void changedCount++} />);
  });
  await flush();
  return {
    container,
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

test("挂载读取关联状态：回收站项显式标记已删除，缺省封面落在第一张正常图", async () => {
  const harness = await setupLinks();

  const items = harness.container.querySelectorAll<HTMLElement>("[data-linked-hash]");
  expect(items).toHaveLength(2);

  // 第一张正常：缺省封面徽标，且不再提供"设为封面"。
  expect(items[0]?.dataset.linkedHash).toBe(HASH_A);
  expect(items[0]?.querySelector(".cover-badge")?.textContent).toBe("封面");
  expect(items[0]?.querySelector(".deleted-badge")).toBeNull();
  expect(items[0]?.querySelector('button[aria-label="把第 1 张图片设为封面"]')).toBeNull();

  // 第二张在回收站：关联保留并显式标记，绝不冒充正常项。
  expect(items[1]?.dataset.linkedHash).toBe(HASH_B);
  expect(items[1]?.querySelector(".deleted-badge")?.textContent).toBe("已删除");
  expect(items[1]?.querySelector(".cover-badge")).toBeNull();
  // 已删除的图不能被设为封面（封面必须来自正常关联图片）。
  expect(
    harness.container.querySelector('button[aria-label="把第 2 张图片设为封面"]'),
  ).toBeNull();

  await harness.unmount();
});

test("显式封面优先于缺省解析：取消封面回到缺省", async () => {
  const harness = await setupLinks(makePrompt({ cover_image_hash: HASH_B }));

  // 已删除图片可以保留关联与显式偏好供还原，但不能继续充当当前有效封面。
  const items = harness.container.querySelectorAll<HTMLElement>("[data-linked-hash]");
  expect(items[0]?.querySelector(".cover-badge")?.textContent).toBe("封面");
  expect(items[1]?.querySelector(".cover-badge")).toBeNull();
  expect(items[1]?.querySelector(".deleted-badge")).not.toBeNull();

  await act(async () =>
    harness.container
      .querySelector<HTMLButtonElement>('button[aria-label="取消第 2 张图片的封面"]')
      ?.click(),
  );
  await flush();
  expect(ipcCalls).toContainEqual({
    command: "set_prompt_cover",
    payload: { promptId: "prompt-0", cover: null },
  });

  await harness.unmount();
});

test("从图片库多选建立关联：候选排除已关联项，确认走批量 link_images", async () => {
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

  // 已关联的哈希不再出现在候选里。
  const labels = [...harness.container.querySelectorAll(".link-candidates label span")].map(
    (el) => el.textContent,
  );
  expect(labels).toEqual(["候选三.png", "候选四.png"]);

  const third = harness.container.querySelector<HTMLInputElement>(
    `.link-candidates input[value="${thirdHash}"]`,
  );
  const fourth = harness.container.querySelector<HTMLInputElement>(
    `.link-candidates input[value="${fourthHash}"]`,
  );
  if (third === null || fourth === null) throw new Error("缺少候选复选框");
  await act(async () => {
    third.click();
    fourth.click();
  });
  await act(async () => harness.buttonByText("确认关联").click());
  await flush();

  expect(ipcCalls).toContainEqual({
    command: "link_images",
    payload: { promptId: "prompt-0", hashes: [thirdHash, fourthHash] },
  });
  // 建立后选择器收起、权威状态重读、工作区收到刷新通知。
  expect(harness.container.querySelector(".link-candidates")).toBeNull();
  expect(ipcCalls.filter((call) => call.command === "linked_image_states")).toHaveLength(2);
  expect(changedCount).toBe(1);

  await harness.unmount();
});

test("解除关联走 unlink_image 并刷新权威", async () => {
  const harness = await setupLinks();

  const unlink = harness.container.querySelector<HTMLButtonElement>(
    'button[aria-label="解除关联第 1 张图片"]',
  );
  if (unlink === null) throw new Error("缺少解除按钮");
  await act(async () => unlink.click());
  await flush();

  expect(ipcCalls).toContainEqual({
    command: "unlink_image",
    payload: { promptId: "prompt-0", hash: HASH_A },
  });
  expect(changedCount).toBe(1);

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
  const reportItem = harness.container.querySelector(".import-report li");
  if (reportItem === null) throw new Error("缺少导入结果条目");
  expect(reportItem.textContent).toContain("逆光.png");
  expect(reportItem.textContent).toContain("已导入并关联");
  expect(changedCount).toBe(1);

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

  const reportItem = harness.container.querySelector(".import-report li");
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
  expect(zone.className).toContain("is-hover");
  expect(promptDropClaimsLatestPoint()).toBe(true);

  // 落下：路径交给 import_and_link，而不是整库导入。
  await act(async () => {
    handleFileDragEvent({ type: "drop", paths: ["E:\\a.png"], x: 50, y: 30 });
  });
  await flush();
  expect(
    ipcCalls.some((call) => call.command === "import_and_link"),
  ).toBe(true);
  expect(changedCount).toBeGreaterThanOrEqual(1);

  // 移出后落下：不认领，也不再次触发导入。
  const callsBefore = ipcCalls.filter((call) => call.command === "import_and_link").length;
  await act(async () => {
    handleFileDragEvent({ type: "move", paths: ["E:\\a.png"], x: 900, y: 700 });
    handleFileDragEvent({ type: "drop", paths: ["E:\\a.png"], x: 900, y: 700 });
  });
  expect(zone.className).not.toContain("is-hover");
  expect(promptDropClaimsLatestPoint()).toBe(false);
  expect(ipcCalls.filter((call) => call.command === "import_and_link")).toHaveLength(
    callsBefore,
  );

  await harness.unmount();
});
