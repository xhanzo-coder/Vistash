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

async function setupEditor(initialNote = "", id = PROMPT_ID): Promise<{
  root: HTMLElement;
  textarea: () => HTMLTextAreaElement;
  unmount: () => Promise<void>;
}> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<PromptNoteEditor id={id} note={initialNote} />);
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
    unmount: () => act(async () => root.unmount()),
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
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

test("切换条目时补写失败，返回同一提示词仍恢复草稿与错误", async () => {
  mockIPC((command) => {
    if (command === "set_prompt_note") {
      throw { code: "library.prompt_note_write_failed", detail: "磁盘只读" };
    }
    throw new Error(`未预期的 IPC：${command}`);
  });

  const first = await setupEditor();
  await act(async () => setInputValue(first.textarea(), "切换前尚未落盘的备注"));
  await first.unmount();
  await act(async () => Promise.resolve());

  const returned = await setupEditor("");
  expect(returned.textarea().value).toBe("切换前尚未落盘的备注");
  expect(
    returned.root.querySelector('[data-error-code="library.prompt_note_write_failed"]'),
  ).not.toBeNull();
  await returned.unmount();
});

test("旧草稿迟到失败不得覆盖同一提示词已经保存的新草稿", async () => {
  const oldWrite = deferred<void>();
  const newWrite = deferred<void>();
  let callCount = 0;
  mockIPC((command) => {
    if (command !== "set_prompt_note") throw new Error(`未预期的 IPC：${command}`);
    callCount += 1;
    return callCount === 1 ? oldWrite.promise : newWrite.promise;
  });
  const id = "prompt-concurrent-note";

  const first = await setupEditor("", id);
  await act(async () => setInputValue(first.textarea(), "旧草稿"));
  await first.unmount();

  const second = await setupEditor("", id);
  await act(async () => {
    const textarea = second.textarea();
    setInputValue(textarea, "新草稿");
    textarea.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
  await act(async () => newWrite.resolve());
  expect(second.root.textContent).toContain("已保存");

  await act(async () => oldWrite.reject({ code: "library.prompt_note_write_failed" }));
  await second.unmount();
  const returned = await setupEditor("新草稿", id);

  expect(returned.textarea().value).toBe("新草稿");
  expect(returned.root.querySelector("[data-error-code]")).toBeNull();
  await returned.unmount();
});

test("旧补写成功后新实例失焦会重新认领草稿并保存", async () => {
  const oldWrite = deferred<void>();
  let callCount = 0;
  mockIPC((command) => {
    if (command !== "set_prompt_note") throw new Error(`未预期的 IPC：${command}`);
    callCount += 1;
    return callCount === 1 ? oldWrite.promise : undefined;
  });
  const id = "prompt-successful-old-write";

  const first = await setupEditor("", id);
  await act(async () => setInputValue(first.textarea(), "待补写草稿"));
  await first.unmount();
  const returned = await setupEditor("", id);
  await act(async () => oldWrite.resolve());

  await act(async () => {
    returned.textarea().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });

  expect(callCount).toBe(2);
  expect(returned.textarea().value).toBe("待补写草稿");
  expect(returned.root.textContent).toContain("已保存");
  await returned.unmount();
});
