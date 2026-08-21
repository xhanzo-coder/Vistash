// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { Channel } from "@tauri-apps/api/core";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

import type { AppError, LibraryStatus, MigrationProgress } from "../../shared/types";
import { LibraryMigration } from "./LibraryMigration";

const STATUS: LibraryStatus = {
  path: "E:\\旧库",
  recorded_path: "E:\\旧库",
  problem: null,
};

const PROGRESS: MigrationProgress = {
  stage: "sidecars_rewritten",
  done: 3,
  total: 10,
  current_filename: "人物.png",
};

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
});

afterEach(() => {
  clearMocks();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function buttonWithText(container: ParentNode, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (button === undefined) throw new Error(`缺少按钮：${text}`);
  return button;
}

test("迁移进行中阻塞按钮，成功后上交打开结果", async () => {
  let resolveMigration: ((status: LibraryStatus) => void) | undefined;
  mockIPC((_command, payload) => {
    if (typeof payload !== "object" || payload === null || !("onProgress" in payload)) {
      throw new TypeError("migrate_library 缺少进度 Channel");
    }
    const channel = payload.onProgress;
    if (!(channel instanceof Channel)) {
      throw new TypeError("onProgress 不是 Channel");
    }
    channel.onmessage(PROGRESS);
    return new Promise<LibraryStatus>((resolve) => {
      resolveMigration = resolve;
    });
  });

  const onOpened = vi.fn<(status: LibraryStatus) => void>();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <LibraryMigration path="E:\\旧库" problem={null} onOpened={onOpened} />,
    );
  });
  await flush();

  await act(async () => {
    buttonWithText(container, "开始迁移").click();
  });
  await flush();

  // 迁移未结束时按钮必须阻塞：迁移中途再点一次会与 journal 状态竞争。
  const busyButton = buttonWithText(container, "正在迁移…");
  expect(busyButton.disabled).toBe(true);
  // 进度行呈现阶段、已处理数、总数与当前文件。
  expect(container.textContent).toContain("3/10");
  expect(container.textContent).toContain("人物.png");

  await act(async () => {
    resolveMigration?.(STATUS);
  });
  await flush();

  expect(onOpened).toHaveBeenCalledExactlyOnceWith(STATUS);
  root.unmount();
});

test("迁移失败时呈现稳定错误码并允许重试", async () => {
  const failure: AppError = {
    code: "migration.sidecar_rewrite_failed",
    detail: "第 4 个侧车写入失败",
  };
  mockIPC((_command, payload) => {
    if (typeof payload !== "object" || payload === null || !("onProgress" in payload)) {
      throw new TypeError("migrate_library 缺少进度 Channel");
    }
    const channel = payload.onProgress;
    if (channel instanceof Channel) {
      channel.onmessage(PROGRESS);
    }
    throw failure;
  });

  const onOpened = vi.fn<(status: LibraryStatus) => void>();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <LibraryMigration path="E:\\旧库" problem={null} onOpened={onOpened} />,
    );
  });
  await flush();

  await act(async () => {
    buttonWithText(container, "开始迁移").click();
  });
  await flush();

  expect(onOpened).not.toHaveBeenCalled();
  // 错误码本身必须可见：它是诊断迁移失败的唯一稳定标识。
  expect(container.textContent).toContain("migration.sidecar_rewrite_failed");
  // 失败后回到可重试状态，而不是把人锁死在失败页。
  expect(buttonWithText(container, "开始迁移").disabled).toBe(false);
  root.unmount();
});
