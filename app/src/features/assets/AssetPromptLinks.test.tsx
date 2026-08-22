// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

import type { PromptRow, PromptSnapshot } from "../../shared/types";
import { AssetPromptLinks } from "./AssetPromptLinks";

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
});

afterEach(() => {
  clearMocks();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

const HASH = "b".repeat(64);

function makePrompt(id: string, overrides: Partial<PromptRow> = {}): PromptRow {
  return {
    id,
    body: `提示词正文 ${id}\n第二行`,
    title: null,
    model: "test-model",
    parameters: null,
    note: "",
    favorite: false,
    folders: [],
    tags: [],
    linked_image_hashes: [HASH],
    cover_image_hash: null,
    created_at: "2026-08-20T00:00:00Z",
    updated_at: "2026-08-20T00:00:00Z",
    deleted_at: null,
    ...overrides,
  };
}

function makeSnapshot(prompts: readonly PromptRow[]): PromptSnapshot {
  return { prompts: [...prompts], folders: [], tags: [], trash_count: 0 };
}

async function setupLinks(): Promise<{
  root: HTMLElement;
  button: (text: string) => HTMLButtonElement;
}> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<AssetPromptLinks hash={HASH} />);
  });
  return {
    root: container,
    button: (text: string) => {
      const el = [...container.querySelectorAll("button")].find(
        (candidate) => candidate.textContent?.trim() === text,
      );
      if (el === undefined) throw new Error(`缺少按钮：${text}`);
      return el;
    },
  };
}

function setInput(input: HTMLInputElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  if (descriptor?.set === undefined) throw new Error("HTMLInputElement.value setter 不存在");
  descriptor.set.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

test("挂载后呈现已关联提示词并对回收站项显式标记已删除", async () => {
  const normal = makePrompt("p1", { title: "人像布光" });
  const trashed = makePrompt("p2", { title: "已删提示词", deleted_at: "2026-08-21T00:00:00Z" });
  mockIPC((command) => {
    if (command === "image_detail") {
      return { asset: {}, linked_prompts: [normal, trashed] };
    }
    throw new Error(`未预期的 IPC：${command}`);
  });

  const harness = await setupLinks();
  const items = [...harness.root.querySelectorAll("[data-linked-prompt]")];
  expect(items.map((item) => item.getAttribute("data-prompt-id"))).toEqual(["p1", "p2"]);
  // 回收站提示词保留显示并显式标记，而不是静默隐藏。
  expect(items[1]?.querySelector(".deleted-badge")?.textContent).toBe("已删除");
  expect(items[0]?.querySelector(".deleted-badge")).toBeNull();
});

test("解除关联调用 unlink_image 并刷新关联列表", async () => {
  const p1 = makePrompt("p1", { title: "人像布光" });
  const p2 = makePrompt("p2", { title: "夜景色调" });
  let linked: PromptRow[] = [p1, p2];
  const ipcCalls: Array<{ command: string; payload: unknown }> = [];
  mockIPC((command, payload) => {
    ipcCalls.push({ command, payload });
    if (command === "image_detail") {
      return { asset: {}, linked_prompts: linked };
    }
    if (command === "unlink_image") {
      if (!isRecord(payload) || typeof payload.promptId !== "string") {
        throw new TypeError("unlink_image 载荷缺少 promptId");
      }
      linked = linked.filter((prompt) => prompt.id !== payload.promptId);
      return undefined;
    }
    throw new Error(`未预期的 IPC：${command}`);
  });

  const harness = await setupLinks();
  const unlink = harness.root.querySelector<HTMLButtonElement>(
    '[aria-label="解除关联 人像布光"]',
  );
  if (unlink === null) throw new Error("缺少解除关联按钮");
  await act(async () => unlink.click());
  await act(async () => {});

  expect(ipcCalls).toContainEqual({
    command: "unlink_image",
    payload: { promptId: "p1", hash: HASH },
  });
  // 列表刷新后只剩另一条关联。
  const remaining = [...harness.root.querySelectorAll("[data-prompt-id]")];
  expect(remaining.map((item) => item.getAttribute("data-prompt-id"))).toEqual(["p2"]);
});

test("建立关联从候选多选写入并在刷新后可见", async () => {
  let linked: PromptRow[] = [];
  const candidates = [
    makePrompt("c1", { title: "水彩风格" }),
    makePrompt("c2", { title: "赛博朋克" }),
  ];
  const snapshotQueries: Array<{ text: string; location: string }> = [];
  const ipcCalls: Array<{ command: string; payload: unknown }> = [];
  mockIPC((command, payload) => {
    ipcCalls.push({ command, payload });
    if (command === "image_detail") {
      return { asset: {}, linked_prompts: linked };
    }
    if (command === "prompt_snapshot") {
      snapshotQueries.push(snapshotQuery(payload));
      return makeSnapshot(candidates);
    }
    if (command === "link_images") {
      const { promptId, hashes } = linkPayload(payload);
      if (hashes.length !== 1 || hashes[0] !== HASH) {
        throw new Error(`link_images 载荷异常：${JSON.stringify(hashes)}`);
      }
      const found = candidates.find((prompt) => prompt.id === promptId);
      if (found !== undefined) linked = [...linked, found];
      return undefined;
    }
    throw new Error(`未预期的 IPC：${command}`);
  });

  const harness = await setupLinks();

  // 打开选择器：候选来自提示词查询（活动区）。
  await act(async () => harness.button("建立关联").click());
  await act(async () => {});
  expect(snapshotQueries.at(-1)?.location).toBe("active");

  // 多选两条候选并确认。
  const c1 = harness.root.querySelector<HTMLInputElement>('input[value="c1"]');
  const c2 = harness.root.querySelector<HTMLInputElement>('input[value="c2"]');
  if (c1 === null || c2 === null) throw new Error("缺少候选复选框");
  await act(async () => c1.click());
  await act(async () => c2.click());
  await act(async () => harness.button("确认关联").click());
  await act(async () => {});

  // 逐条写入：每条提示词一次 link_images。
  expect(ipcCommandPayloads(ipcCalls, "link_images")).toEqual([
    { promptId: "c1", hashes: [HASH] },
    { promptId: "c2", hashes: [HASH] },
  ]);
  const linkedNow = [...harness.root.querySelectorAll("[data-prompt-id]")];
  expect(linkedNow.map((item) => item.getAttribute("data-prompt-id"))).toEqual(["c1", "c2"]);
});

test("选择器按文件名文本过滤候选", async () => {
  const candidates = [makePrompt("c1", { title: "水彩风格" })];
  mockIPC((command, payload) => {
    if (command === "image_detail") return { asset: {}, linked_prompts: [] };
    if (command === "prompt_snapshot") {
      const { text } = snapshotQuery(payload);
      return makeSnapshot(text.includes("水彩") ? candidates : []);
    }
    throw new Error(`未预期的 IPC：${command}`);
  });

  const harness = await setupLinks();
  await act(async () => harness.button("建立关联").click());
  await act(async () => {});
  const search = harness.root.querySelector<HTMLInputElement>("#link-prompt-search");
  if (search === null) throw new Error("缺少候选搜索框");
  await act(async () => setInput(search, "水彩"));
  await act(async () => {});
  expect(harness.root.querySelector('input[value="c1"]')).not.toBeNull();

  await act(async () => setInput(search, "不存在"));
  await act(async () => {});
  expect(harness.root.textContent).toContain("没有匹配的提示词");
});

/** 抽取指定命令的载荷序列。 */
function ipcCommandPayloads(
  calls: Array<{ command: string; payload: unknown }>,
  command: string,
): unknown[] {
  return calls.filter((call) => call.command === command).map((call) => call.payload);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 解出 prompt_snapshot 载荷里的 query 文本与位置。 */
function snapshotQuery(payload: unknown): { text: string; location: string } {
  if (
    !isRecord(payload) ||
    !isRecord(payload.query) ||
    typeof payload.query.text !== "string" ||
    typeof payload.query.location !== "string"
  ) {
    throw new TypeError("prompt_snapshot 载荷缺少 query.text/location");
  }
  return { text: payload.query.text, location: payload.query.location };
}

/** 解出 link_images 载荷。 */
function linkPayload(payload: unknown): { promptId: string; hashes: string[] } {
  if (!isRecord(payload) || typeof payload.promptId !== "string" || !Array.isArray(payload.hashes)) {
    throw new TypeError("link_images 载荷缺少 promptId/hashes");
  }
  const hashes: string[] = [];
  for (const item of payload.hashes) {
    if (typeof item !== "string") throw new TypeError("link_images 的 hashes 含非字符串");
    hashes.push(item);
  }
  return { promptId: payload.promptId, hashes };
}
