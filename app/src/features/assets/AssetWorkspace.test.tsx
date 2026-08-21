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

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
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
    root.render(<AssetWorkspace refreshVersion={0} />);
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

test("在素材详情中编辑标签并确认删除", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<AssetWorkspace refreshVersion={0} />);
  });
  await flush();

  const assetButton = container.querySelector<HTMLButtonElement>(".asset-card > button");
  if (assetButton === null) throw new Error("缺少素材卡片");
  await act(async () => assetButton.click());
  await flush();

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

  await act(async () => buttonWithText(container, "移入回收站").click());
  const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
  if (dialog === null) throw new Error("缺少删除确认对话框");
  expect(dialog.textContent).toContain("可从回收站还原");
  await act(async () => buttonWithText(dialog, "移入回收站").click());
  await flush();
  expect(ipcCalls).toContainEqual({ command: "delete_asset", payload: { hash: ASSET.hash } });

  await act(async () => root.unmount());
});

test("从回收站还原并保留缺失文件夹警告", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<AssetWorkspace refreshVersion={0} />);
  });
  await flush();

  const trash = container.querySelector<HTMLButtonElement>('[aria-label="回收站"]');
  if (trash === null) throw new Error("缺少回收站入口");
  await act(async () => trash.click());
  await flush();
  const assetButton = container.querySelector<HTMLButtonElement>(".asset-card > button");
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
