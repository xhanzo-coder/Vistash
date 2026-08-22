// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

import { SelectionProvider, useSelection } from "../workspace/selectionContext";
import type { AssetRow, PromptRow } from "../../shared/types";
import { AssetInspector } from "./AssetInspector";

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  // 关联提示词分区挂载即拉取 image_detail；多选分区的批量关联选择器自取
  // prompt_snapshot 候选（任务 11.2）：本文件只测检查器自身，两者都给空集。
  mockIPC((command) => {
    if (command === "image_detail") return { asset: {}, linked_prompts: [] };
    if (command === "prompt_snapshot") {
      return { prompts: [], folders: [], tags: [], trash_count: 0 };
    }
    throw new Error(`未预期的 IPC：${command}`);
  });
});

afterEach(() => {
  clearMocks();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function makeAsset(overrides: Partial<AssetRow> = {}): AssetRow {
  return {
    hash: "b".repeat(64),
    hash_algo: "sha256",
    media_type: "png",
    ext: "png",
    byte_size: 2048,
    width: 1920,
    height: 1080,
    imported_at: "2026-08-21T08:30:00Z",
    original_filename: "人物参考.png",
    source_path: null,
    deleted_at: null,
    color_card_status: "ok",
    color_card_algo_version: 1,
    color_card_failure_reason: null,
    color_card_sampled_pixel_count: 100,
    note: "构图说明第一行\n第二行",
    favorite: false,
    tags: ["人物"],
    folders: ["参考"],
    colors: [
      { hex: "#112233", role: "dominant", share: 0.6, oklab_l: 0.2, oklab_a: 0.01, oklab_b: -0.02 },
      { hex: "#445566", role: "accent", share: 0.2, oklab_l: 0.4, oklab_a: -0.01, oklab_b: -0.04 },
    ],
    ...overrides,
  };
}

type Handlers = {
  onSetFolders?: (hash: string, folders: string[]) => void;
  onSetTags?: (hash: string, tags: string[]) => void;
  onDeleteAsset?: (hash: string) => void;
  onRestoreAsset?: (hash: string) => void;
  onToggleFavorite?: (hash: string, favorite: boolean) => void;
  // 批量动作（任务 11.2）：只记录意图，写入与报告由工作区测试覆盖。
  onBatchFolders?: (hashes: string[], path: string, add: boolean) => void;
  onBatchTags?: (hashes: string[], tag: string, add: boolean) => void;
  onBatchFavorite?: (hashes: string[], favorite: boolean) => void;
  onBatchLinkToPrompt?: (promptId: string, hashes: string[]) => void;
  onBatchDelete?: (hashes: string[]) => void;
};

/**
 * 视图替身：渲染与瀑布流卡片同构的单击按钮，把点击翻译成选择模型动作，
 * 让检查器测试不必挂载整个虚拟化视图。
 */
function ClickProxy({ assets }: { assets: readonly AssetRow[] }) {
  const { onItemClick } = useSelection();
  return (
    <>
      {assets.map((asset) => (
        <button
          key={asset.hash}
          type="button"
          data-proxy={asset.hash}
          onClick={(event) => onItemClick(asset.hash, event)}
        >
          {asset.original_filename}
        </button>
      ))}
    </>
  );
}

async function setupInspector(
  assets: readonly AssetRow[],
  handlers: Handlers = {},
  options: { trashLocation?: boolean } = {},
): Promise<{
  root: HTMLElement;
  proxy: (index: number) => HTMLButtonElement;
  section: (key: string) => HTMLElement;
  button: (text: string) => HTMLButtonElement;
}> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  /**
   * 组织回调后把权威变更应用回素材副本再重渲染，模拟生产里
   * 回调 → 权威写入 → 快照刷新 → 新 props 的完整回路。
   */
  function Harness() {
    const [current, setCurrent] = useState(assets);
    return (
      <SelectionProvider ids={current.map((asset) => asset.hash)}>
        <ClickProxy assets={current} />
        <AssetInspector
          assets={current}
          folders={["参考", "参考/构图"]}
          mutating={false}
          trashLocation={options.trashLocation ?? false}
          onSetFolders={(hash, folders) => {
            handlers.onSetFolders?.(hash, folders);
            setCurrent((rows) =>
              rows.map((asset) => (asset.hash === hash ? { ...asset, folders } : asset)),
            );
          }}
          onSetTags={(hash, tags) => {
            handlers.onSetTags?.(hash, tags);
            setCurrent((rows) =>
              rows.map((asset) => (asset.hash === hash ? { ...asset, tags } : asset)),
            );
          }}
          onDeleteAsset={handlers.onDeleteAsset ?? (() => {})}
          onRestoreAsset={handlers.onRestoreAsset ?? (() => {})}
          onToggleFavorite={handlers.onToggleFavorite ?? (() => {})}
          onBatchFolders={(hashes, path, add) =>
            handlers.onBatchFolders?.(hashes, path, add)
          }
          onBatchTags={(hashes, tag, add) => handlers.onBatchTags?.(hashes, tag, add)}
          onBatchFavorite={(hashes, favorite) =>
            handlers.onBatchFavorite?.(hashes, favorite)
          }
          onBatchLinkToPrompt={(promptId, hashes) =>
            handlers.onBatchLinkToPrompt?.(promptId, hashes)
          }
          onBatchDelete={(hashes) => handlers.onBatchDelete?.(hashes)}
        />
      </SelectionProvider>
    );
  }

  await act(async () => {
    root.render(<Harness />);
  });
  return {
    root: container,
    proxy: (index: number) => {
      const el = container.querySelector<HTMLButtonElement>(
        `[data-proxy="${assets[index]?.hash ?? ""}"]`,
      );
      if (el === null) throw new Error(`缺少第 ${index} 个视图替身按钮`);
      return el;
    },
    section: (key: string) => {
      const el = container.querySelector<HTMLElement>(
        `[data-inspector-section="${key}"]`,
      );
      if (el === null) throw new Error(`缺少检查器分区：${key}`);
      return el;
    },
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

function setSelect(select: HTMLSelectElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
  if (descriptor?.set === undefined) throw new Error("HTMLSelectElement.value setter 不存在");
  descriptor.set.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

/** 批量关联选择器的提示词候选夹具（任务 11.2）。 */
function makePrompt(overrides: Partial<PromptRow> = {}): PromptRow {
  return {
    id: "prompt-1",
    body: "一只猫坐在窗台上",
    title: "夜景构图",
    model: null,
    parameters: null,
    note: "",
    favorite: false,
    folders: [],
    tags: [],
    linked_image_hashes: [],
    cover_image_hash: null,
    created_at: "2026-08-20T08:00:00Z",
    updated_at: "2026-08-21T08:00:00Z",
    deleted_at: null,
    ...overrides,
  };
}

test("无活动项时呈现操作引导而不是空白", async () => {
  const harness = await setupInspector([]);
  expect(harness.root.querySelector(".inspector-placeholder")?.textContent).toContain(
    "单击一张图片",
  );
});

test("活动项的信息与色卡分区呈现元数据、色卡状态与主色", async () => {
  const asset = makeAsset();
  const harness = await setupInspector([asset]);
  await act(async () => harness.proxy(0).click());

  const info = harness.section("info");
  expect(info.textContent).toContain("人物参考.png");
  expect(info.textContent).toContain("1920 × 1080");
  expect(info.textContent).toContain("png");
  expect(info.textContent).toContain("2 KB");
  expect(info.textContent).toContain("2026-08-21");
  // 色卡：主色/强调色角色与 HEX 一并呈现。
  expect(info.textContent).toContain("#112233");
  expect(info.textContent).toContain("主色");
  expect(info.textContent).toContain("#445566");
  expect(info.textContent).toContain("强调色");
});

test("色卡失败时信息分区显示稳定错误码而不是假色卡", async () => {
  const asset = makeAsset({
    color_card_status: "failed",
    color_card_failure_reason: "color_card.cluster_failed",
    colors: [],
  });
  const harness = await setupInspector([asset]);
  await act(async () => harness.proxy(0).click());

  const failure = harness
    .section("info")
    .querySelector<HTMLElement>('[data-error-code="color_card.cluster_failed"]');
  if (failure === null) throw new Error("缺少色卡失败提示");
  expect(failure.textContent).toContain("100");
});

test("组织分区的文件夹勾选与标签增删触发回调", async () => {
  const asset = makeAsset();
  const calls: Array<{ kind: string; folders?: string[]; tags?: string[] }> = [];
  const harness = await setupInspector([asset], {
    onSetFolders: (_hash, folders) => calls.push({ kind: "folders", folders }),
    onSetTags: (_hash, tags) => calls.push({ kind: "tags", tags }),
  });
  await act(async () => harness.proxy(0).click());

  // 勾选"参考/构图"：在既有归属上追加。
  const checkbox = harness.section("organization").querySelector<HTMLInputElement>(
    'input[type="checkbox"][value="参考/构图"]',
  );
  if (checkbox === null) throw new Error("缺少文件夹复选框");
  await act(async () => checkbox.click());
  expect(calls).toEqual([{ kind: "folders", folders: ["参考", "参考/构图"] }]);

  // 添加标签 夜景。
  const tagInput = harness.root.querySelector<HTMLInputElement>("#new-tag");
  if (tagInput === null) throw new Error("缺少标签输入框");
  await act(async () => {
    setInput(tagInput, "夜景");
    harness.button("添加").click();
  });
  expect(calls.at(-1)).toEqual({ kind: "tags", tags: ["人物", "夜景"] });

  // 移除标签 人物（芯片按钮以 aria-label 命名）。
  const removeTag = harness.root.querySelector<HTMLButtonElement>(
    '[aria-label="移除标签 人物"]',
  );
  if (removeTag === null) throw new Error("缺少移除标签按钮");
  await act(async () => removeTag.click());
  expect(calls.at(-1)).toEqual({ kind: "tags", tags: ["夜景"] });
});

test("回收站位置的检查器以还原入口替代组织编辑", async () => {
  const restored: string[] = [];
  const asset = makeAsset({ deleted_at: "2026-08-19T01:00:00Z" });
  const harness = await setupInspector(
    [asset],
    { onRestoreAsset: (hash) => restored.push(hash) },
    { trashLocation: true },
  );
  await act(async () => harness.proxy(0).click());

  await act(async () => harness.button("还原素材").click());
  expect(restored).toEqual([asset.hash]);
  expect(harness.root.querySelector("#new-tag")).toBeNull();

  // 回收站里的素材不允许再次删除，只允许还原或清空。
  expect([...harness.root.querySelectorAll("button")].map((b) => b.textContent)).not.toContain(
    "移入回收站",
  );
});

test("备注分区提供自动保存编辑框并预填权威值", async () => {
  const harness = await setupInspector([makeAsset()]);
  await act(async () => harness.proxy(0).click());

  const note = harness.section("note");
  const textarea = note.querySelector<HTMLTextAreaElement>('textarea[aria-label="图片备注"]');
  if (textarea === null) throw new Error("缺少备注编辑框");
  expect(textarea.value).toBe("构图说明第一行\n第二行");
  // 保存状态区存在（保存中/已保存/失败由 AssetNoteEditor 自身测试覆盖）。
  expect(note.querySelector(".note-status")).not.toBeNull();
});

test("收藏快捷开关报告目标状态且初始与素材一致", async () => {
  const toggles: Array<{ hash: string; favorite: boolean }> = [];
  const asset = makeAsset({ favorite: false });
  const harness = await setupInspector(
    [asset],
    { onToggleFavorite: (hash, favorite) => toggles.push({ hash, favorite }) },
  );
  await act(async () => harness.proxy(0).click());

  const button = harness.root.querySelector<HTMLButtonElement>(".favorite-toggle");
  if (button === null) throw new Error("缺少收藏开关");
  expect(button.getAttribute("aria-pressed")).toBe("false");

  await act(async () => button.click());
  expect(toggles).toEqual([{ hash: asset.hash, favorite: true }]);
});

test("活动项下四个规格分区全部可定位", async () => {
  const harness = await setupInspector([makeAsset()]);
  await act(async () => harness.proxy(0).click());

  expect(harness.section("info")).not.toBeNull();
  expect(harness.section("organization")).not.toBeNull();
  expect(harness.section("note")).not.toBeNull();
  // 关联提示词分区（任务 9.3 第二循环）由 AssetPromptLinks 提供内容。
  expect(harness.section("links").textContent).toContain("关联提示词");
});

test("多选时检查器只呈现数量摘要而不呈现单件分区", async () => {
  const first = makeAsset();
  const second = makeAsset({
    hash: "c".repeat(64),
    original_filename: "另一张.png",
  });
  const harness = await setupInspector([first, second]);

  await act(async () => harness.proxy(0).click());
  await act(async () => {
    harness.proxy(1).dispatchEvent(new MouseEvent("click", { ctrlKey: true, bubbles: true }));
  });

  expect(harness.root.textContent).toContain("已选 2 项");
  expect(() => harness.section("info")).toThrow();
  expect(() => harness.section("organization")).toThrow();
});

test("多选批量组织分区按共同值呈现并携带完整选中集合上报", async () => {
  const first = makeAsset();
  const second = makeAsset({ hash: "c".repeat(64) });
  // 两项都拥有标签"人物"（共同值）；文件夹"参考/构图"只在第一项里（混合值，
  // 呈现为待补齐的半选）。批量动作只记录意图，写入由工作区测试覆盖。
  const batch: Array<{
    kind: string;
    hashes?: string[];
    target?: string;
    add?: boolean;
  }> = [];
  const harness = await setupInspector([first, second], {
    onBatchFolders: (hashes, path, add) =>
      batch.push({ kind: "folders", hashes, target: path, add }),
    onBatchTags: (hashes, tag, add) =>
      batch.push({ kind: "tags", hashes, target: tag, add }),
    onBatchFavorite: (hashes, favorite) =>
      batch.push({ kind: "favorite", hashes, add: favorite }),
  });

  await act(async () => harness.proxy(0).click());
  await act(async () => {
    harness.proxy(1).dispatchEvent(new MouseEvent("click", { ctrlKey: true, bubbles: true }));
  });

  // 文件夹三态：两项都没有"参考/构图"，勾选即批量加入。
  const joinFolder = harness.root.querySelector<HTMLInputElement>(
    '[aria-label="批量加入文件夹 参考/构图"]',
  );
  if (joinFolder === null) throw new Error("缺少批量加入文件夹复选框");
  await act(async () => joinFolder.click());
  expect(batch.at(-1)).toEqual({
    kind: "folders",
    hashes: [first.hash, second.hash],
    target: "参考/构图",
    add: true,
  });

  // 标签并集：共同值"人物"以按下状态呈现，点击即批量移除。
  const removeTag = harness.root.querySelector<HTMLButtonElement>(
    '[aria-label="批量移除标签 人物"]',
  );
  if (removeTag === null) throw new Error("缺少批量移除标签按钮");
  expect(removeTag.getAttribute("aria-pressed")).toBe("true");
  await act(async () => removeTag.click());
  expect(batch.at(-1)).toEqual({
    kind: "tags",
    hashes: [first.hash, second.hash],
    target: "人物",
    add: false,
  });

  // 新标签经表单批量添加到全部选中项。
  const tagInput = harness.root.querySelector<HTMLInputElement>("#batch-new-tag");
  if (tagInput === null) throw new Error("缺少批量标签输入框");
  await act(async () => {
    setInput(tagInput, "夜景");
    harness.button("添加").click();
  });
  expect(batch.at(-1)).toEqual({
    kind: "tags",
    hashes: [first.hash, second.hash],
    target: "夜景",
    add: true,
  });

  // 收藏是二值字段：两项都未收藏 → 提供全部收藏出路。
  const favoriteButton = [...harness.root.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === "全部收藏",
  );
  if (favoriteButton === undefined) throw new Error("缺少全部收藏按钮");
  await act(async () => favoriteButton.click());
  expect(batch.at(-1)).toEqual({
    kind: "favorite",
    hashes: [first.hash, second.hash],
    add: true,
  });
});

test("批量关联分区自取提示词候选并在提交时上报选中集合", async () => {
  mockIPC((command) => {
    if (command === "image_detail") return { asset: {}, linked_prompts: [] };
    if (command === "prompt_snapshot") {
      return {
        prompts: [makePrompt()],
        folders: [],
        tags: [],
        trash_count: 0,
      };
    }
    throw new Error(`未预期的 IPC：${command}`);
  });
  const links: Array<{ promptId: string; hashes: string[] }> = [];
  const first = makeAsset();
  const second = makeAsset({ hash: "c".repeat(64) });
  const harness = await setupInspector(
    [first, second],
    { onBatchLinkToPrompt: (promptId, hashes) => links.push({ promptId, hashes }) },
  );

  await act(async () => harness.proxy(0).click());
  await act(async () => {
    harness.proxy(1).dispatchEvent(new MouseEvent("click", { ctrlKey: true, bubbles: true }));
  });

  const linksSection = harness.section("batch-links");
  expect(linksSection.textContent).toContain("批量建立提示词关联");
  const select = linksSection.querySelector<HTMLSelectElement>("#batch-link-prompt");
  if (select === null) throw new Error("缺少目标提示词选择器");
  await act(async () => setSelect(select, "prompt-1"));

  const submit = [...linksSection.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === "建立关联",
  );
  if (submit === undefined) throw new Error("缺少建立关联按钮");
  await act(async () => submit.click());
  expect(links).toEqual([{ promptId: "prompt-1", hashes: [first.hash, second.hash] }]);
});

test("回收站中的多选只提供数量摘要而不提供批量操作", async () => {
  const first = makeAsset({ deleted_at: "2026-08-19T01:00:00Z" });
  const second = makeAsset({
    hash: "c".repeat(64),
    deleted_at: "2026-08-19T01:00:00Z",
  });
  const harness = await setupInspector([first, second], {}, { trashLocation: true });

  await act(async () => harness.proxy(0).click());
  await act(async () => {
    harness.proxy(1).dispatchEvent(new MouseEvent("click", { ctrlKey: true, bubbles: true }));
  });

  expect(harness.root.textContent).toContain("已选 2 项");
  expect(harness.root.textContent).toContain("回收站中的批量操作只提供还原");
  expect(() => harness.section("batch")).toThrow();
  expect(() => harness.section("batch-links")).toThrow();
});

test("批量移入回收站按钮把完整选中集合交给工作区确认", async () => {
  const requests: string[][] = [];
  const first = makeAsset();
  const second = makeAsset({ hash: "c".repeat(64) });
  const harness = await setupInspector(
    [first, second],
    { onBatchDelete: (hashes) => requests.push(hashes) },
  );

  await act(async () => harness.proxy(0).click());
  await act(async () => {
    harness.proxy(1).dispatchEvent(new MouseEvent("click", { ctrlKey: true, bubbles: true }));
  });

  const dangerButton = harness
    .section("batch-danger")
    .querySelector<HTMLButtonElement>("button.danger-button");
  if (dangerButton === null) throw new Error("缺少批量移入回收站按钮");
  await act(async () => dangerButton.click());
  expect(requests).toEqual([[first.hash, second.hash]]);
});
