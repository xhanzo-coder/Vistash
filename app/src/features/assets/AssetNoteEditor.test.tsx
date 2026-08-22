// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

import { AssetNoteEditor } from "./AssetNoteEditor";

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  vi.useFakeTimers();
});

afterEach(() => {
  clearMocks();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

const HASH = "b".repeat(64);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 解出 set_asset_note 载荷。 */
function notePayload(payload: unknown): { hash: string; note: string } {
  if (
    !isRecord(payload) ||
    typeof payload.hash !== "string" ||
    typeof payload.note !== "string"
  ) {
    throw new TypeError("set_asset_note 载荷缺少 hash/note");
  }
  return { hash: payload.hash, note: payload.note };
}

async function setupEditor(initialNote = ""): Promise<{
  root: HTMLElement;
  textarea: () => HTMLTextAreaElement;
}> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<AssetNoteEditor hash={HASH} note={initialNote} />);
  });
  return {
    root: container,
    textarea: () => {
      const el = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="图片备注"]');
      if (el === null) throw new Error("缺少备注编辑框");
      return el;
    },
  };
}

function setInputValue(el: HTMLTextAreaElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
  if (descriptor?.set === undefined) throw new Error("HTMLTextAreaElement.value setter 不存在");
  descriptor.set.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** 推进防抖计时器并把已决议的微任务冲进 React。 */
async function advanceDebounce(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
  });
}

test("停止输入后经防抖自动保存并呈现已保存状态", async () => {
  const calls: Array<{ hash: string; note: string }> = [];
  mockIPC((command, payload) => {
    if (command === "set_asset_note") {
      calls.push(notePayload(payload));
      return undefined;
    }
    throw new Error(`未预期的 IPC：${command}`);
  });

  const harness = await setupEditor();
  await act(async () => {
    setInputValue(harness.textarea(), "第一行说明\n第二行补充");
  });
  // 输入刚结束时是未保存的编辑态，且还没有写入。
  expect(harness.root.textContent).toContain("未保存");
  expect(calls).toEqual([]);

  await advanceDebounce(850);

  expect(calls).toEqual([{ hash: HASH, note: "第一行说明\n第二行补充" }]);
  expect(harness.root.textContent).toContain("已保存");
});

test("连续输入重置防抖，最终只按完整文本保存一次", async () => {
  const notes: string[] = [];
  mockIPC((command, payload) => {
    if (command === "set_asset_note") {
      notes.push(notePayload(payload).note);
      return undefined;
    }
    throw new Error(`未预期的 IPC：${command}`);
  });

  const harness = await setupEditor();
  await act(async () => {
    setInputValue(harness.textarea(), "前半");
  });
  await advanceDebounce(400);
  await act(async () => {
    setInputValue(harness.textarea(), "前半后半");
  });
  // 距最后一次输入只有 400ms：防抖被重置，尚未保存。
  await advanceDebounce(400);
  expect(notes).toEqual([]);
  await advanceDebounce(450);
  expect(notes).toEqual(["前半后半"]);
  expect(harness.textarea().value).toBe("前半后半");
});

test("失焦立即保存而不等待防抖", async () => {
  const notes: string[] = [];
  mockIPC((command, payload) => {
    if (command === "set_asset_note") {
      notes.push(notePayload(payload).note);
      return undefined;
    }
    throw new Error(`未预期的 IPC：${command}`);
  });

  const harness = await setupEditor();
  const textarea = harness.textarea();
  await act(async () => {
    setInputValue(textarea, "失焦前写的内容");
    // React 的 onBlur 经可冒泡的 focusout 委托，手工派发也用它。
    textarea.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });

  expect(notes).toEqual(["失焦前写的内容"]);

  // 失焦已保存之后，残留的防抖计时器不应再次写入同一内容。
  await advanceDebounce(1_000);
  expect(notes).toEqual(["失焦前写的内容"]);
});

test("Ctrl+Enter 立即保存", async () => {
  const notes: string[] = [];
  mockIPC((command, payload) => {
    if (command === "set_asset_note") {
      notes.push(notePayload(payload).note);
      return undefined;
    }
    throw new Error(`未预期的 IPC：${command}`);
  });

  const harness = await setupEditor();
  const textarea = harness.textarea();
  await act(async () => {
    setInputValue(textarea, "快捷键保存");
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }),
    );
  });

  expect(notes).toEqual(["快捷键保存"]);
});

test("保存失败保留全部草稿并显示稳定错误码", async () => {
  let shouldFail = true;
  mockIPC((command) => {
    if (command === "set_asset_note") {
      if (shouldFail) {
        throw { code: "library.asset_metadata_write_failed", detail: "磁盘只读" };
      }
      return undefined;
    }
    throw new Error(`未预期的 IPC：${command}`);
  });

  const harness = await setupEditor();
  const textarea = harness.textarea();
  await act(async () => {
    setInputValue(textarea, "还没保存成功的草稿");
    textarea.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });

  const failure = harness.root.querySelector<HTMLElement>(
    '[data-error-code="library.asset_metadata_write_failed"]',
  );
  if (failure === null) throw new Error("缺少稳定错误码提示");
  // 失败不丢弃编辑文本。
  expect(textarea.value).toBe("还没保存成功的草稿");

  // 重试成功后草稿落盘、错误消失、状态回到已保存。
  shouldFail = false;
  await act(async () => {
    textarea.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
  expect(harness.root.querySelector('[data-error-code]')).toBeNull();
  expect(harness.root.textContent).toContain("已保存");
});
