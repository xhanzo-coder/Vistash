// @vitest-environment jsdom

import { afterEach, expect, test, vi } from "vitest";

import { Channel } from "@tauri-apps/api/core";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

import {
  batchMoveAssetsToFolder,
  batchSetPromptFavorite,
  catalogSnapshot,
  commitV3Migration,
  copyAssetToClipboard,
  createFolder,
  createPrompt,
  createPromptFolder,
  deleteAsset,
  deleteFolder,
  deletePrompt,
  deletePromptFolder,
  exportAssets,
  planExport,
  planV3Migration,
  openWithDefaultApp,
  globalSearch,
  imageDetail,
  importAndLink,
  importSources,
  importStop,
  linkImages,
  linkedImageStates,
  migrateLibrary,
  moveAssetToFolder,
  pasteImport,
  promptDetail,
  promptSnapshot,
  purgePromptTrash,
  purgeTrash,
  readLayout,
  renameFolder,
  renameAssetDisplayFilename,
  renamePromptFolder,
  restoreAsset,
  restorePrompt,
  setAssetFavorite,
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
  ConflictPolicy,
  ExportOutcome,
  PlannedExport,
  FolderMutationProgress,
  GlobalSearchResult,
  ImageDetail,
  ImportAndLinkReport,
  ImportOutcome,
  TransferProgress,
  TransferRunStatus,
  V3MigrationPlan,
  V3FolderResolutionInput,
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

test("v3 迁移规划只读返回冲突，提交只发送唯一选择与进度通道", async () => {
  const plan: V3MigrationPlan = {
    entries: [
      {
        hash: HASH,
        original_filename: "雨夜街道.png",
        kind: "conflict",
        candidates: ["参考", "配色"],
      },
    ],
  };
  const resolutions: V3FolderResolutionInput[] = [{ hash: HASH, folder: "配色" }];
  const progress: MigrationProgress = {
    stage: "replaced",
    done: 1,
    total: 1,
    current_filename: "雨夜街道.png",
  };
  const status: LibraryStatus = {
    path: "E:\\视觉档案",
    library_id: "018f3c9e-6c00-7000-8000-0000000000aa",
    recorded_path: "E:\\视觉档案",
    problem: null,
  };
  const calls: Array<{ command: string; payload: unknown }> = [];
  mockIPC((command, payload) => {
    calls.push({ command, payload });
    if (command === "plan_v3_migration") return plan;
    if (command === "commit_v3_migration") {
      if (!isRecord(payload)) throw new TypeError("提交迁移参数不是对象");
      const channel = payload.onProgress;
      if (channel instanceof Channel) channel.onmessage(progress);
      return status;
    }
    throw new TypeError(`未覆盖命令：${command}`);
  });

  await expect(planV3Migration("E:\\视觉档案")).resolves.toEqual(plan);
  const received = vi.fn<(value: MigrationProgress) => void>();
  await expect(commitV3Migration("E:\\视觉档案", resolutions, received)).resolves.toEqual(status);
  expect(received).toHaveBeenCalledExactlyOnceWith(progress);
  expect(calls[0]).toEqual({
    command: "plan_v3_migration",
    payload: { path: "E:\\视觉档案" },
  });
  expect(calls[1]?.command).toBe("commit_v3_migration");
  expect(calls[1]?.payload).toMatchObject({
    path: "E:\\视觉档案",
    resolutions,
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test("显示文件名修改与导出冲突规划使用独立只读 IPC", async () => {
  const planned: PlannedExport[] = [
    { hash: HASH, display_filename: "雨夜街道.png", existing: true },
  ];
  const calls: Array<{ command: string; payload: unknown }> = [];
  mockIPC((command, payload) => {
    calls.push({ command, payload });
    if (command === "plan_export") return planned;
    return null;
  });

  await renameAssetDisplayFilename(HASH, "雨夜街道");
  await expect(planExport([HASH], "E:\\导出")).resolves.toEqual(planned);

  expect(calls).toEqual([
    {
      command: "rename_asset_display_filename",
      payload: { hash: HASH, stem: "雨夜街道" },
    },
    {
      command: "plan_export",
      payload: { hashes: [HASH], targetDir: "E:\\导出" },
    },
  ]);
});

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

test("importSources 把路径、当前文件夹与数量进度转交给调用方", async () => {
  const expected: TransferProgress = {
    task_id: "task-import-001",
    done: 4,
    total: 10,
    current_filename: "pinterest_005.jpg",
  };
  const outcome: ImportOutcome = {
    task_id: "task-import-001",
    imported: 10,
    skipped_non_images: 1,
    duplicates: 2,
    pending_count: 3,
    failures: [],
  };

  mockIPC((command, payload) => {
    expect(command).toBe("import_sources");
    if (!isRecord(payload)) {
      throw new TypeError("import_sources 的 IPC 参数不是对象");
    }
    const args = payload;
    if (args.currentFolder !== "参考/构图") {
      throw new TypeError("import_sources 缺少当前文件夹参数");
    }
    const channel = args.onProgress;
    if (channel instanceof Channel) {
      channel.onmessage(expected);
    }
    return outcome;
  });

  const received = vi.fn<(progress: TransferProgress) => void>();
  await expect(
    importSources(["E:\\素材"], "参考/构图", received),
  ).resolves.toEqual(outcome);
  expect(received).toHaveBeenCalledExactlyOnceWith(expected);
});

test("importStop 调用真实停止命令并转交任务状态", async () => {
  const stopping: TransferRunStatus = { task_id: "task-001", state: "stopping" };
  mockIPC((command, payload) => {
    expect(command).toBe("import_stop");
    expect(payload).toEqual({ taskId: "task-001" });
    return stopping;
  });
  await expect(importStop("task-001")).resolves.toEqual(stopping);
});

test("pasteImport 走窗口粘贴命令且不携带任何像素参数", async () => {
  // 设计第十一条：前端只决定按键由谁认领；分流在后端。这里固定的合同是
  // command 名与参数面——除当前文件夹与进度通道外不得有其他入参，更没有
  // 像素缓冲的位置。
  const outcome: ImportOutcome = {
    task_id: "task-paste-001",
    imported: 1,
    skipped_non_images: 0,
    duplicates: 0,
    pending_count: 0,
    failures: [],
  };

  mockIPC((command, payload) => {
    expect(command).toBe("paste_import");
    if (!isRecord(payload)) {
      throw new TypeError("paste_import 的 IPC 参数不是对象");
    }
    if (payload.currentFolder !== null) {
      throw new TypeError("paste_import 的当前文件夹应为 null");
    }
    if (!("onProgress" in payload) || Object.keys(payload).length !== 2) {
      throw new TypeError("paste_import 的参数面超出约定");
    }
    const channel = payload.onProgress;
    if (channel instanceof Channel) {
      channel.onmessage({
        task_id: "task-paste-001",
        done: 0,
        total: 1,
        current_filename: "剪贴板图片 2026-08-26 142530.png",
      });
    }
    return outcome;
  });

  const received = vi.fn<(progress: TransferProgress) => void>();
  await expect(pasteImport(null, received)).resolves.toEqual(outcome);
  expect(received).toHaveBeenCalledExactlyOnceWith({
    task_id: "task-paste-001",
    done: 0,
    total: 1,
    current_filename: "剪贴板图片 2026-08-26 142530.png",
  });
});

test("pasteImport 在剪贴板无可导入内容时转交全零报告", async () => {
  // 文本/网址/空剪贴板不是错误：后端返回全零报告，前端据此提示而不是弹错。
  const empty: ImportOutcome = {
    task_id: null,
    imported: 0,
    skipped_non_images: 0,
    duplicates: 0,
    pending_count: 0,
    failures: [],
  };
  mockIPC((command) => {
    expect(command).toBe("paste_import");
    return empty;
  });
  await expect(pasteImport(null, () => {})).resolves.toEqual(empty);
});

test("exportAssets 使用固定 command、参数面与类型化冲突策略", async () => {
  // 设计第十二条：导出是只读库的出站操作；策略是类型化枚举值，
  // 覆盖（overwrite）必须由界面先取得使用者明确确认后才允许传入。
  const outcome: ExportOutcome = {
    task_id: "task-export-001",
    exported: ["风景.png", "人像.jpg"],
    skipped_existing: 1,
    failed: [
      {
        hash: "0".repeat(64),
        display_filename: null,
        error: { code: "export.asset_missing", detail: null },
      },
    ],
    pending_count: 0,
  };

  mockIPC((command, payload) => {
    expect(command).toBe("export_assets");
    if (!isRecord(payload)) {
      throw new TypeError("export_assets 的 IPC 参数不是对象");
    }
    if (payload.policy !== "auto_number") {
      throw new TypeError(`冲突策略应为类型化枚举值，收到：${String(payload.policy)}`);
    }
    if (
      !Array.isArray(payload.hashes) ||
      payload.targetDir !== "E:\\导出" ||
      !("onProgress" in payload) ||
      Object.keys(payload).length !== 4
    ) {
      throw new TypeError("export_assets 的参数面超出约定");
    }
    const channel = payload.onProgress;
    if (channel instanceof Channel) {
      channel.onmessage({
        task_id: "task-export-001",
        done: 0,
        total: 2,
        current_filename: "风景.png",
      });
    }
    return outcome;
  });

  const received = vi.fn<(progress: TransferProgress) => void>();
  const policy: ConflictPolicy = "auto_number";
  await expect(
    exportAssets(["0".repeat(64)], "E:\\导出", policy, received),
  ).resolves.toEqual(outcome);
  expect(received).toHaveBeenCalledExactlyOnceWith({
    task_id: "task-export-001",
    done: 0,
    total: 2,
    current_filename: "风景.png",
  });
});

test("copyAssetToClipboard 与 openWithDefaultApp 是单哈希窄命令", async () => {
  // 任务 5.6：复制图像与默认程序打开都只允许单张——"多选不合成"由参数面
  // 在结构上锁死：入参只有 hash 一个键，不存在数组形状的入口；多选出站
  // 只能走 export_assets 的批量通路。
  const seen: Record<string, Record<string, unknown>> = {};
  mockIPC((command, payload) => {
    if (!isRecord(payload)) {
      throw new TypeError(`${command} 的 IPC 参数不是对象`);
    }
    if (Object.keys(payload).length !== 1 || !("hash" in payload)) {
      throw new TypeError(`${command} 的参数面超出约定（只允许单个 hash）`);
    }
    seen[command] = payload;
    return null;
  });

  const hash = "b".repeat(64);
  // 后端返回 Rust 的 unit，经 JSON 序列化到达前端是 null。
  await expect(copyAssetToClipboard(hash)).resolves.toBeNull();
  await expect(openWithDefaultApp(hash)).resolves.toBeNull();

  expect(seen.copy_asset_to_clipboard).toEqual({ hash });
  expect(seen.open_with_default_app).toEqual({ hash });
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
  await moveAssetToFolder("a".repeat(64), "配色");
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
      command: "move_asset_to_folder",
      payload: { hash: "a".repeat(64), folder: "配色" },
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
    display_filename: "逆光.png",
    source_path: null,
    deleted_at: null,
    color_card_status: "ok",
    color_card_algo_version: 1,
    color_card_failure_reason: null,
    color_card_sampled_pixel_count: 1024,
    note: "",
    favorite: false,
    tags: [],
    folder: null,
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
    if (command === "batch_move_assets_to_folder") {
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
  await expect(batchMoveAssetsToFolder([HASH], "配色", receivedAsset)).resolves.toEqual(assetReport);
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
