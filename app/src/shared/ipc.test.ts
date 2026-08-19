// @vitest-environment jsdom

import { afterEach, expect, test, vi } from "vitest";

import { Channel } from "@tauri-apps/api/core";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

import { importPaths } from "./ipc";
import type { ImportOutcome, ImportProgress } from "./types";

afterEach(() => {
  clearMocks();
  vi.restoreAllMocks();
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test("importPaths 把当前文件与数量进度转交给调用方", async () => {
  const expected: ImportProgress = {
    done: 4,
    total: 10,
    current_filename: "pinterest_005.jpg",
  };
  const outcome: ImportOutcome = {
    imported: 10,
    skipped_non_images: 0,
    failures: [],
  };

  mockIPC((command, payload) => {
    expect(command).toBe("import_paths");
    if (!isRecord(payload)) {
      throw new TypeError("import_paths 的 IPC 参数不是对象");
    }
    const args = payload;
    const channel = args.onProgress;
    if (channel instanceof Channel) {
      channel.onmessage(expected);
    }
    return outcome;
  });

  const received = vi.fn<(progress: ImportProgress) => void>();
  await expect(importPaths(["C:\\素材"], received)).resolves.toEqual(outcome);
  expect(received).toHaveBeenCalledExactlyOnceWith(expected);
});
