// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";

import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

import type {
  AppError,
  AssetRow,
  GlobalSearchResult,
  PromptRow,
} from "../../shared/types";
import { GlobalSearchPanel, type GlobalLocateRequest } from "./GlobalSearch";

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
  tags: [],
  folders: [],
  colors: [],
};

function makePrompt(index: number, deletedAt: string | null = null): PromptRow {
  return {
    id: `prompt-${index}`,
    body: `正文首行 ${index}\n第二行细节`,
    title: null,
    model: null,
    parameters: null,
    note: "",
    favorite: false,
    folders: [],
    tags: [],
    linked_image_hashes: [],
    cover_image_hash: null,
    created_at: "2026-08-20T00:00:00Z",
    updated_at: "2026-08-21T00:00:00Z",
    deleted_at: deletedAt,
  };
}

let reply: GlobalSearchResult | AppError;
let searches: string[];

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  reply = { assets: [], prompts: [] };
  searches = [];
  mockIPC((command, payload) => {
    if (command === "global_search") {
      if (typeof payload !== "object" || payload === null || !("text" in payload)) {
        throw new TypeError("global_search 缺少 text");
      }
      const text = payload.text;
      if (typeof text !== "string") throw new TypeError("text 不是字符串");
      searches.push(text);
      if ("code" in reply) return Promise.reject(reply);
      return reply;
    }
    throw new Error(`未预期的 IPC：${command}`);
  });
});

afterEach(() => {
  clearMocks();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
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

async function setupPanel(onLocate: (request: GlobalLocateRequest) => void): Promise<{
  container: HTMLElement;
  unmount: () => Promise<void>;
}> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<GlobalSearchPanel onLocate={onLocate} />);
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

test("Ctrl+K 聚焦全局搜索框并全选既有内容", async () => {
  const harness = await setupPanel(() => {});
  const input = harness.container.querySelector<HTMLInputElement>(
    '[aria-label="全局搜索（图片与提示词）"]',
  );
  if (input === null) throw new Error("缺少全局搜索输入框");

  await act(async () => setInput(input, "人像"));
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }),
    );
  });
  expect(document.activeElement).toBe(input);
  // 聚焦即全选：连续按 Ctrl+K 直接覆盖上一轮查询。
  expect(input.selectionStart).toBe(0);
  expect(input.selectionEnd).toBe(input.value.length);

  await harness.unmount();
});

test("结果按素材类型分组计数，回收站条目带已删除标记并可定位", async () => {
  const trashedPrompt = makePrompt(2, "2026-08-21T01:00:00Z");
  reply = { assets: [ASSET], prompts: [makePrompt(1), trashedPrompt] };
  const located: GlobalLocateRequest[] = [];
  const harness = await setupPanel((request) => located.push(request));

  const input = harness.container.querySelector<HTMLInputElement>(
    '[aria-label="全局搜索（图片与提示词）"]',
  );
  if (input === null) throw new Error("缺少全局搜索输入框");
  await act(async () => setInput(input, "人像"));
  await flush();
  await flush();

  // 分组呈现与各组数量（规格：绝不混入一个无类型瀑布流）。
  const assetsGroup = harness.container.querySelector<HTMLElement>('[aria-label="图片素材（1）"]');
  const promptsGroup = harness.container.querySelector<HTMLElement>('[aria-label="提示词（2）"]');
  expect(assetsGroup).not.toBeNull();
  expect(promptsGroup).not.toBeNull();
  // 回收站里的提示词带显式删除标记。
  expect(promptsGroup?.querySelectorAll(".deleted-badge").length).toBe(1);

  // 进入一条回收站提示词：上报库归属、目标项与回收站位置，面板收起。
  const row = [...(promptsGroup?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent?.includes("正文首行 2"),
  );
  if (row === undefined) throw new Error("缺少回收站提示词结果行");
  await act(async () => row.click());
  expect(located).toEqual([
    { section: "prompts", id: "prompt-2", inTrash: true },
  ]);
  expect(harness.container.querySelector("#global-search-results")).toBeNull();

  await harness.unmount();
});

test("搜索失败时错误码原样呈现；清空查询后结果消失", async () => {
  reply = { code: "library.global_search_failed", detail: "索引不可用" };
  const harness = await setupPanel(() => {});

  const input = harness.container.querySelector<HTMLInputElement>(
    '[aria-label="全局搜索（图片与提示词）"]',
  );
  if (input === null) throw new Error("缺少全局搜索输入框");
  await act(async () => setInput(input, "人像"));
  await flush();
  await flush();
  const alert = harness.container.querySelector<HTMLParagraphElement>(
    '[data-error-code="library.global_search_failed"]',
  );
  if (alert === null) throw new Error("缺少带错误码的错误行");
  expect(alert.getAttribute("role")).toBe("alert");

  await act(async () => setInput(input, ""));
  await flush();
  await flush();
  expect(harness.container.querySelector("#global-search-results")).toBeNull();
  expect(harness.container.querySelector("[role=alert]")).toBeNull();

  await harness.unmount();
});
