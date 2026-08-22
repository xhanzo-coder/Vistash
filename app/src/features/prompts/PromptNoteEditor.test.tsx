// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

import { PromptNoteEditor } from "./PromptNoteEditor";

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

const PROMPT_ID = "prompt-9";

async function setupEditor(initialNote = ""): Promise<{
  root: HTMLElement;
  textarea: () => HTMLTextAreaElement;
}> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<PromptNoteEditor id={PROMPT_ID} note={initialNote} />);
  });
  return {
    root: container,
    textarea: () => {
      const el = container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="提示词备注"]',
      );
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

test("防抖后写入 set_prompt_note 并呈现已保存", async () => {
  const calls: Array<{ id: string; note: string }> = [];
  mockIPC((command, payload) => {
    if (command === "set_prompt_note") {
      if (
        typeof payload !== "object" ||
        payload === null ||
        !("id" in payload) ||
        !("note" in payload)
      ) {
        throw new TypeError("set_prompt_note 载荷缺少 id/note");
      }
      calls.push({ id: String(payload.id), note: String(payload.note) });
      return undefined;
    }
    throw new Error(`未预期的 IPC：${command}`);
  });

  const harness = await setupEditor();
  await act(async () => setInputValue(harness.textarea(), "提示词备注草稿"));
  expect(calls).toEqual([]);

  await advanceDebounce(850);
  expect(calls).toEqual([{ id: PROMPT_ID, note: "提示词备注草稿" }]);
  expect(harness.root.textContent).toContain("已保存");
});

test("保存失败保留草稿并显示稳定错误码", async () => {
  let shouldFail = true;
  mockIPC((command) => {
    if (command === "set_prompt_note") {
      if (shouldFail) {
        throw { code: "library.prompt_note_write_failed", detail: "磁盘只读" };
      }
      return undefined;
    }
    throw new Error(`未预期的 IPC：${command}`);
  });

  const harness = await setupEditor();
  const textarea = harness.textarea();
  await act(async () => {
    setInputValue(textarea, "失败的备注草稿");
    textarea.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });

  expect(
    harness.root.querySelector('[data-error-code="library.prompt_note_write_failed"]'),
  ).not.toBeNull();
  expect(textarea.value).toBe("失败的备注草稿");

  // 重试成功后草稿落盘、错误消失。
  shouldFail = false;
  await act(async () => {
    textarea.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
  expect(harness.root.querySelector("[data-error-code]")).toBeNull();
  expect(harness.root.textContent).toContain("已保存");
});
