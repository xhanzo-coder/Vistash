// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

import type { PromptRow } from "../../shared/types";
import { SelectionProvider, useSelection } from "../workspace/selectionContext";
import { PromptInspector } from "./PromptInspector";

/** linked_image_states 的应答；检查关联图片分区的测试按需设定。 */
let statesReply: Array<{ hash: string; deleted: boolean }> = [];

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  statesReply = [];
  // 关联图片格位挂载即登记懒加载；全局 IntersectionObserver 处于休眠桩态不会
  // 触发载入，这里仍备好缩略图处理器以免意外触发时落空。
  mockIPC((command) => {
    if (command === "plugin:event|listen" || command === "plugin:event|unlisten") {
      // 关联分区尝试订阅 Tauri 拖放事件：mock 环境没有真实事件流，静默应答。
      return undefined;
    }
    if (command === "asset_thumbnail") return new ArrayBuffer(8);
    if (command === "linked_image_states") return statesReply;
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

/** 合成一条最小 PromptRow，与瀑布流测试同构。 */
function makePrompt(overrides: Partial<PromptRow> = {}): PromptRow {
  return {
    id: "prompt-0",
    body: "正文首行\n第二行细节\n第三行细节",
    title: null,
    model: "sd-xl",
    parameters: "steps=30",
    note: "",
    favorite: false,
    folders: [],
    tags: [],
    linked_image_hashes: [],
    cover_image_hash: null,
    created_at: "2026-08-20T00:00:00Z",
    updated_at: "2026-08-21T00:00:00Z",
    deleted_at: null,
    ...overrides,
  };
}

type Handlers = {
  onSetFolders?: (id: string, folders: string[]) => void;
  onSetTags?: (id: string, tags: string[]) => void;
  onToggleFavorite?: (id: string, favorite: boolean) => void;
  onOpenBodyFocus?: (id: string) => void;
  onEditBodyFocus?: (id: string) => void;
  onImagesChanged?: () => void;
};

/**
 * 视图替身：渲染与集合视图同构的单击按钮，把点击翻译成选择模型动作。
 * 组织回调后把权威变更应用回副本再重渲染，模拟回调 → 快照刷新 → 新 props 的完整回路。
 */
function ClickProxy({ prompts }: { prompts: readonly PromptRow[] }) {
  const { onItemClick } = useSelection();
  return (
    <>
      {prompts.map((prompt) => (
        <button
          key={prompt.id}
          type="button"
          data-proxy={prompt.id}
          onClick={(event) => onItemClick(prompt.id, event)}
        >
          {prompt.title ?? prompt.body}
        </button>
      ))}
    </>
  );
}

async function setupInspector(
  prompts: readonly PromptRow[],
  handlers: Handlers = {},
): Promise<{
  root: HTMLElement;
  proxy: (index: number) => HTMLButtonElement;
  section: (key: string) => HTMLElement;
  buttonByText: (text: string) => HTMLButtonElement;
}> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  function Harness() {
    const [current, setCurrent] = useState(prompts);
    return (
      <SelectionProvider ids={current.map((prompt) => prompt.id)}>
        <ClickProxy prompts={current} />
        <PromptInspector
          prompts={current}
          folders={["人像", "人像/室内"]}
          mutating={false}
          onSetFolders={(id, folders) => {
            handlers.onSetFolders?.(id, folders);
            setCurrent((rows) =>
              rows.map((prompt) => (prompt.id === id ? { ...prompt, folders } : prompt)),
            );
          }}
          onSetTags={(id, tags) => {
            handlers.onSetTags?.(id, tags);
            setCurrent((rows) =>
              rows.map((prompt) => (prompt.id === id ? { ...prompt, tags } : prompt)),
            );
          }}
          onToggleFavorite={(id, favorite) => {
            handlers.onToggleFavorite?.(id, favorite);
            setCurrent((rows) =>
              rows.map((prompt) => (prompt.id === id ? { ...prompt, favorite } : prompt)),
            );
          }}
          onOpenBodyFocus={handlers.onOpenBodyFocus ?? (() => {})}
          onEditBodyFocus={handlers.onEditBodyFocus ?? (() => {})}
          onImagesChanged={handlers.onImagesChanged ?? (() => {})}
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
        `[data-proxy="${prompts[index]?.id ?? ""}"]`,
      );
      if (el === null) throw new Error(`缺少第 ${index} 个视图替身按钮`);
      return el;
    },
    section: (key: string) => {
      const el = container.querySelector<HTMLElement>(`[data-inspector-section="${key}"]`);
      if (el === null) throw new Error(`缺少检查器分区：${key}`);
      return el;
    },
    buttonByText: (text: string) => {
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

test("无活动项时呈现操作引导而不是空白", async () => {
  const harness = await setupInspector([]);
  expect(harness.root.querySelector(".inspector-placeholder")?.textContent).toContain(
    "单击一张卡片",
  );
});

test("信息分区呈现元数据、完整当前正文与聚焦阅读入口", async () => {
  let focusRequest: string | null = null;
  const harness = await setupInspector([makePrompt()], {
    onOpenBodyFocus: (id) => {
      focusRequest = id;
    },
  });
  await act(async () => harness.proxy(0).click());

  const info = harness.section("info");
  // 无显式标题：以正文首行命名；元数据齐全，缺省值以 — 占位。
  expect(info.querySelector("h3")?.textContent).toBe("正文首行");
  expect(info.textContent).toContain("sd-xl");
  expect(info.textContent).toContain("steps=30");
  expect(info.textContent).toContain("2026-08-21");
  expect(info.textContent).toContain("0");

  // 完整正文逐字呈现，不做截断或改写。
  const body = info.querySelector(".inspector-body-full");
  if (body === null) throw new Error("缺少完整正文呈现");
  expect(body.textContent).toBe("正文首行\n第二行细节\n第三行细节");

  await act(async () => harness.buttonByText("聚焦阅读").click());
  expect(focusRequest).toBe("prompt-0");
});

test("组织分区的文件夹勾选与新建路径表单触发归属回调", async () => {
  const calls: Array<{ kind: string; folders?: string[] }> = [];
  const harness = await setupInspector([makePrompt()], {
    onSetFolders: (_id, folders) => calls.push({ kind: "folders", folders }),
  });
  await act(async () => harness.proxy(0).click());

  // 勾选"人像/室内"：在既有归属上追加。
  const checkbox = harness.section("organization").querySelector<HTMLInputElement>(
    'input[type="checkbox"][value="人像/室内"]',
  );
  if (checkbox === null) throw new Error("缺少文件夹复选框");
  await act(async () => checkbox.click());
  expect(calls.at(-1)).toEqual({ kind: "folders", folders: ["人像/室内"] });

  // 新路径表单提交后并入归属数组（后端按需建立路径）。
  const newPathInput = harness.root.querySelector<HTMLInputElement>("#new-prompt-folder");
  if (newPathInput === null) throw new Error("缺少新路径输入框");
  const form = newPathInput.closest("form");
  if (form === null) throw new Error("缺少新路径表单");
  await act(async () => {
    setInput(newPathInput, "抽象/光影");
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  // 新路径并入既有归属（上一步勾选的人像/室内仍在）。
  expect(calls.at(-1)).toEqual({ kind: "folders", folders: ["人像/室内", "抽象/光影"] });

  // 回路刷新后既有路径呈勾选态，可再次取消。
  const checked = harness.section("organization").querySelector<HTMLInputElement>(
    'input[type="checkbox"][value="人像/室内"]:checked',
  );
  if (checked === null) throw new Error("勾选回路未生效");
  await act(async () => checked.click());
  expect(calls.at(-1)).toEqual({ kind: "folders", folders: ["抽象/光影"] });
});

test("标签的添加与移除经共享标签回调", async () => {
  const calls: Array<{ kind: string; tags?: string[] }> = [];
  const harness = await setupInspector([makePrompt({ tags: ["人像"] })], {
    onSetTags: (_id, tags) => calls.push({ kind: "tags", tags }),
  });
  await act(async () => harness.proxy(0).click());

  const tagInput = harness.root.querySelector<HTMLInputElement>("#new-prompt-tag");
  if (tagInput === null) throw new Error("缺少标签输入框");
  const form = tagInput.closest("form");
  if (form === null) throw new Error("缺少标签表单");
  await act(async () => {
    setInput(tagInput, "夜景");
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(calls.at(-1)).toEqual({ kind: "tags", tags: ["人像", "夜景"] });

  const removeTag = harness.root.querySelector<HTMLButtonElement>('[aria-label="移除标签 人像"]');
  if (removeTag === null) throw new Error("缺少移除标签按钮");
  await act(async () => removeTag.click());
  expect(calls.at(-1)).toEqual({ kind: "tags", tags: ["夜景"] });
});

test("备注分区提供自动保存编辑框并预填权威值", async () => {
  mockIPC((command) => {
    if (command === "set_prompt_note") return undefined;
    if (command === "asset_thumbnail") return new ArrayBuffer(8);
    throw new Error(`未预期的 IPC：${command}`);
  });
  const harness = await setupInspector([
    makePrompt({ note: "出图要点：低饱和\n避免过曝" }),
  ]);
  await act(async () => harness.proxy(0).click());

  const textarea = harness
    .section("note")
    .querySelector<HTMLTextAreaElement>('textarea[aria-label="提示词备注"]');
  if (textarea === null) throw new Error("缺少备注编辑框");
  expect(textarea.value).toBe("出图要点：低饱和\n避免过曝");
  // 保存状态区存在（保存中/已保存/失败由共享 NoteAutoSaveEditor 的测试覆盖）。
  expect(harness.section("note").querySelector(".note-status")).not.toBeNull();
});

test("信息分区提供聚焦阅读与编辑主字段两个显式入口", async () => {
  const opened: string[] = [];
  const edited: string[] = [];
  const harness = await setupInspector([makePrompt()], {
    onOpenBodyFocus: (id) => opened.push(id),
    onEditBodyFocus: (id) => edited.push(id),
  });
  await act(async () => harness.proxy(0).click());

  await act(async () => harness.buttonByText("聚焦阅读").click());
  await act(async () => harness.buttonByText("编辑主字段").click());
  expect(opened).toEqual(["prompt-0"]);
  expect(edited).toEqual(["prompt-0"]);
});

test("无关联图片时给出建立关联的出路文案", async () => {
  const harness = await setupInspector([makePrompt()]);
  await act(async () => harness.proxy(0).click());
  // 关联状态按需读取：先冲刷加载，再断言空态出路。
  await flush();
  expect(harness.section("images").textContent).toContain("还没有关联图片");
  expect(harness.section("images").textContent).toContain("从图片库选择");
});

test("带关联图片的活动项按权威顺序列出格位并标注总数", async () => {
  const hashes = ["a".repeat(64), "b".repeat(64)];
  statesReply = [
    { hash: hashes[0] ?? "", deleted: false },
    { hash: hashes[1] ?? "", deleted: false },
  ];
  const harness = await setupInspector([makePrompt({ linked_image_hashes: [...hashes] })]);
  await act(async () => harness.proxy(0).click());
  await flush();

  const list = harness.section("images").querySelector("ul.linked-thumbs");
  if (list === null) throw new Error("缺少关联图片列表");
  expect(list.getAttribute("aria-label")).toBe("关联 2 张图片");
  expect(
    [...list.querySelectorAll<HTMLElement>("[data-linked-hash]")].map(
      (li) => li.dataset.linkedHash,
    ),
  ).toEqual(hashes);
});

test("回收站里的关联图片显式标记已删除而不是消失", async () => {
  statesReply = [{ hash: "a".repeat(64), deleted: true }];
  const harness = await setupInspector([
    makePrompt({ linked_image_hashes: ["a".repeat(64)] }),
  ]);
  await act(async () => harness.proxy(0).click());
  await flush();

  const item = harness.section("images").querySelector<HTMLElement>("[data-linked-hash]");
  if (item === null) throw new Error("缺少关联格位");
  expect(item.querySelector(".deleted-badge")?.textContent).toBe("已删除");
});

test("收藏开关报告目标状态且初始与提示词一致", async () => {
  const toggles: Array<{ id: string; favorite: boolean }> = [];
  const harness = await setupInspector([makePrompt({ favorite: true })], {
    onToggleFavorite: (id, favorite) => toggles.push({ id, favorite }),
  });
  await act(async () => harness.proxy(0).click());

  const button = harness.root.querySelector<HTMLButtonElement>(".favorite-toggle");
  if (button === null) throw new Error("缺少收藏开关");
  expect(button.getAttribute("aria-pressed")).toBe("true");

  await act(async () => button.click());
  expect(toggles).toEqual([{ id: "prompt-0", favorite: false }]);
});

test("多选时检查器只呈现数量摘要而不呈现单件分区", async () => {
  const first = makePrompt();
  const second = makePrompt({ id: "prompt-1", body: "另一条正文" });
  const harness = await setupInspector([first, second]);

  await act(async () => harness.proxy(0).click());
  await act(async () => {
    harness.proxy(1).dispatchEvent(new MouseEvent("click", { ctrlKey: true, bubbles: true }));
  });

  expect(harness.root.textContent).toContain("已选 2 项");
  expect(() => harness.section("info")).toThrow();
  expect(() => harness.section("organization")).toThrow();
});
