import { useState, type ReactNode } from "react";
import { mockIPC } from "@tauri-apps/api/mocks";
import { parseAssetId, parseLibraryId } from "../../app/common";
import { AssetLibraryWorkspace, type AssetLibraryEntry } from "../../modules/asset-library";
import type { AssetRow, PromptRow } from "../../shared/types";
import { Button } from "../../ui/button/Button";
import testImageUrl from "../../../src-tauri/icons/128x128.png?url";
import styles from "./AssetLibraryShowcase.module.css";

const LIBRARIES = [
  { id: parseLibraryId("018f3c9e-6c00-7000-8000-0000000000aa"), displayName: "图片会话 · 甲库" },
  { id: parseLibraryId("018f3c9e-6c00-7000-8000-0000000000bb"), displayName: "图片会话 · 乙库" },
] as const;
let currentLibrary = LIBRARIES[0].id;
let rejectWrite = false;
let failBatch = false;
const thumbnailResponse = await fetch(testImageUrl);
if (!thumbnailResponse.ok) throw new Error("无法读取展台品牌测试图");
const thumbnail = await thumbnailResponse.arrayBuffer();
const foldersByLibrary = new Map(LIBRARIES.map((library) => [library.id, ["参考", "参考/构图", "配色"]]));
const assetsByLibrary = new Map(LIBRARIES.map((library, libraryIndex) => [library.id, Array.from({ length: 1000 }, (_, index): AssetRow => ({
  hash: index.toString(16).padStart(64, "0"), hash_algo: "blake3", media_type: "image/png", ext: "png",
  byte_size: thumbnail.byteLength, width: 128, height: 128, imported_at: "2026-08-27T00:00:00Z",
  original_filename: `fixture-${index}.png`, display_filename: `${libraryIndex === 0 ? "甲" : "乙"}库测试图-${index}.png`,
  source_path: null, folder: null, deleted_at: null, color_card_status: "ok", color_card_algo_version: 1,
  color_card_failure_reason: null, color_card_sampled_pixel_count: 1, note: "开发专用品牌测试图", favorite: false, tags: [], colors: [{ hex: "#E8664A", oklab_l: .6, oklab_a: .2, oklab_b: .1, share: .8, role: "dominant" }, { hex: "#171919", oklab_l: .2, oklab_a: 0, oklab_b: 0, share: .2, role: "neutral" }],
}))]));
const promptsByLibrary = new Map(LIBRARIES.map((library) => [library.id, ["光影参考", "归档提示词"].map((title, index): PromptRow => ({
  id: `fixture-prompt-${index}`, title, body: "开发专用普通提示词，不执行图像反推。", model: null, parameters: null, note: "", favorite: false, folders: [], tags: [], linked_image_hashes: index === 1 ? ["0".repeat(64)] : [], cover_image_hash: null, resolved_cover_hash: null, created_at: "2026-08-28T00:00:00Z", updated_at: "2026-08-28T00:00:00Z", deleted_at: index === 1 ? "2026-08-28T00:00:00Z" : null,
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

/** 只安装在开发展台；生产入口不会加载此模块，也不会访问真实库。 */
mockIPC((command, payload) => {
  const request = record(payload);
  switch (command) {
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
      return { assets: rows.filter((asset) =>
        (query.location === "trash" ? asset.deleted_at !== null : asset.deleted_at === null) &&
        (query.location === "trash" || folder.kind === "all" || (folder.kind === "root" ? asset.folder === null : asset.folder === folder.path)) &&
        (query.favorite === null || asset.favorite === query.favorite) &&
        `${asset.display_filename} ${asset.original_filename}`.toLocaleLowerCase().includes(text)), folders, tags: [], trash_count: rows.filter((asset) => asset.deleted_at !== null).length };
    }
    case "asset_thumbnail": return thumbnail.slice(0);
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
    case "batch_delete_assets": {
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
        if (command === "batch_delete_assets") row.deleted_at = "2026-08-28T00:00:00Z";
        else if (command === "batch_move_assets_to_folder") {
          if (request.folder !== null && typeof request.folder !== "string") throw new TypeError("移动目标非法");
          row.folder = request.folder;
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
    default: throw new Error(`展台未实现 IPC：${command}`);
  }
});

export function AssetLibraryShowcase(): ReactNode {
  const [libraryIndex, setLibraryIndex] = useState<0 | 1>(0);
  const [entry, setEntry] = useState<AssetLibraryEntry>({ kind: "resume" });
  const [writeFailure, setWriteFailure] = useState(false);
  const [batchFailure, setBatchFailure] = useState(false);
  return <main className={styles.page}>
    <div className={styles.controls} aria-label="开发验收控制">
      <span>图片模块验收 · 品牌测试图 · 非完整工作区</span>
      <Button size="compact" onClick={() => {
        const index = libraryIndex === 0 ? 1 : 0;
        currentLibrary = LIBRARIES[index].id;
        setLibraryIndex(index);
        setEntry({ kind: "resume" });
      }}>切换测试库</Button>
      <Button size="compact" onClick={() => setEntry({ kind: "locate", requestId: crypto.randomUUID(), hash: parseAssetId((80).toString(16).padStart(64, "0")), location: "active" })}>定位第 81 项</Button>
      <Button size="compact" aria-pressed={writeFailure} onClick={() => { rejectWrite = !writeFailure; setWriteFailure(!writeFailure); }}>模拟保存失败</Button>
      <Button size="compact" aria-pressed={batchFailure} onClick={() => { failBatch = !batchFailure; setBatchFailure(!batchFailure); }}>模拟部分失败</Button>
    </div>
    <div className={styles.workspace}><AssetLibraryWorkspace session={LIBRARIES[libraryIndex]} active entry={entry} /></div>
  </main>;
}
