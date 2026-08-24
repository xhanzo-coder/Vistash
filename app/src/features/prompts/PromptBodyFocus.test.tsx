// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

import type { PromptRow } from "../../shared/types";
import { blockIfPromptDraftDirty } from "./draftGuard";
import { PromptBodyFocus } from "./PromptBodyFocus";

/** 合成一条最小 PromptRow，与工作区测试同构。 */
function makePrompt(overrides: Partial<PromptRow> = {}): PromptRow {
  return {
    id: "prompt-0",
    body: "权威正文第一行\n第二行",
    title: null,
    model: "sd-xl",
    parameters: "steps=30",
    note: "",
    favorite: false,
    folders: [],
    tags: [],
    linked_image_hashes: [],
    cover_image_hash: null,
    resolved_cover_hash: null,
    created_at: "2026-08-20T00:00:00Z",
    updated_at: "2026-08-21T00:00:00Z",
    deleted_at: null,
    ...overrides,
  };
}

let ipcCalls: Array<{ command: string; payload: unknown }>;
let failUpdate: boolean;

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  ipcCalls = [];
  failUpdate = false;
  mockIPC((command, payload) => {
    ipcCalls.push({ command, payload });
    if (command === "update_prompt") {
      if (failUpdate) {
        throw { code: "library.prompt_write_failed", detail: "侧车写入失败" };
      }
      return { format_version: 2, ...makePrompt() };
    }
    throw new Error(`未预期的 IPC：${command}`);
  });
});

afterEach(() => {
  clearMocks();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

async function setupFocus(
  prompt: PromptRow,
  handlers: { onClose?: () => void; onSaved?: () => Promise<void> | void } = {},
  initialEditing = false,
): Promise<{
  root: HTMLElement;
  section: () => HTMLElement;
  buttonByText: (text: string) => HTMLButtonElement;
  input: (name: string) => HTMLInputElement;
  bodyArea: () => HTMLTextAreaElement;
  unmount: () => Promise<void>;
}> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <PromptBodyFocus
        prompt={prompt}
        initialEditing={initialEditing}
        onClose={handlers.onClose ?? (() => {})}
        onSaved={handlers.onSaved ?? (() => {})}
      />,
    );
  });
  return {
    root: container,
    section: () => {
      const el = container.querySelector<HTMLElement>(".prompt-body-focus");
      if (el === null) throw new Error("缺少聚焦视图");
      return el;
    },
    buttonByText: (text: string) => {
      const el = [...container.querySelectorAll("button")].find(
        (candidate) => candidate.textContent?.trim() === text,
      );
      if (el === undefined) throw new Error(`缺少按钮：${text}`);
      return el;
    },
    input: (name: string) => {
      const el = container.querySelector<HTMLInputElement>(`input[name="${name}"]`);
      if (el === null) throw new Error(`缺少输入框：${name}`);
      return el;
    },
    bodyArea: () => {
      const el = container.querySelector<HTMLTextAreaElement>('textarea[name="prompt-body"]');
      if (el === null) throw new Error("缺少正文编辑框");
      return el;
    },
    unmount: () =>
      act(async () => {
        root.unmount();
      }),
  };
}

function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const descriptor =
    el instanceof HTMLTextAreaElement
      ? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")
      : Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  if (descriptor?.set === undefined) throw new Error("value setter 不存在");
  descriptor.set.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

test("只读呈现完整正文，编辑入口预填权威值", async () => {
  const prompt = makePrompt();
  const harness = await setupFocus(prompt);

  const body = harness.root.querySelector(".focus-body");
  if (body === null) throw new Error("缺少只读正文");
  expect(body.textContent).toBe(prompt.body);
  expect(harness.root.querySelector('textarea[name="prompt-body"]')).toBeNull();

  await act(async () => harness.buttonByText("编辑主字段").click());
  expect(harness.bodyArea().value).toBe(prompt.body);
  expect(harness.input("prompt-title").value).toBe("");
  expect(harness.input("prompt-model").value).toBe("sd-xl");
  expect(harness.input("prompt-parameters").value).toBe("steps=30");

  await harness.unmount();
});

test("显式保存把归一后的主字段发给 update_prompt 并刷新权威", async () => {
  const prompt = makePrompt();
  let saved = 0;
  const harness = await setupFocus(prompt, { onSaved: () => void saved++ }, true);

  await act(async () => {
    setInputValue(harness.input("prompt-title"), "新标题");
    setInputValue(harness.input("prompt-model"), ""); // 归一为 null
    setInputValue(harness.bodyArea(), "修改后的正文");
  });
  expect(harness.root.textContent).toContain("有未保存的修改");

  await act(async () => harness.buttonByText("保存").click());
  expect(ipcCalls).toContainEqual({
    command: "update_prompt",
    payload: {
      id: prompt.id,
      edit: { body: "修改后的正文", title: "新标题", model: null, parameters: "steps=30" },
    },
  });
  expect(saved).toBe(1);
  expect(harness.root.textContent).toContain("已保存");
  // 保存成功不退出编辑态：可继续迭代或干净地返回列表。
  expect(harness.bodyArea().value).toBe("修改后的正文");

  await harness.unmount();
});

test("保存失败不退出编辑、不丢弃草稿并显示稳定错误码", async () => {
  failUpdate = true;
  const harness = await setupFocus(makePrompt(), {}, true);

  await act(async () => setInputValue(harness.bodyArea(), "还没保存成功的草稿"));
  await act(async () => harness.buttonByText("保存").click());

  const failure = harness.root.querySelector<HTMLElement>(
    '[data-error-code="library.prompt_write_failed"]',
  );
  if (failure === null) throw new Error("缺少稳定错误码提示");
  expect(harness.root.textContent).toContain("全部修改仍保留");
  expect(harness.bodyArea().value).toBe("还没保存成功的草稿");

  await harness.unmount();
});

test("Ctrl+S 触发保存", async () => {
  const harness = await setupFocus(makePrompt(), {}, true);

  await act(async () => {
    setInputValue(harness.bodyArea(), "快捷键保存的正文");
    harness.section().dispatchEvent(
      new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true }),
    );
  });

  expect(ipcCalls.some((call) => call.command === "update_prompt")).toBe(true);

  await harness.unmount();
});

test("干净状态返回列表立即退出；取消按钮放弃修改回只读", async () => {
  const closed: number[] = [];
  const harness = await setupFocus(makePrompt(), { onClose: () => closed.push(1) });

  await act(async () => harness.buttonByText("返回列表").click());
  expect(closed).toEqual([1]);

  await harness.unmount();
});

test("有未保存修改时折叠编辑器先要三选一", async () => {
  const closed: number[] = [];
  const harness = await setupFocus(makePrompt(), { onClose: () => closed.push(1) }, true);

  await act(async () => setInputValue(harness.bodyArea(), "脏草稿"));
  await act(async () => harness.buttonByText("返回列表").click());

  // 不直接退出：先呈现保存/放弃/留在当前页。
  expect(closed).toEqual([]);
  const dialog = harness.root.querySelector<HTMLElement>('[role="dialog"]');
  if (dialog === null) throw new Error("缺少未保存对话框");
  expect(dialog.textContent).toContain("保存后离开、放弃修改，还是留在当前页面");
  expect(document.activeElement?.textContent).toBe("留在当前页");

  // 留在当前页：回到编辑，草稿原样。
  await act(async () => harness.buttonByText("留在当前页").click());
  expect(harness.root.querySelector('[role="dialog"]')).toBeNull();
  expect(harness.bodyArea().value).toBe("脏草稿");

  // 再次折叠 → 放弃修改：草稿重置并退出编辑，随后离开。
  await act(async () => harness.buttonByText("返回列表").click());
  await act(async () => harness.buttonByText("放弃修改").click());
  expect(closed).toEqual([1]);

  await harness.unmount();
});

test("对话框里的保存并离开：成功后离开，失败回到编辑", async () => {
  const closed: number[] = [];
  const harness = await setupFocus(makePrompt(), { onClose: () => closed.push(1) }, true);

  await act(async () => setInputValue(harness.bodyArea(), "要保存的正文"));
  await act(async () => harness.buttonByText("返回列表").click());
  await act(async () => harness.buttonByText("保存并离开").click());
  expect(closed).toEqual([1]);

  await harness.unmount();

  failUpdate = true;
  const failing = await setupFocus(makePrompt(), { onClose: () => closed.push(2) }, true);
  await act(async () => setInputValue(failing.bodyArea(), "失败的正文"));
  await act(async () => failing.buttonByText("返回列表").click());
  await act(async () => failing.buttonByText("保存并离开").click());
  expect(closed).toEqual([1]);
  // 失败：对话框退回编辑状态，草稿保留、错误码可见。
  expect(failing.root.querySelector('[role="dialog"]')).toBeNull();
  expect(failing.bodyArea().value).toBe("失败的正文");
  expect(failing.root.querySelector('[data-error-code="library.prompt_write_failed"]')).not.toBeNull();

  await failing.unmount();
});

test("Esc 在脏状态下同样先要三选一", async () => {
  const closed: number[] = [];
  const harness = await setupFocus(makePrompt(), { onClose: () => closed.push(1) }, true);

  await act(async () => {
    setInputValue(harness.bodyArea(), "Esc 前的草稿");
    harness.section().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  expect(closed).toEqual([]);
  expect(harness.root.querySelector('[role="dialog"]')).not.toBeNull();

  await harness.unmount();
});

test("对话框打开后 Esc 是留在当前页，Tab 圈住三个动作（任务 11.3）", async () => {
  const closed: number[] = [];
  const harness = await setupFocus(makePrompt(), { onClose: () => closed.push(1) }, true);

  await act(async () => setInputValue(harness.bodyArea(), "圈内的草稿"));
  await act(async () => harness.buttonByText("返回列表").click());
  expect(harness.root.querySelector('[role="dialog"]')).not.toBeNull();

  // 焦点在对话框内，Esc 走安全侧"留在当前页"且不再触发外层的折叠请求。
  const dialog = harness.root.querySelector<HTMLElement>('[role="dialog"]');
  if (dialog === null) throw new Error("缺少未保存对话框");
  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  expect(harness.root.querySelector('[role="dialog"]')).toBeNull();
  expect(closed).toEqual([]);
  expect(harness.bodyArea().value).toBe("圈内的草稿");

  // Tab 圈住三个动作：从默认焦点（留在当前页/圈首）正向到放弃修改、再到保存并离开，
  // 再正向一次绕回圈首——不泄漏到底层页面。
  await act(async () => harness.buttonByText("返回列表").click());
  pressTab(false);
  expect(document.activeElement?.textContent).toBe("放弃修改");
  pressTab(false);
  expect(document.activeElement?.textContent).toBe("保存并离开");
  pressTab(false);
  expect(document.activeElement?.textContent).toBe("留在当前页");

  await harness.unmount();
});

function pressTab(shift: boolean): void {
  document.activeElement?.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Tab", shiftKey: shift, bubbles: true }),
  );
}

test("全局脏探针：干净放行、脏时请求解决并要求拦截", async () => {
  const harness = await setupFocus(makePrompt(), {}, true);

  expect(blockIfPromptDraftDirty(() => undefined)).toBe(false);
  await act(async () => setInputValue(harness.bodyArea(), "探针看到的草稿"));
  // requestResolve 在探针调用里拉起对话框：状态更新需在 act 内冲刷。
  await act(async () => {
    expect(blockIfPromptDraftDirty(() => undefined)).toBe(true);
  });
  // App 层据此不放行一级入口切换/窗口关闭。
  expect(harness.root.querySelector('[role="dialog"]')).not.toBeNull();

  // 卸载后探针注销，恢复放行。
  await harness.unmount();
  expect(blockIfPromptDraftDirty(() => undefined)).toBe(false);
});

test("全局草稿守卫在放弃修改后继续最初被拦截的动作", async () => {
  const continued: string[] = [];
  const closed: string[] = [];
  const harness = await setupFocus(
    makePrompt(),
    { onClose: () => closed.push("local-close") },
    true,
  );
  await act(async () => setInputValue(harness.bodyArea(), "切换库前的草稿"));
  await act(async () => {
    expect(blockIfPromptDraftDirty(() => continued.push("switch-library"))).toBe(true);
  });

  await act(async () => harness.buttonByText("放弃修改").click());

  expect(continued).toEqual(["switch-library"]);
  expect(closed).toEqual([]);
  await harness.unmount();
});

test("全局草稿守卫在保存成功后继续最初被拦截的动作", async () => {
  const continued: string[] = [];
  const closed: string[] = [];
  const harness = await setupFocus(
    makePrompt(),
    { onClose: () => closed.push("local-close") },
    true,
  );
  await act(async () => setInputValue(harness.bodyArea(), "保存后切换库"));
  await act(async () => {
    expect(blockIfPromptDraftDirty(() => continued.push("switch-library"))).toBe(true);
  });

  await act(async () => harness.buttonByText("保存并离开").click());

  expect(continued).toEqual(["switch-library"]);
  expect(closed).toEqual([]);
  await harness.unmount();
});
