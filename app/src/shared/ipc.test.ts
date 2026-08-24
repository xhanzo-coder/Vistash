// @vitest-environment jsdom

import { afterEach, expect, test, vi } from "vitest";

import { Channel } from "@tauri-apps/api/core";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

import {
  batchAddAssetFolder,
  batchSetPromptFavorite,
  catalogSnapshot,
  createFolder,
  createPrompt,
  createPromptFolder,
  deleteAsset,
  deleteFolder,
  deletePrompt,
  deletePromptFolder,
  globalSearch,
  imageDetail,
  importAndLink,
  importPaths,
  linkImages,
  linkedImageStates,
  migrateLibrary,
  promptDetail,
  promptSnapshot,
  purgePromptTrash,
  purgeTrash,
  readLayout,
  renameFolder,
  renamePromptFolder,
  restoreAsset,
  restorePrompt,
  setAssetFavorite,
  setAssetFolders,
  setAssetNote,
  setAssetTags,
  setPromptCover,
  setPromptFavorite,
  setPromptFolders,
  setPromptNote,
  setPromptTags,
  unlinkImage,
  updatePrompt,
  writeLayout,
} from "./ipc";
import type {
  AssetQuery,
  AssetRow,
  BatchReport,
  CatalogSnapshot,
  FolderMutationProgress,
  GlobalSearchResult,
  ImageDetail,
  ImportAndLinkReport,
  ImportOutcome,
  ImportProgress,
  LibraryStatus,
  MigrationProgress,
  PromptAsset,
  PromptQuery,
  PromptSnapshot,
  PromptPurgeReport,
  PromptRestoreOutcome,
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

test("migrateLibrary 转交迁移进度并使用固定 command 名", async () => {
  const expected: MigrationProgress = {
    stage: "sidecars_rewritten",
    done: 7,
    total: 20,
    current_filename: "pinterest_008.jpg",
  };
  const status: LibraryStatus = {
    path: "E:\\旧库",
    library_id: null,
    recorded_path: "E:\\旧库",
    problem: null,
  };

  mockIPC((command, payload) => {
    expect(command).toBe("migrate_library");
    if (!isRecord(payload)) {
      throw new TypeError("migrate_library 的 IPC 参数不是对象");
    }
    if (payload.path !== "E:\\旧库") {
      throw new TypeError("migrate_library 缺少库路径");
    }
    const channel = payload.onProgress;
    if (channel instanceof Channel) {
      channel.onmessage(expected);
    }
    return status;
  });

  const received = vi.fn<(progress: MigrationProgress) => void>();
  await expect(migrateLibrary("E:\\旧库", received)).resolves.toEqual(status);
  expect(received).toHaveBeenCalledExactlyOnceWith(expected);
});

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
    favorite: null,
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

// ---------------------------------------------------------------------------
// 提示词素材、普通关联、批量报告、全局搜索与布局偏好的契约锁定。
//
// 这些测试用 Tauri 官方 mock 把 command 名与参数名钉死：后端改名或改参数形状时，
// 前端测试先红，而不是等到运行时才发现 invoke 找不到命令。
// ---------------------------------------------------------------------------

const PROMPT_ID = "018f3c9e-6c00-7000-8000-000000000001";
const HASH = "a".repeat(64);

function samplePrompt(): PromptAsset {
  return {
    format_version: 2,
    id: PROMPT_ID,
    body: "电影感布光",
    title: null,
    model: null,
    parameters: null,
    note: "",
    favorite: false,
    folders: [],
    tags: ["布光"],
    linked_image_hashes: [HASH],
    cover_image_hash: null,
    created_at: "2026-08-21T00:00:00Z",
    updated_at: "2026-08-21T00:00:00Z",
    deleted_at: null,
    deleted_from_folders: null,
  };
}

test("提示词 CRUD、组织与回收站 IPC 使用固定 command 和参数名称", async () => {
  const calls: Array<{ command: string; payload: unknown }> = [];
  const prompt = samplePrompt();
  const restored: PromptRestoreOutcome = { missing_folders: ["已归档"] };
  const purge: PromptPurgeReport = { purged: 2, failures: [] };
  const promptQuery: PromptQuery = {
    text: "布光",
    tags: ["布光"],
    folder: { kind: "root" },
    favorite: null,
    location: "active",
  };
  const snapshot: PromptSnapshot = {
    prompts: [],
    folders: ["灵感"],
    tags: [{ tag: "布光", count: 1 }],
    trash_count: 0,
  };
  mockIPC((command, payload) => {
    calls.push({ command, payload });
    if (command === "create_prompt") return prompt;
    if (command === "create_prompt_folder") return "灵感";
    if (command === "rename_prompt_folder") return "档案";
    if (command === "update_prompt") return prompt;
    if (command === "prompt_detail") return prompt;
    if (command === "prompt_snapshot") return snapshot;
    if (command === "restore_prompt") return restored;
    if (command === "purge_prompt_trash") return purge;
    return null;
  });
  const edit = { body: "新正文", title: null, model: "gpt", parameters: null };

  await createPrompt({ body: "电影感布光", title: null, model: null, parameters: null, folders: [], tags: [] });
  await updatePrompt(PROMPT_ID, edit);
  await promptDetail(PROMPT_ID);
  await promptSnapshot(promptQuery);
  await createPromptFolder(null, "灵感");
  await renamePromptFolder("灵感", "档案");
  await deletePromptFolder("档案");
  await setPromptNote(PROMPT_ID, "备注");
  await setPromptFavorite(PROMPT_ID, true);
  await setPromptFolders(PROMPT_ID, ["灵感"]);
  await setPromptTags(PROMPT_ID, ["布光"]);
  await deletePrompt(PROMPT_ID);
  await restorePrompt(PROMPT_ID);
  await purgePromptTrash();

  expect(calls).toEqual([
    {
      command: "create_prompt",
      payload: {
        prompt: { body: "电影感布光", title: null, model: null, parameters: null, folders: [], tags: [] },
      },
    },
    { command: "update_prompt", payload: { id: PROMPT_ID, edit } },
    { command: "prompt_detail", payload: { id: PROMPT_ID } },
    { command: "prompt_snapshot", payload: { query: promptQuery } },
    { command: "create_prompt_folder", payload: { parent: null, name: "灵感" } },
    { command: "rename_prompt_folder", payload: { path: "灵感", newName: "档案" } },
    { command: "delete_prompt_folder", payload: { path: "档案" } },
    { command: "set_prompt_note", payload: { id: PROMPT_ID, note: "备注" } },
    { command: "set_prompt_favorite", payload: { id: PROMPT_ID, favorite: true } },
    { command: "set_prompt_folders", payload: { id: PROMPT_ID, folders: ["灵感"] } },
    { command: "set_prompt_tags", payload: { id: PROMPT_ID, tags: ["布光"] } },
    { command: "delete_prompt", payload: { id: PROMPT_ID } },
    { command: "restore_prompt", payload: { id: PROMPT_ID } },
    { command: "purge_prompt_trash", payload: {} },
  ]);
});

function sampleAssetRow(): AssetRow {
  return {
    hash: HASH,
    hash_algo: "blake3",
    media_type: "image/png",
    ext: "png",
    byte_size: 1024,
    width: 32,
    height: 32,
    imported_at: "2026-08-21T00:00:00Z",
    original_filename: "逆光.png",
    source_path: null,
    deleted_at: null,
    color_card_status: "ok",
    color_card_algo_version: 1,
    color_card_failure_reason: null,
    color_card_sampled_pixel_count: 1024,
    note: "",
    favorite: false,
    tags: [],
    folders: [],
    colors: [],
  };
}

test("普通关联、封面与图片 note/favorite IPC 使用固定 command 和参数名称", async () => {
  const calls: Array<{ command: string; payload: unknown }> = [];
  const report: ImportAndLinkReport = {
    items: [
      {
        source_path: "E:\\素材\\逆光.png",
        original_filename: "逆光.png",
        outcome: { kind: "linked_imported", hash: HASH },
      },
    ],
  };
  const detail: ImageDetail = { asset: sampleAssetRow(), linked_prompts: [] };
  const states = [
    { hash: HASH, deleted: false },
    { hash: "f".repeat(64), deleted: true },
  ];
  mockIPC((command) => {
    calls.push({ command, payload: undefined });
    if (command === "import_and_link") return report;
    if (command === "image_detail") return detail;
    if (command === "linked_image_states") return states;
    return null;
  });

  await linkImages(PROMPT_ID, [HASH]);
  await unlinkImage(PROMPT_ID, HASH);
  await setPromptCover(PROMPT_ID, HASH);
  await setPromptCover(PROMPT_ID, null);
  await importAndLink(PROMPT_ID, ["E:\\素材\\逆光.png"]);
  await imageDetail(HASH);
  await linkedImageStates(PROMPT_ID);
  await setAssetNote(HASH, "构图参考");
  await setAssetFavorite(HASH, true);

  expect(calls.map((call) => call.command)).toEqual([
    "link_images",
    "unlink_image",
    "set_prompt_cover",
    "set_prompt_cover",
    "import_and_link",
    "image_detail",
    "linked_image_states",
    "set_asset_note",
    "set_asset_favorite",
  ]);
});

test("关联与导入命令携带完整参数形状", async () => {
  const seen: Record<string, Record<string, unknown>> = {};
  mockIPC((command, payload) => {
    if (!isRecord(payload)) {
      throw new TypeError(`${command} 的 IPC 参数不是对象`);
    }
    seen[command] = payload;
    return null;
  });

  await linkImages(PROMPT_ID, [HASH]);
  await setPromptCover(PROMPT_ID, null);
  await importAndLink(PROMPT_ID, ["E:\\素材\\逆光.png"]);
  await linkedImageStates(PROMPT_ID);

  expect(seen.link_images).toEqual({ promptId: PROMPT_ID, hashes: [HASH] });
  expect(seen.set_prompt_cover).toEqual({ promptId: PROMPT_ID, cover: null });
  expect(seen.import_and_link).toEqual({ promptId: PROMPT_ID, sources: ["E:\\素材\\逆光.png"] });
  expect(seen.linked_image_states).toEqual({ promptId: PROMPT_ID });
});

test("批量命令转交逐项进度并返回统一报告", async () => {
  const assetReport: BatchReport = { succeeded: 2, failures: [] };
  const promptReport: BatchReport = {
    succeeded: 1,
    failures: [{ id: PROMPT_ID, display_name: "未命名提示词", error: { code: "prompt.write_failed", detail: null } }],
  };
  const assetProgress = { done: 1, total: 2 };
  const promptProgress = { done: 1, total: 1 };

  mockIPC((command, payload) => {
    if (!isRecord(payload)) {
      throw new TypeError(`${command} 的 IPC 参数不是对象`);
    }
    if (!(payload.onProgress instanceof Channel)) {
      throw new TypeError(`${command} 缺少进度 Channel`);
    }
    if (command === "batch_add_asset_folder") {
      payload.onProgress.onmessage(assetProgress);
      return assetReport;
    }
    if (command === "batch_set_prompt_favorite") {
      payload.onProgress.onmessage(promptProgress);
      return promptReport;
    }
    throw new TypeError(`意外的命令：${command}`);
  });

  const receivedAsset = vi.fn<(progress: { done: number; total: number }) => void>();
  const receivedPrompt = vi.fn<(progress: { done: number; total: number }) => void>();
  await expect(batchAddAssetFolder([HASH], "配色", receivedAsset)).resolves.toEqual(assetReport);
  await expect(batchSetPromptFavorite([PROMPT_ID], true, receivedPrompt)).resolves.toEqual(promptReport);
  expect(receivedAsset).toHaveBeenCalledExactlyOnceWith(assetProgress);
  expect(receivedPrompt).toHaveBeenCalledExactlyOnceWith(promptProgress);
});

test("global_search 按类型分组返回结果", async () => {
  const result: GlobalSearchResult = { assets: [], prompts: [] };
  mockIPC((command, payload) => {
    expect(command).toBe("global_search");
    if (!isRecord(payload)) {
      throw new TypeError("global_search 的 IPC 参数不是对象");
    }
    expect(payload.text).toBe("逆光");
    return result;
  });
  await expect(globalSearch("逆光")).resolves.toEqual(result);
});

test("布局偏好按 libraryId 读写并允许从未保存", async () => {
  const calls: Array<{ command: string; payload: unknown }> = [];
  const layout = { image: { view: "grid" }, prompt: { sort: "created_desc" } };
  mockIPC((command, payload) => {
    calls.push({ command, payload });
    if (command === "read_layout") return layout;
    return null;
  });
  const libraryId = "018f3c9e-6c00-7000-8000-0000000000aa";

  await expect(readLayout(libraryId)).resolves.toEqual(layout);
  await writeLayout(libraryId, layout);

  expect(calls).toEqual([
    { command: "read_layout", payload: { libraryId } },
    { command: "write_layout", payload: { libraryId, layout } },
  ]);
});
