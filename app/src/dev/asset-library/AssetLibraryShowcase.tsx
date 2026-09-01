import { useState, type ReactNode } from "react";
import { mockIPC } from "@tauri-apps/api/mocks";
import { createRequestId, parseAssetId, parseLibraryId } from "../../app/common";
import { createWorkspaceNavigation } from "../../app/navigation";
import { createImagePromptRelations, createTauriImagePromptRelationAdapter } from "../../modules/image-prompt-relations";
import { appTaskCenter } from "../../app/runtime";
import { canStopTransferTask, stopAssetTransferTask } from "../../modules/asset-library";
import { TaskCenterPopover } from "../../app/shell/TaskCenterPopover";
import { ImportMenu } from "../../app/shell/ImportMenu";
import { AssetLibraryWorkspace, type AssetImportRequest, type AssetLibraryEntry } from "../../modules/asset-library";
import type { AssetRow, PromptRow } from "../../shared/types";
import { Button } from "../../ui/button/Button";
import testImageUrl from "../../../src-tauri/icons/128x128.png?url";
import testOriginalUrl from "../../../src-tauri/icons/1024x1024.png?url";
import styles from "./AssetLibraryShowcase.module.css";

const LIBRARIES = [
  { id: parseLibraryId("018f3c9e-6c00-7000-8000-0000000000aa"), displayName: "图片会话 · 甲库" },
  { id: parseLibraryId("018f3c9e-6c00-7000-8000-0000000000bb"), displayName: "图片会话 · 乙库" },
] as const;
const showcaseRelations = createImagePromptRelations({ adapter: createTauriImagePromptRelationAdapter(), navigation: createWorkspaceNavigation() });
let currentLibrary = LIBRARIES[0].id;
let rejectWrite = false;
let failBatch = false;
let rejectOriginal = false;
let exportConflict = false;
const [thumbnailResponse, originalResponse] = await Promise.all([fetch(testImageUrl), fetch(testOriginalUrl)]);
if (!thumbnailResponse.ok) throw new Error("无法读取展台品牌测试图");
if (!originalResponse.ok) throw new Error("无法读取展台原图");
const [thumbnail, original] = await Promise.all([thumbnailResponse.arrayBuffer(), originalResponse.arrayBuffer()]);
const foldersByLibrary = new Map(LIBRARIES.map((library) => [library.id, ["参考", "参考/构图", "配色"]]));
const deletedFoldersByLibrary = new Map(LIBRARIES.map((library) => [library.id, new Map<string, string | null>()]));
const assetsByLibrary = new Map(LIBRARIES.map((library, libraryIndex) => [library.id, Array.from({ length: 1000 }, (_, index): AssetRow => ({
  hash: index.toString(16).padStart(64, "0"), hash_algo: "blake3", media_type: "image/png", ext: "png",
  byte_size: original.byteLength, width: 1024, height: 1024, imported_at: "2026-08-27T00:00:00Z",
  original_filename: `fixture-${index}.png`, display_filename: `${libraryIndex === 0 ? "甲" : "乙"}库测试图-${index}.png`,
  source_path: null, folder: null, deleted_at: null, color_card_status: "ok", color_card_algo_version: 1,
  color_card_failure_reason: null, color_card_sampled_pixel_count: 1, note: "品牌演示测试图", favorite: false, tags: [], colors: [{ hex: "#E8664A", oklab_l: .6, oklab_a: .2, oklab_b: .1, share: .8, role: "dominant" }, { hex: "#171919", oklab_l: .2, oklab_a: 0, oklab_b: 0, share: .2, role: "neutral" }],
}))]));
const promptsByLibrary = new Map(LIBRARIES.map((library) => [library.id, ["光影参考", "归档提示词"].map((title, index): PromptRow => ({
  id: `fixture-prompt-${index}`, title, body: "演示用普通提示词，不执行图像反推。", model: null, parameters: null, note: "", favorite: false, folders: [], tags: [], linked_image_hashes: index === 1 ? ["0".repeat(64)] : [], cover_image_hash: null, resolved_cover_hash: null, created_at: "2026-08-28T00:00:00Z", updated_at: "2026-08-28T00:00:00Z", deleted_at: index === 1 ? "2026-08-28T00:00:00Z" : null,
}))]));

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError("展台 IPC 载荷必须为对象");
  return value;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function folderName(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("文件夹名称不是字符串");
  const name = value.trim();
  if (name.length === 0 || name === "." || name === ".." || name.includes("/") || /\p{Cc}/u.test(name)) throw { code: "library.folder_invalid", detail: "文件夹名称无效" };
  return name;
}

/** 只安装在演示入口；生产入口不会加载此模块，也不会访问真实库。 */
mockIPC((command, payload) => {
  const request = record(payload);
  switch (command) {
    case "plugin:dialog|open": {
      const options = record(request.options);
      if (options.title === "选择图片导出目录") return "E:\\Vistash\\导出演示";
      if (options.directory === true) return "E:\\Vistash\\导入演示";
      return ["E:\\Vistash\\demo-01.png", "E:\\Vistash\\demo-02.jpg"];
    }
    case "read_layout": {
      if (typeof request.libraryId !== "string") throw new TypeError("布局请求缺少库身份");
      const saved = localStorage.getItem(`vistash.dev.asset-session:${request.libraryId}`);
      return saved === null ? null : JSON.parse(saved);
    }
    case "write_layout":
      if (rejectWrite) throw { code: "library.io_failed", detail: "展台模拟只读磁盘" };
      if (typeof request.libraryId !== "string") throw new TypeError("布局请求缺少库身份");
      localStorage.setItem(`vistash.dev.asset-session:${request.libraryId}`, JSON.stringify(request.layout));
      return undefined;
    case "catalog_snapshot": {
      const query = record(request.query);
      if (typeof query.text !== "string") throw new TypeError("集合请求缺少查询文本");
      const rows = assetsByLibrary.get(currentLibrary);
      const folders = foldersByLibrary.get(currentLibrary);
      if (rows === undefined || folders === undefined) throw new Error("展台库不存在");
      const text = query.text.toLocaleLowerCase();
      const folder = record(query.folder);
      const queryTags = query.tags;
      if (!Array.isArray(queryTags) || !queryTags.every((tag): tag is string => typeof tag === "string")) throw new TypeError("标签查询非法");
      const tagCounts = new Map<string, number>();
      for (const row of rows) if (row.deleted_at === null) for (const tag of row.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      return { assets: rows.filter((asset) =>
        (query.location === "trash" ? asset.deleted_at !== null : asset.deleted_at === null) &&
        (query.location === "trash" || folder.kind === "all" || (folder.kind === "root" ? asset.folder === null : asset.folder === folder.path)) &&
        (query.favorite === null || asset.favorite === query.favorite) &&
        queryTags.every((tag) => asset.tags.includes(tag)) &&
        `${asset.display_filename} ${asset.original_filename}`.toLocaleLowerCase().includes(text)), folders, tags: [...tagCounts].map(([tag, count]) => ({ tag, count })), trash_count: rows.filter((asset) => asset.deleted_at !== null).length };
    }
    case "asset_thumbnail": return thumbnail.slice(0);
    case "import_sources":
    case "paste_import": return { task_id: "dev-import-task", imported: 2, skipped_non_images: 1, duplicates: 0, pending_count: 0, failures: [] };
    case "import_stop": return { task_id: request.taskId, state: "stopped" };
    case "plan_export": {
      const hashes = request.hashes;
      if (!Array.isArray(hashes) || !hashes.every((hash): hash is string => typeof hash === "string")) throw new TypeError("导出规划哈希无效");
      const rows = assetsByLibrary.get(currentLibrary);
      if (rows === undefined) throw new Error("展台库不存在");
      return hashes.map((hash) => {
        const row = rows.find((asset) => asset.hash === hash);
        if (row === undefined) throw new Error("导出目标不存在");
        return { hash, display_filename: row.display_filename, existing: exportConflict };
      });
    }
    case "export_assets": {
      const hashes = request.hashes;
      if (!Array.isArray(hashes) || !hashes.every((hash): hash is string => typeof hash === "string")) throw new TypeError("导出哈希无效");
      const rows = assetsByLibrary.get(currentLibrary);
      if (rows === undefined || (request.policy !== "skip" && request.policy !== "overwrite" && request.policy !== "auto_number")) throw new TypeError("导出请求无效");
      const names = hashes.map((hash) => {
        const row = rows.find((asset) => asset.hash === hash);
        if (row === undefined) throw new Error("导出目标不存在");
        return row.display_filename;
      });
      return { task_id: "dev-export-task", exported: request.policy === "skip" && exportConflict ? [] : names, skipped_existing: request.policy === "skip" && exportConflict ? names.length : 0, failed: [], pending_count: 0 };
    }
    case "copy_asset_to_clipboard":
    case "open_with_default_app": return undefined;
    case "asset_original": {
      if (rejectOriginal) throw { code: "library.io_failed", detail: "展台模拟原图读取失败" };
      return original.slice(0);
    }
    case "image_detail": {
      const rows = assetsByLibrary.get(currentLibrary);
      const prompts = promptsByLibrary.get(currentLibrary);
      const asset = rows?.find((row) => row.hash === request.hash);
      if (asset === undefined || prompts === undefined) throw new Error("详情目标不存在");
      return { asset, linked_prompts: prompts.filter((prompt) => prompt.linked_image_hashes.includes(asset.hash)) };
    }
    case "prompt_snapshot": {
      const prompts = promptsByLibrary.get(currentLibrary);
      const query = record(request.query);
      if (prompts === undefined || typeof query.text !== "string") throw new Error("提示词查询无效");
      const text = query.text.toLowerCase();
      return { prompts: prompts.filter((prompt) => prompt.deleted_at === null && `${prompt.title} ${prompt.body}`.toLowerCase().includes(text)), folders: [], tags: [], trash_count: 1 };
    }
    case "create_prompt": {
      const draft = record(request.prompt);
      if (typeof draft.body !== "string" || draft.body.trim().length === 0) throw new TypeError("展台创建提示词缺少正文");
      const prompts = promptsByLibrary.get(currentLibrary);
      if (prompts === undefined) throw new Error("展台提示词库不存在");
      const created: PromptRow = {
        id: crypto.randomUUID(), body: draft.body,
        title: typeof draft.title === "string" ? draft.title : null,
        model: typeof draft.model === "string" ? draft.model : null,
        parameters: typeof draft.parameters === "string" ? draft.parameters : null,
        note: "", favorite: false, folders: [], tags: [], linked_image_hashes: [], cover_image_hash: null, resolved_cover_hash: null,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(), deleted_at: null,
      };
      prompts.push(created);
      return { ...created, format_version: 1, deleted_from_folders: null };
    }
    case "link_images":
    case "unlink_image": {
      if (rejectWrite) throw { code: "library.io_failed", detail: "展台模拟关联写入失败" };
      const prompts = promptsByLibrary.get(currentLibrary);
      const prompt = prompts?.find((row) => row.id === request.promptId);
      if (prompt === undefined) throw new Error("关联目标不存在");
      if (command === "link_images") {
        const hashes = request.hashes;
        if (!Array.isArray(hashes) || !hashes.every((hash): hash is string => typeof hash === "string")) throw new TypeError("关联哈希无效");
        prompt.linked_image_hashes = [...new Set([...prompt.linked_image_hashes, ...hashes])];
      } else prompt.linked_image_hashes = prompt.linked_image_hashes.filter((hash) => hash !== request.hash);
      return undefined;
    }
    case "set_asset_note":
    case "set_asset_tags":
    case "move_asset_to_folder": {
      if (rejectWrite) throw { code: "library.asset_metadata_write_failed", detail: "展台模拟只读元数据" };
      const row = assetsByLibrary.get(currentLibrary)?.find((asset) => asset.hash === request.hash);
      if (row === undefined) throw new Error("编辑图片不存在");
      if (command === "set_asset_note") {
        if (typeof request.note !== "string") throw new TypeError("备注无效");
        row.note = request.note;
      } else if (command === "set_asset_tags") {
        const tags = request.tags;
        if (!Array.isArray(tags) || !tags.every((tag): tag is string => typeof tag === "string")) throw new TypeError("标签无效");
        if (tags.some((tag) => tag.trim().length === 0 || /\p{Cc}/u.test(tag))) throw { code: "library.tag_invalid", detail: "标签不可为空或包含控制字符" };
        row.tags = [...new Set(tags.map((tag) => tag.trim()))];
      } else {
        if (request.folder !== null && typeof request.folder !== "string") throw new TypeError("文件夹无效");
        row.folder = request.folder;
      }
      return undefined;
    }
    case "set_asset_favorite": {
      const rows = assetsByLibrary.get(currentLibrary);
      if (rows === undefined || typeof request.favorite !== "boolean") throw new TypeError("收藏请求非法");
      const row = rows.find((asset) => asset.hash === request.hash);
      if (row === undefined) throw new Error("收藏目标不存在");
      row.favorite = request.favorite;
      return undefined;
    }
    case "rename_asset_display_filename": {
      const rows = assetsByLibrary.get(currentLibrary);
      if (rows === undefined || typeof request.stem !== "string") throw new TypeError("重命名请求非法");
      const row = rows.find((asset) => asset.hash === request.hash);
      if (row === undefined) throw new Error("重命名目标不存在");
      const stem = request.stem.trim();
      if (stem.length === 0 || /[<>:"/\\|?*\p{Cc}]/u.test(stem) || /\.(png|jpe?g|webp|gif|bmp)$/i.test(stem)) throw { code: "library.filename_invalid", detail: "请只输入合法名称主体" };
      if (rejectWrite) throw { code: "library.asset_metadata_write_failed", detail: "展台模拟只读元数据" };
      row.display_filename = `${stem}.${row.ext}`;
      return undefined;
    }
    case "batch_set_asset_favorite":
    case "batch_move_assets_to_folder":
    case "batch_add_asset_tag":
    case "batch_remove_asset_tag":
    case "batch_link_to_prompt":
    case "batch_delete_assets": {
      if (rejectWrite && (command === "batch_add_asset_tag" || command === "batch_remove_asset_tag" || command === "batch_link_to_prompt")) throw { code: "library.io_failed", detail: "展台模拟批量写入失败" };
      const rows = assetsByLibrary.get(currentLibrary);
      if (rows === undefined || !Array.isArray(request.hashes) || !request.hashes.every((hash): hash is string => typeof hash === "string")) throw new TypeError("批量请求非法");
      const targets = new Set(request.hashes);
      const failures = [];
      let succeeded = 0;
      for (const row of rows.filter((asset) => targets.has(asset.hash))) {
        if (failBatch && failures.length === 0) {
          failures.push({ id: row.hash, display_name: row.display_filename, error: { code: "library.io_failed", detail: "展台模拟只读素材" } });
          continue;
        }
        if (command === "batch_delete_assets") {
          const deletedFolders = deletedFoldersByLibrary.get(currentLibrary);
          if (deletedFolders === undefined) throw new Error("缺少删除记录");
          deletedFolders.set(row.hash, row.folder);
          row.folder = null;
          row.deleted_at = "2026-08-28T00:00:00Z";
        }
        else if (command === "batch_move_assets_to_folder") {
          if (request.folder !== null && typeof request.folder !== "string") throw new TypeError("移动目标非法");
          row.folder = request.folder;
        }
        else if (command === "batch_add_asset_tag" || command === "batch_remove_asset_tag") {
          if (typeof request.tag !== "string") throw new TypeError("批量标签非法");
          const tag = request.tag.trim();
          if (tag.length === 0 || /\p{Cc}/u.test(tag)) throw { code: "library.tag_invalid", detail: "标签不可为空或包含控制字符" };
          row.tags = command === "batch_add_asset_tag" ? [...new Set([...row.tags, tag])] : row.tags.filter((value) => value !== tag);
        }
        else if (command === "batch_link_to_prompt") {
          const prompt = promptsByLibrary.get(currentLibrary)?.find((item) => item.id === request.promptId && item.deleted_at === null);
          if (prompt === undefined) throw new Error("批量关联目标不存在");
          prompt.linked_image_hashes = [...new Set([...prompt.linked_image_hashes, row.hash])];
        }
        else {
          if (typeof request.favorite !== "boolean") throw new TypeError("收藏值非法");
          row.favorite = request.favorite;
        }
        succeeded += 1;
      }
      return { succeeded, failures };
    }
    case "create_folder":
    case "rename_folder":
    case "delete_folder": {
      if (rejectWrite) throw { code: "library.io_failed", detail: "展台模拟只读磁盘" };
      const folders = foldersByLibrary.get(currentLibrary);
      const rows = assetsByLibrary.get(currentLibrary);
      if (folders === undefined || rows === undefined) throw new Error("展台库不存在");
      if (command === "create_folder") {
        const name = folderName(request.name);
        if (request.parent !== null && typeof request.parent !== "string") throw new TypeError("父文件夹非法");
        if (request.parent !== null && !folders.includes(request.parent)) throw { code: "library.folder_not_found", detail: request.parent };
        const path = request.parent === null ? name : `${request.parent}/${name}`;
        if (folders.includes(path)) throw { code: "library.folder_exists", detail: path };
        folders.push(path);
        return path;
      }
      const path = request.path;
      if (typeof path !== "string") throw new TypeError("文件夹路径非法");
      if (!folders.includes(path)) throw { code: "library.folder_not_found", detail: path };
      const matches = (value: string): boolean => value === path || value.startsWith(`${path}/`);
      if (command === "delete_folder") {
        foldersByLibrary.set(currentLibrary, folders.filter((folder) => !matches(folder)));
        for (const row of rows) if (row.folder !== null && matches(row.folder)) row.folder = null;
        return undefined;
      }
      const renamed = path.slice(0, path.lastIndexOf("/") + 1) + folderName(request.newName);
      if (renamed !== path && folders.includes(renamed)) throw { code: "library.folder_exists", detail: renamed };
      foldersByLibrary.set(currentLibrary, folders.map((folder) => matches(folder) ? renamed + folder.slice(path.length) : folder));
      for (const row of rows) if (row.folder !== null && matches(row.folder)) row.folder = renamed + row.folder.slice(path.length);
      return renamed;
    }
    case "restore_asset": {
      const row = assetsByLibrary.get(currentLibrary)?.find((asset) => asset.hash === request.hash && asset.deleted_at !== null);
      const folders = foldersByLibrary.get(currentLibrary);
      const deletedFolders = deletedFoldersByLibrary.get(currentLibrary);
      if (row === undefined || folders === undefined || deletedFolders === undefined) throw new Error("还原目标不存在");
      if (rejectWrite || (failBatch && row.hash === "0".repeat(64))) throw { code: "trash.restore_failed", detail: "展台模拟还原写入失败" };
      const previous = deletedFolders.get(row.hash);
      if (previous === undefined) throw new Error("缺少删除前归属");
      const missing = previous !== null && !folders.includes(previous);
      row.folder = missing ? null : previous;
      row.deleted_at = null;
      deletedFolders.delete(row.hash);
      return { missing_folders: missing ? [previous] : [] };
    }
    case "purge_trash": {
      if (rejectWrite) throw { code: "trash.purge_failed", detail: "展台模拟清空写入失败" };
      const rows = assetsByLibrary.get(currentLibrary);
      const prompts = promptsByLibrary.get(currentLibrary);
      const deletedFolders = deletedFoldersByLibrary.get(currentLibrary);
      if (rows === undefined || prompts === undefined || deletedFolders === undefined) throw new Error("清空目标库不存在");
      const purged = new Set<string>();
      const failures = [];
      for (const row of rows) {
        if (row.deleted_at === null) continue;
        if (failBatch && failures.length === 0) { failures.push({ hash: row.hash, original_filename: row.original_filename, error: { code: "trash.purge_failed", detail: "展台模拟原图被占用" } }); continue; }
        purged.add(row.hash);
        deletedFolders.delete(row.hash);
      }
      assetsByLibrary.set(currentLibrary, rows.filter((row) => !purged.has(row.hash)));
      for (const prompt of prompts) prompt.linked_image_hashes = prompt.linked_image_hashes.filter((hash) => !purged.has(hash));
      return { purged: purged.size, failures };
    }
    default: throw new Error(`展台未实现 IPC：${command}`);
  }
});

export function AssetLibraryShowcase(): ReactNode {
  const [libraryIndex, setLibraryIndex] = useState<0 | 1>(0);
  const [entry, setEntry] = useState<AssetLibraryEntry>({ kind: "resume" });
  const [importRequest, setImportRequest] = useState<AssetImportRequest | undefined>();
  const [writeFailure, setWriteFailure] = useState(false);
  const [batchFailure, setBatchFailure] = useState(false);
  const [originalFailure, setOriginalFailure] = useState(false);
  const [exportConflictState, setExportConflict] = useState(false);
  return <main className={styles.page}>
    <div className={styles.controls} aria-label="演示控制">
      <span>图片模块演示 · 品牌测试图 · 非完整工作区</span>
      <Button size="compact" onClick={() => {
        const index = libraryIndex === 0 ? 1 : 0;
        currentLibrary = LIBRARIES[index].id;
        setLibraryIndex(index);
        setEntry({ kind: "resume" });
      }}>切换测试库</Button>
      <Button size="compact" onClick={() => setEntry({ kind: "locate", requestId: crypto.randomUUID(), hash: parseAssetId((80).toString(16).padStart(64, "0")), location: "active" })}>定位第 81 项</Button>
      <Button size="compact" aria-pressed={writeFailure} onClick={() => { rejectWrite = !writeFailure; setWriteFailure(!writeFailure); }}>模拟保存失败</Button>
      <Button size="compact" aria-pressed={batchFailure} onClick={() => { failBatch = !batchFailure; setBatchFailure(!batchFailure); }}>模拟部分失败</Button>
      <Button size="compact" aria-pressed={originalFailure} onClick={() => { rejectOriginal = !originalFailure; setOriginalFailure(!originalFailure); }}>模拟原图失败</Button>
      <Button size="compact" aria-pressed={exportConflictState} onClick={() => { exportConflict = !exportConflictState; setExportConflict(!exportConflictState); }}>模拟导出冲突</Button>
      <ImportMenu onImportImages={() => setImportRequest({ requestId: createRequestId(), kind: "images" })} onImportFolder={() => setImportRequest({ requestId: createRequestId(), kind: "folder" })} />
      <TaskCenterPopover taskCenter={appTaskCenter} onStopTask={stopAssetTransferTask} canStopTask={canStopTransferTask} />
    </div>
    <div className={styles.workspace}><AssetLibraryWorkspace session={LIBRARIES[libraryIndex]} relations={showcaseRelations} active entry={entry} {...(importRequest === undefined ? {} : { importRequest })} onImportRequestHandled={(requestId) => setImportRequest((current) => current?.requestId === requestId ? undefined : current)} /></div>
  </main>;
}
