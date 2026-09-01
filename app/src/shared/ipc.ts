/**
 * 前端与后端之间的唯一通道。
 *
 * IPC 调用集中在 `src/shared`，不散落在组件里。理由是错误码到可读文案的
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
  BatchProgress,
  BatchReport,
  CatalogSnapshot,
  ConflictPolicy,
  ExportOutcome,
  FolderMutationProgress,
  GlobalSearchResult,
  ImageDetail,
  ImportAndLinkReport,
  ImportOutcome,
  TransferProgress,
  TransferRunStatus,
  LibraryStatus,
  LinkedImageState,
  MigrationProgress,
  NewPromptInput,
  PromptAsset,
  PromptEditInput,
  PromptPurgeReport,
  PromptQuery,
  PromptRestoreOutcome,
  PromptSnapshot,
  PlannedExport,
  PurgeReport,
  RestoreOutcome,
  V3FolderResolutionInput,
  V3MigrationPlan,
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
 * 库位置必须由使用者显式选择，禁止在默认路径静默创建——因此这里没有"默认位置"
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

/**
 * 弹出多选图片文件对话框；取消时返回空数组。
 *
 * 扩展名清单与核心导入层支持的格式一致——对话框放行的类型后端不会再拒第二遍，
 * 两份清单必须同步修改。
 */
export async function pickImageFiles(): Promise<string[]> {
  try {
    const picked = await openDialog({
      multiple: true,
      title: "选择要导入并关联的图片",
      filters: [
        { name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] },
      ],
    });
    return picked ?? [];
  } catch (raw) {
    throw new IpcError(asAppError(raw));
  }
}

/** 选择要导入的目录；取消时返回 null，不复用库位置选择器的语义。 */
export async function pickImportDirectory(): Promise<string | null> {
  try {
    return await openDialog({ directory: true, multiple: false, title: "选择要导入的图片文件夹" });
  } catch (raw) {
    throw new IpcError(asAppError(raw));
  }
}

/** 选择导出目标目录；取消时返回 null，不能复用库或导入目录选择语义。 */
export async function pickExportDirectory(): Promise<string | null> {
  try {
    return await openDialog({ directory: true, multiple: false, title: "选择图片导出目录" });
  } catch (raw) {
    throw new IpcError(asAppError(raw));
  }
}

/** 对旧版本格式的库执行一次性迁移，成功后该库成为当前库。 */
export function migrateLibrary(
  path: string,
  onProgress: (progress: MigrationProgress) => void,
): Promise<LibraryStatus> {
  const progress = new Channel<MigrationProgress>(onProgress);
  return call<LibraryStatus>("migrate_library", { path, onProgress: progress });
}

/** 为 v2 库生成只读的 v3 迁移计划；计划阶段不修改任何权威文件。 */
export function planV3Migration(path: string): Promise<V3MigrationPlan> {
  return call<V3MigrationPlan>("plan_v3_migration", { path });
}

/** 提交已完成全部冲突选择的 v3 迁移，成功后该库成为当前兼容库。 */
export function commitV3Migration(
  path: string,
  resolutions: V3FolderResolutionInput[],
  onProgress: (progress: MigrationProgress) => void,
): Promise<LibraryStatus> {
  const progress = new Channel<MigrationProgress>(onProgress);
  return call<LibraryStatus>("commit_v3_migration", {
    path,
    resolutions,
    onProgress: progress,
  });
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

/** 把完整逻辑文件夹子树移动到目标父节点；null 表示移动到库根位置。 */
export function moveFolder(
  path: string,
  destinationParent: string | null,
  onProgress: (progress: FolderMutationProgress) => void,
): Promise<string> {
  const progress = new Channel<FolderMutationProgress>(onProgress);
  return call<string>("move_folder", { path, destinationParent, onProgress: progress });
}

export function deleteFolder(path: string): Promise<void> {
  return call<void>("delete_folder", { path });
}

/** 把素材移动到唯一目标文件夹；`folder` 为 null 表示移回未分类。 */
export function moveAssetToFolder(hash: string, folder: string | null): Promise<void> {
  return call<void>("move_asset_to_folder", { hash, folder });
}

export function renameAssetDisplayFilename(hash: string, stem: string): Promise<void> {
  return call<void>("rename_asset_display_filename", { hash, stem });
}

export function setAssetTags(hash: string, tags: string[]): Promise<void> {
  return call<void>("set_asset_tags", { hash, tags });
}

/** 从库内权威原图重新生成色卡；像素始终留在 Rust 侧。 */
export function regenerateColorCard(hash: string): Promise<void> {
  return call<void>("regenerate_color_card", { hash });
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

/**
 * 统一导入入口：按钮、拖放与目录选择都走这一条命令。
 *
 * 文件与目录路径混排即可——后端按磁盘事实分类来源，目录以所选名称为逻辑根保留
 * 相对层级。`currentFolder` 是工作区当前所在的具体逻辑文件夹；null 表示当前在
 * 全部、未分类或回收站位置，导入一律落入未分类。
 */
export function importSources(
  paths: string[],
  currentFolder: string | null,
  onProgress: (progress: TransferProgress) => void,
): Promise<ImportOutcome> {
  const progress = new Channel<TransferProgress>(onProgress);
  return call<ImportOutcome>("import_sources", {
    paths,
    currentFolder,
    onProgress: progress,
  });
}

/**
 * 窗口级 Ctrl+V 的统一入口。
 *
 * 前端只负责"这个按键该不该由图片工作区认领"；剪贴板上有什么、按
 * 文件 > 位图 > 文本 > 空的顺序如何分流，全部在后端裁决。WebView 没有
 * 任何通用剪贴板权限，位图像素从系统剪贴板到库内本体全程不经过前端。
 * 剪贴板里没有可导入内容时后端返回全零报告而不是报错。
 */
export function pasteImport(
  currentFolder: string | null,
  onProgress: (progress: TransferProgress) => void,
): Promise<ImportOutcome> {
  const progress = new Channel<TransferProgress>(onProgress);
  return call<ImportOutcome>("paste_import", {
    currentFolder,
    onProgress: progress,
  });
}

/**
 * 提交导入停止请求：真实的后端命令，返回提交后的任务状态。
 * 只有后端确认后才是 stopped——前端隐藏进度不算已停止。
 */
export function importStop(taskId: string): Promise<TransferRunStatus> {
  return call<TransferRunStatus>("import_stop", { taskId });
}

/**
 * 原图导出入口。
 *
 * 后端按侧车显示文件名与真实扩展名复制原始字节到使用者明确选择的目标目录，
 * 库内本体与侧车不被修改。同名冲突以调用方给定的策略落地；覆盖是破坏性操作，
 * 界面必须先取得使用者的明确确认才允许传 "overwrite"。停止复用 import_stop：
 * 导入与导出共用同一把库级并发键。
 */
export function exportAssets(
  hashes: string[],
  targetDir: string,
  policy: ConflictPolicy,
  onProgress: (progress: TransferProgress) => void,
): Promise<ExportOutcome> {
  const progress = new Channel<TransferProgress>(onProgress);
  return call<ExportOutcome>("export_assets", {
    hashes,
    targetDir,
    policy,
    onProgress: progress,
  });
}

/** 只读导出冲突规划；使用者确认 policy 前不写目标目录。 */
export function planExport(hashes: string[], targetDir: string): Promise<PlannedExport[]> {
  return call<PlannedExport[]>("plan_export", { hashes, targetDir });
}

/**
 * 把一张素材的原始位图复制到系统剪贴板。
 *
 * 参数刻意是单个哈希而不是数组：复制图像只允许单张，多选不合成、多选出站
 * 走批量导出——这条规则由 API 形状在结构上锁死。像素全程留在后端，前端
 * 只见成功或错误码。
 */
export function copyAssetToClipboard(hash: string): Promise<void> {
  return call<void>("copy_asset_to_clipboard", { hash });
}

/**
 * 用系统默认程序打开素材原图。
 *
 * 后端把原始字节复制为应用缓存侧的只读临时副本，只把副本路径交给系统打开；
 * 库内本体路径绝不离开 Rust 侧。同样只接受单个哈希。
 */
export function openWithDefaultApp(hash: string): Promise<void> {
  return call<void>("open_with_default_app", { hash });
}

/**
 * 把二进制 IPC 的返回值归一成 ArrayBuffer。
 *
 * 开发模式经 HTTP 传输时 `tauri::ipc::Response` 到达前端
 * 是 ArrayBuffer，而 release（自定义协议内嵌）经 postMessage JSON 传输时是**数字数组**——
 * 字节本身无损，只是序列化形态不同。直接把数组交给 `Blob` 会得到 `"82,73,70,70…"` 这样的
 * 十进制文本，`<img>` 静默解码失败。因此这里显式归一，不轻信传输层给哪种形态。
 */
function asArrayBuffer(bytes: ArrayBuffer | number[]): ArrayBuffer {
  if (bytes instanceof ArrayBuffer) return bytes;
  return Uint8Array.from(bytes).buffer;
}

/**
 * 后端返回的原始字节包成 blob: URL。
 *
 * 走字节而不是 base64：base64 会把体积放大三分之一，而网格一次要取上百张缩略图。
 * CSP 已允许 `blob:` 作为图片来源。
 *
 * **这里不做任何像素处理。**界面层不使用 `Canvas`、`OffscreenCanvas` 或 `ImageData`
 * 读取像素做缩放、采样或聚类——本函数只是把后端已经生成好的字节交给 `<img>` 渲染。
 */
function toObjectUrl(bytes: ArrayBuffer, mime: string): string {
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

/** 素材缩略图的 blob: URL。缺失时后端会按需重新生成。 */
export async function loadThumbnail(hash: string): Promise<string> {
  const bytes = await call<ArrayBuffer | number[]>("asset_thumbnail", { hash });
  // 缩略图一律是 WebP，与素材本体的格式无关。
  return toObjectUrl(asArrayBuffer(bytes), "image/webp");
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
  const bytes = await call<ArrayBuffer | number[]>("asset_original", { hash });
  return toObjectUrl(asArrayBuffer(bytes), "");
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

/**
 * 窗口级文件拖放的完整事件流。
 *
 * `onPathsDropped` 只回答"放下了什么"，而关联图片区还需要"悬停在哪里"才能呈现
 * 命中高亮并在落点上与整库导入分流。位置是物理像素，逻辑像素换算由消费方按
 * `devicePixelRatio` 自行完成。
 */
export type FileDragEvent =
  | { type: "enter"; paths: string[]; x: number; y: number }
  | { type: "move"; paths: string[]; x: number; y: number }
  | { type: "leave" }
  | { type: "drop"; paths: string[]; x: number; y: number };

export async function onFileDragEvent(
  handler: (event: FileDragEvent) => void,
): Promise<() => void> {
  const unlisten = await getCurrentWebview().onDragDropEvent((event) => {
    const payload = event.payload;
    if (payload.type === "leave") {
      handler({ type: "leave" });
      return;
    }
    // Tauri 把"拖动经过"报作 over 且不带路径；本应用的语义是 move，命中
    // 判定只需要坐标，路径以空列表占位。
    if (payload.type === "over") {
      handler({ type: "move", paths: [], x: payload.position.x, y: payload.position.y });
      return;
    }
    handler({
      type: payload.type,
      paths: payload.paths,
      x: payload.position.x,
      y: payload.position.y,
    });
  });
  return unlisten;
}

// ---------------------------------------------------------------------------
// 提示词素材：CRUD、组织、回收站、普通关联与封面。
// ---------------------------------------------------------------------------

/** 创建提示词：正文是唯一必填项，身份由后端生成。 */
export function createPrompt(prompt: NewPromptInput): Promise<PromptAsset> {
  return call<PromptAsset>("create_prompt", { prompt });
}

/** 显式保存主字段（正文/标题/模型/参数），身份与组织保持不变。 */
export function updatePrompt(id: string, edit: PromptEditInput): Promise<PromptAsset> {
  return call<PromptAsset>("update_prompt", { id, edit });
}

/** 按需读取提示词完整详情：列表只携带轻量行，检查器打开时才调用。 */
export function promptDetail(id: string): Promise<PromptAsset> {
  return call<PromptAsset>("prompt_detail", { id });
}

export function promptSnapshot(query: PromptQuery): Promise<PromptSnapshot> {
  return call<PromptSnapshot>("prompt_snapshot", { query });
}

/** 在独立的提示词文件夹树中创建一个逻辑文件夹。 */
export function createPromptFolder(parent: string | null, name: string): Promise<string> {
  return call<string>("create_prompt_folder", { parent, name });
}

/** 重命名提示词文件夹子树，并由核心事务同步更新成员归属。 */
export function renamePromptFolder(path: string, newName: string): Promise<string> {
  return call<string>("rename_prompt_folder", { path, newName });
}

/** 把完整提示词文件夹子树移动到目标父节点；null 表示提示词文件夹树顶层。 */
export function movePromptFolder(path: string, destinationParent: string | null): Promise<string> {
  return call<string>("move_prompt_folder", { path, destinationParent });
}

/** 删除提示词文件夹子树；提示词素材本身保留并按核心语义回到根位置。 */
export function deletePromptFolder(path: string): Promise<void> {
  return call<void>("delete_prompt_folder", { path });
}

/** 设置提示词备注（独立自动保存流，不推进更新时间）。 */
export function setPromptNote(id: string, note: string): Promise<void> {
  return call<void>("set_prompt_note", { id, note });
}

export function setPromptFavorite(id: string, favorite: boolean): Promise<void> {
  return call<void>("set_prompt_favorite", { id, favorite });
}

export function setPromptFolders(id: string, folders: string[]): Promise<void> {
  return call<void>("set_prompt_folders", { id, folders });
}

export function setPromptTags(id: string, tags: string[]): Promise<void> {
  return call<void>("set_prompt_tags", { id, tags });
}

/** 把提示词移入库内回收站：只移动归属，不改写任何使用者数据。 */
export function deletePrompt(id: string): Promise<void> {
  return call<void>("delete_prompt", { id });
}

/** 还原一条回收站提示词；缺失的原文件夹经结果说明，不作为失败。 */
export function restorePrompt(id: string): Promise<PromptRestoreOutcome> {
  return call<PromptRestoreOutcome>("restore_prompt", { id });
}

/** 逐项清理提示词回收站；单项失败不阻止其余条目。 */
export function purgePromptTrash(): Promise<PromptPurgeReport> {
  return call<PromptPurgeReport>("purge_prompt_trash");
}

/** 把图片追加到提示词的有序关联列表末尾；重复关联是幂等空操作。 */
export function linkImages(promptId: string, hashes: string[]): Promise<void> {
  return call<void>("link_images", { promptId, hashes });
}

/** 解除一张图的关联；解除显式封面时封面回落缺省。未关联时是幂等空操作。 */
export function unlinkImage(promptId: string, hash: string): Promise<void> {
  return call<void>("unlink_image", { promptId, hash });
}

/** 设置显式封面；null 清除显式值回到缺省。封面必须在关联列表中。 */
export function setPromptCover(promptId: string, cover: string | null): Promise<void> {
  return call<void>("set_prompt_cover", { promptId, cover });
}

/** 本地导入后关联：逐源报告 LinkedExisting/LinkedImported/失败。 */
export function importAndLink(
  promptId: string,
  sources: string[],
): Promise<ImportAndLinkReport> {
  return call<ImportAndLinkReport>("import_and_link", { promptId, sources });
}

/** 图片检查器的按需详情：轻量行加关联提示词反查。 */
export function imageDetail(hash: string): Promise<ImageDetail> {
  return call<ImageDetail>("image_detail", { hash });
}

/** 提示词检查器的按需关联状态：与权威文件同序的哈希加各自回收站标记。 */
export function linkedImageStates(promptId: string): Promise<LinkedImageState[]> {
  return call<LinkedImageState[]>("linked_image_states", { promptId });
}

/** 图片备注与收藏（与提示词侧同一语义）。 */
export function setAssetNote(hash: string, note: string): Promise<void> {
  return call<void>("set_asset_note", { hash, note });
}

export function setAssetFavorite(hash: string, favorite: boolean): Promise<void> {
  return call<void>("set_asset_favorite", { hash, favorite });
}

// ---------------------------------------------------------------------------
// 批量组织：统一 BatchReport，逐项失败隔离，进度按项转交。
// ---------------------------------------------------------------------------

function batchCall(
  command: string,
  args: Record<string, unknown>,
  onProgress: (progress: BatchProgress) => void,
): Promise<BatchReport> {
  const progress = new Channel<BatchProgress>(onProgress);
  return call<BatchReport>(command, { ...args, onProgress: progress });
}

/** 批量把素材移动到唯一目标文件夹；`folder` 为 null 表示批量移回未分类。 */
export function batchMoveAssetsToFolder(
  hashes: string[],
  folder: string | null,
  onProgress: (progress: BatchProgress) => void,
): Promise<BatchReport> {
  return batchCall("batch_move_assets_to_folder", { hashes, folder }, onProgress);
}

export function batchAddAssetTag(
  hashes: string[],
  tag: string,
  onProgress: (progress: BatchProgress) => void,
): Promise<BatchReport> {
  return batchCall("batch_add_asset_tag", { hashes, tag }, onProgress);
}

export function batchRemoveAssetTag(
  hashes: string[],
  tag: string,
  onProgress: (progress: BatchProgress) => void,
): Promise<BatchReport> {
  return batchCall("batch_remove_asset_tag", { hashes, tag }, onProgress);
}

export function batchSetAssetFavorite(
  hashes: string[],
  favorite: boolean,
  onProgress: (progress: BatchProgress) => void,
): Promise<BatchReport> {
  return batchCall("batch_set_asset_favorite", { hashes, favorite }, onProgress);
}

export function batchLinkToPrompt(
  promptId: string,
  hashes: string[],
  onProgress: (progress: BatchProgress) => void,
): Promise<BatchReport> {
  return batchCall("batch_link_to_prompt", { promptId, hashes }, onProgress);
}

export function batchDeleteAssets(
  hashes: string[],
  onProgress: (progress: BatchProgress) => void,
): Promise<BatchReport> {
  return batchCall("batch_delete_assets", { hashes }, onProgress);
}

export function batchAddPromptFolder(
  ids: string[],
  folder: string,
  onProgress: (progress: BatchProgress) => void,
): Promise<BatchReport> {
  return batchCall("batch_add_prompt_folder", { ids, folder }, onProgress);
}

export function batchRemovePromptFolder(
  ids: string[],
  folder: string,
  onProgress: (progress: BatchProgress) => void,
): Promise<BatchReport> {
  return batchCall("batch_remove_prompt_folder", { ids, folder }, onProgress);
}

export function batchAddPromptTag(
  ids: string[],
  tag: string,
  onProgress: (progress: BatchProgress) => void,
): Promise<BatchReport> {
  return batchCall("batch_add_prompt_tag", { ids, tag }, onProgress);
}

export function batchRemovePromptTag(
  ids: string[],
  tag: string,
  onProgress: (progress: BatchProgress) => void,
): Promise<BatchReport> {
  return batchCall("batch_remove_prompt_tag", { ids, tag }, onProgress);
}

export function batchSetPromptFavorite(
  ids: string[],
  favorite: boolean,
  onProgress: (progress: BatchProgress) => void,
): Promise<BatchReport> {
  return batchCall("batch_set_prompt_favorite", { ids, favorite }, onProgress);
}

export function batchDeletePrompts(
  ids: string[],
  onProgress: (progress: BatchProgress) => void,
): Promise<BatchReport> {
  return batchCall("batch_delete_prompts", { ids }, onProgress);
}

// ---------------------------------------------------------------------------
// 全局搜索与布局偏好。
// ---------------------------------------------------------------------------

/** 跨图片与提示词的全局搜索：结果按素材类型分组。 */
export function globalSearch(text: string): Promise<GlobalSearchResult> {
  return call<GlobalSearchResult>("global_search", { text });
}

/**
 * 读取一个库的布局偏好。从未保存过时返回 null。
 *
 * 布局内容是前端领域的任意 JSON——后端只按键存储透传，不解释其结构，
 * 因此布局模型的演进不需要改动 IPC 合同。
 */
export function readLayout(libraryId: string): Promise<unknown> {
  return call<unknown>("read_layout", { libraryId });
}

/** 写入一个库的布局偏好（整体覆盖）。 */
export function writeLayout(libraryId: string, layout: unknown): Promise<void> {
  return call<void>("write_layout", { libraryId, layout });
}
