// @vitest-environment jsdom

import { afterEach, expect, test, vi } from "vitest";

import { Channel } from "@tauri-apps/api/core";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

import {
  catalogSnapshot,
  createFolder,
  deleteAsset,
  deleteFolder,
  importPaths,
  purgeTrash,
  renameFolder,
  restoreAsset,
  setAssetFolders,
  setAssetTags,
} from "./ipc";
import type {
  AssetQuery,
  CatalogSnapshot,
  FolderMutationProgress,
  ImportOutcome,
  ImportProgress,
  PurgeReport,
  RestoreOutcome,
} from "./types";

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
  await expect(importPaths(["E:\\素材"], received)).resolves.toEqual(outcome);
  expect(received).toHaveBeenCalledExactlyOnceWith(expected);
});

test("素材编目 IPC 使用固定 command 和参数名称", async () => {
  const calls: Array<{ command: string; payload: unknown }> = [];
  const snapshot: CatalogSnapshot = {
    assets: [],
    folders: ["参考"],
    tags: [{ tag: "人物", count: 1 }],
    trash_count: 1,
  };
  const restore: RestoreOutcome = { missing_folders: ["已删除"] };
  const purge: PurgeReport = { purged: 1, failures: [] };
  const renameProgress: FolderMutationProgress = {
    done: 1,
    total: 1,
    current_filename: "人物.png",
  };
  const receivedRenameProgress = vi.fn<(progress: FolderMutationProgress) => void>();
  mockIPC((command, payload) => {
    calls.push({ command, payload });
    if (command === "catalog_snapshot") return snapshot;
    if (command === "create_folder") return "参考";
    if (command === "rename_folder") {
      if (!isRecord(payload) || !(payload.onProgress instanceof Channel)) {
        throw new TypeError("rename_folder 缺少进度 Channel");
      }
      payload.onProgress.onmessage(renameProgress);
      return "参考";
    }
    if (command === "restore_asset") return restore;
    if (command === "purge_trash") return purge;
    return null;
  });
  const query: AssetQuery = {
    text: "人物",
    tags: ["参考"],
    folder: { kind: "path", path: "参考" },
    location: "active",
  };

  await catalogSnapshot(query);
  await createFolder(null, "参考");
  await renameFolder("参考", "灵感", receivedRenameProgress);
  await deleteFolder("灵感");
  await setAssetFolders("a".repeat(64), ["配色"]);
  await setAssetTags("a".repeat(64), ["人物"]);
  await deleteAsset("a".repeat(64));
  await restoreAsset("a".repeat(64));
  await purgeTrash();

  const renameCall = calls.find((call) => call.command === "rename_folder");
  if (
    renameCall === undefined ||
    !isRecord(renameCall.payload) ||
    !(renameCall.payload.onProgress instanceof Channel)
  ) {
    throw new TypeError("rename_folder 调用没有携带进度 Channel");
  }
  const renameChannel = renameCall.payload.onProgress;

  expect(calls).toEqual([
    { command: "catalog_snapshot", payload: { query } },
    { command: "create_folder", payload: { parent: null, name: "参考" } },
    {
      command: "rename_folder",
      payload: { path: "参考", newName: "灵感", onProgress: renameChannel },
    },
    { command: "delete_folder", payload: { path: "灵感" } },
    {
      command: "set_asset_folders",
      payload: { hash: "a".repeat(64), folders: ["配色"] },
    },
    {
      command: "set_asset_tags",
      payload: { hash: "a".repeat(64), tags: ["人物"] },
    },
    { command: "delete_asset", payload: { hash: "a".repeat(64) } },
    { command: "restore_asset", payload: { hash: "a".repeat(64) } },
    { command: "purge_trash", payload: {} },
  ]);
  expect(receivedRenameProgress).toHaveBeenCalledExactlyOnceWith(renameProgress);
});

test("IPC 保留后端错误码与详情", async () => {
  mockIPC(() => {
    throw { code: "library.tag_invalid", detail: "标签包含控制字符" };
  });

  await expect(setAssetTags("a".repeat(64), ["人物\n参考"])).rejects.toMatchObject({
    name: "IpcError",
    appError: {
      code: "library.tag_invalid",
      detail: "标签包含控制字符",
    },
  });
});
