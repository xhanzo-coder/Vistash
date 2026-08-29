// @vitest-environment jsdom

import { act } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { createRoot } from "react-dom/client";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { afterEach, expect, test, vi } from "vitest";

import { App } from "./App";
import { createAppQueryClient } from "./app/queryClient";
import { UiProvider } from "./ui/UiProvider";

function appNode() {
  return <QueryClientProvider client={createAppQueryClient()}><UiProvider><App /></UiProvider></QueryClientProvider>;
}

test("主窗口拥有草稿解决后继续关闭所需的最小权限", () => {
  const capabilities: unknown = JSON.parse(readFileSync("src-tauri/capabilities/default.json", "utf8"));
  expect(capabilities).toHaveProperty("windows", ["main"]);
  expect(capabilities).toHaveProperty("permissions", expect.arrayContaining(["core:window:allow-close", "core:window:allow-destroy"]));
});

test("真正关闭窗口失败也保留原生错误而不是未处理拒绝", async () => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  mockWindows("main");
  mockIPC((command) => {
    if (command === "library_status") return { path: null, library_id: null, recorded_path: null, problem: null };
    if (command === "plugin:window|destroy") throw new Error("窗口销毁被拒绝");
    throw new Error(`未预期的 IPC：${command}`);
  }, { shouldMockEvents: true });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(appNode()));
    // 等待原生模块的异步导入完成，再从真实事件 SDK 边界请求关闭。
    await act(async () => vi.dynamicImportSettled());
    await act(async () => emit("tauri://close-requested"));
    expect(container.textContent).toContain("窗口销毁被拒绝");
  } finally {
    act(() => root.unmount());
  }
});

afterEach(() => {
  clearMocks();
  Reflect.deleteProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__");
  document.body.replaceChildren();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

test("关闭监听在组件卸载之后注册成功仍立即释放", async () => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  mockWindows("main");
  Object.defineProperty(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", {
    configurable: true,
    value: { unregisterListener: vi.fn() },
  });
  let finishRegistration: ((id: number) => void) | undefined;
  const registration = new Promise<number>((resolve) => { finishRegistration = resolve; });
  let subscribed = false;
  const released: unknown[] = [];
  mockIPC((command, payload) => {
    if (command === "library_status") return { path: null, library_id: null, recorded_path: null, problem: null };
    if (command === "plugin:event|listen") {
      subscribed = true;
      return registration;
    }
    if (command === "plugin:event|unlisten") {
      released.push(payload);
      return undefined;
    }
    throw new Error(`未预期的 IPC：${command}`);
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(appNode()));
  await vi.waitFor(() => expect(subscribed).toBe(true));
  act(() => root.unmount());
  await act(async () => {
    if (finishRegistration === undefined) throw new Error("测试未建立原生订阅");
    finishRegistration(42);
  });
  expect(released).toContainEqual({ event: "tauri://close-requested", eventId: 42 });
});

test("原生关闭保护注册失败时选库页持续呈现原因", async () => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  mockWindows("main");
  mockIPC((command) => {
    if (command === "library_status") {
      return { path: null, library_id: null, recorded_path: null, problem: null };
    }
    if (command === "plugin:event|listen") throw new Error("关闭事件权限被拒绝");
    throw new Error(`未预期的 IPC：${command}`);
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(appNode()));
    await vi.waitFor(async () => {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(container.textContent).toContain("关闭保护不可用");
    });
    expect(container.textContent).toContain("关闭事件权限被拒绝");
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  } finally {
    act(() => root.unmount());
  }
});

test("兼容库通过生命周期门禁后进入新版 AppShell，并装配两个公开工作区", async () => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  mockIPC((command) => {
    if (command === "library_status") {
      return { path: "E:\\视觉档案", library_id: "018f3c9e-6c00-7000-8000-0000000000aa", recorded_path: null, problem: null };
    }
    if (command === "read_layout") return null;
    if (command === "catalog_snapshot") return { assets: [], folders: [], tags: [], trash_count: 0 };
    if (command === "prompt_snapshot") return { prompts: [], folders: [], tags: [], trash_count: 0 };
    throw new Error(`未预期的 IPC：${command}`);
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(appNode()));
    await vi.waitFor(() => expect(container.querySelector('[data-workspace="assets"]')).not.toBeNull());
    expect(container.querySelector('[data-workspace="prompts"]')).not.toBeNull();
    expect(container.textContent).toContain("全部图片");
  } finally {
    act(() => root.unmount());
  }
});
