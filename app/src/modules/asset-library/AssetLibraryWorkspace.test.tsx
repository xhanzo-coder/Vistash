// @vitest-environment jsdom

/**
 * 图片模块公开 interface 行为测试。
 *
 * 测试只从 `./index.ts` 的公开出口渲染 [`AssetLibraryWorkspace`]，在传输接缝
 * （`@tauri-apps/api/mocks`）伪造一次 IPC 后端；不导入 `internal/`，也不在每个
 * 叶子组件逐个 mock 命令。覆盖四个验收面：
 *
 * 1. **查询恢复**：`resume` 条目按库身份恢复持久化的查询与视图，修改经
 *    `write_layout` 写回同一库键。
 * 2. **全局定位**：`locate` 条目把目标设为活动项与选中项，重复投递同一
 *    `requestId` 幂等，过期条目不得劫持较新的定位。
 * 3. **视图切换**：瀑布流与详情列表共享同一查询、选择集合与活动项。
 * 4. **libraryId 隔离**：不同会话各取各的快照与偏好，写入不越过库边界。
 *
 * 本测试先于实施落地（红）：同时它也是实现方 MUST 满足的界面可观察契约——
 * - 文件名搜索框 `aria-label="按文件名搜索"`；
 * - 视图切换是文案为「瀑布流」「详情列表」的按钮，状态用 `aria-pressed` 表达；
 * - 素材项携带 `data-hash` 与 `data-waterfall-item` / `data-list-item` 标记，
 *   用 `role="option"` + `aria-selected` 表达选中集合，用 `aria-current="true"`
 *   表达唯一活动项；
 * - 集合查询使用后端当前库；布局按 libraryId 持久化；同一 QueryClient 内切库
 *   不能复用另一库的数据。集合不依赖外壳级刷新协议。
 */

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { createRequestId, parseAssetId, parseLibraryId, type AssetId } from "../../app/common";
import { createAppQueryClient } from "../../app/queryClient";
import { appTaskCenter } from "../../app/runtime";
import { canStopTransferTask, getTransferTaskStopError, stopAssetTransferTask } from "./index";
import { TaskCenterPopover } from "../../app/shell/TaskCenterPopover";
import type { AssetRow, CatalogSnapshot, ExportOutcome, ImportOutcome, PromptRow } from "../../shared/types";
import { UiProvider } from "../../ui/UiProvider";
import { createWorkspaceNavigation, type WorkspaceNavigation } from "../../app/navigation";
import { createImagePromptRelations, createTauriImagePromptRelationAdapter, type ImagePromptRelations } from "../image-prompt-relations";
import { blockIfPromptDraftDirty } from "../prompt-library";
import {
  AssetLibraryWorkspace,
  type AssetLibraryEntry,
  type AssetLibraryWorkspaceProps,
} from "./index";

const LIB_A = parseLibraryId("018f3c9e-6c00-7000-8000-0000000000aa");
const LIB_B = parseLibraryId("018f3c9e-6c00-7000-8000-0000000000bb");

const H_STREET = parseAssetId("a".repeat(64));
const H_NIGHT = parseAssetId("b".repeat(64));
const H_TRASHED = parseAssetId("c".repeat(64));

function makeSession(id: typeof LIB_A, displayName: string) {
  return { id, displayName };
}

function assetRow(overrides: Partial<AssetRow> & Pick<AssetRow, "hash" | "display_filename">): AssetRow {
  return {
    hash_algo: "blake3",
    media_type: "png",
    ext: "png",
    byte_size: 96,
    width: 640,
    height: 960,
    imported_at: "2026-08-20T08:00:00Z",
    original_filename: "IMG_0001.PNG",
    source_path: null,
    folder: null,
    deleted_at: null,
    color_card_status: "ok",
    color_card_algo_version: 1,
    color_card_failure_reason: null,
    color_card_sampled_pixel_count: 16,
    note: "",
    favorite: false,
    tags: [],
    colors: [],
    ...overrides,
  };
}

/** 甲库活动集合：两条素材分别属于两级文件夹，另有一条在回收站。 */
const SNAPSHOT_A: CatalogSnapshot = {
  assets: [
    assetRow({
      hash: H_STREET,
      display_filename: "晨光街道.png",
      folder: "参考",
      tags: ["人物"],
      favorite: true,
    }),
    assetRow({
      hash: H_NIGHT,
      display_filename: "雨夜霓虹.jpg",
      ext: "jpg",
      media_type: "jpeg",
      folder: "参考/构图",
      imported_at: "2026-08-21T09:00:00Z",
    }),
  ],
  folders: ["参考", "参考/构图"],
  tags: [{ tag: "人物", count: 1 }],
  trash_count: 1,
};

/** 回收站夹具每用例重建：批量回收站测试会真实改动假快照。 */
function freshTrashSnapshot(): CatalogSnapshot {
  return {
    assets: [
      assetRow({
        hash: H_TRASHED,
        display_filename: "废弃草图.png",
        deleted_at: "2026-08-22T10:00:00Z",
      }),
    ],
    folders: SNAPSHOT_A.folders,
    tags: SNAPSHOT_A.tags,
    trash_count: 1,
  };
}

/** 乙库内容与甲库完全不同：用于证明缓存与渲染不会跨库泄漏。 */
const SNAPSHOT_B: CatalogSnapshot = {
  assets: [
    assetRow({
      hash: H_NIGHT,
      display_filename: "远山湖岸.jpg",
      ext: "jpg",
      media_type: "jpeg",
    }),
  ],
  folders: [],
  tags: [],
  trash_count: 0,
};

/** 甲库持久化布局：使用者上次停在「参考」里搜「晨光」的详情列表视图。 */
function savedAssetsSectionA(): Record<string, unknown> {
  return {
    view: "list",
    text: "晨光",
    folder: { kind: "path", path: "参考" },
    tags: ["人物"],
    favorite: true,
    location: "active",
  };
}

let ipcCalls: Array<{ command: string; payload: unknown; currentLibrary: string }>;
let currentLibrary = LIB_A;
let queryClient = createAppQueryClient();
/** 以 libraryId 为键的假持久化偏好；`write_layout` 会更新它，模拟真实落盘。 */
let savedLayouts: Record<string, unknown>;
let snapshotsByLibrary: Record<string, CatalogSnapshot>;
let trashSnapshotA: CatalogSnapshot;
let rejectLayoutWrite = false;
let rejectLayoutRead = false;
let nextWriteGate: Promise<void> | null = null;
let failedBatchId: string | null = null;
let rejectFolderMutation = false;
let renameFailure: string | null = null;
let applyFilenameFilter = false;
let filenameQueryFailure = false;
let inspectorWriteFailure = false;
let relationFailurePromptId: string | null = null;
let noteGate: Promise<void> | null = null;
let prompts: PromptRow[];
let detailFailure = false;
let promptFailure = false;
let promptCreateFailure = false;
let promptSerial = 0;
let applyTagFilter = false;
let applyFolderFilter = false;
let deletedFolders: Map<string, string | null>;
let failedRestoreId: string | null = null;
let failedPurgeId: string | null = null;
let restoreGate: Promise<void> | null = null;
let purgeFailsAfterDelete = false;
let originalFailure = false;
let originalGate: Promise<ArrayBuffer> | null = null;
let dialogImageFiles: string[] = [];
let dialogExportDirectory: string | null = null;
let importGate: Promise<ImportOutcome> | null = null;
let collectionGate: Promise<CatalogSnapshot> | null = null;
let emitImportProgress = false;
let importStopState: "stopping" | "stopped" = "stopped";
let importStopFailure = false;
let exportConflict = false;
let exportGate: Promise<ExportOutcome> | null = null;
let outboundFailure: "copy" | "open" | null = null;
let createObjectUrlMock: ReturnType<typeof vi.fn>;
let revokeObjectUrlMock: ReturnType<typeof vi.fn>;
let testRelations: ImagePromptRelations;
let testNavigation: WorkspaceNavigation;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError("测试合同要求对象载荷");
  return value;
}

/** 与后端一致的父路径推导：顶层文件夹的父级是 null。 */
function parentOf(value: string): string | null {
  return value.includes("/") ? value.slice(0, value.lastIndexOf("/")) : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string")) throw new TypeError("测试合同要求字符串数组");
  return value;
}

function hasProgressChannel(value: unknown): value is { onmessage: (progress: unknown) => void } {
  return typeof value === "object" && value !== null && "onmessage" in value && typeof value.onmessage === "function";
}

function recordedQueries(): Array<{ libraryId: unknown; query: Record<string, unknown> }> {
  return ipcCalls
    .filter((call) => call.command === "catalog_snapshot")
    .map((call) => {
      const payload = record(call.payload);
      return { libraryId: call.currentLibrary, query: record(payload.query) };
    });
}

function recordedWrites(): Array<{ libraryId: unknown; layout: Record<string, unknown> }> {
  return ipcCalls
    .filter((call) => call.command === "write_layout")
    .map((call) => {
      const payload = record(call.payload);
      return { libraryId: payload.libraryId, layout: record(payload.layout) };
    });
}

class DormantIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = "0px";
  readonly scrollMargin = "0px";
  readonly thresholds = [0];

  disconnect(): void {}
  observe(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  unobserve(): void {}
}

/** jsdom 不做布局，窗口层级由显式设定的视口宽度决定（沿用旧工作区测试约定）。 */
function setWindowWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
}

function stubGeometry(): void {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
    this: Element,
  ) {
    const style = this instanceof HTMLElement ? this.style : null;
    const width = Number.parseFloat(style?.width ?? "") || 1200;
    const height = Number.parseFloat(style?.height ?? "") || 800;
    return {
      x: 0,
      y: 0,
      width,
      height,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      toJSON: () => ({}),
    };
  });
}

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  setWindowWidth(1440);
  stubGeometry();
  vi.stubGlobal("IntersectionObserver", DormantIntersectionObserver);
  createObjectUrlMock = vi.fn(() => "blob:vistash-test");
  revokeObjectUrlMock = vi.fn();
  vi.stubGlobal("URL", { createObjectURL: createObjectUrlMock, revokeObjectURL: revokeObjectUrlMock });

  ipcCalls = [];
  testNavigation = createWorkspaceNavigation();
  testRelations = createImagePromptRelations({ adapter: createTauriImagePromptRelationAdapter(), navigation: testNavigation });
  currentLibrary = LIB_A;
  queryClient = createAppQueryClient();
  savedLayouts = {};
  rejectLayoutWrite = false;
  rejectLayoutRead = false;
  nextWriteGate = null;
  failedBatchId = null;
  rejectFolderMutation = false;
  renameFailure = null;
  applyFilenameFilter = false;
  filenameQueryFailure = false;
  inspectorWriteFailure = false;
  relationFailurePromptId = null;
  noteGate = null;
  detailFailure = false;
  promptFailure = false;
  promptCreateFailure = false;
  promptSerial = 0;
  applyTagFilter = false;
  applyFolderFilter = false;
  deletedFolders = new Map([[H_TRASHED, "参考"]]);
  failedRestoreId = null;
  failedPurgeId = null;
  restoreGate = null;
  purgeFailsAfterDelete = false;
  originalFailure = false;
  originalGate = null;
  dialogImageFiles = [];
  dialogExportDirectory = null;
  importGate = null;
  collectionGate = null;
  emitImportProgress = false;
  importStopState = "stopped";
  importStopFailure = false;
  exportConflict = false;
  exportGate = null;
  outboundFailure = null;
  prompts = ["光影参考", "已删除记录"].map((title, index) => ({ id: `prompt-${index}`, title, body: "普通提示词正文", model: null, parameters: null, note: "", favorite: false, folders: [], tags: [], linked_image_hashes: index === 1 ? [H_STREET] : [], cover_image_hash: null, resolved_cover_hash: null, created_at: "2026-08-28T00:00:00Z", updated_at: "2026-08-28T00:00:00Z", deleted_at: index === 1 ? "2026-08-28T00:00:00Z" : null }));
  snapshotsByLibrary = {
    [LIB_A]: SNAPSHOT_A,
    [LIB_B]: SNAPSHOT_B,
  };
  trashSnapshotA = freshTrashSnapshot();

  mockIPC((command, payload) => {
    ipcCalls.push({ command, payload, currentLibrary });
    const request = record(payload);
    switch (command) {
      case "plugin:dialog|open": {
        const options = record(request.options);
        if (options.title === "选择图片导出目录") return dialogExportDirectory;
        return options.directory === true ? "E:\\待导入" : dialogImageFiles;
      }
      case "paste_import":
      case "import_sources": {
        if (emitImportProgress) {
          const channel = request.onProgress;
          if (hasProgressChannel(channel)) {
            channel.onmessage({ task_id: "backend-import-test", done: 1, total: 3, current_filename: "一张.png" });
          }
        }
        if (importGate !== null) { const gate = importGate; importGate = null; return gate; }
        return { task_id: "task-import-test", imported: 0, skipped_non_images: 0, duplicates: 0, pending_count: 0, failures: [] };
      }
      case "plan_export": {
        const hashes = request.hashes;
        if (!Array.isArray(hashes) || hashes.length === 0 || !hashes.every((hash): hash is string => typeof hash === "string")) throw new TypeError("导出规划哈希无效");
        return [{ hash: hashes[0], display_filename: "晨光街道.png", existing: exportConflict }];
      }
      case "export_assets": {
        if (exportGate !== null) { const gate = exportGate; exportGate = null; return gate; }
        return { task_id: "task-export-test", exported: ["晨光街道.png"], skipped_existing: 0, failed: [], pending_count: 0 };
      }
      case "copy_asset_to_clipboard": if (outboundFailure === "copy") throw { code: "clipboard.write_failed", detail: "复制失败" }; return undefined;
      case "open_with_default_app": if (outboundFailure === "open") throw { code: "external.open_failed", detail: "打开失败" }; return undefined;
      case "import_stop": {
        if (importStopFailure) throw { code: "transfer.task_not_active", detail: "终态确认失败" };
        return { task_id: "backend-import-test", state: importStopState };
      }
      case "catalog_snapshot": {
        if (filenameQueryFailure) throw { code: "library.io_failed", detail: "文件名查询失败" };
        expect(request).not.toHaveProperty("libraryId");
        const query = record(request.query);
        const libraryKey = currentLibrary;
        const base =
          query.location === "trash" && libraryKey === LIB_A ? trashSnapshotA : snapshotsByLibrary[libraryKey];
        if (base === undefined) throw new Error(`未知库的集合查询：${libraryKey}`);
        if (collectionGate !== null) {
          const gate = collectionGate;
          collectionGate = null;
          return gate;
        }
        if (applyFolderFilter) {
          const folder = record(query.folder);
          const assets = folder.kind === "all"
            ? base.assets
            : folder.kind === "root"
              ? base.assets.filter((asset) => asset.folder === null)
              : base.assets.filter((asset) => asset.folder === folder.path);
          return { ...base, assets };
        }
        if (applyTagFilter) {
          const tags = query.tags;
          if (!Array.isArray(tags) || !tags.every((tag): tag is string => typeof tag === "string")) throw new TypeError("查询标签无效");
          return { ...base, assets: base.assets.filter((asset) => tags.every((tag) => asset.tags.includes(tag))) };
        }
        if (applyFilenameFilter) {
          if (typeof query.text !== "string") throw new TypeError("缺少文件名查询文本");
          const needle = query.text.toLowerCase();
          return { ...base, assets: base.assets.filter((asset) => asset.display_filename.toLowerCase().includes(needle) || asset.original_filename.toLowerCase().includes(needle)) };
        }
        return base;
      }
      case "read_layout": {
        if (rejectLayoutRead) throw { code: "library.io_failed", detail: "无法读取布局" };
        const libraryKey = request.libraryId;
        if (typeof libraryKey !== "string") throw new TypeError("read_layout 缺少 libraryId");
        return savedLayouts[libraryKey] ?? null;
      }
      case "write_layout": {
        if (rejectLayoutWrite) throw { code: "library.io_failed", detail: "磁盘只读" };
        const libraryKey = request.libraryId;
        if (typeof libraryKey !== "string") throw new TypeError("write_layout 缺少 libraryId");
        if (nextWriteGate !== null) {
          const gate = nextWriteGate;
          nextWriteGate = null;
          return gate.then(() => { savedLayouts[libraryKey] = request.layout; return undefined; });
        }
        savedLayouts[libraryKey] = request.layout;
        return undefined;
      }
      case "set_asset_favorite": {
        const snapshot = snapshotsByLibrary[currentLibrary];
        if (snapshot === undefined || typeof request.favorite !== "boolean") throw new TypeError("收藏测试收到非法载荷");
        const favorite = request.favorite;
        snapshotsByLibrary[currentLibrary] = { ...snapshot, assets: snapshot.assets.map((asset) => asset.hash === request.hash ? { ...asset, favorite } : asset) };
        return undefined;
      }
      case "regenerate_color_card": {
        const snapshot = snapshotsByLibrary[currentLibrary];
        if (snapshot === undefined || typeof request.hash !== "string") throw new TypeError("色卡重算请求非法");
        snapshotsByLibrary[currentLibrary] = {
          ...snapshot,
          assets: snapshot.assets.map((asset) => asset.hash === request.hash ? {
            ...asset,
            color_card_status: "ok",
            color_card_algo_version: 2,
            color_card_failure_reason: null,
            color_card_sampled_pixel_count: 25_600,
            colors: [{ hex: "#315f73", oklab_l: .5, oklab_a: -.1, oklab_b: -.1, share: 1, role: "dominant" }],
          } : asset),
        };
        return undefined;
      }
      case "image_detail": {
        if (detailFailure) throw { code: "library.io_failed", detail: "详情读取失败" };
        const snapshot = snapshotsByLibrary[currentLibrary];
        if (snapshot === undefined) throw new Error("未知详情库");
        const asset = [...snapshot.assets, ...trashSnapshotA.assets].find((item) => item.hash === request.hash);
        if (asset === undefined) throw new Error("详情测试目标不存在");
        return { asset, linked_prompts: prompts.filter((prompt) => prompt.linked_image_hashes.includes(asset.hash)) };
      }
      case "prompt_snapshot": {
        if (promptFailure) throw { code: "library.io_failed", detail: "候选读取失败" };
        const query = record(request.query);
        expect(query.location).toBe("active");
        if (typeof query.text !== "string") throw new TypeError("候选搜索无效");
        const text = query.text;
        return { prompts: prompts.filter((prompt) => prompt.deleted_at === null && `${prompt.title} ${prompt.body}`.includes(text)), folders: [], tags: [], trash_count: 1 };
      }
      case "create_prompt": {
        if (promptCreateFailure) throw { code: "library.prompt_write_failed", detail: "提示词目录只读" };
        const draft = record(request.prompt);
        if (typeof draft.body !== "string" || draft.body.trim().length === 0) throw new TypeError("创建提示词缺少正文");
        const row: PromptRow = {
          id: `created-prompt-${++promptSerial}`,
          body: draft.body,
          title: typeof draft.title === "string" ? draft.title : null,
          model: typeof draft.model === "string" ? draft.model : null,
          parameters: typeof draft.parameters === "string" ? draft.parameters : null,
          note: "",
          favorite: false,
          folders: [],
          tags: [],
          linked_image_hashes: [],
          cover_image_hash: null,
          resolved_cover_hash: null,
          created_at: "2026-08-31T08:00:00Z",
          updated_at: "2026-08-31T08:00:00Z",
          deleted_at: null,
        };
        prompts = [...prompts, row];
        return { ...row, format_version: 1, deleted_from_folders: null };
      }
      case "prompt_detail": {
        const prompt = prompts.find((item) => item.id === request.id);
        if (prompt === undefined) throw { code: "prompt.not_found", detail: "目标已永久删除" };
        return { ...prompt, format_version: 1 };
      }
      case "link_images":
      case "unlink_image": {
        if (inspectorWriteFailure || command === "link_images" && request.promptId === relationFailurePromptId) throw { code: "library.io_failed", detail: "关联写入失败" };
        if (command === "link_images") {
          const hashes = request.hashes;
          if (!Array.isArray(hashes) || !hashes.every((hash): hash is string => typeof hash === "string")) throw new TypeError("关联目标非法");
          prompts = prompts.map((prompt) => prompt.id === request.promptId ? { ...prompt, linked_image_hashes: [...new Set([...prompt.linked_image_hashes, ...hashes])] } : prompt);
        } else prompts = prompts.map((prompt) => prompt.id === request.promptId ? { ...prompt, linked_image_hashes: prompt.linked_image_hashes.filter((hash) => hash !== request.hash) } : prompt);
        return undefined;
      }
      case "move_asset_to_folder":
      case "set_asset_tags": {
        if (inspectorWriteFailure) throw { code: "library.asset_metadata_write_failed", detail: "组织写入失败" };
        const snapshot = snapshotsByLibrary[currentLibrary];
        if (snapshot === undefined) throw new Error("未知组织库");
        if (command === "move_asset_to_folder") {
          const folder = request.folder;
          if (folder !== null && typeof folder !== "string") throw new TypeError("移动目标非法");
          snapshotsByLibrary[currentLibrary] = { ...snapshot, assets: snapshot.assets.map((asset) => asset.hash === request.hash ? { ...asset, folder } : asset) };
        } else {
          const tags = request.tags;
          if (!Array.isArray(tags) || !tags.every((tag): tag is string => typeof tag === "string")) throw new TypeError("标签非法");
          snapshotsByLibrary[currentLibrary] = { ...snapshot, assets: snapshot.assets.map((asset) => asset.hash === request.hash ? { ...asset, tags } : asset) };
        }
        return undefined;
      }
      case "set_asset_note": {
        const library = currentLibrary;
        const hash = request.hash;
        const note = request.note;
        if (typeof note !== "string" || typeof hash !== "string") throw new TypeError("备注请求无效");
        if (inspectorWriteFailure) throw { code: "library.asset_metadata_write_failed", detail: "只读备注" };
        const commit = (): void => {
          const snapshot = snapshotsByLibrary[library];
          if (snapshot === undefined) throw new Error("备注目标库不存在");
          snapshotsByLibrary[library] = { ...snapshot, assets: snapshot.assets.map((asset) => asset.hash === hash ? { ...asset, note } : asset) };
        };
        if (noteGate !== null) {
          const gate = noteGate;
          noteGate = null;
          return gate.then(commit);
        }
        commit();
        return undefined;
      }
      case "rename_asset_display_filename": {
        if (renameFailure !== null) throw { code: renameFailure, detail: "名称元数据无法写入" };
        const snapshot = snapshotsByLibrary[currentLibrary];
        const stem = request.stem;
        if (snapshot === undefined || typeof stem !== "string" || typeof request.hash !== "string") throw new TypeError("重命名素材请求非法");
        snapshotsByLibrary[currentLibrary] = { ...snapshot, assets: snapshot.assets.map((asset) => asset.hash === request.hash ? { ...asset, display_filename: `${stem.trim()}.${asset.ext}` } : asset) };
        return undefined;
      }
      case "restore_asset": {
        if (request.hash === failedRestoreId) throw { code: "trash.restore_failed", detail: "恢复写入失败" };
        const library = currentLibrary;
        const snapshot = snapshotsByLibrary[library];
        const asset = trashSnapshotA.assets.find((row) => row.hash === request.hash);
        if (snapshot === undefined || asset === undefined) throw new Error("还原目标不存在");
        const previous = deletedFolders.get(asset.hash);
        if (previous === undefined) throw new Error("测试缺少删除前归属");
        const missing = previous !== null && !snapshot.folders.includes(previous);
        const restored = { ...asset, folder: missing ? null : previous, deleted_at: null };
        const commit = () => {
          trashSnapshotA = { ...trashSnapshotA, assets: trashSnapshotA.assets.filter((row) => row.hash !== asset.hash), trash_count: trashSnapshotA.trash_count - 1 };
          snapshotsByLibrary[library] = { ...snapshot, assets: [...snapshot.assets, restored], trash_count: trashSnapshotA.trash_count };
          return { missing_folders: missing ? [previous] : [] };
        };
        if (restoreGate !== null) {
          const gate = restoreGate;
          restoreGate = null;
          return gate.then(commit);
        }
        return commit();
      }
      case "purge_trash": {
        if (purgeFailsAfterDelete) {
          const remaining = trashSnapshotA.assets.slice(1);
          trashSnapshotA = { ...trashSnapshotA, assets: remaining, trash_count: remaining.length };
          const snapshot = snapshotsByLibrary[currentLibrary];
          if (snapshot === undefined) throw new Error("清空目标库不存在");
          snapshotsByLibrary[currentLibrary] = { ...snapshot, trash_count: remaining.length };
          throw { code: "library.io_failed", detail: "删除后索引重建失败" };
        }
        const failed = trashSnapshotA.assets.filter((asset) => asset.hash === failedPurgeId);
        const purged = trashSnapshotA.assets.length - failed.length;
        trashSnapshotA = { ...trashSnapshotA, assets: failed, trash_count: failed.length };
        const snapshot = snapshotsByLibrary[currentLibrary];
        if (snapshot === undefined) throw new Error("清空目标库不存在");
        snapshotsByLibrary[currentLibrary] = { ...snapshot, trash_count: failed.length };
        return { purged, failures: failed.map((asset) => ({ hash: asset.hash, original_filename: asset.original_filename, error: { code: "trash.purge_failed", detail: "原图仍被占用" } })) };
      }
      case "create_folder": {
        const snapshot = snapshotsByLibrary[currentLibrary];
        if (rejectFolderMutation) throw { code: "library.io_failed", detail: "文件夹元数据只读" };
        if (snapshot === undefined || typeof request.name !== "string" || (request.parent !== null && typeof request.parent !== "string")) throw new TypeError("创建文件夹请求非法");
        const path = request.parent === null ? request.name : `${request.parent}/${request.name}`;
        snapshotsByLibrary[currentLibrary] = { ...snapshot, folders: [...snapshot.folders, path] };
        return path;
      }
      case "rename_folder": {
        if (rejectFolderMutation) throw { code: "library.io_failed", detail: "文件夹元数据只读" };
        const snapshot = snapshotsByLibrary[currentLibrary];
        const oldPath = request.path;
        const name = request.newName;
        if (snapshot === undefined || typeof oldPath !== "string" || typeof name !== "string") throw new TypeError("重命名请求非法");
        const path = oldPath.slice(0, oldPath.lastIndexOf("/") + 1) + name;
        const remap = (value: string): string => value === oldPath || value.startsWith(`${oldPath}/`) ? path + value.slice(oldPath.length) : value;
        snapshotsByLibrary[currentLibrary] = { ...snapshot, folders: snapshot.folders.map(remap), assets: snapshot.assets.map((asset) => ({ ...asset, folder: asset.folder === null ? null : remap(asset.folder) })) };
        return path;
      }
      case "move_folder": {
        if (rejectFolderMutation) throw { code: "library.io_failed", detail: "文件夹元数据只读" };
        const snapshot = snapshotsByLibrary[currentLibrary];
        const oldPath = request.path;
        const destinationParent = request.destinationParent;
        if (snapshot === undefined || typeof oldPath !== "string" || (destinationParent !== null && typeof destinationParent !== "string")) throw new TypeError("移动文件夹请求非法");
        const leaf = oldPath.slice(oldPath.lastIndexOf("/") + 1);
        const path = destinationParent === null ? leaf : `${destinationParent}/${leaf}`;
        const remap = (value: string): string => value === oldPath || value.startsWith(`${oldPath}/`) ? path + value.slice(oldPath.length) : value;
        snapshotsByLibrary[currentLibrary] = { ...snapshot, folders: snapshot.folders.map(remap), assets: snapshot.assets.map((asset) => ({ ...asset, folder: asset.folder === null ? null : remap(asset.folder) })) };
        return path;
      }
      case "delete_folder": {
        if (rejectFolderMutation) throw { code: "library.io_failed", detail: "文件夹元数据只读" };
        const snapshot = snapshotsByLibrary[currentLibrary];
        const path = request.path;
        if (snapshot === undefined || typeof path !== "string") throw new TypeError("删除文件夹请求非法");
        const removed = (value: string): boolean => value === path || value.startsWith(`${path}/`);
        snapshotsByLibrary[currentLibrary] = { ...snapshot, folders: snapshot.folders.filter((folder) => !removed(folder)), assets: snapshot.assets.map((asset) => ({ ...asset, folder: asset.folder !== null && removed(asset.folder) ? null : asset.folder })) };
        return undefined;
      }
      case "reorder_folder": {
        if (rejectFolderMutation) throw { code: "library.io_failed", detail: "文件夹元数据只读" };
        const snapshot = snapshotsByLibrary[currentLibrary];
        const path = request.path;
        const direction = request.direction;
        if (snapshot === undefined || typeof path !== "string" || (direction !== "up" && direction !== "down")) throw new TypeError("排序请求非法");
        // 与后端一致：同级交换后按深度优先重建整份清单。
        const parentKey = parentOf(path);
        const siblings = snapshot.folders.filter((folder) => parentOf(folder) === parentKey);
        const index = siblings.indexOf(path);
        const swapWith = direction === "up" ? index - 1 : index + 1;
        if (index === -1 || swapWith < 0 || swapWith >= siblings.length) return undefined;
        const reordered = [...siblings];
        const forward = reordered[index];
        const backward = reordered[swapWith];
        if (forward === undefined || backward === undefined) throw new TypeError("排序交换越界");
        reordered[index] = backward;
        reordered[swapWith] = forward;
        const remapped = new Map<string, string>(siblings.map((folder, siblingIndex) => [folder, reordered[siblingIndex] ?? folder]));
        const childrenOf = new Map<string | null, string[]>();
        for (const folder of snapshot.folders) {
          const key = parentOf(folder);
          const list = childrenOf.get(key) ?? [];
          list.push(key === parentKey ? remapped.get(folder) ?? folder : folder);
          childrenOf.set(key, list);
        }
        const ordered: string[] = [];
        const emit = (key: string | null): void => {
          for (const folder of childrenOf.get(key) ?? []) {
            ordered.push(folder);
            emit(folder);
          }
        };
        emit(null);
        snapshotsByLibrary[currentLibrary] = { ...snapshot, folders: ordered };
        return undefined;
      }
      case "batch_move_assets_to_folder": {
        const snapshot = snapshotsByLibrary[currentLibrary];
        const hashes = request.hashes;
        const folder = request.folder;
        if (snapshot === undefined || !Array.isArray(hashes) || !hashes.every((hash): hash is string => typeof hash === "string") || (folder !== null && typeof folder !== "string")) throw new TypeError("批量移动请求非法");
        const targets = new Set(hashes);
        const failures = snapshot.assets.filter((asset) => targets.has(asset.hash) && asset.hash === failedBatchId).map((asset) => ({ id: asset.hash, display_name: asset.display_filename, error: { code: "library.io_failed", detail: "只读素材" } }));
        snapshotsByLibrary[currentLibrary] = { ...snapshot, assets: snapshot.assets.map((asset) => targets.has(asset.hash) && asset.hash !== failedBatchId ? { ...asset, folder } : asset) };
        return { succeeded: targets.size - failures.length, failures };
      }
      case "batch_add_asset_tag":
      case "batch_remove_asset_tag": {
        if (inspectorWriteFailure) throw { code: "library.io_failed", detail: "批量标签写入失败" };
        const snapshot = snapshotsByLibrary[currentLibrary];
        const hashes = request.hashes;
        const tag = request.tag;
        if (snapshot === undefined || typeof tag !== "string" || !Array.isArray(hashes) || !hashes.every((hash): hash is string => typeof hash === "string")) throw new TypeError("批量标签载荷无效");
        const targets = new Set(hashes);
        const failures = snapshot.assets.filter((asset) => targets.has(asset.hash) && asset.hash === failedBatchId).map((asset) => ({ id: asset.hash, display_name: asset.display_filename, error: { code: "library.io_failed", detail: "只读素材" } }));
        snapshotsByLibrary[currentLibrary] = { ...snapshot, assets: snapshot.assets.map((asset) => targets.has(asset.hash) && asset.hash !== failedBatchId ? { ...asset, tags: command === "batch_add_asset_tag" ? [...new Set([...asset.tags, tag])] : asset.tags.filter((item) => item !== tag) } : asset) };
        return { succeeded: targets.size - failures.length, failures };
      }
      case "batch_link_to_prompt": {
        if (inspectorWriteFailure) throw { code: "library.io_failed", detail: "批量关联写入失败" };
        const snapshot = snapshotsByLibrary[currentLibrary];
        const hashes = request.hashes;
        if (snapshot === undefined || !Array.isArray(hashes) || !hashes.every((hash): hash is string => typeof hash === "string")) throw new TypeError("批量关联载荷无效");
        const targets = new Set(hashes);
        const failures = snapshot.assets.filter((asset) => targets.has(asset.hash) && asset.hash === failedBatchId).map((asset) => ({ id: asset.hash, display_name: asset.display_filename, error: { code: "library.io_failed", detail: "只读素材" } }));
        prompts = prompts.map((prompt) => prompt.id === request.promptId ? { ...prompt, linked_image_hashes: [...new Set([...prompt.linked_image_hashes, ...hashes.filter((hash) => hash !== failedBatchId)])] } : prompt);
        return { succeeded: targets.size - failures.length, failures };
      }
      // 批量命令直接作用于假快照：失效重取后界面能看到真实结果。
      case "batch_set_asset_favorite": {
        const snapshot = snapshotsByLibrary[currentLibrary];
        const hashes = request.hashes;
        if (snapshot === undefined || !Array.isArray(hashes) || typeof request.favorite !== "boolean") {
          throw new TypeError("批量收藏测试收到非法载荷");
        }
        const favorite = request.favorite;
        const targets = new Set(hashes.map(String));
        snapshotsByLibrary[currentLibrary] = {
          ...snapshot,
          assets: snapshot.assets.map((asset) => targets.has(asset.hash) && asset.hash !== failedBatchId ? { ...asset, favorite } : asset),
        };
        const failed = snapshot.assets.find((asset) => asset.hash === failedBatchId && targets.has(asset.hash));
        return { succeeded: targets.size - (failed === undefined ? 0 : 1), failures: failed === undefined ? [] : [{ id: failed.hash, display_name: failed.display_filename, error: { code: "library.io_failed", detail: "只读素材" } }] };
      }
      case "batch_delete_assets": {
        const snapshot = snapshotsByLibrary[currentLibrary];
        const hashes = request.hashes;
        if (snapshot === undefined || !Array.isArray(hashes)) throw new TypeError("批量回收站测试收到非法载荷");
        const targets = new Set(hashes.map(String));
        const deletedAt = "2026-08-27T12:00:00Z";
        const moved = snapshot.assets.filter((asset) => targets.has(asset.hash))
          .map((asset) => ({ ...asset, deleted_at: deletedAt }));
        snapshotsByLibrary[currentLibrary] = {
          ...snapshot,
          assets: snapshot.assets.filter((asset) => !targets.has(asset.hash)),
          trash_count: snapshot.trash_count + moved.length,
        };
        trashSnapshotA.assets = [...trashSnapshotA.assets, ...moved];
        return { succeeded: targets.size, failures: [] };
      }
      // 虚拟卡片按需取缩略图字节；URL.createObjectURL 已被替换为测试桩。
      case "asset_thumbnail":
        return new ArrayBuffer(4);
      case "asset_original":
        if (originalFailure) throw { code: "library.io_failed", detail: "原图读取失败" };
        if (originalGate !== null) { const gate = originalGate; originalGate = null; return gate; }
        return new ArrayBuffer(8);
      default:
        throw new Error(`未预期的 IPC：${command}`);
    }
  });
});

afterEach(async () => {
  await teardown();
  queryClient.clear();
  clearMocks();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setWindowWidth(1024);
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function teardown(): Promise<void> {
  if (root !== null) {
    act(() => root?.unmount());
    root = null;
  }
  container?.remove();
  container = null;
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function dismissVisibleTransferReports(): Promise<void> {
  const buttons = [...(container?.querySelectorAll<HTMLButtonElement>('button[aria-label="关闭导入结果"], button[aria-label="关闭导出结果"]') ?? [])];
  for (const button of buttons) await act(async () => button.click());
}

async function mountWorkspace(props: Omit<AssetLibraryWorkspaceProps, "relations">): Promise<void> {
  await teardown();
  currentLibrary = props.session.id;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const node: ReactNode = (
    <QueryClientProvider client={queryClient}>
      <UiProvider>
        <TaskCenterPopover taskCenter={appTaskCenter} onStopTask={stopAssetTransferTask} canStopTask={canStopTransferTask} getStopError={getTransferTaskStopError} />
        <AssetLibraryWorkspace {...props} relations={testRelations} />
      </UiProvider>
    </QueryClientProvider>
  );
  await act(async () => {
    root?.render(node);
  });
}

async function rerenderWorkspace(props: Omit<AssetLibraryWorkspaceProps, "relations">): Promise<void> {
  if (root === null || container === null) throw new Error("工作区尚未挂载");
  currentLibrary = props.session.id;
  const node: ReactNode = (
    <QueryClientProvider client={queryClient}>
      <UiProvider>
        <TaskCenterPopover taskCenter={appTaskCenter} onStopTask={stopAssetTransferTask} canStopTask={canStopTransferTask} getStopError={getTransferTaskStopError} />
        <AssetLibraryWorkspace {...props} relations={testRelations} />
      </UiProvider>
    </QueryClientProvider>
  );
  await act(async () => {
    root?.render(node);
  });
}

function searchInput(): HTMLInputElement {
  const input = container?.querySelector<HTMLInputElement>('[aria-label="按文件名搜索"]');
  if (input === null || input === undefined) throw new Error("缺少文件名搜索框");
  return input;
}

function setInput(input: HTMLInputElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  if (descriptor?.set === undefined) throw new Error("HTMLInputElement.value setter 不存在");
  descriptor.set.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function setTextarea(input: HTMLTextAreaElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
  if (descriptor?.set === undefined) throw new Error("HTMLTextAreaElement.value setter 不存在");
  descriptor.set.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function viewButton(text: "瀑布流" | "详情列表"): HTMLButtonElement {
  const button = [...(container?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (button === undefined) throw new Error(`缺少视图按钮：${text}`);
  return button;
}

function card(hash: string): HTMLElement {
  const element = container?.querySelector<HTMLElement>(`[data-hash="${hash}"]`);
  if (element === null || element === undefined) throw new Error(`缺少素材卡片：${hash}`);
  return element;
}

function locate(
  requestId: string,
  hash: AssetId,
  location: "active" | "trash",
): Extract<AssetLibraryEntry, { kind: "locate" }> {
  return { kind: "locate", requestId, hash, location };
}

test("集合标题反映导航范围，库名交给应用顶栏而文件夹操作留在侧栏", async () => {
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true, entry: { kind: "resume" } });
  await vi.waitFor(() => expect(container?.querySelector("h1")?.textContent).toBe("全部图片"));
  const navigation = container?.querySelector('[aria-label="图片导航"]');
  expect(navigation?.textContent).not.toContain("视觉档案");
  expect(navigation?.querySelector('[aria-label="文件夹操作"] button[aria-label="新建文件夹"]')).not.toBeNull();
  expect(container?.querySelector('[aria-label="图片查询与视图"]')?.textContent).not.toContain("新建文件夹");
  await vi.waitFor(() => expect(folderButton("参考/构图")).toBeDefined());
  await act(async () => folderButton("参考/构图").click());
  await vi.waitFor(() => expect(container?.querySelector("h1")?.textContent).toBe("参考/构图"));
  await act(async () => railButton("回收站").click());
  await vi.waitFor(() => expect(container?.querySelector("h1")?.textContent).toBe("回收站"));
});

test("文件夹树明确区分父子层级，瀑布流信息作为图片内部浮层", async () => {
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  expect(folderButton("参考").dataset.depth).toBe("0");
  expect(folderButton("参考/构图").dataset.depth).toBe("1");
  // 缩进现在落在行容器上（按钮旁还要放折叠箭头），不再直接写在按钮上。
  expect(folderButton("参考/构图").parentElement?.style.paddingInlineStart).not.toBe(folderButton("参考").parentElement?.style.paddingInlineStart);
  expect(folderButton("参考/构图").dataset.treeGuide).toBe("vertical");
  expect(folderButton("参考/构图").querySelector("[data-tree-branch]")).toBeNull();
  const caption = card(H_STREET).querySelector<HTMLElement>('[data-card-caption="overlay"]');
  expect(caption?.textContent).toContain("晨光街道.png");
  expect(caption?.parentElement).toBe(card(H_STREET));
});

test("resume 条目按库身份恢复上次查询，修改经 write_layout 写回同一库", async () => {
  savedLayouts[LIB_A] = { assets: savedAssetsSectionA(), prompts: {} };
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true, entry: { kind: "resume" } });

  await vi.waitFor(() => expect(searchInput().value).toBe("晨光"));
  expect(recordedQueries()[0]).toMatchObject({
    libraryId: LIB_A,
    query: {
      text: "晨光",
      tags: ["人物"],
      folder: { kind: "all" },
      favorite: true,
      location: "active",
    },
  });
  // 上次停留的详情列表视图同样属于要恢复的工作现场。
  expect(viewButton("详情列表").getAttribute("aria-pressed")).toBe("true");

  await act(async () => setInput(searchInput(), "霓虹"));
  await vi.waitFor(() => {
    const write = recordedWrites().at(-1);
    expect(write?.libraryId).toBe(LIB_A);
    expect(record(write?.layout.assets).text).toBe("霓虹");
  });

  // 重开同库直接回到新现场：持久化闭环不经过任何外壳协议。
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true, entry: { kind: "resume" } });
  await vi.waitFor(() => expect(searchInput().value).toBe("霓虹"));
  expect(lastQuery()).toMatchObject({ text: "霓虹" });
});

test("没有持久化偏好的会话以默认查询落在瀑布流的活动集合", async () => {
  await mountWorkspace({ session: makeSession(LIB_B, "另一座档案"), active: true, entry: { kind: "resume" } });

  await vi.waitFor(() => {
    expect(container?.textContent).toContain("远山湖岸.jpg");
  });
  expect(recordedQueries()[0]?.query).toEqual({
    text: "",
    tags: [],
    folder: { kind: "all" },
    favorite: null,
    location: "active",
  });
  expect(viewButton("瀑布流").getAttribute("aria-pressed")).toBe("true");
  expect(container?.querySelectorAll("[data-waterfall-item]").length).toBeGreaterThan(0);
});

test("locate 条目把目标设为活动项并加入选择集合，requestId 保证幂等与时效", async () => {
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true, entry: { kind: "resume" } });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  const baseline = recordedQueries().length;

  // 首次定位：目标成为唯一活动项，并按“活动项必须属于选择集合”同时被选中。
  await rerenderWorkspace({
    session: makeSession(LIB_A, "视觉档案"),
    active: true,
    entry: locate("req-1", H_NIGHT, "active"),
  });
  await vi.waitFor(() => expect(card(H_NIGHT).getAttribute("aria-current")).toBe("true"));
  expect(card(H_NIGHT).getAttribute("aria-selected")).toBe("true");
  // 同一作用域的定位命中既有查询，不需要重新拉取整个集合。
  expect(recordedQueries().length).toBe(baseline);

  // 新 requestId 的定位立即生效：活动项移动到新目标。
  await rerenderWorkspace({
    session: makeSession(LIB_A, "视觉档案"),
    active: true,
    entry: locate("req-2", H_STREET, "active"),
  });
  await vi.waitFor(() => expect(card(H_STREET).getAttribute("aria-current")).toBe("true"));

  // 迟到的 req-1 不再劫持现场：渲染幂等靠 requestId 比较，而不是取走即清。
  const beforeStale = recordedQueries().length;
  await rerenderWorkspace({
    session: makeSession(LIB_A, "视觉档案"),
    active: true,
    entry: locate("req-1", H_NIGHT, "active"),
  });
  await flush();
  await flush();
  expect(card(H_STREET).getAttribute("aria-current")).toBe("true");
  expect(card(H_NIGHT).getAttribute("aria-current")).not.toBe("true");
  expect(recordedQueries().length).toBe(beforeStale);
});

test("locate 到回收站时集合切换为回收站查询并标记目标素材", async () => {
  await mountWorkspace({
    session: makeSession(LIB_A, "视觉档案"),
    active: true,
    entry: locate("req-trash-1", H_TRASHED, "trash"),
  });

  await vi.waitFor(() => expect(card(H_TRASHED).getAttribute("aria-current")).toBe("true"));
  expect(card(H_TRASHED).getAttribute("aria-selected")).toBe("true");
  expect(recordedQueries()[0]?.query).toMatchObject({ location: "trash" });
});

test("切换视图共享同一结果集、选择集合与活动项，并且视图本身得到持久化", async () => {
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true, entry: { kind: "resume" } });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());

  await act(async () => card(H_STREET).click());
  await flush();
  expect(card(H_STREET).getAttribute("aria-selected")).toBe("true");
  expect(card(H_STREET).getAttribute("aria-current")).toBe("true");
  const beforeSwitch = recordedQueries().length;

  await act(async () => viewButton("详情列表").click());
  await vi.waitFor(() => expect(container?.querySelectorAll("[data-list-item]").length).toBeGreaterThan(0));
  expect(container?.querySelectorAll("[data-waterfall-item]").length).toBe(0);
  // 同一结果集、同一选择与活动项：视图只是呈现层，不产生新的集合查询。
  expect(recordedQueries().length).toBe(beforeSwitch);
  expect(card(H_STREET).getAttribute("aria-selected")).toBe("true");
  expect(card(H_STREET).getAttribute("aria-current")).toBe("true");

  await vi.waitFor(() => {
    const write = recordedWrites().at(-1);
    expect(write?.libraryId).toBe(LIB_A);
    expect(record(write?.layout.assets).view).toBe("list");
  });

  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true, entry: { kind: "resume" } });
  await vi.waitFor(() => {
    expect(container?.querySelectorAll("[data-list-item]").length).toBeGreaterThan(0);
  });
  expect(viewButton("详情列表").getAttribute("aria-pressed")).toBe("true");
});

test("不同 libraryId 的会话各自取数与恢复偏好，写回不越过库边界", async () => {
  savedLayouts[LIB_A] = { assets: savedAssetsSectionA(), prompts: {} };
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true, entry: { kind: "resume" } });
  await vi.waitFor(() => expect(searchInput().value).toBe("晨光"));
  // 布局恢复与虚拟项布局是两个异步阶段，不能拿搜索框就绪代替图片就绪。
  await vi.waitFor(() => expect(container?.textContent).toContain("晨光街道.png"));
  await teardown();

  // 同一进程内切到乙库：既不继承甲库的查询文本，也不复用甲库的集合数据。
  await mountWorkspace({ session: makeSession(LIB_B, "另一座档案"), active: true, entry: { kind: "resume" } });
  await flush();
  await flush();
  expect(container?.textContent).not.toContain("晨光街道.png");
  await vi.waitFor(() => {
    expect(searchInput().value).toBe("");
    expect(container?.textContent).toContain("远山湖岸.jpg");
  });
  const bQueries = recordedQueries().filter((call) => call.libraryId === LIB_B);
  expect(bQueries.length).toBeGreaterThan(0);
  expect(bQueries.every((call) => call.query.text === "")).toBe(true);

  await act(async () => setInput(searchInput(), "雾中"));
  await vi.waitFor(() => {
    const write = recordedWrites().at(-1);
    expect(write?.libraryId).toBe(LIB_B);
    expect(record(write?.layout.assets).text).toBe("雾中");
  });
  // 甲库的持久化原样保留：写入以库身份为键，不发生整份覆盖。
  expect(record(record(savedLayouts[LIB_A]).assets).text).toBe("晨光");
});

test("集合切片只渲染视口与过扫项，不把全部轻量记录变成 DOM", async () => {
  snapshotsByLibrary[LIB_A] = {
    ...SNAPSHOT_A,
    assets: Array.from({ length: 1000 }, (_, index) => assetRow({ hash: index.toString(16).padStart(64, "0"), display_filename: `参考-${index}.png` })),
  };
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true });
  await vi.waitFor(() => expect(container?.querySelectorAll('[role="option"]').length).toBeGreaterThan(0));
  expect(container?.querySelectorAll('[role="option"]').length).toBeLessThan(40);
});

test("收藏成功只刷新当前库集合，视图和布局写入不触发集合刷新", async () => {
  await mountWorkspace({ session: makeSession(LIB_B, "另一座档案"), active: true });
  await vi.waitFor(() => expect(card(H_NIGHT)).toBeDefined());
  const queriesB = recordedQueries().filter((call) => call.libraryId === LIB_B).length;
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => card(H_STREET).click());
  const baseline = recordedQueries().length;
  const favorite = container?.querySelector<HTMLButtonElement>('button[aria-label="取消收藏"]');
  expect(favorite).not.toBeNull();
  await act(async () => favorite?.click());
  // 界面翻到已收藏态是“失效刷新已应用”的直接证据；拉取次数随后应恰好 +1，
  // 不多不少。以查询先到达为信号会在数据落地前放行，属于时序竞态。
  await vi.waitFor(() =>
    expect(container?.querySelector('button[aria-label="收藏图片"]')).not.toBeNull(),
  );
  await flush();
  expect(recordedQueries().length).toBe(baseline + 1);
  expect(recordedQueries().filter((call) => call.libraryId === LIB_B)).toHaveLength(queriesB);
  expect(card(H_STREET).getAttribute("aria-selected")).toBe("true");
});

test("布局保存失败保留草稿与错误，重开同库仍可显式重试且不覆盖提示词偏好", async () => {
  savedLayouts[LIB_A] = { assets: savedAssetsSectionA(), prompts: { text: "原提示词查询" }, extra: "保留" };
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true });
  await vi.waitFor(() => expect(searchInput().value).toBe("晨光"));
  rejectLayoutWrite = true;
  await act(async () => setInput(searchInput(), "未保存查询"));
  await vi.waitFor(() => expect(container?.textContent).toContain("library.io_failed"));
  expect(searchInput().value).toBe("未保存查询");
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true });
  await vi.waitFor(() => expect(searchInput().value).toBe("未保存查询"));
  expect(container?.textContent).toContain("library.io_failed");
  rejectLayoutWrite = false;
  savedLayouts[LIB_A] = { ...record(savedLayouts[LIB_A]), prompts: { text: "另一工作区刚写入" } };
  const retry = [...document.querySelectorAll("button")].find((button) => button.textContent === "重试保存布局");
  if (retry === undefined) throw new Error("缺少显式重试入口");
  await act(async () => retry.click());
  await vi.waitFor(() => expect(record(record(savedLayouts[LIB_A]).assets).text).toBe("未保存查询"));
  expect(record(savedLayouts[LIB_A]).prompts).toEqual({ text: "另一工作区刚写入" });
  expect(record(savedLayouts[LIB_A]).extra).toBe("保留");
});

test("非活动工作区不发起查询也不消费定位，激活后才定位目标", async () => {
  const entry = locate("deferred-request", H_NIGHT, "active");
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: false, entry });
  await flush();
  expect(ipcCalls).toHaveLength(0);
  await rerenderWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true, entry });
  await vi.waitFor(() => expect(card(H_NIGHT).getAttribute("aria-current")).toBe("true"));
  expect(card(H_NIGHT).getAttribute("aria-selected")).toBe("true");
});

test("布局读取失败不查询或覆盖默认值，显式重试后恢复真实偏好", async () => {
  savedLayouts[LIB_A] = { assets: savedAssetsSectionA(), prompts: {} };
  rejectLayoutRead = true;
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true });
  await vi.waitFor(() => expect(container?.textContent).toContain("library.io_failed"));
  expect(recordedQueries()).toHaveLength(0);
  expect(recordedWrites()).toHaveLength(0);
  rejectLayoutRead = false;
  const retry = [...document.querySelectorAll("button")].find((button) => button.textContent === "重试恢复布局");
  if (retry === undefined) throw new Error("缺少恢复重试入口");
  await act(async () => retry.click());
  await vi.waitFor(() => expect(searchInput().value).toBe("晨光"));
});

test("连续布局写入按库串行，慢的旧写入不能覆盖较新的查询", async () => {
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true });
  await vi.waitFor(() => expect(searchInput().value).toBe(""));
  let releaseWrite: (() => void) | undefined;
  nextWriteGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
  if (releaseWrite === undefined) throw new Error("保存测试未建立释放入口");
  const release = releaseWrite;
  try {
    await act(async () => setInput(searchInput(), "较早的查询"));
    await vi.waitFor(() => expect(recordedWrites()).toHaveLength(1));
    await act(async () => setInput(searchInput(), "最新查询"));
    await flush();
    expect(recordedWrites()).toHaveLength(1);
  } finally {
    await act(async () => release());
  }
  await vi.waitFor(() => expect(record(record(savedLayouts[LIB_A]).assets).text).toBe("最新查询"));
  expect(recordedWrites()).toHaveLength(2);
});

// ---------------------------------------------------------------------------
// 左栏导航与标签筛选面板。
// 契约：导航容器 aria-label="图片导航"；入口文案「全部图片」「收藏」「未分类」
// 「回收站」，当前入口用 aria-current="true" 表达；文件夹树按钮携带
// data-folder=<精确路径>；标签面板容器 aria-label="标签筛选"，标签按钮携带
// data-tag=<标签名> 并以 aria-pressed 表达选择状态，徽标计数放在按钮之外；
// 本地 Ctrl+F 聚焦搜索框并全选内容，模块不认领 Ctrl+K（归应用外壳的全局搜索），
// 非激活时不响应任何本地快捷键。左栏动作复用统一的 changeLayout 偏好通道，
// 因此每次切换都会写回当前库的 assets 分区。
// ---------------------------------------------------------------------------

function railButton(text: string): HTMLButtonElement {
  const nav = container?.querySelector<HTMLElement>('[aria-label="图片导航"]');
  const button = [...(nav?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (button === undefined) throw new Error(`缺少导航入口：${text}`);
  return button;
}

function folderButton(path: string): HTMLButtonElement {
  const nav = container?.querySelector<HTMLElement>('[aria-label="图片导航"]');
  const button = nav?.querySelector<HTMLButtonElement>(`[data-folder="${path}"]`);
  if (button === null || button === undefined) throw new Error(`缺少文件夹项：${path}`);
  return button;
}

async function folderMenuItem(path: string, label: string): Promise<HTMLElement> {
  await act(async () =>
    folderButton(path).dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }),
    ),
  );
  const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="文件夹快捷菜单"]');
  const item = [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (item === undefined) throw new Error(`文件夹快捷菜单缺少入口：${label}`);
  return item;
}

function tagButton(tag: string): HTMLButtonElement {
  const panel = container?.querySelector<HTMLElement>('[aria-label="标签筛选"]');
  const button = panel?.querySelector<HTMLButtonElement>(`[data-tag="${tag}"]`);
  if (button === null || button === undefined) throw new Error(`缺少标签筛选项：${tag}`);
  return button;
}

test("左栏标签名不拼接使用计数，计数只作为辅助语义", async () => {
  snapshotsByLibrary[LIB_A] = {
    ...SNAPSHOT_A,
    assets: SNAPSHOT_A.assets.map((asset, index) => index === 0 ? { ...asset, tags: ["速速速"] } : asset),
    tags: [{ tag: "速速速", count: 1 }],
  };
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true });
  await vi.waitFor(() => expect(tagButton("速速速")).toBeDefined());
  expect(tagButton("速速速").textContent?.trim()).toBe("速速速");
  expect(tagButton("速速速").getAttribute("aria-label")).toBe("速速速，1 张图片");
});

function pressKey(key: string, modifiers: { ctrl?: boolean } = {}): void {
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ctrlKey: modifiers.ctrl === true,
    }),
  );
}

/** 最近一次集合查询的载荷（recordedQueries 的元素是 {libraryId, query} 包装）。 */
function lastQuery(): Record<string, unknown> | undefined {
  return recordedQueries().at(-1)?.query;
}

test("全部图片、收藏、未分类和文件夹是互斥浏览范围，切换后不残留上一范围", async () => {
  await mountWorkspace({
    session: makeSession(LIB_A, "视觉档案"),
    active: true,
    entry: { kind: "resume" },
  });
  await vi.waitFor(() => expect(container?.querySelectorAll("[data-hash]").length).toBeGreaterThan(0));

  await act(async () => setInput(searchInput(), "晨光"));
  await act(async () => tagButton("人物").click());

  await act(async () => railButton("收藏").click());
  await vi.waitFor(() => {
    expect(lastQuery()?.favorite).toBe(true);
    expect(lastQuery()?.folder).toEqual({ kind: "all" });
    expect(lastQuery()?.text).toBe("");
    expect(lastQuery()?.tags).toEqual([]);
  });
  expect(container?.querySelector("h1")?.textContent).toBe("收藏");

  await act(async () => railButton("全部图片").click());
  await vi.waitFor(() => {
    expect(railButton("全部图片").getAttribute("aria-current")).toBe("true");
    const assets = record(record(recordedWrites().at(-1)?.layout).assets);
    expect(assets.favorite).toBeNull();
    expect(assets.folder).toEqual({ kind: "all" });
    expect(assets.location).toBe("active");
  });

  await act(async () => railButton("收藏").click());
  await vi.waitFor(() => expect(railButton("收藏").getAttribute("aria-current")).toBe("true"));
  await act(async () => railButton("未分类").click());
  await vi.waitFor(() => {
    expect(lastQuery()?.favorite).toBeNull();
    expect(lastQuery()?.folder).toEqual({ kind: "root" });
  });

  await act(async () => folderButton("参考/构图").click());
  await vi.waitFor(() => expect(lastQuery()?.folder).toEqual({ kind: "path", path: "参考/构图" }));
  await act(async () => railButton("收藏").click());
  await vi.waitFor(() => {
    expect(railButton("收藏").getAttribute("aria-current")).toBe("true");
    const assets = record(record(recordedWrites().at(-1)?.layout).assets);
    expect(assets.favorite).toBe(true);
    expect(assets.folder).toEqual({ kind: "all" });
  });
});

test("全部图片中移动素材后，点击目标文件夹只显示该文件夹直接成员", async () => {
  applyFolderFilter = true;
  snapshotsByLibrary[LIB_A] = { ...SNAPSHOT_A, folders: [...SNAPSHOT_A.folders, "配色"] };
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  expect(card(H_NIGHT)).toBeDefined();

  await act(async () => card(H_STREET).click());
  const folder = inspector().querySelector<HTMLSelectElement>('select[aria-label="图片所在文件夹"]');
  if (folder === null) throw new Error("组织检查器缺少文件夹选择");
  await act(async () => {
    folder.value = "folder:配色";
    folder.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await vi.waitFor(() => expect(snapshotsByLibrary[LIB_A]?.assets.find((asset) => asset.hash === H_STREET)?.folder).toBe("配色"));

  await act(async () => folderButton("配色").click());
  await vi.waitFor(() => expect(lastQuery()?.folder).toEqual({ kind: "path", path: "配色" }));
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  expect(container?.querySelector(`[data-hash="${H_NIGHT}"]`)).toBeNull();
});

test("切换文件夹等待新查询时不把全部图片旧快照冒充文件夹成员", async () => {
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  let finish!: (snapshot: CatalogSnapshot) => void;
  collectionGate = new Promise<CatalogSnapshot>((resolve) => { finish = resolve; });

  await act(async () => folderButton("参考/构图").click());
  await vi.waitFor(() => expect(lastQuery()?.folder).toEqual({ kind: "path", path: "参考/构图" }));
  expect(container?.querySelector("h1")?.textContent).toBe("参考/构图");
  expect(container?.textContent).toContain("正在读取图片…");
  expect(container?.querySelector(`[data-hash="${H_STREET}"]`)).toBeNull();
  expect(container?.querySelector(`[data-hash="${H_NIGHT}"]`)).toBeNull();

  await act(async () => finish({ ...SNAPSHOT_A, assets: [SNAPSHOT_A.assets[1]!] }));
  await vi.waitFor(() => expect(card(H_NIGHT)).toBeDefined());
  expect(container?.querySelector(`[data-hash="${H_STREET}"]`)).toBeNull();
});

test("收藏或文件夹范围为空时显示范围空态，不冒充整库首次导入", async () => {
  snapshotsByLibrary[LIB_A] = { ...SNAPSHOT_A, assets: [] };
  savedLayouts[LIB_A] = {
    assets: {
      ...savedAssetsSectionA(),
      text: "",
      tags: [],
      folder: { kind: "all" },
      favorite: true,
      view: "waterfall",
    },
    prompts: {},
  };
  await mountWorkspace({
    session: makeSession(LIB_A, "视觉档案"),
    active: true,
    entry: { kind: "resume" },
  });
  await vi.waitFor(() => expect(container?.querySelector("h1")?.textContent).toBe("收藏"));
  await vi.waitFor(() => expect(container?.textContent).toContain("还没有收藏图片"));
  expect([...document.querySelectorAll("button")].some((button) => button.textContent === "导入图片")).toBe(false);
});

test("左栏镜像恢复的现场并提供全部图片、收藏、未分类与回收站入口", async () => {
  savedLayouts[LIB_A] = { assets: savedAssetsSectionA(), prompts: {} };
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true, entry: { kind: "resume" } });
  await vi.waitFor(() => expect(searchInput().value).toBe("晨光"));

  // 旧偏好曾允许“收藏 + 文件夹”同时存在；恢复时收藏范围优先并清掉隐藏文件夹。
  await vi.waitFor(() => expect(folderButton("参考").getAttribute("aria-current")).not.toBe("true"));
  expect(railButton("收藏").getAttribute("aria-current")).toBe("true");
  expect(railButton("全部图片").getAttribute("aria-current")).not.toBe("true");

  // 具体文件夹接管浏览范围，同时清除收藏。
  await act(async () => folderButton("参考/构图").click());
  await vi.waitFor(() =>
    expect(lastQuery()?.folder).toEqual({ kind: "path", path: "参考/构图" }),
  );
  expect(lastQuery()?.favorite).toBeNull();
  expect(railButton("收藏").getAttribute("aria-current")).not.toBe("true");

  // 收藏接管浏览范围并回到全库；重复点击是幂等选择，不再当复选框反转。
  await act(async () => railButton("收藏").click());
  await vi.waitFor(() => expect(railButton("收藏").getAttribute("aria-current")).toBe("true"));
  expect(record(record(recordedWrites().at(-1)?.layout).assets).folder).toEqual({ kind: "all" });
  await act(async () => railButton("收藏").click());
  await flush();
  expect(railButton("收藏").getAttribute("aria-current")).toBe("true");

  await act(async () => railButton("未分类").click());
  await vi.waitFor(() => expect(lastQuery()?.folder).toEqual({ kind: "root" }));

  await act(async () => railButton("回收站").click());
  await vi.waitFor(() => expect(lastQuery()?.location).toBe("trash"));
  expect(container?.textContent).toContain("废弃草图.png");

  // 「全部图片」回到正常集合的全部范围：清空文件夹条件并离开回收站。
  await act(async () => railButton("全部图片").click());
  await vi.waitFor(() => {
    expect(lastQuery()?.folder).toEqual({ kind: "all" });
    expect(lastQuery()?.location).toBe("active");
  });

  // 入口动作走同一偏好通道：最终切换作为一次左栏修改落盘到 assets 分区。
  await vi.waitFor(() => {
    const write = recordedWrites().at(-1);
    expect(write?.libraryId).toBe(LIB_A);
    const assets = record(write?.layout.assets);
    expect(assets.folder).toEqual({ kind: "all" });
    expect(assets.location).toBe("active");
  });
});

test("文件夹右键菜单提供子文件夹、重命名和删除，并把节点作为操作目标", async () => {
  await mountWorkspace({
    session: makeSession(LIB_A, "视觉档案"),
    active: true,
    entry: { kind: "resume" },
  });
  await vi.waitFor(() => expect(folderButton("参考/构图")).not.toBeNull());
  const headerActions = container?.querySelector<HTMLElement>('[aria-label="文件夹操作"]');
  expect(headerActions?.querySelector('button[aria-label="新建文件夹"]')).not.toBeNull();
  expect(headerActions?.textContent).not.toContain("重命名文件夹");
  expect(headerActions?.textContent).not.toContain("删除文件夹");

  await act(async () =>
    folderButton("参考/构图").dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }),
    ),
  );
  const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="文件夹快捷菜单"]');
  if (menu === null) throw new Error("右键文件夹没有打开快捷菜单");
  expect(menu.textContent).toContain("新建子文件夹");
  expect(menu.textContent).toContain("重命名");
  expect(menu.textContent).toContain("移动文件夹");
  expect(menu.textContent).toContain("删除");

  const createChild = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (item) => item.textContent?.trim() === "新建子文件夹",
  );
  if (createChild === undefined) throw new Error("文件夹快捷菜单缺少新建子文件夹");
  await act(async () => createChild.click());

  expect(document.querySelector('[role="dialog"]')).toBeNull();
  const creator = container?.querySelector<HTMLElement>('[data-inline-folder-creator]');
  expect(creator?.dataset.parent).toBe("参考/构图");
  expect(creator?.querySelector<HTMLInputElement>('input[name="inline-folder-name"]')).not.toBeNull();
});

test("父文件夹可以折叠与展开，折叠后子节点从树中隐藏", async () => {
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true });
  await vi.waitFor(() => expect(folderButton("参考/构图")).toBeDefined());
  const nav = container?.querySelector<HTMLElement>('[aria-label="图片导航"]');
  const caret = (): HTMLButtonElement => {
    const button = nav?.querySelector<HTMLButtonElement>('button[aria-label="折叠文件夹 参考"], button[aria-label="展开文件夹 参考"]');
    if (button === null || button === undefined) throw new Error("缺少折叠箭头");
    return button;
  };
  expect(caret().getAttribute("aria-expanded")).toBe("true");
  await act(async () => caret().click());
  expect(caret().getAttribute("aria-label")).toBe("展开文件夹 参考");
  expect(caret().getAttribute("aria-expanded")).toBe("false");
  expect(nav?.querySelector('[data-folder="参考/构图"]')).toBeNull();
  // 父节点本身仍在，只是子树收起。
  expect(nav?.querySelector('[data-folder="参考"]')).not.toBeNull();
  await act(async () => caret().click());
  await vi.waitFor(() => expect(folderButton("参考/构图")).toBeDefined());
});

test("文件夹右键菜单的上移下移按存储顺序重排同级节点", async () => {
  snapshotsByLibrary[LIB_A] = { ...SNAPSHOT_A, folders: [...SNAPSHOT_A.folders, "配色"] };
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true });
  await vi.waitFor(() => expect(folderButton("配色")).toBeDefined());
  // 初始顺序即 folders.json 的存储顺序：参考（含子树）在前，配色在后。
  expect(folderButton("参考").compareDocumentPosition(folderButton("配色")) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

  const up = await folderMenuItem("配色", "上移");
  expect(up.getAttribute("aria-disabled")).not.toBe("true");
  const down = await folderMenuItem("配色", "下移");
  // 配色已是同级末尾：下移不可用。
  expect(down.getAttribute("aria-disabled")).toBe("true");
  await act(async () => up.click());
  await vi.waitFor(() => {
    const call = ipcCalls.find((entry) => entry.command === "reorder_folder");
    expect(record(call?.payload)).toMatchObject({ path: "配色", direction: "up" });
  });
  await vi.waitFor(() => {
    expect(folderButton("配色").compareDocumentPosition(folderButton("参考")) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  // 交换后配色成为同级首位：上移不可用，下移恢复可用。
  const upAgain = await folderMenuItem("配色", "上移");
  expect(upAgain.getAttribute("aria-disabled")).toBe("true");
  const downAgain = await folderMenuItem("配色", "下移");
  expect(downAgain.getAttribute("aria-disabled")).not.toBe("true");
  await act(async () => downAgain.click());
  await vi.waitFor(() => {
    expect(folderButton("参考").compareDocumentPosition(folderButton("配色")) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });
});

test("文件夹右键移动使用明确目标并提交完整子树移动命令", async () => {
  await mountWorkspace({
    session: makeSession(LIB_A, "视觉档案"),
    active: true,
    entry: { kind: "resume" },
  });
  await vi.waitFor(() => expect(folderButton("参考/构图")).not.toBeNull());
  await act(async () =>
    folderButton("参考/构图").dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }),
    ),
  );
  const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="文件夹快捷菜单"]');
  const moveItem = [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])].find(
    (item) => item.textContent?.trim() === "移动文件夹",
  );
  if (moveItem === undefined) throw new Error("文件夹快捷菜单缺少移动入口");
  await act(async () => moveItem.click());

  const target = document.querySelector<HTMLSelectElement>('select[name="folder-move-target"]');
  if (target === null) throw new Error("移动文件夹对话框缺少目标选择");
  expect(target.options[0]?.textContent).toBe("顶层（无父文件夹）");
  await act(async () => {
    target.value = "";
    target.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const submit = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
    (button) => button.textContent?.trim() === "移动文件夹",
  );
  if (submit === undefined) throw new Error("移动文件夹对话框缺少提交按钮");
  await act(async () => submit.click());
  await vi.waitFor(() => {
    const call = ipcCalls.find((entry) => entry.command === "move_folder");
    expect(record(call?.payload)).toMatchObject({ path: "参考/构图", destinationParent: null });
  });
});

test("嵌套文件夹可从右键菜单直接移到顶层", async () => {
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true });
  await vi.waitFor(() => expect(folderButton("参考/构图")).toBeDefined());
  const moveToTop = await folderMenuItem("参考/构图", "移到顶层");
  await act(async () => moveToTop.click());
  await vi.waitFor(() => {
    const call = ipcCalls.find((entry) => entry.command === "move_folder");
    expect(record(call?.payload)).toMatchObject({ path: "参考/构图", destinationParent: null });
  });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

test("回收站入口显示待清理数量徽标且不影响其他入口文案", async () => {
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true, entry: { kind: "resume" } });
  await vi.waitFor(() => {
    expect(container?.querySelectorAll("[data-hash]").length).toBeGreaterThan(0);
  });
  const trashEntry = railButton("回收站");
  expect(trashEntry.textContent?.trim()).toBe("回收站");
  // 徽标在按钮之外但同属条目：夹具快照声明 trash_count: 1。
  expect(trashEntry.parentElement?.textContent).toContain("1");
});

test("标签面板把所选标签按点击顺序并入查询，取消后逐个移除", async () => {
  snapshotsByLibrary[LIB_A] = {
    ...SNAPSHOT_A,
    tags: [
      { tag: "人物", count: 1 },
      { tag: "逆光", count: 2 },
    ],
  };
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true, entry: { kind: "resume" } });
  await vi.waitFor(() => {
    expect(container?.querySelectorAll("[data-hash]").length).toBeGreaterThan(0);
  });

  // 标签面板随集合数据同帧渲染；用 waitFor 吸收并发调度下的瞬时差帧。
  await vi.waitFor(() => expect(tagButton("人物").getAttribute("aria-pressed")).toBe("false"));
  await act(async () => tagButton("人物").click());
  await vi.waitFor(() => expect(lastQuery()?.tags).toEqual(["人物"]));
  expect(tagButton("人物").getAttribute("aria-pressed")).toBe("true");

  // 多个标签是并且关系：一次查询同时要求全部所选标签。
  await act(async () => tagButton("逆光").click());
  await vi.waitFor(() => expect(lastQuery()?.tags).toEqual(["人物", "逆光"]));
  expect(tagButton("逆光").getAttribute("aria-pressed")).toBe("true");

  await act(async () => tagButton("人物").click());
  await vi.waitFor(() => expect(lastQuery()?.tags).toEqual(["逆光"]));
  await vi.waitFor(() => expect(tagButton("人物").getAttribute("aria-pressed")).toBe("false"));

  await vi.waitFor(() => {
    const write = recordedWrites().at(-1);
    expect(record(write?.layout.assets).tags).toEqual(["逆光"]);
  });
});

test("本地 Ctrl+F 聚焦搜索框并全选内容，模块不认领 Ctrl+K", async () => {
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true, entry: { kind: "resume" } });
  await vi.waitFor(() => {
    expect(container?.querySelectorAll("[data-hash]").length).toBeGreaterThan(0);
  });

  // 焦点先落在素材卡片上：Ctrl+F 是全域本库快捷键，不依赖当前焦点位置。
  await act(async () => card(H_STREET).click());
  await act(async () => setInput(searchInput(), "晨光"));

  await act(async () => pressKey("f", { ctrl: true }));
  expect(document.activeElement).toBe(searchInput());
  expect(searchInput().selectionStart).toBe(0);
  expect(searchInput().selectionEnd).toBe("晨光".length);

  // 全局搜索属于应用外壳：模块不得吞掉或转移该组合键造成的任何行为。
  await act(async () => pressKey("k", { ctrl: true }));
  expect(document.activeElement).toBe(searchInput());

  // 非修饰键保持原生输入路径，不被快捷键层拦改。
  await act(async () => pressKey("雾"));
  expect(document.activeElement).toBe(searchInput());
});

test("非激活的工作区不认领本地快捷键", async () => {
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: false, entry: { kind: "resume" } });
  await flush();

  pressKey("f", { ctrl: true });
  await flush();
  // 非激活时偏好读取都未启动，搜索框不存在；快捷键层不得把焦点抓到任何地方。
  expect(document.activeElement).toBe(document.body);
});

// ---------------------------------------------------------------------------
// 可调密度、排序与滚动恢复。
// 契约：工具栏存在 aria-label="缩略图大小" 的三档滑杆，档位经 tileSize 轴
// 持久化并驱动瀑布流列宽；视觉不再常驻“小/中/大”三个文字按钮；
// 工具栏存在原生 select[aria-label="排序方式"]（imported-desc / name-asc /
// size-desc 三值），排序作用于瀑布流与详情列表共同的结果序列并写回 sort 轴；
// 集合滚动容器的偏移经布局偏好的 scrollOffsets["assets-collection"] 落盘，
// 重开同库后在数据就绪时恢复。两轴都沿用左栏同一 changeLayout 通道。
// ---------------------------------------------------------------------------

function densityControl(): HTMLInputElement {
  const input = container?.querySelector<HTMLInputElement>('input[type="range"][aria-label="缩略图大小"]');
  if (input === null || input === undefined) throw new Error("缺少缩略图大小滑杆");
  return input;
}

function chooseDensity(value: "small" | "medium" | "large"): void {
  const position = { small: "0", medium: "1", large: "2" }[value];
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  if (descriptor?.set === undefined) throw new Error("HTMLInputElement.value setter 不存在");
  descriptor.set.call(densityControl(), position);
  densityControl().dispatchEvent(new Event("input", { bubbles: true }));
}

function waterfallTileWidth(): number {
  const tile = container?.querySelector<HTMLElement>("[data-waterfall-item]");
  if (tile === null || tile === undefined) throw new Error("缺少瀑布流卡片");
  return Math.round(Number.parseFloat(tile.style.width));
}

function collectionScroll(): HTMLElement {
  const element = container?.querySelector<HTMLElement>('[aria-label="图片集合"]');
  if (element === null || element === undefined) throw new Error("缺少集合滚动容器");
  return element;
}

function cardOrder(): string[] {
  return [...(container?.querySelectorAll<HTMLElement>("[data-hash]") ?? [])].map(
    (element) => element.dataset.hash ?? "",
  );
}

function sortSelect(): HTMLSelectElement {
  const select = container?.querySelector<HTMLSelectElement>('select[aria-label="排序方式"]');
  if (select === null || select === undefined) throw new Error("缺少排序方式选择器");
  return select;
}

function chooseSort(value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
  if (descriptor?.set === undefined) throw new Error("HTMLSelectElement.value setter 不存在");
  descriptor.set.call(sortSelect(), value);
  sortSelect().dispatchEvent(new Event("change", { bubbles: true }));
}

test("缩略图密度滑杆即时驱动列宽、写回偏好并在重开同库时保持", async () => {
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true, entry: { kind: "resume" } });
  await vi.waitFor(() => {
    expect(container?.querySelectorAll("[data-waterfall-item]").length).toBeGreaterThan(0);
  });

  await vi.waitFor(() => expect(densityControl().value).toBe("1"));
  const mediumWidth = waterfallTileWidth();

  await act(async () => chooseDensity("large"));
  await vi.waitFor(() => {
    expect(densityControl().value).toBe("2");
    expect(waterfallTileWidth()).toBeGreaterThan(mediumWidth);
  });

  await vi.waitFor(() => {
    const write = recordedWrites().at(-1);
    expect(record(write?.layout.assets).tileSize).toBe("large");
  });

  // 重开同库直接回到「大」档：密度属于要恢复的工作现场。
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true, entry: { kind: "resume" } });
  await vi.waitFor(() => {
    expect(container?.querySelectorAll("[data-waterfall-item]").length).toBeGreaterThan(0);
  });
  await vi.waitFor(() => expect(densityControl().value).toBe("2"));
  expect(waterfallTileWidth()).toBeGreaterThan(mediumWidth);
});

test("左右栏恢复独立宽度与折叠状态，键盘调整只写回当前库", async () => {
  savedLayouts[LIB_A] = {
    assets: {
      ...savedAssetsSectionA(),
      text: "",
      tags: [],
      favorite: null,
      folder: { kind: "all" },
      view: "waterfall",
      navigationWidth: 264,
      inspectorWidth: 352,
      navigationCollapsed: false,
      inspectorCollapsed: false,
    },
    prompts: {},
  };
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  const navigation = container?.querySelector<HTMLElement>('[aria-label="图片导航"]')?.closest<HTMLElement>("aside");
  const inspectorPanel = container?.querySelector<HTMLElement>('[aria-label="图片检查器"]');
  expect(navigation?.style.flexBasis).toBe("264px");
  expect(inspectorPanel?.style.flexBasis).toBe("352px");
  const separator = container?.querySelector<HTMLElement>('[role="separator"][aria-label="调整图片导航宽度"]');
  expect(separator?.getAttribute("aria-valuenow")).toBe("264");
  const baseline = recordedWrites().length;
  await act(async () => separator?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })));
  await vi.waitFor(() => expect(record(recordedWrites().at(-1)?.layout.assets).navigationWidth).toBe(272));
  expect(recordedWrites()).toHaveLength(baseline + 1);
  await act(async () => namedButton("收起图片检查器").click());
  await vi.waitFor(() => expect(namedButton("展开图片检查器")).toBeDefined());
  expect(record(recordedWrites().at(-1)?.layout.assets).inspectorCollapsed).toBe(true);
});

test("排序方式作用于瀑布流与详情列表的共同序列，且默认按导入时间倒序", async () => {
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true, entry: { kind: "resume" } });
  await vi.waitFor(() => {
    expect(container?.querySelectorAll("[data-hash]").length).toBeGreaterThan(0);
  });
  await vi.waitFor(() => expect(sortSelect().value).toBe("imported-desc"));

  // 夹具里「雨夜霓虹」导入更晚：默认倒序它在前。
  expect(cardOrder()[0]).toBe(H_NIGHT);

  await act(async () => chooseSort("name-asc"));
  await vi.waitFor(() => expect(cardOrder()[0]).toBe(H_STREET));

  // 排序属于查询语义的一部分：详情列表呈现同一序列。
  await act(async () => viewButton("详情列表").click());
  await vi.waitFor(() =>
    expect(container?.querySelectorAll("[data-list-item]").length).toBeGreaterThan(0),
  );
  expect(cardOrder()).toEqual([H_STREET, H_NIGHT]);

  await vi.waitFor(() => {
    const write = recordedWrites().at(-1);
    const assets = record(write?.layout.assets);
    expect(assets.sort).toBe("name-asc");
    expect(assets.view).toBe("list");
  });

  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true, entry: { kind: "resume" } });
  await vi.waitFor(() => {
    expect(cardOrder()).toEqual([H_STREET, H_NIGHT]);
  });
  expect(sortSelect().value).toBe("name-asc");
});

test("详情列表呈现缩略图、名称、文件夹、标签、尺寸、格式、导入时间与备注摘要", async () => {
  snapshotsByLibrary[LIB_A] = {
    ...SNAPSHOT_A,
    assets: SNAPSHOT_A.assets.map((asset) => asset.hash === H_STREET ? {
      ...asset,
      note: "潮湿街道的构图观察",
      tags: ["人物", "逆光"],
    } : asset),
  };
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => viewButton("详情列表").click());
  await vi.waitFor(() => expect(container?.querySelector('[data-list-item]')).not.toBeNull());
  const header = container?.querySelector('[aria-label="详情列表列标题"]');
  expect(header?.parentElement?.getAttribute("data-list-surface")).toBe("");
  for (const name of ["名称", "文件夹", "标签", "尺寸", "格式", "导入时间", "备注"]) expect(header?.textContent).toContain(name);
  const row = card(H_STREET);
  expect(row.dataset.listRowStyle).toBe("table");
  expect(row.querySelector('[data-column="folder"]')?.textContent).toBe("参考");
  expect(row.querySelector('[data-column="tags"]')?.textContent).toBe("人物、逆光");
  expect(row.querySelectorAll("[data-list-tag]")).toHaveLength(2);
  expect(row.querySelector('[data-column="dimensions"]')?.textContent).toBe("640 × 960");
  expect(row.querySelector('[data-column="format"]')?.textContent).toBe("PNG");
  expect(row.querySelector('[data-column="imported"]')?.textContent).not.toBe("");
  expect(row.querySelector('[data-column="note"]')?.textContent).toBe("潮湿街道的构图观察");
});

test("集合滚动位置写入偏好，重开同库在数据就绪后恢复", async () => {
  savedLayouts[LIB_A] = {
    assets: { ...savedAssetsSectionA(), view: "waterfall", scrollOffsets: { "assets-collection": 300 } },
    prompts: {},
  };
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true, entry: { kind: "resume" } });
  await vi.waitFor(() => {
    expect(collectionScroll().scrollTop).toBe(300);
  });

  // 使用者继续滚动 → 偏好随防抖落盘到同一容器键。
  await act(async () => {
    collectionScroll().scrollTop = 520;
    collectionScroll().dispatchEvent(new Event("scroll", { bubbles: false }));
  });
  await vi.waitFor(() => {
    const write = recordedWrites().at(-1);
    const offsets = record(record(write?.layout.assets).scrollOffsets);
    expect(Object.entries(offsets).some(([key, value]) => key.startsWith("assets-collection:") && value === 520)).toBe(true);
  });

  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true, entry: { kind: "resume" } });
  await vi.waitFor(() => {
    expect(collectionScroll().scrollTop).toBe(520);
  });
});

test("切换到没有历史偏移的查询必须回到顶部，不能复用旧查询导致有结果却空白", async () => {
  savedLayouts[LIB_A] = {
    assets: {
      ...savedAssetsSectionA(),
      view: "waterfall",
      text: "",
      tags: [],
      folder: { kind: "all" },
      favorite: null,
      scrollOffsets: { "assets-collection": 520 },
    },
    prompts: {},
  };
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true });
  await vi.waitFor(() => expect(collectionScroll().scrollTop).toBe(520));
  await act(async () => folderButton("参考/构图").click());
  await vi.waitFor(() => expect(lastQuery()?.folder).toEqual({ kind: "path", path: "参考/构图" }));
  await vi.waitFor(() => expect(container?.querySelector('[aria-label="图片集合"]')).not.toBeNull());
  expect(collectionScroll().scrollTop).toBe(0);
  expect(container?.querySelectorAll('[role="option"]')).not.toHaveLength(0);
});

// ---------------------------------------------------------------------------
// 多选语义、框选、底部操作栏与右键快捷菜单。
// 契约：单击把目标设为唯一选中与活动项；`Ctrl+单击` 在集合内增减；`Shift+单击`
// 以最近一次直接单击为锚点取有序范围；`Ctrl+A` 全选当前查询（焦点在文本输入内
// 时不认领）；`Esc` 清空选中与活动项，独立保留键盘位置；框选在画布空白处按下并拖出矩形，与
// 虚拟几何相交的全部素材（含离屏项）参与选择，拖动期间显示 `data-selection-box`
// 矩形，结束或 `Esc`/`pointercancel` 收束；多选时中央区底部出现
// `aria-label="批量操作"` 栏，呈现「已选中 N 项」与收藏、移入回收站批量动作；
// 卡片右键打开快捷菜单，提供同一批动作的快捷入口。
// ---------------------------------------------------------------------------

const H_DAWN = "d".repeat(64);

function threeAssetSnapshot(): CatalogSnapshot {
  return {
    assets: [
      assetRow({
        hash: H_DAWN,
        display_filename: "黎明公路.jpg",
        ext: "jpg",
        media_type: "jpeg",
        imported_at: "2026-08-23T08:00:00Z",
      }),
      ...SNAPSHOT_A.assets,
    ],
    folders: SNAPSHOT_A.folders,
    tags: SNAPSHOT_A.tags,
    trash_count: 1,
  };
}

function selectedHashes(): string[] {
  return [...(container?.querySelectorAll<HTMLElement>('[aria-selected="true"][data-hash]') ?? [])]
    .map((element) => element.dataset.hash ?? "");
}

/** 成员比较用：按字典序排副本（与查询呈现顺序解耦）。 */
function sortedIds(ids: string[]): string[] {
  const copy = [...ids];
  copy.sort();
  return copy;
}

function bar(): HTMLElement {
  const element = container?.querySelector<HTMLElement>('[aria-label="批量操作"]');
  if (element === null || element === undefined) throw new Error("缺少批量操作栏");
  return element;
}

function barButton(text: string): HTMLButtonElement {
  const button = [...bar().querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (button === undefined) throw new Error(`缺少批量操作按钮：${text}`);
  return button;
}

function namedButton(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.getAttribute("aria-label") === label,
  );
  if (button === undefined) throw new Error(`缺少按钮：${label}`);
  return button;
}

async function chooseBatchMore(label: string): Promise<void> {
  const trigger = namedButton("更多批量操作");
  trigger.focus();
  await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" })));
  const item = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (item === undefined) throw new Error(`更多批量操作缺少：${label}；当前菜单项：${[...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((candidate) => candidate.textContent?.trim()).join("｜")}`);
  await act(async () => item.click());
}

function clickWithModifiers(
  hash: string,
  modifiers: { ctrl?: boolean; shift?: boolean } = {},
): void {
  card(hash).dispatchEvent(
    new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      ctrlKey: modifiers.ctrl === true,
      shiftKey: modifiers.shift === true,
    }),
  );
}

/** 框选手势所需的指针能力桩；与既有几何桩配合给出确定命中。 */
function installPointerStubs(): { setPointerCapture: ReturnType<typeof vi.fn> } {
  const setPointerCapture = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", { configurable: true, value: setPointerCapture });
  Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", { configurable: true, value: () => true });
  return { setPointerCapture };
}

async function pointer(target: HTMLElement, type: string, x: number, y: number, ctrlKey = false): Promise<void> {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
    ctrlKey,
  });
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    pointerType: { value: "mouse" },
    isPrimary: { value: true },
  });
  await act(async () => {
    target.dispatchEvent(event);
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
}

test("单击、Ctrl+单击、Shift+单击、Ctrl+A 与 Esc 构成 Windows 多选语法", async () => {
  snapshotsByLibrary[LIB_A] = threeAssetSnapshot();
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true, entry: { kind: "resume" } });
  await vi.waitFor(() => {
    expect(container?.querySelectorAll("[data-hash]").length).toBeGreaterThan(0);
  });

  await act(async () => card(H_STREET).click());
  expect(selectedHashes()).toEqual([H_STREET]);
  expect(card(H_STREET).getAttribute("aria-current")).toBe("true");

  await act(async () => clickWithModifiers(H_NIGHT, { ctrl: true }));
  expect(sortedIds(selectedHashes())).toEqual(sortedIds([H_NIGHT, H_STREET]));
  expect(card(H_NIGHT).getAttribute("aria-current")).toBe("true");

  // 直接单击重置锚点；随后的 Shift+单击以它为起点取有序范围。
  await act(async () => clickWithModifiers(H_DAWN));
  expect(selectedHashes()).toEqual([H_DAWN]);
  await act(async () => clickWithModifiers(H_STREET, { shift: true }));
  // 默认导入倒序为 [黎明, 雨夜, 晨光]：锚点黎明到晨光覆盖全部三项。
  expect(sortedIds(selectedHashes())).toEqual(sortedIds([H_DAWN, H_NIGHT, H_STREET]));
  expect(bar().textContent).toContain("已选中 3 项");

  // 焦点在文本输入内时 Ctrl+A 保持原生文本语义，不认领全选。
  await act(async () => searchInput().focus());
  await act(async () => pressKey("a", { ctrl: true }));
  expect(selectedHashes()).toEqual([H_DAWN, H_NIGHT, H_STREET]);

  // 焦点不在可编辑控件时 Ctrl+A 全选当前查询。
  await act(async () => card(H_DAWN).focus());
  await act(async () => pressKey("a", { ctrl: true }));
  expect(sortedIds(selectedHashes())).toEqual(sortedIds([H_DAWN, H_NIGHT, H_STREET]));

  // Esc 清空选择及活动项，避免检查器继续操作未选中的图片。
  await act(async () => pressKey("Escape"));
  expect(selectedHashes()).toEqual([]);
  expect(card(H_STREET).getAttribute("aria-current")).toBeNull();
});

test("操作表面随选择上下文变化：单选用检查器，多选才用批量栏", async () => {
  snapshotsByLibrary[LIB_A] = threeAssetSnapshot();
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());

  const queryToolbar = container?.querySelector('[aria-label="图片查询与视图"]');
  expect(queryToolbar?.textContent).not.toContain("导入图片");
  expect(queryToolbar?.textContent).not.toContain("复制图像");
  expect(queryToolbar?.textContent).not.toContain("修改文件名");
  expect(container?.querySelector('[aria-label="检查器分区定位"]')).toBeNull();

  await act(async () => card(H_STREET).click());
  expect(container?.querySelector('[aria-label="批量操作"]')).toBeNull();
  const singleActions = container?.querySelector('[aria-label="当前图片操作"]');
  expect(singleActions).not.toBeNull();
  expect(singleActions?.querySelector('button[aria-label="复制图像"]')).not.toBeNull();
  expect(singleActions?.querySelector('button[aria-label="修改显示文件名"]')).not.toBeNull();

  await act(async () => clickWithModifiers(H_NIGHT, { ctrl: true }));
  expect(bar().textContent).toContain("已选中 2 项");
  expect(container?.querySelector('[aria-label="当前图片操作"]')).toBeNull();
  expect(bar().textContent).not.toContain("取消收藏");
  expect(bar().textContent).not.toContain("关联提示词");
  expect(bar().querySelector('button[aria-label="更多批量操作"]')).not.toBeNull();
});

test("跨视图保留多选与批量操作栏", async () => {
  snapshotsByLibrary[LIB_A] = threeAssetSnapshot();
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true, entry: { kind: "resume" } });
  await vi.waitFor(() => {
    expect(container?.querySelectorAll("[data-hash]").length).toBeGreaterThan(0);
  });

  await act(async () => card(H_NIGHT).click());
  await act(async () => clickWithModifiers(H_STREET, { ctrl: true }));
  expect(sortedIds(selectedHashes())).toEqual(sortedIds([H_NIGHT, H_STREET]));
  expect(bar().textContent).toContain("已选中 2 项");

  await act(async () => viewButton("详情列表").click());
  await vi.waitFor(() =>
    expect(container?.querySelectorAll("[data-list-item]").length).toBeGreaterThan(0),
  );
  expect(sortedIds(selectedHashes())).toEqual(sortedIds([H_NIGHT, H_STREET]));
  // Windows 语义：活动项是最后一次直接点击的 street，跨视图不丢失。
  expect(card(H_STREET).getAttribute("aria-current")).toBe("true");
  expect(bar().textContent).toContain("已选中 2 项");
});

test("框选按虚拟几何命中，拖动显示矩形，Esc 与 pointercancel 收束", async () => {
  installPointerStubs();
  snapshotsByLibrary[LIB_A] = threeAssetSnapshot();
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true, entry: { kind: "resume" } });
  await vi.waitFor(() => {
    expect(container?.querySelectorAll("[data-hash]").length).toBeGreaterThan(0);
  });
  // 本用例的手势坐标对应 900px 容器中的三列大图，不依赖默认密度。
  await act(async () => chooseDensity("large"));
  await act(async () => card(H_DAWN).click());

  const surface = collectionScroll();
  // 从列间隙空白处向右下拖：矩形只与第二列卡片的虚拟几何相交。
  await pointer(surface, "pointerdown", 296, 20);
  await pointer(surface, "pointermove", 500, 140);
  expect(container?.querySelector("[data-selection-box]")).not.toBeNull();
  expect(selectedHashes()).toEqual([H_NIGHT]);
  expect(card(H_NIGHT).getAttribute("aria-current")).toBe("true");

  await pointer(surface, "pointerup", 500, 140);
  expect(selectedHashes()).toEqual([H_NIGHT]);
  expect(container?.querySelector("[data-selection-box]")).toBeNull();

  // 进行中的手势可被 Esc 取消并恢复原选择；pointercancel 同样收束。
  // 先用直接单击把基础集合收敛为单项，Ctrl 框选在其上增选后再取消。
  await act(async () => card(H_DAWN).click());
  await pointer(surface, "pointerdown", 296, 20, true);
  await pointer(surface, "pointermove", 500, 140, true);
  expect(selectedHashes()).toEqual([H_DAWN, H_NIGHT]);
  await act(async () => surface.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(selectedHashes()).toEqual([H_DAWN]);
  expect(container?.querySelector("[data-selection-box]")).toBeNull();

  await pointer(surface, "pointerdown", 296, 20);
  await pointer(surface, "pointermove", 500, 140);
  await pointer(surface, "pointercancel", 500, 140);
  expect(selectedHashes()).toEqual([H_DAWN]);
  expect(container?.querySelector("[data-selection-box]")).toBeNull();
});

test("Ctrl 框选缩回矩形时去掉旧命中，失去指针捕获时恢复原选择", async () => {
  installPointerStubs();
  snapshotsByLibrary[LIB_A] = threeAssetSnapshot();
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true });
  await vi.waitFor(() => expect(card(H_DAWN)).toBeDefined());
  await act(async () => chooseDensity("large"));
  await act(async () => card(H_DAWN).click());
  const surface = collectionScroll();
  await pointer(surface, "pointerdown", 296, 20, true);
  await pointer(surface, "pointermove", 850, 140, true);
  expect(selectedHashes()).toHaveLength(3);
  await pointer(surface, "pointermove", 500, 140, true);
  expect(sortedIds(selectedHashes())).toEqual(sortedIds([H_DAWN, H_NIGHT]));
  await pointer(surface, "lostpointercapture", 500, 140, true);
  expect(selectedHashes()).toEqual([H_DAWN]);
  expect(container?.querySelector("[data-selection-box]")).toBeNull();
});

test("底部操作栏批量收藏与移入回收站作用于全部选中项", async () => {
  snapshotsByLibrary[LIB_A] = threeAssetSnapshot();
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true, entry: { kind: "resume" } });
  await vi.waitFor(() => {
    expect(container?.querySelectorAll("[data-hash]").length).toBeGreaterThan(0);
  });

  await act(async () => card(H_NIGHT).click());
  await act(async () => clickWithModifiers(H_STREET, { ctrl: true }));
  const baseline = recordedQueries().length;

  await act(async () => barButton("收藏").click());
  await vi.waitFor(() => {
    const call = ipcCalls.find((entry) => entry.command === "batch_set_asset_favorite");
    expect(call).toBeDefined();
    const payload = record(call?.payload);
    expect(payload.hashes).toEqual(expect.arrayContaining([H_NIGHT, H_STREET]));
    expect(payload.hashes).toHaveLength(2);
    expect(payload.favorite).toBe(true);
  });
  // 批量写入后精确失效当前库集合：恰好一次重取。
  await vi.waitFor(() => expect(recordedQueries().length).toBe(baseline + 1));

  await chooseBatchMore("移入回收站");
  await vi.waitFor(() => {
    const call = ipcCalls.find((entry) => entry.command === "batch_delete_assets");
    const payload = record(call?.payload);
    expect(payload.hashes).toEqual(expect.arrayContaining([H_NIGHT, H_STREET]));
    expect(payload.hashes).toHaveLength(2);
  });
  // 假后端把选中两项移入回收站：回收站快照随之可查。
  await vi.waitFor(() => {
    expect(trashSnapshotA.assets.length).toBe(3);
  });
});

test("批量部分成功显示逐项失败，清空选择后报告仍可查看", async () => {
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true });
  await vi.waitFor(() => expect(card(H_NIGHT)).toBeDefined());
  await act(async () => card(H_NIGHT).click());
  await act(async () => clickWithModifiers(H_STREET, { ctrl: true }));
  failedBatchId = H_STREET;
  await act(async () => barButton("收藏").click());
  await vi.waitFor(() => expect(container?.querySelector('[aria-label="操作结果"]')?.textContent).toContain("library.io_failed"));
  const report = container?.querySelector('[aria-label="操作结果"]');
  expect(report?.textContent).toContain("晨光街道.png");
  expect(report?.textContent).toContain("成功 1 项");
  await act(async () => pressKey("Escape"));
  expect(selectedHashes()).toHaveLength(0);
  expect(container?.querySelector('[aria-label="操作结果"]')?.textContent).toContain("library.io_failed");
});

test("取消活动项后活动身份仍属于选择，清选后不再保留活动项", async () => {
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true });
  await vi.waitFor(() => expect(card(H_NIGHT)).toBeDefined());
  await act(async () => card(H_NIGHT).click());
  await act(async () => clickWithModifiers(H_STREET, { ctrl: true }));
  await act(async () => clickWithModifiers(H_STREET, { ctrl: true }));
  expect(selectedHashes()).toEqual([H_NIGHT]);
  expect(card(H_STREET).getAttribute("aria-current")).toBeNull();
  expect(card(H_NIGHT).getAttribute("aria-current")).toBe("true");
});

test("卡片上的 Ctrl+A 全选查询，搜索中的 Escape 不清除图片选择", async () => {
  snapshotsByLibrary[LIB_A] = threeAssetSnapshot();
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true });
  await vi.waitFor(() => expect(card(H_NIGHT)).toBeDefined());
  await act(async () => card(H_NIGHT).click());
  await act(async () => card(H_NIGHT).dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true })));
  expect(selectedHashes()).toHaveLength(3);
  await act(async () => setInput(searchInput(), "图片查询"));
  await act(async () => searchInput().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(searchInput().value).toBe("");
  expect(selectedHashes()).toHaveLength(3);
});

test("集合方向键移动焦点并选择图片，Shift 扩展范围，Esc 保留键盘位置", async () => {
  snapshotsByLibrary[LIB_A] = threeAssetSnapshot();
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true });
  await vi.waitFor(() => expect(card(H_DAWN)).toBeDefined());
  await act(async () => card(H_DAWN).click());
  await act(async () => card(H_DAWN).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true, bubbles: true, cancelable: true })));
  expect(sortedIds(selectedHashes())).toEqual(sortedIds([H_DAWN, H_NIGHT]));
  await vi.waitFor(() => expect(document.activeElement).toBe(card(H_NIGHT)));
  await act(async () => card(H_NIGHT).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(selectedHashes()).toHaveLength(0);
  await act(async () => card(H_NIGHT).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
  expect(selectedHashes()).toEqual([H_STREET]);
});

test("顶栏新建文件夹始终落在根目录，与当前浏览的文件夹无关", async () => {
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true });
  await vi.waitFor(() => expect(folderButton("参考")).toBeDefined());
  // 先进入一个具体文件夹：回归点是“+”不再把当前文件夹当作默认父级。
  await act(async () => folderButton("参考").click());
  await vi.waitFor(() => {
    const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === "新建文件夹")
      ?? document.querySelector<HTMLButtonElement>('button[aria-label="新建文件夹"]');
    expect(button?.disabled).toBe(false);
  });
  const create = [...document.querySelectorAll("button")].find((button) => button.textContent === "新建文件夹");
  const createButton = create ?? document.querySelector<HTMLButtonElement>('button[aria-label="新建文件夹"]') ?? undefined;
  if (createButton === undefined) throw new Error("缺少新建文件夹入口");
  await act(async () => createButton.click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  const creator = container?.querySelector<HTMLElement>('[data-inline-folder-creator]');
  expect(creator?.dataset.parent).toBe("");
  const name = creator?.querySelector<HTMLInputElement>('input[name="inline-folder-name"]');
  if (name === undefined || name === null) throw new Error("缺少文件夹名称输入");
  await act(async () => setInput(name, "灵感"));
  const submit = creator?.querySelector<HTMLButtonElement>('button[aria-label="创建文件夹"]');
  await act(async () => submit?.click());
  await vi.waitFor(() => expect(folderButton("灵感")).toBeDefined());
  expect(lastQuery()?.folder).toEqual({ kind: "path", path: "灵感" });
  expect(container?.querySelector('[data-inline-folder-creator]')).toBeNull();
});

test("右键新建子文件夹仍以该文件夹为父级", async () => {
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true });
  await vi.waitFor(() => expect(folderButton("参考")).toBeDefined());
  const createChild = await folderMenuItem("参考", "新建子文件夹");
  await act(async () => createChild.click());
  const creator = container?.querySelector<HTMLElement>('[data-inline-folder-creator]');
  expect(creator?.dataset.parent).toBe("参考");
  const name = creator?.querySelector<HTMLInputElement>('input[name="inline-folder-name"]');
  if (name === undefined || name === null) throw new Error("缺少文件夹名称输入");
  // 子文件夹的内联输入框挂载后必须持有焦点（右键菜单关闭会把焦点还给触发按钮）。
  await vi.waitFor(() => expect(document.activeElement).toBe(name));
  await act(async () => setInput(name, "光影"));
  const submit = creator?.querySelector<HTMLButtonElement>('button[aria-label="创建文件夹"]');
  await act(async () => submit?.click());
  await vi.waitFor(() => expect(folderButton("参考/光影")).toBeDefined());
  expect(lastQuery()?.folder).toEqual({ kind: "path", path: "参考/光影" });
});

test("全部图片首次导入成功后清除隐藏条件并保持在全部图片", async () => {
  savedLayouts[LIB_A] = {
    assets: { ...savedAssetsSectionA(), text: "旧搜索", tags: ["人物"], folder: { kind: "all" }, favorite: null },
    prompts: {},
  };
  importGate = Promise.resolve({ task_id: "task-import-test", imported: 1, skipped_non_images: 0, duplicates: 0, pending_count: 0, failures: [] });
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(searchInput().value).toBe("旧搜索"));
  await act(async () => window.dispatchEvent(new Event("paste", { bubbles: true, cancelable: true })));
  await vi.waitFor(() => {
    const assets = record(record(recordedWrites().at(-1)?.layout).assets);
    expect(assets.text).toBe("");
    expect(assets.tags).toEqual([]);
    expect(assets.favorite).toBeNull();
    expect(assets.folder).toEqual({ kind: "all" });
    expect(assets.location).toBe("active");
  });
});

test("重命名父文件夹失败保留名称与查询，成功后当前子路径跟随重命名", async () => {
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true });
  await vi.waitFor(() => expect(folderButton("参考/构图")).toBeDefined());
  await act(async () => folderButton("参考/构图").click());
  const trigger = await folderMenuItem("参考/构图", "重命名");
  await act(async () => trigger.click());
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  const target = dialog?.querySelector<HTMLSelectElement>("select");
  const name = dialog?.querySelector<HTMLInputElement>('input[name="folder-name"]');
  const submit = dialog?.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (target === undefined || target === null || name === undefined || name === null || submit === undefined || submit === null) throw new Error("重命名表单不完整");
  await act(async () => { target.value = "参考"; target.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => setInput(name, "灵感"));
  name.focus();
  const dialogSearch = new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true });
  await act(async () => name.dispatchEvent(dialogSearch));
  expect(dialogSearch.defaultPrevented).toBe(false);
  rejectFolderMutation = true;
  await act(async () => submit.click());
  await vi.waitFor(() => expect(dialog?.textContent).toContain("library.io_failed"));
  expect(name.value).toBe("灵感");
  expect(lastQuery()?.folder).toEqual({ kind: "path", path: "参考/构图" });
  expect(folderButton("参考/构图")).toBeDefined();
  rejectFolderMutation = false;
  await act(async () => submit.click());
  await vi.waitFor(() => expect(folderButton("灵感/构图")).toBeDefined());
  expect(lastQuery()?.folder).toEqual({ kind: "path", path: "灵感/构图" });
});

test("删除文件夹必须确认，失败不改现场，成功后子树素材回到未分类", async () => {
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true });
  await vi.waitFor(() => expect(folderButton("参考")).toBeDefined());
  await act(async () => folderButton("参考").click());
  const trigger = await folderMenuItem("参考", "删除");
  await act(async () => trigger.click());
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  const confirmTrigger = [...(dialog?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "继续删除");
  if (confirmTrigger === undefined) throw new Error("缺少删除确认入口");
  await act(async () => confirmTrigger.click());
  expect(ipcCalls.some((call) => call.command === "delete_folder")).toBe(false);
  const cancel = [...document.querySelectorAll('[role="alertdialog"] button')].find((button) => button.textContent === "取消");
  if (!(cancel instanceof HTMLButtonElement)) throw new Error("缺少取消确认按钮");
  await act(async () => cancel.click());
  expect(ipcCalls.some((call) => call.command === "delete_folder")).toBe(false);
  rejectFolderMutation = true;
  await act(async () => confirmTrigger.click());
  const confirm = [...document.querySelectorAll('[role="alertdialog"] button')].find((button) => button.textContent === "确认删除文件夹");
  if (!(confirm instanceof HTMLButtonElement)) throw new Error("缺少明确删除确认");
  await act(async () => confirm.click());
  await vi.waitFor(() => expect(dialog?.textContent).toContain("library.io_failed"));
  expect(folderButton("参考/构图")).toBeDefined();
  expect(lastQuery()?.folder).toEqual({ kind: "path", path: "参考" });
  rejectFolderMutation = false;
  await act(async () => confirmTrigger.click());
  const retry = [...document.querySelectorAll('[role="alertdialog"] button')].find((button) => button.textContent === "确认删除文件夹");
  if (!(retry instanceof HTMLButtonElement)) throw new Error("缺少重试删除确认");
  await act(async () => retry.click());
  await vi.waitFor(() => expect(lastQuery()?.folder).toEqual({ kind: "root" }));
  expect(container?.querySelector('[data-folder="参考"]')).toBeNull();
  expect(container?.querySelector('[data-folder="参考/构图"]')).toBeNull();
  await vi.waitFor(() => {
    expect(card(H_NIGHT)).toBeDefined();
    expect(card(H_STREET)).toBeDefined();
  });
});

test("批量移动明确选择唯一目标，部分失败保留目标并只重试失败项", async () => {
  snapshotsByLibrary[LIB_A] = { ...SNAPSHOT_A, folders: [...SNAPSHOT_A.folders, "配色"] };
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true });
  await vi.waitFor(() => expect(card(H_NIGHT)).toBeDefined());
  await act(async () => card(H_NIGHT).click());
  await act(async () => clickWithModifiers(H_STREET, { ctrl: true }));
  await act(async () => barButton("移动").click());
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  const target = dialog?.querySelector<HTMLSelectElement>('select[name="move-target"]');
  const submit = dialog?.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (target === undefined || target === null || submit === undefined || submit === null) throw new Error("移动表单不完整");
  expect(submit.disabled).toBe(true);
  await act(async () => { target.value = "folder:配色"; target.dispatchEvent(new Event("change", { bubbles: true })); });
  failedBatchId = H_STREET;
  await act(async () => submit.click());
  await vi.waitFor(() => expect(dialog?.textContent).toContain("library.io_failed"));
  expect(target.value).toBe("folder:配色");
  const first = ipcCalls.find((call) => call.command === "batch_move_assets_to_folder");
  expect(record(first?.payload).folder).toBe("配色");
  expect(record(first?.payload).hashes).toEqual(expect.arrayContaining([H_NIGHT, H_STREET]));
  failedBatchId = null;
  await act(async () => submit.click());
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  const retry = ipcCalls.filter((call) => call.command === "batch_move_assets_to_folder").at(-1);
  expect(record(retry?.payload).hashes).toEqual([H_STREET]);
});

test("拖动已选图片到文件夹移动整组选中项，取消不写入，拖到未分类清除归属", async () => {
  installPointerStubs();
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true });
  await vi.waitFor(() => expect(card(H_NIGHT)).toBeDefined());
  await act(async () => card(H_NIGHT).click());
  await act(async () => clickWithModifiers(H_STREET, { ctrl: true }));
  const workspace = container?.querySelector<HTMLElement>('[aria-label="图片工作区"]');
  if (workspace === undefined || workspace === null) throw new Error("缺少工作区");
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => folderButton("参考") });
  try {
    await pointer(card(H_NIGHT), "pointerdown", 100, 100);
    await pointer(workspace, "pointermove", 200, 120);
    await pointer(workspace, "pointerup", 200, 120);
    await vi.waitFor(() => expect(ipcCalls.filter((call) => call.command === "batch_move_assets_to_folder")).toHaveLength(1));
    const moved = ipcCalls.find((call) => call.command === "batch_move_assets_to_folder");
    expect(record(moved?.payload).folder).toBe("参考");
    expect(record(moved?.payload).hashes).toEqual(expect.arrayContaining([H_NIGHT, H_STREET]));
    await pointer(card(H_NIGHT), "pointerdown", 100, 100);
    await pointer(workspace, "pointermove", 200, 120);
    await act(async () => workspace.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    await pointer(workspace, "pointerup", 200, 120);
    expect(ipcCalls.filter((call) => call.command === "batch_move_assets_to_folder")).toHaveLength(1);
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => railButton("未分类") });
    await pointer(card(H_NIGHT), "pointerdown", 100, 100);
    await pointer(workspace, "pointermove", 200, 120);
    await pointer(workspace, "pointerup", 200, 120);
    await vi.waitFor(() => expect(ipcCalls.filter((call) => call.command === "batch_move_assets_to_folder")).toHaveLength(2));
    expect(record(ipcCalls.filter((call) => call.command === "batch_move_assets_to_folder").at(-1)?.payload).folder).toBeNull();
  } finally {
    Reflect.deleteProperty(document, "elementFromPoint");
  }
});

test("拖动文件夹到另一文件夹会重组完整子树且不触发图片移动", async () => {
  installPointerStubs();
  snapshotsByLibrary[LIB_A] = {
    ...SNAPSHOT_A,
    folders: [...SNAPSHOT_A.folders, "项目 A"],
  };
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true });
  await vi.waitFor(() => expect(folderButton("项目 A")).toBeDefined());
  const tree = container?.querySelector<HTMLElement>('[data-folder-tree-root]');
  if (tree === undefined || tree === null) throw new Error("缺少图片文件夹树");
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => folderButton("项目 A"),
  });
  try {
    await pointer(folderButton("参考/构图"), "pointerdown", 30, 120);
    await pointer(tree, "pointermove", 80, 180);
    await pointer(tree, "pointerup", 80, 180);
    await vi.waitFor(() => {
      const call = ipcCalls.find((entry) => entry.command === "move_folder");
      expect(record(call?.payload)).toMatchObject({
        path: "参考/构图",
        destinationParent: "项目 A",
      });
    });
    expect(ipcCalls.some((entry) => entry.command === "batch_move_assets_to_folder")).toBe(false);
  } finally {
    Reflect.deleteProperty(document, "elementFromPoint");
  }
});

test("文件夹普通点击在越过拖动阈值前不捕获指针，真实鼠标仍能进入文件夹", async () => {
  const pointerStubs = installPointerStubs();
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true });
  await vi.waitFor(() => expect(folderButton("参考")).toBeDefined());
  await pointer(folderButton("参考"), "pointerdown", 30, 120);
  expect(pointerStubs.setPointerCapture).not.toHaveBeenCalled();
  await pointer(folderButton("参考"), "pointerup", 30, 120);
  await act(async () => folderButton("参考").click());
  await vi.waitFor(() => expect(container?.querySelector("h1")?.textContent).toBe("参考"));
});

test("拖动图片子文件夹时揭示可命中的移到顶层放置区", async () => {
  installPointerStubs();
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true });
  await vi.waitFor(() => expect(folderButton("参考/构图")).toBeDefined());
  const tree = container?.querySelector<HTMLElement>('[data-folder-tree-root]');
  if (tree === undefined || tree === null) throw new Error("缺少图片文件夹树");
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => tree });
  try {
    await pointer(folderButton("参考/构图"), "pointerdown", 30, 120);
    await pointer(tree, "pointermove", 90, 180);
    const rootDrop = container?.querySelector<HTMLElement>('[data-folder-root-drop]');
    expect(rootDrop?.textContent).toContain("移到顶层");
    expect(rootDrop?.dataset.dropActive).toBe("true");
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => rootDrop });
    await pointer(tree, "pointermove", 90, 190);
    await pointer(tree, "pointerup", 90, 190);
    await vi.waitFor(() => {
      const call = ipcCalls.filter((entry) => entry.command === "move_folder").at(-1);
      expect(record(call?.payload)).toMatchObject({ path: "参考/构图", destinationParent: null });
    });
  } finally {
    Reflect.deleteProperty(document, "elementFromPoint");
  }
});

test("窄窗口可以打开图片导航，选择文件夹后关闭浮层并更新查询", async () => {
  setWindowWidth(760);
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true });
  await vi.waitFor(() => expect(card(H_NIGHT)).toBeDefined());
  const trigger = [...document.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "图片导航");
  if (trigger === undefined) throw new Error("窄窗口缺少导航入口");
  await act(async () => trigger.click());
  const target = document.querySelector<HTMLButtonElement>('[role="dialog"] [data-folder="参考/构图"]');
  if (target === null) throw new Error("导航浮层缺少文件夹");
  await act(async () => target.click());
  await vi.waitFor(() => expect(lastQuery()?.folder).toEqual({ kind: "path", path: "参考/构图" }));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

test("卡片右键打开快捷菜单并提供批量动作入口", async () => {
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true, entry: { kind: "resume" } });
  await vi.waitFor(() => {
    expect(container?.querySelectorAll("[data-hash]").length).toBeGreaterThan(0);
  });

  await act(async () => {
    card(H_STREET).dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }),
    );
  });
  const menu = document.body.querySelector('[role="menu"]');
  if (menu === null) throw new Error("右键未打开快捷菜单");
  // 夹具里晨光街道已是收藏态：菜单呈现反向动作，选择后应写入取消收藏。
  const favoriteItem = [...(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]
    .find((candidate) => candidate.textContent?.trim() === "取消收藏");
  if (favoriteItem === undefined) throw new Error("快捷菜单缺少取消收藏入口");

  await act(async () => favoriteItem.click());
  await vi.waitFor(() => {
    // 快捷菜单面向单项：走单素材收藏通道，语义与批量一致但命令更轻。
    const call = ipcCalls.find((entry) => entry.command === "set_asset_favorite");
    const payload = record(call?.payload);
    expect(payload.hash).toBe(H_STREET);
    expect(payload.favorite).toBe(false);
  });
});

test("卡片右键菜单提供复制图像与重命名入口", async () => {
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true, entry: { kind: "resume" } });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());

  await act(async () => {
    card(H_STREET).dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }),
    );
  });
  const menu = document.body.querySelector('[role="menu"]');
  if (menu === null) throw new Error("右键未打开快捷菜单");
  const copyItem = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((candidate) => candidate.textContent?.trim() === "复制图像");
  if (copyItem === undefined) throw new Error("快捷菜单缺少复制图像入口");
  await act(async () => copyItem.click());
  await vi.waitFor(() => expect(ipcCalls.some((call) => call.command === "copy_asset_to_clipboard")).toBe(true));

  await act(async () => {
    card(H_STREET).dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }),
    );
  });
  const renameItem = [...(document.body.querySelector('[role="menu"]')?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]
    .find((candidate) => candidate.textContent?.trim() === "重命名");
  if (renameItem === undefined) throw new Error("快捷菜单缺少重命名入口");
  await act(async () => renameItem.click());
  // 与 F2 相同的重命名对话框：编辑名称主体，来源文件名保持可见。
  await vi.waitFor(() => expect(document.querySelector('input[name="display-filename-stem"]')).not.toBeNull());
  const input = document.querySelector<HTMLInputElement>('input[name="display-filename-stem"]');
  expect(input?.value).toBe("晨光街道");
});

test("F2 编辑单图名称主体，保存后显示新名且来源文件名与选择不变", async () => {
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => card(H_STREET).click());
  const key = new KeyboardEvent("keydown", { key: "F2", bubbles: true, cancelable: true });
  await act(async () => card(H_STREET).dispatchEvent(key));
  expect(key.defaultPrevented).toBe(true);
  const input = document.querySelector<HTMLInputElement>('input[name="display-filename-stem"]');
  if (input === null) throw new Error("缺少显示文件名编辑框");
  expect(input.value).toBe("晨光街道");
  expect(document.activeElement).toBe(input);
  expect(input.selectionStart).toBe(0);
  expect(input.selectionEnd).toBe(input.value.length);
  const dialog = input.closest('[role="dialog"]');
  expect(dialog?.textContent).toContain(".png");
  expect(dialog?.textContent).toContain("IMG_0001.PNG");
  await act(async () => setInput(input, "雨夜街道"));
  const submit = dialog?.querySelector<HTMLButtonElement>('button[type="submit"]');
  await act(async () => submit?.click());
  await vi.waitFor(() => expect(card(H_STREET).textContent).toContain("雨夜街道.png"));
  expect(card(H_STREET).getAttribute("aria-selected")).toBe("true");
  expect(container?.querySelector('[aria-label="图片文件信息"]')?.textContent).toContain("IMG_0001.PNG");
  const call = ipcCalls.find((entry) => entry.command === "rename_asset_display_filename");
  expect(call?.payload).toEqual({ hash: H_STREET, stem: "雨夜街道" });
  await vi.waitFor(() => expect(document.querySelector('input[name="display-filename-stem"]')).toBeNull());
});

test("改名失败保留输入与原名，取消后再次按 F2 打开不继承旧错误", async () => {
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => { card(H_STREET).click(); card(H_STREET).focus(); });
  await act(async () => card(H_STREET).dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true, cancelable: true })));
  const input = document.querySelector<HTMLInputElement>('input[name="display-filename-stem"]');
  if (input === null) throw new Error("缺少名称输入");
  const dialog = input.closest('[role="dialog"]');
  const submit = dialog?.querySelector<HTMLButtonElement>('button[type="submit"]');
  renameFailure = "library.asset_metadata_write_failed";
  await act(async () => setInput(input, "未保存的新名称"));
  await act(async () => submit?.click());
  await vi.waitFor(() => expect(dialog?.textContent).toContain("library.asset_metadata_write_failed"));
  expect(input.value).toBe("未保存的新名称");
  expect(input.getAttribute("aria-invalid")).toBe("false");
  expect(card(H_STREET).textContent).toContain("晨光街道.png");
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  await vi.waitFor(() => expect(document.querySelector('input[name="display-filename-stem"]')).toBeNull());
  renameFailure = null;
  await act(async () => { card(H_STREET).focus(); card(H_STREET).dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true, cancelable: true })); });
  const reopened = document.querySelector<HTMLInputElement>('input[name="display-filename-stem"]');
  expect(reopened?.value).toBe("晨光街道");
  expect(reopened?.closest('[role="dialog"]')?.querySelector('[role="alert"]')).toBeNull();
});

test("改名退出当前查询后恢复搜索焦点，仍能按来源名和新显示名找到同一图片", async () => {
  applyFilenameFilter = true;
  snapshotsByLibrary[LIB_A] = { ...SNAPSHOT_A, assets: [assetRow({ hash: H_STREET, display_filename: "晨光街道.png", original_filename: "IMG_0042.PNG" })] };
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => setInput(searchInput(), "晨光"));
  await act(async () => { card(H_STREET).click(); card(H_STREET).focus(); });
  await act(async () => card(H_STREET).dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true, cancelable: true })));
  const input = document.querySelector<HTMLInputElement>('input[name="display-filename-stem"]');
  if (input === null) throw new Error("缺少名称输入");
  await act(async () => setInput(input, "夜色街道"));
  const submit = input.closest("form")?.querySelector<HTMLButtonElement>('button[type="submit"]');
  await act(async () => submit?.click());
  await vi.waitFor(() => expect(document.querySelector('input[name="display-filename-stem"]')).toBeNull());
  expect(searchInput().value).toBe("晨光");
  expect(container?.querySelector('[data-hash]')).toBeNull();
  await vi.waitFor(() => expect(document.activeElement).toBe(searchInput()));
  await act(async () => setInput(searchInput(), "img_0042"));
  await vi.waitFor(() => expect(card(H_STREET).textContent).toContain("夜色街道.png"));
  await act(async () => setInput(searchInput(), "夜色街道"));
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => card(H_STREET).click());
  expect(container?.querySelector('[aria-label="图片文件信息"]')?.textContent).toContain("IMG_0042.PNG");
});

test("检查器共用重命名表单，服务端拒绝伪造扩展名后可以保留输入重试", async () => {
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => card(H_STREET).click());
  const edit = container?.querySelector<HTMLButtonElement>('button[aria-label="修改显示文件名"]');
  if (edit === null || edit === undefined) throw new Error("缺少检查器编辑入口");
  await act(async () => edit.click());
  const input = document.querySelector<HTMLInputElement>('input[name="display-filename-stem"]');
  if (input === null) throw new Error("缺少编辑框");
  const dialog = input.closest('[role="dialog"]');
  const submit = dialog?.querySelector<HTMLButtonElement>('button[type="submit"]');
  expect(dialog?.querySelectorAll("input")).toHaveLength(1);
  renameFailure = "library.filename_invalid";
  await act(async () => setInput(input, "参考图.jpg"));
  await act(async () => submit?.click());
  await vi.waitFor(() => expect(dialog?.textContent).toContain("library.filename_invalid"));
  expect(input.value).toBe("参考图.jpg");
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(dialog?.textContent).toContain(".png");
  expect(card(H_STREET).textContent).toContain("晨光街道.png");
  renameFailure = null;
  await act(async () => setInput(input, "  构图参考  "));
  await act(async () => submit?.click());
  await vi.waitFor(() => expect(card(H_STREET).textContent).toContain("构图参考.png"));
  expect(ipcCalls.filter((call) => call.command === "rename_asset_display_filename")).toHaveLength(2);
  expect(container?.querySelector('[aria-label="图片文件信息"]')?.textContent).toContain("IMG_0001.PNG");
});

test("F2 不抢占其他输入框，也不允许多选、回收站或非活动工作区重命名", async () => {
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => card(H_STREET).click());
  const inputKey = new KeyboardEvent("keydown", { key: "F2", bubbles: true, cancelable: true });
  await act(async () => searchInput().dispatchEvent(inputKey));
  expect(inputKey.defaultPrevented).toBe(false);
  await act(async () => clickWithModifiers(H_NIGHT, { ctrl: true }));
  const multiKey = new KeyboardEvent("keydown", { key: "F2", bubbles: true, cancelable: true });
  await act(async () => card(H_NIGHT).dispatchEvent(multiKey));
  expect(multiKey.defaultPrevented).toBe(false);
  await act(async () => railButton("回收站").click());
  await vi.waitFor(() => expect(card(H_TRASHED)).toBeDefined());
  await act(async () => card(H_TRASHED).click());
  const trashKey = new KeyboardEvent("keydown", { key: "F2", bubbles: true, cancelable: true });
  await act(async () => card(H_TRASHED).dispatchEvent(trashKey));
  expect(trashKey.defaultPrevented).toBe(false);
  await rerenderWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: false });
  const inactiveKey = new KeyboardEvent("keydown", { key: "F2", bubbles: true, cancelable: true });
  await act(async () => window.dispatchEvent(inactiveKey));
  expect(inactiveKey.defaultPrevented).toBe(false);
  expect(document.querySelector('input[name="display-filename-stem"]')).toBeNull();
  expect(ipcCalls.filter((call) => call.command === "rename_asset_display_filename")).toHaveLength(0);
});

test("双文件名查询失败时保留搜索词和稳定错误，不开放过期素材的编辑", async () => {
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => card(H_STREET).click());
  filenameQueryFailure = true;
  await act(async () => setInput(searchInput(), "IMG_0042"));
  await vi.waitFor(() => expect(container?.textContent).toContain("文件名查询失败"));
  expect(searchInput().value).toBe("IMG_0042");
  expect(container?.textContent).toContain("library.io_failed");
  const trigger = [...document.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "修改显示文件名");
  expect(trigger).toBeUndefined();
});

function inspector(): HTMLElement {
  const element = document.querySelector<HTMLElement>('aside[aria-label="图片检查器"]');
  if (element === null) throw new Error("检查器未挂载");
  return element;
}

function inspectorButton(label: string): HTMLButtonElement {
  const button = [...inspector().querySelectorAll("button")].find((item) => (item.getAttribute("aria-label") ?? item.textContent) === label);
  if (button === undefined) throw new Error(`找不到检查器按钮：${label}`);
  return button;
}

test("单选检查器连续呈现六分区且不重复显示分区定位标签", async () => {
  await mountWorkspace({ session: makeSession(LIB_A, "视觉档案"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  expect(ipcCalls.filter((call) => call.command === "image_detail")).toHaveLength(0);
  await act(async () => card(H_STREET).click());
  await vi.waitFor(() => expect(inspector().querySelectorAll('[data-inspector-section]')).toHaveLength(6));
  for (const title of ["摘要", "色卡", "组织", "备注", "关联提示词", "文件信息"]) {
    expect(inspectorButton(title).getAttribute("aria-expanded")).toBe("true");
  }
  await act(async () => inspectorButton("色卡").click());
  expect(inspectorButton("色卡").getAttribute("aria-expanded")).toBe("false");
  expect(inspectorButton("备注").getAttribute("aria-expanded")).toBe("true");
  await vi.waitFor(() => expect(record(record(savedLayouts[LIB_A]).assets).inspectorSections).toEqual({ colors: false }));
  expect(inspector().querySelector('[aria-label="检查器分区定位"]')).toBeNull();
  await act(async () => inspectorButton("色卡").click());
  expect(inspectorButton("色卡").getAttribute("aria-expanded")).toBe("true");
  await act(async () => inspectorButton("备注").click());
  await mountWorkspace({ session: makeSession(LIB_B, "乙库"), active: true });
  await vi.waitFor(() => expect(card(H_NIGHT)).toBeDefined());
  await act(async () => card(H_NIGHT).click());
  expect(inspectorButton("备注").getAttribute("aria-expanded")).toBe("true");
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => card(H_STREET).click());
  expect(inspectorButton("备注").getAttribute("aria-expanded")).toBe("false");
});

function noteInput(): HTMLTextAreaElement {
  const input = inspector().querySelector<HTMLTextAreaElement>('textarea[aria-label="图片备注"]');
  if (input === null) throw new Error("备注输入框不存在");
  return input;
}

function editNote(text: string): void {
  const input = noteInput();
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

test("检查器备注自动保存纯文本，失败后切图保留原文并允许明确重试", async () => {
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => card(H_STREET).click());
  await act(async () => editNote("# 不是标题\n中文 **原文**"));
  await vi.waitFor(() => expect(inspector().textContent).toContain("已保存"), { timeout: 2000 });
  expect(snapshotsByLibrary[LIB_A]?.assets.find((item) => item.hash === H_STREET)?.note).toBe("# 不是标题\n中文 **原文**");
  inspectorWriteFailure = true;
  await act(async () => { editNote("失败后不丢弃"); noteInput().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })); });
  await vi.waitFor(() => expect(inspector().textContent).toContain("library.asset_metadata_write_failed"));
  await act(async () => card(H_NIGHT).click());
  expect(noteInput().value).toBe("");
  await act(async () => card(H_STREET).click());
  expect(noteInput().value).toBe("失败后不丢弃");
  expect(inspector().textContent).toContain("library.asset_metadata_write_failed");
  inspectorWriteFailure = false;
  await act(async () => inspectorButton("保存备注").click());
  await vi.waitFor(() => expect(inspector().textContent).toContain("已保存"));
  expect(noteInput().value).toBe("失败后不丢弃");
});

test("备注在途保存不覆盖新输入，重复提交不并发写同一图片", async () => {
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => card(H_STREET).click());
  let finish!: () => void;
  noteGate = new Promise<void>((resolve) => { finish = resolve; });
  await act(async () => { editNote("第一版"); inspectorButton("保存备注").click(); });
  await vi.waitFor(() => expect(inspector().textContent).toContain("正在保存"));
  await act(async () => { editNote("第二版"); noteInput().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })); });
  expect(ipcCalls.filter((call) => call.command === "set_asset_note")).toHaveLength(1);
  await act(async () => finish());
  expect(noteInput().value).toBe("第二版");
  await vi.waitFor(() => expect(snapshotsByLibrary[LIB_A]?.assets.find((item) => item.hash === H_STREET)?.note).toBe("第二版"), { timeout: 2500 });
  expect(ipcCalls.filter((call) => call.command === "set_asset_note")).toHaveLength(2);
});

test("切库取消未发出的备注写入，同哈希草稿隔离且返回后可恢复", async () => {
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_NIGHT)).toBeDefined());
  await act(async () => { card(H_NIGHT).click(); });
  await act(async () => editNote("仅甲库的未保存草稿"));
  await mountWorkspace({ session: makeSession(LIB_B, "乙库"), active: true });
  await vi.waitFor(() => expect(card(H_NIGHT)).toBeDefined());
  await act(async () => card(H_NIGHT).click());
  expect(noteInput().value).toBe("");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 900)); });
  expect(ipcCalls.filter((call) => call.command === "set_asset_note")).toHaveLength(0);
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_NIGHT)).toBeDefined());
  await act(async () => card(H_NIGHT).click());
  expect(noteInput().value).toBe("仅甲库的未保存草稿");
  await act(async () => inspectorButton("保存备注").click());
  await vi.waitFor(() => expect(inspector().textContent).toContain("已保存"));
  expect(ipcCalls.filter((call) => call.command === "set_asset_note").map((call) => call.currentLibrary)).toEqual([LIB_A]);
});

test("单选组织移动到唯一文件夹，标签失败保留草稿，成功后可移除", async () => {
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => card(H_STREET).click());
  const folder = inspector().querySelector<HTMLSelectElement>('select[aria-label="图片所在文件夹"]');
  expect(folder).not.toBeNull();
  await act(async () => { folder!.value = "root"; folder!.dispatchEvent(new Event("change", { bubbles: true })); });
  await vi.waitFor(() => expect(snapshotsByLibrary[LIB_A]?.assets.find((asset) => asset.hash === H_STREET)?.folder).toBeNull());
  await vi.waitFor(() => expect(folder!.disabled).toBe(false));
  const tag = inspector().querySelector<HTMLInputElement>('input[aria-label="添加图片标签"]');
  if (tag === null) throw new Error("缺少标签输入");
  inspectorWriteFailure = true;
  await act(async () => setInput(tag, "构图"));
  await act(async () => inspectorButton("添加标签").click());
  await vi.waitFor(() => expect(inspector().textContent).toContain("library.asset_metadata_write_failed"));
  expect(tag.value).toBe("构图");
  inspectorWriteFailure = false;
  await act(async () => inspectorButton("添加标签").click());
  await vi.waitFor(() => expect(inspectorButton("移除图片标签 构图").disabled).toBe(false));
  expect(tag.value).toBe("");
  await act(async () => inspectorButton("移除图片标签 构图").click());
  await vi.waitFor(() => expect(snapshotsByLibrary[LIB_A]?.assets.find((asset) => asset.hash === H_STREET)?.tags).toEqual(["人物"]));
});

test("普通提示词关联按需加载，失败保留选择，解除不删除提示词", async () => {
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => card(H_STREET).click());
  await vi.waitFor(() => expect(inspector().textContent).toContain("已删除记录"));
  expect(ipcCalls.filter((call) => call.command === "prompt_snapshot")).toHaveLength(0);
  await act(async () => inspectorButton("添加已有提示词").click());
  await vi.waitFor(() => expect(document.querySelector('input[value="prompt-0"]')).not.toBeNull());
  await act(async () => document.querySelector<HTMLInputElement>('input[value="prompt-0"]')!.click());
  inspectorWriteFailure = true;
  let confirmLink = [...document.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === "建立 1 条普通关联");
  if (confirmLink === undefined) throw new Error("缺少确认关联按钮");
  const firstConfirmLink = confirmLink;
  await act(async () => firstConfirmLink.click());
  await vi.waitFor(() => expect(document.body.textContent).toContain("关联写入失败"));
  expect(document.querySelector<HTMLInputElement>('input[value="prompt-0"]')!.checked).toBe(true);
  inspectorWriteFailure = false;
  confirmLink = [...document.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === "建立 1 条普通关联");
  if (confirmLink === undefined) throw new Error("失败重试缺少确认关联按钮");
  const retryConfirmLink = confirmLink;
  await act(async () => retryConfirmLink.click());
  await vi.waitFor(() => expect(inspector().textContent).toContain("光影参考"));
  const more = inspector().querySelector<HTMLButtonElement>('button[aria-label="提示词关联操作 光影参考"]');
  if (more === null) throw new Error("缺少提示词关联操作入口");
  more.focus();
  await act(async () => more.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" })));
  const unlink = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.trim() === "解除关联");
  if (unlink === undefined) throw new Error("缺少解除关联菜单项");
  await act(async () => unlink.click());
  await vi.waitFor(() => expect(prompts[0]?.linked_image_hashes).toEqual([]));
  expect(prompts).toHaveLength(2);
});

test("图片侧关联提示词行提供独立直接解除入口且不抢打开主命中", async () => {
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => card(H_STREET).click());
  await vi.waitFor(() => expect(inspector().textContent).toContain("已删除记录"));

  const open = inspector().querySelector<HTMLButtonElement>('button[aria-label="打开提示词 已删除记录"]');
  const directUnlink = inspector().querySelector<HTMLButtonElement>('button[aria-label="解除与提示词 已删除记录 的关联"]');
  expect(open).not.toBeNull();
  expect(directUnlink).not.toBeNull();
  expect(directUnlink).not.toBe(open);

  await act(async () => directUnlink!.click());
  await vi.waitFor(() => expect(prompts.find((prompt) => prompt.id === "prompt-1")?.linked_image_hashes).toEqual([]));
  expect(prompts.find((prompt) => prompt.id === "prompt-1")?.title).toBe("已删除记录");
});

test("提示词侧写入推进关系 revision 后图片详情立即刷新，关联项可打开对应提示词", async () => {
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => card(H_STREET).click());
  await vi.waitFor(() => expect(inspector().textContent).toContain("已删除记录"));

  const openDeleted = inspector().querySelector<HTMLButtonElement>('button[aria-label="打开提示词 已删除记录"]');
  if (openDeleted === null) throw new Error("关联提示词缺少跨页打开入口");
  await act(async () => openDeleted.click());
  await flush();
  expect(testNavigation.entryFor("prompts")).toMatchObject({ kind: "locate_prompt", promptId: "prompt-1", location: "trash" });

  await act(async () => {
    await testRelations.execute({ kind: "link", libraryId: LIB_A, images: [H_STREET], prompts: ["prompt-0"] });
  });
  await vi.waitFor(() => expect(inspector().textContent).toContain("光影参考"));

  prompts = prompts.map((prompt) => prompt.id === "prompt-0" ? { ...prompt, deleted_at: "2026-08-31T02:00:00Z" } : prompt);
  await act(async () => {
    await testRelations.synchronize(LIB_A, { imageIds: [], promptIds: ["prompt-0"] });
  });
  await vi.waitFor(() => expect(inspector().querySelector('button[aria-label="打开提示词 光影参考"]')?.closest("li")?.textContent).toContain("已删除"));

  prompts = prompts.map((prompt) => prompt.id === "prompt-0" ? { ...prompt, deleted_at: null } : prompt);
  await act(async () => {
    await testRelations.synchronize(LIB_A, { imageIds: [], promptIds: ["prompt-0"] });
  });
  await vi.waitFor(() => expect(inspector().querySelector('button[aria-label="打开提示词 光影参考"]')?.closest("li")?.textContent).not.toContain("已删除"));
});

test("回收站检查器只读，详情错误可重试且不冒充空关联", async () => {
  detailFailure = true;
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => card(H_STREET).click());
  await vi.waitFor(() => expect(inspector().textContent).toContain("详情读取失败"));
  expect(inspector().textContent).not.toContain("尚未关联提示词");
  detailFailure = false;
  await act(async () => inspectorButton("重试读取详情").click());
  await vi.waitFor(() => expect(inspector().textContent).toContain("已删除记录"));
  await act(async () => railButton("回收站").click());
  await vi.waitFor(() => expect(card(H_TRASHED)).toBeDefined());
  await act(async () => card(H_TRASHED).click());
  expect(noteInput().disabled).toBe(true);
  expect(inspector().querySelector('button[aria-label="修改显示文件名"]')).toBeNull();
  expect(inspector().querySelector('input[aria-label="添加图片标签"]')).toBeNull();
});

test("检查器色卡用比例色带呈现，并允许从稳定失败码重新分析", async () => {
  snapshotsByLibrary[LIB_A] = { ...SNAPSHOT_A, assets: SNAPSHOT_A.assets.map((asset) => asset.hash === H_STREET ? { ...asset, colors: [{ hex: "#E8664A", oklab_l: .5, oklab_a: .2, oklab_b: .1, share: .75, role: "dominant" }] } : { ...asset, color_card_status: "failed", color_card_failure_reason: "color_card.cluster_failed" }) };
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => card(H_STREET).click());
  await vi.waitFor(() => expect(inspector().querySelector('[data-inspector-section="summary"] img')).not.toBeNull());
  expect(inspector().textContent).toContain("#E8664A");
  expect(inspector().textContent).toContain("主色");
  expect(inspector().textContent).toContain("75.0%");
  expect(inspector().querySelector('[aria-label^="色彩比例"]')).not.toBeNull();
  expect(ipcCalls.some((call) => call.command === "asset_original")).toBe(false);
  await act(async () => card(H_NIGHT).click());
  expect(inspector().textContent).toContain("色彩聚类没有得到可靠结果");
  expect(inspector().textContent).toContain("color_card.cluster_failed");
  expect(inspector().textContent).not.toContain("#E8664A");
  const regenerate = [...inspector().querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "重新分析色卡");
  if (regenerate === undefined) throw new Error("失败色卡缺少重新分析入口");
  await act(async () => regenerate.click());
  await vi.waitFor(() => expect(inspector().textContent).toContain("#315f73"));
  expect(ipcCalls).toContainEqual(expect.objectContaining({ command: "regenerate_color_card" }));
});

test("选择图片的延迟聚焦不得抢走检查器分区焦点", async () => {
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { frames.set(++frameId, callback); return frameId; });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
  await act(async () => card(H_STREET).click());
  const heading = inspectorButton("色卡");
  await act(async () => heading.focus());
  expect(document.activeElement).toBe(heading);
  const pendingFrames = Array.from(frames.values());
  await act(async () => { for (const callback of pendingFrames) callback(performance.now()); });
  expect(document.activeElement).toBe(heading);
});

test("窄窗口关闭检查器时不读取隐藏详情，打开后只呈现一份检查器", async () => {
  setWindowWidth(760);
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => card(H_STREET).click());
  expect(ipcCalls.filter((call) => call.command === "image_detail")).toHaveLength(0);
  const trigger = [...document.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === "图片信息");
  if (trigger === undefined) throw new Error("缺少窄屏检查器入口");
  await act(async () => trigger.click());
  await vi.waitFor(() => expect(document.querySelectorAll('[data-inspector-section]')).toHaveLength(6));
  expect(ipcCalls.filter((call) => call.command === "image_detail")).toHaveLength(1);
});

test("关联候选读取失败时保留搜索词和错误，显式重试后才可选择", async () => {
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => card(H_STREET).click());
  await vi.waitFor(() => expect(inspectorButton("添加已有提示词")).toBeDefined());
  promptFailure = true;
  await act(async () => inspectorButton("添加已有提示词").click());
  const search = document.querySelector<HTMLInputElement>('input[name="association-prompt-search"]');
  if (search === null) throw new Error("缺少关联搜索");
  await act(async () => setInput(search, "光影"));
  await vi.waitFor(() => expect(document.body.textContent).toContain("候选读取失败"));
  expect(search.value).toBe("光影");
  const confirm = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "建立 0 条普通关联");
  expect(confirm?.disabled).toBe(true);
  promptFailure = false;
  const retry = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "重试读取提示词");
  if (retry === undefined) throw new Error("缺少提示词候选重试入口");
  await act(async () => retry.click());
  await vi.waitFor(() => expect(document.querySelector('input[value="prompt-0"]')).not.toBeNull());
});

test("折叠检查器分区不覆盖最新滚动位置与提示词布局", async () => {
  savedLayouts[LIB_A] = { assets: savedAssetsSectionA(), prompts: { text: "提示词现场" } };
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => card(H_STREET).click());
  await act(async () => {
    collectionScroll().scrollTop = 560;
    collectionScroll().dispatchEvent(new Event("scroll"));
  });
  await vi.waitFor(() => expect(Object.entries(record(record(record(savedLayouts[LIB_A]).assets).scrollOffsets)).some(([key, value]) => key.startsWith("assets-collection:") && value === 560)).toBe(true));
  await act(async () => inspectorButton("备注").click());
  await vi.waitFor(() => expect(record(record(savedLayouts[LIB_A]).assets).inspectorSections).toEqual({ note: false }));
  expect(Object.values(record(record(record(savedLayouts[LIB_A]).assets).scrollOffsets))).toContain(560);
  expect(record(savedLayouts[LIB_A]).prompts).toEqual({ text: "提示词现场" });
});

test("多选检查器展示共同值与混合值，不使用活动图片冒充整组信息", async () => {
  snapshotsByLibrary[LIB_A] = { ...SNAPSHOT_A, assets: SNAPSHOT_A.assets.map((asset) => ({ ...asset, tags: asset.hash === H_STREET ? ["共同", "人物"] : ["共同", "夜景"] })) };
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => card(H_STREET).click());
  await act(async () => clickWithModifiers(H_NIGHT, { ctrl: true }));
  expect(inspector().textContent).toContain("已选 2 张图片");
  expect(inspector().textContent).toContain("混合值（2 个位置）");
  expect(inspector().textContent).toContain("混合值（1/2 已收藏）");
  expect(inspector().querySelector('[aria-label="共同标签"]')?.textContent).toBe("共同");
  expect(inspector().querySelector('[aria-label="部分图片标签"]')?.textContent).toContain("人物（1/2）");
  expect(inspector().querySelector('[aria-label="部分图片标签"]')?.textContent).toContain("夜景（1/2）");
  expect(inspector().querySelector("textarea")).toBeNull();
  expect(inspector().textContent).not.toContain("晨光街道.png");
  expect(inspector().querySelector("img")).toBeNull();
  await act(async () => viewButton("详情列表").click());
  expect(inspector().textContent).toContain("已选 2 张图片");
  expect(inspector().querySelector('[aria-label="共同标签"]')?.textContent).toBe("共同");
});

test("多选检查器只显示概览，成功操作不在集合底部追加结果条", async () => {
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => card(H_STREET).click());
  await act(async () => clickWithModifiers(H_NIGHT, { ctrl: true }));
  expect(inspector().textContent).not.toContain("批量操作");
  await act(async () => barButton("收藏").click());
  await vi.waitFor(() => expect(inspector().textContent).toContain("全部已收藏"));
  await vi.waitFor(() => expect(barButton("取消收藏").disabled).toBe(false));
  await act(async () => barButton("取消收藏").click());
  await vi.waitFor(() => expect(inspector().textContent).toContain("全部未收藏"));
  await chooseBatchMore("移入回收站");
  await vi.waitFor(() => expect(container?.querySelectorAll('[role="option"]')).toHaveLength(0));
  expect(document.querySelector('[aria-label="操作结果"]')).toBeNull();
});

function batchDialog(): HTMLElement {
  const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((element) => element.querySelector("h2")?.textContent === "批量编辑标签" || element.querySelector("h2")?.textContent === "批量关联提示词");
  if (dialog === undefined) throw new Error("缺少批量编辑 Dialog");
  return dialog;
}

function batchDialogButton(label: string): HTMLButtonElement {
  const button = [...batchDialog().querySelectorAll("button")].find((element) => (element.getAttribute("aria-label") ?? element.textContent) === label);
  if (button === undefined) throw new Error(`批量编辑缺少按钮：${label}`);
  return button;
}

function associationDialog(): HTMLElement {
  const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((element) => element.querySelector("h2")?.textContent === "图片 × 提示词关联");
  if (dialog === undefined) throw new Error("缺少图片 × 提示词关联台");
  return dialog;
}

function associationDialogButton(label: string): HTMLButtonElement {
  const button = [...associationDialog().querySelectorAll<HTMLButtonElement>("button")].find((element) => (element.getAttribute("aria-label") ?? element.textContent)?.trim() === label);
  if (button === undefined) throw new Error(`图片关联台缺少按钮：${label}`);
  return button;
}

test("批量标签部分失败保留意图且只重试失败项，成功后可批量移除", async () => {
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => card(H_STREET).click());
  await act(async () => clickWithModifiers(H_NIGHT, { ctrl: true }));
  await act(async () => barButton("标签").click());
  const input = batchDialog().querySelector<HTMLInputElement>('input[name="batch-asset-tag"]');
  if (input === null) throw new Error("缺少批量标签输入");
  await act(async () => setInput(input, "建筑"));
  failedBatchId = H_NIGHT;
  await act(async () => batchDialogButton("添加到所选图片").click());
  await vi.waitFor(() => expect(batchDialog().textContent).toContain("雨夜霓虹.jpg"));
  expect(batchDialog().textContent).toContain("library.io_failed");
  expect(input.value).toBe("建筑");
  expect(input.disabled).toBe(true);
  failedBatchId = null;
  await act(async () => batchDialogButton("重试失败项").click());
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  expect(inspector().querySelector('[aria-label="共同标签"]')?.textContent).toBe("建筑");
  const writes = ipcCalls.filter((call) => call.command === "batch_add_asset_tag");
  expect(record(writes[0]?.payload).hashes).toEqual([H_STREET, H_NIGHT]);
  expect(record(writes[1]?.payload).hashes).toEqual([H_NIGHT]);
  await act(async () => barButton("标签").click());
  const remove = batchDialog().querySelector<HTMLInputElement>('input[value="remove"]');
  if (remove === null) throw new Error("缺少移除模式");
  await act(async () => remove.click());
  await act(async () => setInput(batchDialog().querySelector<HTMLInputElement>('input[name="batch-asset-tag"]')!, "建筑"));
  await act(async () => batchDialogButton("从所选图片移除").click());
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  expect(inspector().querySelector('[aria-label="共同标签"]')?.textContent).toBe("无共同标签");
  expect(document.querySelector('[aria-label="操作结果"]')?.textContent).toContain("雨夜霓虹.jpg");
});

test("批量提示词关联按需加载正常候选，失败保留选择并用同一冻结目标重试", async () => {
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => card(H_STREET).click());
  await act(async () => clickWithModifiers(H_NIGHT, { ctrl: true }));
  expect(ipcCalls.filter((call) => call.command === "prompt_snapshot")).toHaveLength(0);
  await chooseBatchMore("关联提示词");
  await vi.waitFor(() => expect(associationDialog().querySelector('input[value="prompt-0"]')).not.toBeNull());
  expect(associationDialog().querySelector('input[value="prompt-1"]')).toBeNull();
  await act(async () => associationDialog().querySelector<HTMLInputElement>('input[value="prompt-0"]')!.click());
  inspectorWriteFailure = true;
  const submit = [...associationDialog().querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "建立 2 条普通关联");
  if (submit === undefined) throw new Error("缺少批量关联提交按钮");
  await act(async () => submit.click());
  await vi.waitFor(() => expect(associationDialog().textContent).toContain("关联写入失败"));
  expect(associationDialog().querySelector<HTMLInputElement>('input[value="prompt-0"]')?.checked).toBe(true);
  inspectorWriteFailure = false;
  const retry = [...associationDialog().querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "建立 2 条普通关联");
  if (retry === undefined) throw new Error("缺少批量关联重试按钮");
  await act(async () => retry.click());
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  const writes = ipcCalls.filter((call) => call.command === "link_images");
  expect(writes).toHaveLength(2);
  expect(writes.every((call) => JSON.stringify(sortedIds(stringArray(record(call.payload).hashes))) === JSON.stringify(sortedIds([H_STREET, H_NIGHT])))).toBe(true);
  await act(async () => card(H_STREET).click());
  await vi.waitFor(() => expect(inspector().querySelector('button[aria-label="打开提示词 光影参考"]')).not.toBeNull());
  await act(async () => card(H_NIGHT).click());
  await vi.waitFor(() => expect(inspector().querySelector('button[aria-label="打开提示词 光影参考"]')).not.toBeNull());
});

test("图片关联台冻结多选目标、允许多选提示词并只计算实际新增关系", async () => {
  prompts = [
    { ...prompts[0]!, linked_image_hashes: [H_STREET] },
    prompts[1]!,
    { ...prompts[0]!, id: "prompt-2", title: "平面海报构图", linked_image_hashes: [] },
  ];
  snapshotsByLibrary[LIB_A] = threeAssetSnapshot();
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => card(H_STREET).click());
  await act(async () => clickWithModifiers(H_NIGHT, { ctrl: true }));
  await chooseBatchMore("关联提示词");
  await vi.waitFor(() => expect(associationDialog().querySelector('input[value="prompt-0"]')).not.toBeNull());

  expect(associationDialog().textContent).toContain("已选图片 2 张");
  expect(associationDialog().textContent).toContain("晨光街道.png");
  expect(associationDialog().textContent).toContain("雨夜霓虹.jpg");
  expect(associationDialog().querySelector('label:has(input[value="prompt-0"])')?.textContent).toContain("已关联 1/2 张");

  await act(async () => associationDialog().querySelector<HTMLInputElement>('input[value="prompt-0"]')!.click());
  await act(async () => associationDialog().querySelector<HTMLInputElement>('input[value="prompt-2"]')!.click());
  expect(associationDialog().textContent).toContain("已选提示词 2 条");
  const submit = [...associationDialog().querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "建立 3 条普通关联");
  if (submit === undefined) throw new Error("关联台没有按缺失关系显示提交数量");

  await rerenderWorkspace({ session: makeSession(LIB_A, "甲库"), active: true, entry: { kind: "locate", requestId: "association-target-frozen", hash: parseAssetId(H_DAWN), location: "active" } });
  expect(associationDialog().textContent).toContain("已选图片 2 张");
  expect(associationDialog().textContent).not.toContain("黎明广场.webp");

  await act(async () => submit.click());
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  expect(sortedIds(prompts.find((prompt) => prompt.id === "prompt-0")?.linked_image_hashes ?? [])).toEqual(sortedIds([H_STREET, H_NIGHT]));
  expect(sortedIds(prompts.find((prompt) => prompt.id === "prompt-2")?.linked_image_hashes ?? [])).toEqual(sortedIds([H_STREET, H_NIGHT]));
  const writes = ipcCalls.filter((call) => call.command === "link_images");
  expect(writes.map((call) => record(call.payload).promptId)).toEqual(["prompt-0", "prompt-2"]);
  expect(writes.every((call) => JSON.stringify(sortedIds(stringArray(record(call.payload).hashes))) === JSON.stringify(sortedIds([H_STREET, H_NIGHT])))).toBe(true);
});

test("图片关联台跨搜索保留所选提示词并按全部选择计算关系", async () => {
  prompts = [
    prompts[0]!,
    prompts[1]!,
    { ...prompts[0]!, id: "prompt-2", title: "平面海报构图", linked_image_hashes: [] },
  ];
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_NIGHT)).toBeDefined());
  await act(async () => card(H_NIGHT).click());
  await vi.waitFor(() => expect(inspectorButton("添加已有提示词")).toBeDefined());
  await act(async () => inspectorButton("添加已有提示词").click());
  await vi.waitFor(() => expect(associationDialog().querySelector('input[value="prompt-0"]')).not.toBeNull());
  await act(async () => associationDialog().querySelector<HTMLInputElement>('input[value="prompt-0"]')!.click());

  const search = associationDialog().querySelector<HTMLInputElement>('input[name="association-prompt-search"]');
  if (search === null) throw new Error("关联台缺少提示词搜索框");
  await act(async () => setInput(search, "海报"));
  await vi.waitFor(() => expect(associationDialog().querySelector('input[value="prompt-2"]')).not.toBeNull());
  expect(associationDialog().querySelector('input[value="prompt-0"]')).toBeNull();
  await act(async () => associationDialog().querySelector<HTMLInputElement>('input[value="prompt-2"]')!.click());

  expect(associationDialog().textContent).toContain("已选提示词 2 条");
  const submit = associationDialogButton("建立 2 条普通关联");
  await act(async () => submit.click());
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  expect(prompts.find((prompt) => prompt.id === "prompt-0")?.linked_image_hashes).toContain(H_NIGHT);
  expect(prompts.find((prompt) => prompt.id === "prompt-2")?.linked_image_hashes).toContain(H_NIGHT);
});

test("图片关联台先重试刷新，再继续处理同批失败提示词", async () => {
  prompts = [
    prompts[0]!,
    prompts[1]!,
    { ...prompts[0]!, id: "prompt-2", title: "平面海报构图", linked_image_hashes: [] },
  ];
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => card(H_STREET).click());
  await vi.waitFor(() => expect(inspectorButton("添加已有提示词")).toBeDefined());
  await act(async () => inspectorButton("添加已有提示词").click());
  await vi.waitFor(() => expect(associationDialog().querySelector('input[value="prompt-0"]')).not.toBeNull());
  await act(async () => associationDialog().querySelector<HTMLInputElement>('input[value="prompt-0"]')!.click());
  await act(async () => associationDialog().querySelector<HTMLInputElement>('input[value="prompt-2"]')!.click());

  relationFailurePromptId = "prompt-2";
  promptFailure = true;
  await act(async () => associationDialogButton("建立 2 条普通关联").click());
  await vi.waitFor(() => expect(associationDialog().textContent).toContain("关系已写入、刷新失败"));
  expect(associationDialog().textContent).toContain("关联写入失败");
  expect(associationDialog().textContent).toContain("已选提示词 1 条");

  promptFailure = false;
  await act(async () => associationDialogButton("重试刷新").click());
  await vi.waitFor(() => expect(associationDialog().textContent).not.toContain("关系已写入、刷新失败"));
  expect(associationDialog().textContent).toContain("关联写入失败");
  await vi.waitFor(() => expect(associationDialog().querySelector<HTMLInputElement>('input[value="prompt-2"]')?.checked).toBe(true));
  relationFailurePromptId = null;
  await act(async () => associationDialogButton("建立 1 条普通关联").click());
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  expect(prompts.find((prompt) => prompt.id === "prompt-2")?.linked_image_hashes).toContain(H_STREET);
});

test("图片关联台手动创建一条提示词并关联全部冻结图片", async () => {
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => card(H_STREET).click());
  await act(async () => clickWithModifiers(H_NIGHT, { ctrl: true }));
  await chooseBatchMore("关联提示词");
  await vi.waitFor(() => expect(associationDialog()).toBeDefined());
  await act(async () => associationDialogButton("新建提示词").click());

  const body = associationDialog().querySelector<HTMLTextAreaElement>('textarea[name="association-create-body"]');
  const title = associationDialog().querySelector<HTMLInputElement>('input[name="association-create-title"]');
  const model = associationDialog().querySelector<HTMLInputElement>('input[name="association-create-model"]');
  if (body === null || title === null || model === null) throw new Error("关联台缺少手写提示词字段");
  expect(body.value).toBe("");
  await act(async () => setInput(title, "柔光参考"));
  await act(async () => setInput(model, "SDXL"));
  await act(async () => setTextarea(body, "主体偏右，柔和侧光，保留暗部细节。"));
  await act(async () => associationDialogButton("创建提示词并关联到 2 张图片").click());

  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  const created = prompts.find((prompt) => prompt.title === "柔光参考");
  expect(created?.body).toBe("主体偏右，柔和侧光，保留暗部细节。");
  expect(created?.model).toBe("SDXL");
  expect(sortedIds(created?.linked_image_hashes ?? [])).toEqual(sortedIds([H_STREET, H_NIGHT]));
  expect(ipcCalls.filter((call) => call.command === "create_prompt")).toHaveLength(1);
  expect(ipcCalls.filter((call) => call.command === "link_images")).toHaveLength(1);
});

test("图片关联台保留创建失败草稿，创建后关联失败只重试关系", async () => {
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => card(H_STREET).click());
  await vi.waitFor(() => expect(inspectorButton("添加已有提示词")).toBeDefined());
  await act(async () => inspectorButton("添加已有提示词").click());
  await vi.waitFor(() => expect(associationDialog()).toBeDefined());
  await act(async () => associationDialogButton("新建提示词").click());
  const body = associationDialog().querySelector<HTMLTextAreaElement>('textarea[name="association-create-body"]');
  if (body === null) throw new Error("关联台缺少手写提示词正文");
  await act(async () => setTextarea(body, "失败后仍要保留的正文"));

  promptCreateFailure = true;
  await act(async () => associationDialogButton("创建提示词并关联到 1 张图片").click());
  await vi.waitFor(() => expect(associationDialog().textContent).toContain("提示词目录只读"));
  expect(body.value).toBe("失败后仍要保留的正文");

  promptCreateFailure = false;
  inspectorWriteFailure = true;
  await act(async () => associationDialogButton("创建提示词并关联到 1 张图片").click());
  await vi.waitFor(() => expect(associationDialog().textContent).toContain("提示词已创建、关联失败"));
  const created = prompts.find((prompt) => prompt.body === "失败后仍要保留的正文");
  expect(created).toBeDefined();
  expect(ipcCalls.filter((call) => call.command === "create_prompt")).toHaveLength(2);

  inspectorWriteFailure = false;
  await act(async () => associationDialogButton("重试关联到 1 张图片").click());
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  expect(ipcCalls.filter((call) => call.command === "create_prompt")).toHaveLength(2);
  expect(prompts.find((prompt) => prompt.id === created?.id)?.linked_image_hashes).toEqual([H_STREET]);
});

test("图片关联台的新建草稿统一拦截外部导航与直接关闭", async () => {
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => card(H_STREET).click());
  await vi.waitFor(() => expect(inspectorButton("添加已有提示词")).toBeDefined());
  await act(async () => inspectorButton("添加已有提示词").click());
  await vi.waitFor(() => expect(associationDialog()).toBeDefined());
  await act(async () => associationDialogButton("新建提示词").click());
  const body = associationDialog().querySelector<HTMLTextAreaElement>('textarea[name="association-create-body"]');
  if (body === null) throw new Error("关联台缺少手写提示词正文");
  await act(async () => setTextarea(body, "需要守卫的图片上下文草稿"));

  const continueNavigation = vi.fn();
  let blocked = false;
  await act(async () => { blocked = blockIfPromptDraftDirty(continueNavigation); });
  expect(blocked).toBe(true);
  const guardDialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((dialog) => dialog.textContent?.includes("有未保存的修改"));
  if (guardDialog === undefined) throw new Error("外部导航没有打开统一草稿决议");
  const stay = [...guardDialog.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "留在当前页");
  if (stay === undefined) throw new Error("草稿决议缺少留在当前页");
  await act(async () => stay.click());
  expect(continueNavigation).not.toHaveBeenCalled();
  expect(body.value).toBe("需要守卫的图片上下文草稿");

  await act(async () => associationDialogButton("关闭").click());
  const closeGuard = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((dialog) => dialog.textContent?.includes("有未保存的修改"));
  if (closeGuard === undefined) throw new Error("直接关闭没有打开统一草稿决议");
  const discard = [...closeGuard.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "放弃草稿");
  if (discard === undefined) throw new Error("草稿决议缺少放弃草稿");
  await act(async () => discard.click());
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  expect(blockIfPromptDraftDirty(vi.fn())).toBe(false);
});

test("移除筛选标签导致多选变单选时，批量编辑会话与失败目标仍保留", async () => {
  applyTagFilter = true;
  savedLayouts[LIB_A] = { assets: { ...savedAssetsSectionA(), tags: ["共同"] }, prompts: {} };
  snapshotsByLibrary[LIB_A] = { ...SNAPSHOT_A, assets: SNAPSHOT_A.assets.map((asset) => ({ ...asset, tags: ["共同"] })) };
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => card(H_STREET).click());
  await act(async () => clickWithModifiers(H_NIGHT, { ctrl: true }));
  await act(async () => barButton("标签").click());
  await act(async () => batchDialog().querySelector<HTMLInputElement>('input[value="remove"]')!.click());
  await act(async () => setInput(batchDialog().querySelector<HTMLInputElement>('input[name="batch-asset-tag"]')!, "共同"));
  failedBatchId = H_NIGHT;
  await act(async () => batchDialogButton("从所选图片移除").click());
  await vi.waitFor(() => expect(container?.querySelectorAll('[role="option"]')).toHaveLength(1));
  expect(batchDialog().textContent).toContain("待处理 1 张图片");
  expect(batchDialog().textContent).toContain("雨夜霓虹.jpg");
  failedBatchId = null;
  await act(async () => batchDialogButton("重试失败项").click());
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  expect(container?.textContent).toContain("没有符合条件的图片");
  await vi.waitFor(() => expect(document.activeElement).toBe(searchInput()));
  const activeFilter = document.querySelector<HTMLButtonElement>('[data-tag="共同"]');
  expect(activeFilter).not.toBeNull();
  expect(activeFilter?.getAttribute("aria-pressed")).toBe("true");
  await act(async () => activeFilter?.click());
  await vi.waitFor(() => expect(container?.querySelectorAll('[role="option"]')).toHaveLength(2));
});

test("批量标签固定打开时的目标，整个请求失败保留输入而不写入新的活动项", async () => {
  snapshotsByLibrary[LIB_A] = threeAssetSnapshot();
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => card(H_STREET).click());
  await act(async () => clickWithModifiers(H_NIGHT, { ctrl: true }));
  await act(async () => barButton("标签").click());
  const input = batchDialog().querySelector<HTMLInputElement>('input[name="batch-asset-tag"]')!;
  await act(async () => setInput(input, "固定目标"));
  await rerenderWorkspace({ session: makeSession(LIB_A, "甲库"), active: true, entry: { kind: "locate", requestId: "batch-target-frozen", hash: parseAssetId(H_DAWN), location: "active" } });
  inspectorWriteFailure = true;
  await act(async () => batchDialogButton("添加到所选图片").click());
  await vi.waitFor(() => expect(batchDialog().textContent).toContain("批量标签写入失败"));
  expect(input.value).toBe("固定目标");
  expect(input.disabled).toBe(false);
  inspectorWriteFailure = false;
  await act(async () => batchDialogButton("添加到所选图片").click());
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  expect(inspector().querySelector('[aria-label="图片标签"]')?.textContent).not.toContain("固定目标");
  expect(record(ipcCalls.filter((call) => call.command === "batch_add_asset_tag").at(-1)?.payload).hashes).toEqual([H_STREET, H_NIGHT]);
});

test("批量关联候选读取失败可明确重试，不对旧候选或回收站提示词提交", async () => {
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => card(H_STREET).click());
  await act(async () => clickWithModifiers(H_NIGHT, { ctrl: true }));
  promptFailure = true;
  await chooseBatchMore("关联提示词");
  await vi.waitFor(() => expect(associationDialog().textContent).toContain("候选读取失败"));
  const submit = [...associationDialog().querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "建立 0 条普通关联");
  expect(submit?.disabled).toBe(true);
  promptFailure = false;
  const retry = [...associationDialog().querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "重试读取提示词");
  if (retry === undefined) throw new Error("缺少提示词候选重试入口");
  await act(async () => retry.click());
  await vi.waitFor(() => expect(associationDialog().querySelector('input[value="prompt-0"]')).not.toBeNull());
  expect(associationDialog().querySelector('input[value="prompt-1"]')).toBeNull();
  const close = [...associationDialog().querySelectorAll<HTMLButtonElement>("button")].find((button) => button.getAttribute("aria-label") === "关闭");
  if (close === undefined) throw new Error("关联台缺少关闭按钮");
  await act(async () => close.click());
  expect(ipcCalls.filter((call) => call.command === "batch_link_to_prompt")).toHaveLength(0);
});

test("回收站多选只读且不加载单张信息", async () => {
  trashSnapshotA.assets = [...trashSnapshotA.assets, assetRow({ hash: H_NIGHT, display_filename: "另一张.png", deleted_at: "2026-08-28T00:00:00Z" })];
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => railButton("回收站").click());
  await vi.waitFor(() => expect(card(H_TRASHED)).toBeDefined());
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true })));
  expect(inspector().textContent).toContain("已选 2 张图片");
  expect(inspector().textContent).toContain("回收站中的组织信息只读");
  expect(inspector().querySelectorAll("input, textarea")).toHaveLength(0);
  expect(barButton("还原所选图片")).toBeDefined();
  expect(ipcCalls.filter((call) => call.command === "image_detail")).toHaveLength(0);
});

test("回收站单选还原恢复原文件夹，纯成功不在底部追加结果条", async () => {
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => railButton("回收站").click());
  await vi.waitFor(() => expect(card(H_TRASHED)).toBeDefined());
  await act(async () => card(H_TRASHED).click());
  await act(async () => inspectorButton("还原图片").click());
  await vi.waitFor(() => expect(container?.textContent).toContain("图片回收站为空"));
  expect(document.querySelector('[aria-label="回收站操作结果"]')).toBeNull();
  expect(appTaskCenter.snapshot().at(-1)?.kind).toBe("batch_organization");
  expect(appTaskCenter.snapshot().at(-1)?.title).toBe("还原图片");
  await act(async () => railButton("全部图片").click());
  await vi.waitFor(() => expect(card(H_TRASHED)).toBeDefined());
  await act(async () => card(H_TRASHED).click());
  expect(inspector().querySelector<HTMLSelectElement>('select[aria-label="图片所在文件夹"]')?.value).toBe("folder:参考");
});

test("多选还原区分缺失文件夹成功与事务失败，失败图片保留在回收站可重试", async () => {
  trashSnapshotA.assets.push(assetRow({ hash: H_NIGHT, display_filename: "待恢复.png", deleted_at: "2026-08-28T00:00:00Z" }));
  trashSnapshotA.trash_count = 2;
  deletedFolders.set(H_TRASHED, "已删除文件夹");
  deletedFolders.set(H_NIGHT, "参考");
  failedRestoreId = H_NIGHT;
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => railButton("回收站").click());
  await vi.waitFor(() => expect(card(H_TRASHED)).toBeDefined());
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true })));
  expect(inspector().textContent).toContain("还原时恢复删除前位置");
  await act(async () => barButton("还原所选图片").click());
  await vi.waitFor(() => expect(container?.querySelectorAll('[role="option"]')).toHaveLength(1));
  const report = document.querySelector('[aria-label="回收站操作结果"]');
  expect(report?.textContent).toContain("已还原 1 张图片，失败 1 张");
  expect(report?.textContent).toContain("废弃草图.png：已还原到未分类");
  expect(report?.textContent).toContain("已删除文件夹");
  expect(report?.textContent).toContain("trash.restore_target_folder_missing");
  expect(report?.textContent).toContain("待恢复.png");
  expect(report?.textContent).toContain("trash.restore_failed");
  expect(inspector().textContent).not.toContain("原文件夹：未分类");
  failedRestoreId = null;
  await vi.waitFor(() => expect(inspectorButton("还原图片").disabled).toBe(false));
  await act(async () => inspectorButton("还原图片").click());
  await vi.waitFor(() => expect(container?.textContent).toContain("图片回收站为空"));
  expect(report?.textContent).toContain("trash.restore_failed");
});

function purgeButton(): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")].find((element) => element.textContent === "清空图片回收站");
  if (button === undefined) throw new Error("缺少清空回收站入口");
  return button;
}

function purgeConfirmationButton(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find((element) => element.textContent === label);
  if (button === undefined) throw new Error(`缺少清空确认按钮：${label}`);
  return button;
}

test("永久清空明确覆盖整个回收站，取消不写入，部分失败显示未在筛选中的显示文件名", async () => {
  applyFilenameFilter = true;
  trashSnapshotA.assets.push(assetRow({ hash: H_NIGHT, display_filename: "已改名.png", original_filename: "CAMERA_02.PNG", deleted_at: "2026-08-28T00:00:00Z" }));
  trashSnapshotA.trash_count = 2;
  failedPurgeId = H_NIGHT;
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => railButton("回收站").click());
  await vi.waitFor(() => expect(card(H_TRASHED)).toBeDefined());
  await act(async () => setInput(searchInput(), "废弃"));
  await vi.waitFor(() => expect(container?.querySelectorAll('[role="option"]')).toHaveLength(1));
  await act(async () => purgeButton().click());
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("全部 2 张图片");
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("包括当前筛选未显示的图片");
  await act(async () => purgeConfirmationButton("取消").click());
  expect(ipcCalls.filter((call) => call.command === "purge_trash")).toHaveLength(0);
  await act(async () => purgeButton().click());
  await act(async () => purgeConfirmationButton("永久清空").click());
  await vi.waitFor(() => expect(document.querySelector('[aria-label="回收站操作结果"]')?.textContent).toContain("已永久删除 1 张图片，失败 1 张"));
  expect(appTaskCenter.snapshot().at(-1)?.kind).toBe("batch_organization");
  expect(appTaskCenter.snapshot().at(-1)?.title).toBe("清空图片回收站");
  const report = document.querySelector('[aria-label="回收站操作结果"]');
  expect(report?.textContent).toContain("已改名.png");
  expect(report?.textContent).not.toContain("CAMERA_02.PNG");
  expect(report?.textContent).toContain("trash.purge_failed");
  await act(async () => setInput(searchInput(), ""));
  await vi.waitFor(() => expect(card(H_NIGHT)).toBeDefined());
  expect(container?.querySelectorAll('[role="option"]')).toHaveLength(1);
  failedPurgeId = null;
  await act(async () => purgeButton().click());
  await act(async () => purgeConfirmationButton("永久清空").click());
  await vi.waitFor(() => expect(container?.textContent).toContain("图片回收站为空"));
  await vi.waitFor(() => expect(report?.textContent).toContain("已永久删除 1 张图片，失败 0 张"));
  expect(purgeButton().disabled).toBe(true);
  await vi.waitFor(() => expect(document.activeElement).toBe(searchInput()));
});

test("清空前读取回收站失败不执行永久删除，读取错误可明确重试", async () => {
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => railButton("回收站").click());
  await vi.waitFor(() => expect(card(H_TRASHED)).toBeDefined());
  await act(async () => purgeButton().click());
  filenameQueryFailure = true;
  await act(async () => purgeConfirmationButton("永久清空").click());
  await vi.waitFor(() => expect(document.querySelector('[aria-label="回收站操作结果"]')?.textContent).toContain("library.io_failed"));
  expect(ipcCalls.filter((call) => call.command === "purge_trash")).toHaveLength(0);
  const retry = [...document.querySelectorAll("button")].find((button) => button.textContent === "重试读取图片");
  expect(retry).toBeDefined();
  filenameQueryFailure = false;
  await act(async () => retry?.click());
  await vi.waitFor(() => expect(card(H_TRASHED)).toBeDefined());
});

test("切库后不继续还原旧库目标，返回原库仍能查看未处理报告", async () => {
  trashSnapshotA.assets.push(assetRow({ hash: H_NIGHT, display_filename: "另一张.png", deleted_at: "2026-08-28T00:00:00Z" }));
  trashSnapshotA.trash_count = 2;
  deletedFolders.set(H_NIGHT, null);
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => railButton("回收站").click());
  await vi.waitFor(() => expect(card(H_TRASHED)).toBeDefined());
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true })));
  let finish!: () => void;
  restoreGate = new Promise<void>((resolve) => { finish = resolve; });
  await act(async () => barButton("还原所选图片").click());
  await vi.waitFor(() => expect(ipcCalls.filter((call) => call.command === "restore_asset")).toHaveLength(1));
  await mountWorkspace({ session: makeSession(LIB_B, "乙库"), active: true });
  await act(async () => finish());
  await flush();
  expect(ipcCalls.filter((call) => call.command === "restore_asset").map((call) => call.currentLibrary)).toEqual([LIB_A]);
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(document.querySelector('[aria-label="回收站操作结果"]')?.textContent).toContain("未处理 1 张"));
});

test("清空在部分删除后报错仍刷新真实剩余图片，不宣称全部未删除", async () => {
  trashSnapshotA.assets.push(assetRow({ hash: H_NIGHT, display_filename: "仍在回收站.png", deleted_at: "2026-08-28T00:00:00Z" }));
  trashSnapshotA.trash_count = 2;
  purgeFailsAfterDelete = true;
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => railButton("回收站").click());
  await vi.waitFor(() => expect(card(H_TRASHED)).toBeDefined());
  await act(async () => purgeButton().click());
  await act(async () => purgeConfirmationButton("永久清空").click());
  await vi.waitFor(() => expect(container?.querySelectorAll('[role="option"]')).toHaveLength(1));
  expect(card(H_NIGHT)).toBeDefined();
  const report = document.querySelector('[aria-label="回收站操作结果"]');
  expect(report?.textContent).toContain("删除后索引重建失败");
  expect(report?.textContent).toContain("请以刷新后的回收站内容为准");
  expect(report?.textContent).not.toContain("已永久删除 0");
});

function lightbox(): HTMLElement {
  const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((element) => element.getAttribute("data-lightbox") === "true");
  if (dialog === undefined) throw new Error("灯箱未打开");
  return dialog;
}

function lightboxButton(label: string): HTMLButtonElement {
  const button = [...lightbox().querySelectorAll("button")].find((element) => (element.getAttribute("aria-label") ?? element.textContent) === label);
  if (button === undefined) throw new Error(`灯箱缺少按钮：${label}`);
  return button;
}

test("双击才打开原图灯箱，按当前排序切图并在 Esc 后恢复滚动和最后活动项", async () => {
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_NIGHT)).toBeDefined());
  await act(async () => card(H_NIGHT).click());
  expect(document.querySelector('[data-lightbox]')).toBeNull();
  expect(ipcCalls.filter((call) => call.command === "asset_original")).toHaveLength(0);
  const gallery = collectionScroll();
  await act(async () => { gallery.scrollTop = 240; card(H_NIGHT).dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
  await vi.waitFor(() => expect(lightbox().querySelector('img[alt="雨夜霓虹.jpg"]')).not.toBeNull());
  expect(lightboxButton("上一张").disabled).toBe(true);
  await act(async () => lightboxButton("下一张").click());
  await vi.waitFor(() => expect(lightbox().querySelector('img[alt="晨光街道.png"]')).not.toBeNull());
  expect(lightboxButton("下一张").disabled).toBe(true);
  await act(async () => lightbox().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  await vi.waitFor(() => expect(document.querySelector('[data-lightbox]')).toBeNull());
  expect(collectionScroll()).toBe(gallery);
  expect(gallery.scrollTop).toBe(240);
  expect(card(H_STREET).getAttribute("aria-current")).toBe("true");
  expect(card(H_STREET).getAttribute("aria-selected")).toBe("true");
});

test("灯箱支持适合窗口、100%、有界平移、键盘平移和背景切换", async () => {
  installPointerStubs();
  snapshotsByLibrary[LIB_A] = { ...SNAPSHOT_A, assets: SNAPSHOT_A.assets.map((asset) => asset.hash === H_NIGHT ? { ...asset, width: 2400, height: 1600 } : asset) };
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_NIGHT)).toBeDefined());
  await act(async () => card(H_NIGHT).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  await vi.waitFor(() => expect(lightbox().querySelector("img")).not.toBeNull());
  const img = lightbox().querySelector("img")!;
  await act(async () => img.dispatchEvent(new Event("load")));
  expect(lightbox().querySelector('[aria-label="缩放比例"]')?.textContent).toBe("50%");
  await act(async () => lightboxButton("100%").click());
  expect(lightbox().querySelector('[aria-label="缩放比例"]')?.textContent).toBe("100%");
  const stage = lightbox().querySelector<HTMLElement>('[aria-label="原图画布"]')!;
  await pointer(stage, "pointerdown", 600, 400);
  await pointer(stage, "pointermove", 800, 500);
  await pointer(stage, "pointerup", 800, 500);
  expect(img.style.transform).toBe("translate(200px, 100px) scale(1)");
  await act(async () => stage.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true, cancelable: true })));
  expect(img.style.transform).toBe("translate(240px, 100px) scale(1)");
  await pointer(stage, "pointerdown", 600, 400);
  await pointer(stage, "pointermove", 20000, 20000);
  await pointer(stage, "pointerup", 20000, 20000);
  expect(img.style.transform).toBe("translate(600px, 400px) scale(1)");
  await act(async () => lightboxButton("适合窗口").click());
  expect(img.style.transform).toBe("translate(0px, 0px) scale(0.5)");
  await act(async () => lightboxButton("放大").click());
  expect(lightbox().querySelector('[aria-label="缩放比例"]')?.textContent).toBe("62.5%");
  const background = lightbox().querySelector<HTMLSelectElement>('select[aria-label="灯箱背景"]')!;
  await act(async () => { background.value = "checker"; background.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(stage.dataset.background).toBe("checker");
});

test("灯箱原图读取或显示失败保留明确错误，只有手动重试才再次读取", async () => {
  originalFailure = true;
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_NIGHT)).toBeDefined());
  await act(async () => card(H_NIGHT).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  await vi.waitFor(() => expect(lightbox().textContent).toContain("library.io_failed"));
  expect(lightbox().querySelector("img")).toBeNull();
  expect(lightboxButton("放大").disabled).toBe(true);
  expect(ipcCalls.filter((call) => call.command === "asset_original")).toHaveLength(1);
  originalFailure = false;
  await act(async () => lightboxButton("重试读取原图").click());
  await vi.waitFor(() => expect(lightbox().querySelector("img")).not.toBeNull());
  await act(async () => lightbox().querySelector("img")!.dispatchEvent(new Event("error")));
  expect(lightbox().textContent).toContain("viewer.decode_failed");
  expect(lightbox().querySelector("img")).toBeNull();
  expect(ipcCalls.filter((call) => call.command === "asset_original")).toHaveLength(2);
  await act(async () => lightboxButton("重试读取原图").click());
  await vi.waitFor(() => expect(lightbox().querySelector("img")).not.toBeNull());
  expect(lightbox().textContent).not.toContain("viewer.decode_failed");
});

test("灯箱切图丢弃迟到原图，并在换源和关闭时释放租约", async () => {
  let nextUrl = 0;
  const createUrl = vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:lightbox-${++nextUrl}`);
  const releaseUrl = vi.spyOn(URL, "revokeObjectURL");
  let finish!: (bytes: ArrayBuffer) => void;
  originalGate = new Promise<ArrayBuffer>((resolve) => { finish = resolve; });
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_NIGHT)).toBeDefined());
  await act(async () => card(H_NIGHT).dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  await act(async () => lightboxButton("下一张").click());
  await vi.waitFor(() => expect(lightbox().querySelector("img")).not.toBeNull());
  const currentUrl = lightbox().querySelector("img")!.src;
  await act(async () => finish(new ArrayBuffer(8)));
  const lateResult = createUrl.mock.results.at(-1);
  if (lateResult?.type !== "return") throw new Error("迟到原图没有创建租约");
  expect(releaseUrl).toHaveBeenCalledWith(lateResult.value);
  expect(lightbox().querySelector("img")!.src).toBe(currentUrl);
  await act(async () => lightboxButton("上一张").click());
  await vi.waitFor(() => expect(lightbox().querySelector('img[alt="雨夜霓虹.jpg"]')).not.toBeNull());
  expect(releaseUrl).toHaveBeenCalledWith(currentUrl);
  const finalUrl = lightbox().querySelector("img")!.src;
  expect(finalUrl).not.toBe(lateResult.value);
  await act(async () => lightboxButton("关闭灯箱").click());
  await vi.waitFor(() => expect(document.querySelector('[data-lightbox]')).toBeNull());
  expect(releaseUrl).toHaveBeenCalledWith(finalUrl);
});

test("停用工作区和切库关闭灯箱，回收站也可显式查看原图", async () => {
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => railButton("回收站").click());
  await vi.waitFor(() => expect(card(H_TRASHED)).toBeDefined());
  await act(async () => card(H_TRASHED).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  await vi.waitFor(() => expect(lightbox().querySelector('img[alt="废弃草图.png"]')).not.toBeNull());
  await rerenderWorkspace({ session: makeSession(LIB_A, "甲库"), active: false });
  expect(document.querySelector('[data-lightbox]')).toBeNull();
  await rerenderWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  expect(document.querySelector('[data-lightbox]')).toBeNull();
  await vi.waitFor(() => expect(recordedQueries().length).toBeGreaterThan(2));
  await vi.waitFor(() => expect(card(H_TRASHED)).toBeDefined());
  await flush();
  await flush();
  await act(async () => card(H_TRASHED).dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  await vi.waitFor(() => expect(lightbox().querySelector("img")).not.toBeNull());
  await mountWorkspace({ session: makeSession(LIB_B, "乙库"), active: true });
  expect(document.querySelector('[data-lightbox]')).toBeNull();
});

test("虚拟集合项换源或切库卸载时释放全部缩略图租约", async () => {
  applyFilenameFilter = true;
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await vi.waitFor(() => expect(createObjectUrlMock).toHaveBeenCalled());
  await act(async () => setInput(searchInput(), "不会匹配的图片"));
  await vi.waitFor(() => expect(document.querySelector(`[data-hash="${H_STREET}"]`)).toBeNull());
  expect(revokeObjectUrlMock).toHaveBeenCalled();
  const releasedAfterFilter = revokeObjectUrlMock.mock.calls.length;
  await mountWorkspace({ session: makeSession(LIB_B, "乙库"), active: true });
  await vi.waitFor(() => expect(card(H_NIGHT)).toBeDefined());
  await teardown();
  expect(revokeObjectUrlMock.mock.calls.length).toBeGreaterThan(releasedAfterFilter);
});

test("剪贴板导入不占独立按钮，系统 paste 事件可触发并明确反馈空内容", async () => {
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  expect([...document.querySelectorAll("button")].some((button) => button.textContent === "导入图片")).toBe(false);
  expect([...document.querySelectorAll("button")].some((button) => button.textContent === "导入文件夹")).toBe(false);
  expect([...document.querySelectorAll("button")].some((button) => button.textContent === "从剪贴板导入")).toBe(false);
  await act(async () => window.dispatchEvent(new Event("paste", { bubbles: true, cancelable: true })));
  await vi.waitFor(() => expect(ipcCalls.some((call) => call.command === "paste_import")).toBe(true));
  await vi.waitFor(() => expect(document.body.textContent).toContain("剪贴板中没有可导入的图片"));
  expect(container?.textContent).not.toContain("剪贴板中没有可导入的图片");
  await act(async () => [...document.querySelectorAll("button")].find((button) => button.getAttribute("aria-label")?.startsWith("任务中心"))?.click());
  await vi.waitFor(() => expect(document.body.textContent).toContain("粘贴导入"));
});

test("导入部分失败在图片工作区持续呈现逐项错误，直到使用者明确关闭", async () => {
  importGate = Promise.resolve({
    task_id: "task-import-partial",
    imported: 1,
    skipped_non_images: 1,
    duplicates: 1,
    pending_count: 2,
    failures: [{
      source_path: "E:\\素材\\损坏.png",
      original_filename: "损坏.png",
      error: { code: "import.source_unreadable", detail: "文件被占用" },
    }],
  });
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => window.dispatchEvent(new Event("paste", { bubbles: true, cancelable: true })));
  const report = await vi.waitFor(() => {
    const element = container?.querySelector<HTMLElement>('[aria-label="导入结果"]');
    expect(element).not.toBeNull();
    return element!;
  });
  expect(report.textContent).toContain("成功 1");
  expect(report.textContent).toContain("跳过 2");
  expect(report.textContent).toContain("失败 1");
  expect(report.textContent).toContain("未处理 2");
  expect(report.textContent).toContain("重复内容");
  expect(report.textContent).toContain("不支持的格式");
  expect(report.textContent).toContain("损坏.png");
  expect(report.textContent).toContain("import.source_unreadable");
  importGate = Promise.resolve({ task_id: "task-import-retry", imported: 1, skipped_non_images: 0, duplicates: 0, pending_count: 0, failures: [] });
  await act(async () => window.dispatchEvent(new Event("paste", { bubbles: true, cancelable: true })));
  await vi.waitFor(() => expect(ipcCalls.filter((call) => call.command === "paste_import")).toHaveLength(2));
  expect(container?.querySelectorAll('[aria-label="导入结果"]')).toHaveLength(1);
  expect(report.textContent).toContain("损坏.png");
  await rerenderWorkspace({ session: makeSession(LIB_B, "乙库"), active: true });
  await vi.waitFor(() => expect(container?.querySelector('[aria-label="导入结果"]')).toBeNull());
  await rerenderWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(container?.querySelector('[aria-label="导入结果"]')?.textContent).toContain("损坏.png"));
  const restoredReport = container?.querySelector<HTMLElement>('[aria-label="导入结果"]');
  if (restoredReport === undefined || restoredReport === null) throw new Error("切回原库后导入结果未恢复");
  const close = restoredReport.querySelector<HTMLButtonElement>('button[aria-label="关闭导入结果"]');
  if (close === null) throw new Error("导入结果缺少关闭入口");
  await act(async () => close.click());
  expect(container?.querySelector('[aria-label="导入结果"]')).toBeNull();
});

test("整次导入失败按素材库持续保留稳定错误，直到使用者明确关闭", async () => {
  let rejectImport!: (reason: unknown) => void;
  importGate = new Promise<ImportOutcome>((_resolve, reject) => { rejectImport = reject; });
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => window.dispatchEvent(new Event("paste", { bubbles: true, cancelable: true })));
  await vi.waitFor(() => expect(ipcCalls.some((call) => call.command === "paste_import")).toBe(true));
  await act(async () => rejectImport({ code: "clipboard.read_failed", detail: "截图位图无法读取" }));
  await vi.waitFor(() => expect(container?.querySelector('[aria-label="导入结果"]')?.textContent).toContain("clipboard.read_failed"));
  await rerenderWorkspace({ session: makeSession(LIB_B, "乙库"), active: true });
  await vi.waitFor(() => expect(container?.querySelector('[aria-label="导入结果"]')).toBeNull());
  await rerenderWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  const report = await vi.waitFor(() => {
    const element = container?.querySelector<HTMLElement>('[aria-label="导入结果"]');
    expect(element?.textContent).toContain("截图位图无法读取");
    return element!;
  });
  const close = report.querySelector<HTMLButtonElement>('button[aria-label="关闭导入结果"]');
  if (close === null) throw new Error("整次导入失败报告缺少关闭入口");
  await act(async () => close.click());
  expect(container?.querySelector('[aria-label="导入结果"]')).toBeNull();
});

test("顶栏图片和文件夹意图复用同一导入协调器，并把当前逻辑文件夹作为目标", async () => {
  savedLayouts[LIB_A] = {
    assets: { ...savedAssetsSectionA(), favorite: false },
    prompts: {},
  };
  dialogImageFiles = ["E:\\素材\\一张.png", "E:\\素材\\两张.jpg"];
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await rerenderWorkspace({ session: makeSession(LIB_A, "甲库"), active: true, importRequest: { requestId: createRequestId(), kind: "images" } });
  await vi.waitFor(() => expect(ipcCalls.some((call) => call.command === "import_sources")).toBe(true));
  const imageImport = record(ipcCalls.find((call) => call.command === "import_sources")?.payload);
  expect(imageImport.paths).toEqual(dialogImageFiles);
  expect(imageImport.currentFolder).toBe("参考");
  await rerenderWorkspace({ session: makeSession(LIB_A, "甲库"), active: true, importRequest: { requestId: createRequestId(), kind: "folder" } });
  await vi.waitFor(() => expect(ipcCalls.filter((call) => call.command === "import_sources")).toHaveLength(2));
  const folderImport = record(ipcCalls.filter((call) => call.command === "import_sources").at(-1)?.payload);
  expect(folderImport.paths).toEqual(["E:\\待导入"]);
  expect(folderImport.currentFolder).toBe("参考");
});

test("图片工作区的文本输入保持原生 Ctrl+V，导入任务运行时拒绝第二个任务并显示稳定码", async () => {
  let finish!: (outcome: ImportOutcome) => void;
  importGate = new Promise<ImportOutcome>((resolve) => { finish = resolve; });
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => searchInput().dispatchEvent(new KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true, cancelable: true })));
  expect(ipcCalls.filter((call) => call.command === "paste_import")).toHaveLength(0);
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true, cancelable: true })));
  await vi.waitFor(() => expect(ipcCalls.filter((call) => call.command === "paste_import")).toHaveLength(1));
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true, cancelable: true })));
  await vi.waitFor(() => expect(document.body.textContent).toContain("导入任务正在运行"));
  await act(async () => finish({ task_id: "task-import-test", imported: 1, skipped_non_images: 0, duplicates: 0, pending_count: 0, failures: [] }));
  await act(async () => [...document.querySelectorAll("button")].find((button) => button.getAttribute("aria-label")?.startsWith("任务中心"))?.click());
  await vi.waitFor(() => expect(document.body.textContent).toContain("粘贴导入"));
  expect(ipcCalls.filter((call) => call.command === "paste_import")).toHaveLength(1);
});

test("导入任务取得后端任务 ID 后可真实请求停止，并等待 stopped 确认", async () => {
  emitImportProgress = true;
  let finish!: (outcome: ImportOutcome) => void;
  importGate = new Promise<ImportOutcome>((resolve) => { finish = resolve; });
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true, cancelable: true })));
  await vi.waitFor(() => expect(ipcCalls.some((call) => call.command === "paste_import")).toBe(true));
  await act(async () => [...document.querySelectorAll("button")].find((button) => button.getAttribute("aria-label")?.startsWith("任务中心"))?.click());
  const taskPanel = document.querySelector<HTMLElement>('[data-ui="task-center"]');
  if (taskPanel === null) throw new Error("任务中心未打开");
  expect(taskPanel.textContent).toContain("停止");
  importStopState = "stopping";
  await act(async () => [...taskPanel.querySelectorAll("button")].find((button) => button.textContent === "停止")?.click());
  await vi.waitFor(() => expect(taskPanel.textContent).toContain("正在停止"));
  expect(taskPanel.textContent).not.toContain("已停止");
  importStopState = "stopped";
  await act(async () => [...taskPanel.querySelectorAll("button")].find((button) => button.textContent === "正在停止…")?.click());
  await act(async () => finish({ task_id: "backend-import-test", imported: 1, skipped_non_images: 0, duplicates: 0, pending_count: 2, failures: [] }));
  await vi.waitFor(() => expect(taskPanel.textContent).toContain("已停止"));
  expect(ipcCalls.filter((call) => call.command === "import_stop")).toHaveLength(2);
  expect(taskPanel.textContent).toContain("未处理 2");
  await vi.waitFor(() => expect(container?.querySelector('[aria-label="导入结果"]')?.textContent).toContain("已停止"));
  await dismissVisibleTransferReports();
});

test("停止先返回 stopping 时，导入结果到达后再次向后端确认终态", async () => {
  emitImportProgress = true;
  let finish!: (outcome: ImportOutcome) => void;
  importGate = new Promise<ImportOutcome>((resolve) => { finish = resolve; });
  importStopState = "stopping";
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true, cancelable: true })));
  await vi.waitFor(() => expect(ipcCalls.some((call) => call.command === "paste_import")).toBe(true));
  const taskButton = document.querySelector<HTMLButtonElement>('[aria-label^="任务中心"]');
  if (taskButton === null) throw new Error("任务中心按钮不存在");
  await act(async () => taskButton.click());
  const taskPanel = document.querySelector<HTMLElement>('[data-ui="task-center"]');
  if (taskPanel === null) throw new Error("任务中心未打开");
  await act(async () => [...taskPanel.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "停止")?.click());
  await act(async () => finish({ task_id: "backend-import-test", imported: 1, skipped_non_images: 0, duplicates: 0, pending_count: 0, failures: [] }));
  await vi.waitFor(() => expect(container?.querySelector('[aria-label="导入结果"]')?.textContent).toContain("正在停止"));
  expect(container?.querySelector('[aria-label="导入结果"]')?.textContent).not.toContain("已停止");
  importStopState = "stopped";
  await vi.waitFor(() => expect(taskPanel.textContent).toContain("已停止"));
  expect(ipcCalls.filter((call) => call.command === "import_stop").length).toBeGreaterThanOrEqual(2);
  await vi.waitFor(() => expect(container?.querySelector('[aria-label="导入结果"]')?.textContent).toContain("已停止"));
  await dismissVisibleTransferReports();
});

test("停止终态确认失败在任务中心保留稳定错误码并允许重试", async () => {
  emitImportProgress = true;
  let finish!: (outcome: ImportOutcome) => void;
  importGate = new Promise<ImportOutcome>((resolve) => { finish = resolve; });
  importStopState = "stopping";
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true, cancelable: true })));
  await vi.waitFor(() => expect(ipcCalls.some((call) => call.command === "paste_import")).toBe(true));
  const transferTask = appTaskCenter.snapshot().at(-1);
  if (transferTask === undefined || transferTask.title !== "粘贴导入") throw new Error("停止失败回归缺少粘贴任务记录");
  const taskButton = document.querySelector<HTMLButtonElement>('[aria-label^="任务中心"]');
  if (taskButton === null) throw new Error("任务中心按钮不存在");
  await act(async () => taskButton.click());
  const taskPanel = document.querySelector<HTMLElement>('[data-ui="task-center"]');
  if (taskPanel === null) throw new Error("任务中心未打开");
  const taskItem = (): HTMLElement => {
    const item = taskPanel.querySelector<HTMLElement>(`[data-task-id="${transferTask.id}"]`);
    if (item === null) throw new Error("停止失败回归缺少粘贴任务项目");
    return item;
  };
  await act(async () => [...taskItem().querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "停止")?.click());
  importStopFailure = true;
  await act(async () => finish({ task_id: "backend-import-test", imported: 1, skipped_non_images: 0, duplicates: 0, pending_count: 1, failures: [] }));
  await vi.waitFor(() => expect(taskItem().textContent).toContain("transfer.task_not_active"));
  expect(taskItem().textContent).toContain("正在停止");
  importStopFailure = false;
  importStopState = "stopped";
  await act(async () => [...taskItem().querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "正在停止…")?.click());
  await vi.waitFor(() => expect(taskItem().textContent).toContain("已停止"));
  appTaskCenter.dismiss(transferTask.id);
  await dismissVisibleTransferReports();
});

test("单选提供复制与默认程序打开，多选只提供原图导出并进入任务中心", async () => {
  dialogExportDirectory = "E:\\导出";
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => card(H_STREET).click());
  await act(async () => namedButton("复制图像").click());
  await vi.waitFor(() => expect(ipcCalls.some((call) => call.command === "copy_asset_to_clipboard")).toBe(true));
  expect(document.body.textContent).toContain("已复制图片到剪贴板");
  await act(async () => namedButton("用默认程序打开").click());
  await vi.waitFor(() => expect(ipcCalls.some((call) => call.command === "open_with_default_app")).toBe(true));
  await act(async () => clickWithModifiers(H_NIGHT, { ctrl: true }));
  expect([...document.querySelectorAll<HTMLButtonElement>("button")].some((button) => button.getAttribute("aria-label") === "复制图像")).toBe(false);
  expect([...document.querySelectorAll<HTMLButtonElement>("button")].some((button) => button.getAttribute("aria-label") === "导出原图")).toBe(true);
  await act(async () => namedButton("导出原图").click());
  await vi.waitFor(() => expect(ipcCalls.some((call) => call.command === "plan_export")).toBe(true));
  await vi.waitFor(() => expect(ipcCalls.some((call) => call.command === "export_assets")).toBe(true));
  await act(async () => [...document.querySelectorAll("button")].find((button) => button.getAttribute("aria-label")?.startsWith("任务中心"))?.click());
  expect(document.body.textContent).toContain("导出图片");
});

test("导出部分失败在选择和素材库切换后仍保留完整逐项报告", async () => {
  dialogExportDirectory = "E:\\导出";
  exportGate = Promise.resolve({
    task_id: "task-export-partial",
    exported: ["晨光街道.png"],
    skipped_existing: 1,
    pending_count: 2,
    failed: [
      { hash: H_STREET, display_filename: "同名图片.png", error: { code: "export.copy_failed", detail: "磁盘只读" } },
      { hash: H_NIGHT, display_filename: "同名图片.png", error: { code: "export.copy_failed", detail: "文件被占用" } },
    ],
  });
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => card(H_STREET).click());
  await act(async () => namedButton("导出原图").click());
  const report = await vi.waitFor(() => {
    const element = container?.querySelector<HTMLElement>('[aria-label="导出结果"]');
    expect(element).not.toBeNull();
    return element!;
  });
  expect(report.textContent).toContain("成功 1");
  expect(report.textContent).toContain("跳过 1");
  expect(report.textContent).toContain("失败 2");
  expect(report.textContent).toContain("未处理 2");
  expect(report.textContent).toContain("同名冲突");
  expect(report.querySelectorAll("li")).toHaveLength(3);
  await rerenderWorkspace({ session: makeSession(LIB_B, "乙库"), active: true });
  await vi.waitFor(() => expect(container?.querySelector('[aria-label="导出结果"]')).toBeNull());
  await rerenderWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  const restored = await vi.waitFor(() => {
    const element = container?.querySelector<HTMLElement>('[aria-label="导出结果"]');
    expect(element?.textContent).toContain("export.copy_failed");
    return element!;
  });
  const close = restored.querySelector<HTMLButtonElement>('button[aria-label="关闭导出结果"]');
  if (close === null) throw new Error("导出异常报告缺少关闭入口");
  await act(async () => close.click());
  expect(container?.querySelector('[aria-label="导出结果"]')).toBeNull();
});

test("导出冲突先提供跳过/自动编号，覆盖必须二次确认，取消不写入目标目录", async () => {
  dialogExportDirectory = "E:\\导出";
  exportConflict = true;
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => card(H_STREET).click());
  await act(async () => namedButton("导出原图").click());
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain("导出文件冲突"));
  expect(ipcCalls.filter((call) => call.command === "export_assets")).toHaveLength(0);
  const conflict = document.querySelector<HTMLElement>('[role="dialog"]');
  if (conflict === null) throw new Error("冲突 Dialog 未打开");
  await act(async () => [...conflict.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "跳过冲突并导出")?.click());
  await vi.waitFor(() => expect(ipcCalls.filter((call) => call.command === "export_assets")).toHaveLength(1));
  await act(async () => namedButton("导出原图").click());
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')?.textContent).toContain("导出文件冲突"));
  const conflictAgain = document.querySelector<HTMLElement>('[role="dialog"]');
  if (conflictAgain === null) throw new Error("第二次冲突 Dialog 未打开");
  await act(async () => [...conflictAgain.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "覆盖并导出")?.click());
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("覆盖现有导出文件");
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find((button) => button.textContent === "取消")?.click());
  expect(ipcCalls.filter((call) => call.command === "export_assets")).toHaveLength(1);
  await act(async () => [...conflictAgain.querySelectorAll("button")].find((button) => button.textContent === "覆盖并导出")?.click());
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find((button) => button.textContent === "确认覆盖")?.click());
  await vi.waitFor(() => expect(ipcCalls.filter((call) => call.command === "export_assets")).toHaveLength(2));
  expect(record(ipcCalls.filter((call) => call.command === "export_assets").at(-1)?.payload).policy).toBe("overwrite");
});

test("导出冲突选择自动编号后才提交对应策略", async () => {
  dialogExportDirectory = "E:\\导出";
  exportConflict = true;
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => card(H_STREET).click());
  await act(async () => namedButton("导出原图").click());
  const conflict = document.querySelector<HTMLElement>('[role="dialog"]');
  if (conflict === null) throw new Error("冲突 Dialog 未打开");
  await act(async () => [...conflict.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "自动编号并导出")?.click());
  await vi.waitFor(() => expect(record(ipcCalls.filter((call) => call.command === "export_assets").at(-1)?.payload).policy).toBe("auto_number"));
});

test("复制和默认程序打开失败显示稳定错误，成功后提供轻量状态反馈", async () => {
  await mountWorkspace({ session: makeSession(LIB_A, "甲库"), active: true });
  await vi.waitFor(() => expect(card(H_STREET)).toBeDefined());
  await act(async () => card(H_STREET).click());
  outboundFailure = "copy";
  await act(async () => namedButton("复制图像").click());
  await vi.waitFor(() => expect(document.body.textContent).toContain("clipboard.write_failed"));
  outboundFailure = null;
  await act(async () => namedButton("复制图像").click());
  await vi.waitFor(() => expect(document.body.textContent).toContain("已复制图片到剪贴板"));
  outboundFailure = "open";
  await act(async () => namedButton("用默认程序打开").click());
  await vi.waitFor(() => expect(document.body.textContent).toContain("external.open_failed"));
  expect(document.body.textContent).not.toContain("已交给 Windows 默认程序打开");
});
