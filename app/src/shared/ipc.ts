/**
 * 前端与后端之间的唯一通道。
 *
 * 设计第一条要求 IPC 调用集中在 `src/shared`，不散落在组件里。理由是错误码到可读文案的
 * 映射只能有一处；一旦某个组件自己调 `invoke`，它就会自己处理失败，而"自己处理"通常
 * 意味着一句 `alert('失败')`，错误码随之丢失。
 *
 * 组件从本模块导入函数，**不导入 `@tauri-apps/api`**。
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import { asAppError, IpcError } from "./errors";
import type {
  AssetQuery,
  AssetRow,
  CatalogSnapshot,
  FolderMutationProgress,
  ImportOutcome,
  ImportProgress,
  LibraryStatus,
  PurgeReport,
  RestoreOutcome,
} from "./types";

/** 唯一的 `invoke` 出口。所有失败都在这里收敛成 `IpcError`。 */
async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (raw) {
    throw new IpcError(asAppError(raw));
  }
}

/** 当前库状态。`path` 为 null 表示需要使用者选择。 */
export function libraryStatus(): Promise<LibraryStatus> {
  return call<LibraryStatus>("library_status");
}

/**
 * 弹出目录选择对话框。使用者取消时返回 null。
 *
 * 规格要求库位置必须由使用者显式选择，禁止在默认路径静默创建——因此这里没有"默认位置"
 * 参数，也不预填任何路径。
 */
export async function pickLibraryDirectory(): Promise<string | null> {
  try {
    return await openDialog({ directory: true, multiple: false, title: "选择 Vistash 库位置" });
  } catch (raw) {
    throw new IpcError(asAppError(raw));
  }
}

/** 打开选中的目录；该目录还不是库时创建一个。 */
export function openLibrary(path: string): Promise<LibraryStatus> {
  return call<LibraryStatus>("open_library", { path });
}

/** 网格用的素材列表，不含回收站中的素材。 */
export function listAssets(): Promise<AssetRow[]> {
  return call<AssetRow[]>("list_assets");
}

export function catalogSnapshot(query: AssetQuery): Promise<CatalogSnapshot> {
  return call<CatalogSnapshot>("catalog_snapshot", { query });
}

export function createFolder(parent: string | null, name: string): Promise<string> {
  return call<string>("create_folder", { parent, name });
}

export function renameFolder(
  path: string,
  newName: string,
  onProgress: (progress: FolderMutationProgress) => void,
): Promise<string> {
  const progress = new Channel<FolderMutationProgress>(onProgress);
  return call<string>("rename_folder", { path, newName, onProgress: progress });
}

export function deleteFolder(path: string): Promise<void> {
  return call<void>("delete_folder", { path });
}

export function setAssetFolders(hash: string, folders: string[]): Promise<void> {
  return call<void>("set_asset_folders", { hash, folders });
}

export function setAssetTags(hash: string, tags: string[]): Promise<void> {
  return call<void>("set_asset_tags", { hash, tags });
}

export function deleteAsset(hash: string): Promise<void> {
  return call<void>("delete_asset", { hash });
}

export function restoreAsset(hash: string): Promise<RestoreOutcome> {
  return call<RestoreOutcome>("restore_asset", { hash });
}

export function purgeTrash(): Promise<PurgeReport> {
  return call<PurgeReport>("purge_trash");
}

/** 导入给定的文件或目录路径，并把单次任务的进度交给调用方。 */
export function importPaths(
  paths: string[],
  onProgress: (progress: ImportProgress) => void,
): Promise<ImportOutcome> {
  const progress = new Channel<ImportProgress>(onProgress);
  return call<ImportOutcome>("import_paths", { paths, onProgress: progress });
}

/**
 * 后端返回的原始字节包成 blob: URL。
 *
 * 走字节而不是 base64：base64 会把体积放大三分之一，而网格一次要取上百张缩略图。
 * CSP 已允许 `blob:` 作为图片来源。
 *
 * **这里不做任何像素处理。**规格禁止界面层用 `Canvas`、`OffscreenCanvas` 或 `ImageData`
 * 读取像素做缩放、采样或聚类——本函数只是把后端已经生成好的字节交给 `<img>` 渲染。
 */
function toObjectUrl(bytes: ArrayBuffer, mime: string): string {
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

/** 素材缩略图的 blob: URL。缺失时后端会按需重新生成。 */
export async function loadThumbnail(hash: string): Promise<string> {
  const bytes = await call<ArrayBuffer>("asset_thumbnail", { hash });
  // 缩略图一律是 WebP，与素材本体的格式无关。
  return toObjectUrl(bytes, "image/webp");
}

/**
 * 素材原图的 blob: URL。
 *
 * 不传扩展名：库内路径由 `<hash>.<ext>` 拼成，扩展名一旦是前端入参，带 `..` 的值就能把
 * 读取指到库外。后端从索引取扩展名，前端对库布局没有话语权。
 *
 * MIME 交给浏览器嗅探。`<img>` 按内容判定格式，因此这里不需要（也不该）自己猜。
 */
export async function loadOriginal(hash: string): Promise<string> {
  const bytes = await call<ArrayBuffer>("asset_original", { hash });
  return toObjectUrl(bytes, "");
}

/**
 * 释放 blob: URL。
 *
 * 必须显式释放：blob: URL 会把整份字节钉在内存里直到文档卸载，而网格滚动会不断新建。
 */
export function releaseImageUrl(url: string): void {
  URL.revokeObjectURL(url);
}

/** 监听拖入窗口的文件与目录。返回取消监听的函数。 */
export async function onPathsDropped(
  handler: (paths: string[]) => void,
): Promise<() => void> {
  const unlisten = await getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type === "drop") {
      handler(event.payload.paths);
    }
  });
  return unlisten;
}
