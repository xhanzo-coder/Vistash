/**
 * 平台 seam 的领域 port（任务 6.1，设计第三条与第十六条）。
 *
 * Tauri 是项目自有的跨进程依赖：生产用 `TauriPlatformAdapter`，测试用
 * `MemoryPlatformAdapter`（两者都在任务 6.2 实现，并满足同一套共享 contract
 * tests）。port 只做传输映射——command、进度 channel、拖放事件、文件对话框、
 * 剪贴板导入意图、默认程序打开与媒体租约；产品规则、自动重试、缓存失效和
 * 默认值一律不进入 adapter。
 *
 * 合同基线（任务 6.2 的 contract tests 按此验证）：
 * - 所有拒绝都必须携带稳定错误码的 `AppError`（经 `IpcError` 抛出），不存在
 *   无码失败或通用"操作失败"文案的入口。
 * - 事件订阅只接受本文件与 `shared/ipc` 里类型化的判别联合载荷，返回取消
 *   函数；取消之后不得再向 handler 投递任何事件。
 * - 前端永远不接收像素缓冲：剪贴板导入只提交意图，位图字节留在 Rust 侧。
 */

import type { FileDragEvent } from "../shared/ipc";
import type { Unsubscribe } from "./common";
import type {
  ConflictPolicy,
  ExportOutcome,
  ImportOutcome,
  TransferProgress,
  TransferRunStatus,
} from "../shared/types";

/**
 * 显式媒体租约（设计第十四条）：url 只是借用，release 必须由持有方在项卸载、
 * 换源、预览关闭、缓存淘汰或切库时调用。租约隐藏 blob URL 与未来 asset
 * protocol 的差异，调用方不感知字节来源。
 */
export type ImageLease = {
  url: string;
  release(): void;
};

/**
 * 平台 port：图片与提示词模块能从平台得到的全部能力都在这里。
 *
 * 方法按传输关注点分组；入参出参全部是领域类型。集合查询等纯数据 command
 * 继续走集中式 `shared/ipc`——那里已有逐命令的合同锁定；本 port 收拢的是
 * 无法用"一次调用一个返回值"表达的传输面：租约、对话框、事件流与进度通道。
 */
export interface PlatformPort {
  // --- 媒体租约 -----------------------------------------------------------

  /** 缩略图租约。缺失时后端按需生成后返回。 */
  acquireThumbnail(hash: string): Promise<ImageLease>;
  /** 原图租约。只在预览或灯箱显式需要原图字节时使用。 */
  acquireOriginal(hash: string): Promise<ImageLease>;

  // --- 文件对话框 ---------------------------------------------------------

  /** 多选图片文件对话框；使用者取消时解析为空数组。扩展名清单与核心导入层一致。 */
  pickImageFiles(): Promise<string[]>;
  /** 选择待导入的图片目录；取消时返回 null。 */
  pickImportDirectory(): Promise<string | null>;
  /** 选择原图导出的目标目录；取消时返回 null。 */
  pickExportDirectory(): Promise<string | null>;
  /** 选择库位置对话框；取消时解析为 null。规格禁止默认路径，因此没有位置参数。 */
  pickLibraryDirectory(): Promise<string | null>;

  // --- 拖放事件 -----------------------------------------------------------

  /**
   * 订阅整窗口文件拖放的完整事件流（enter/move/leave/drop 判别联合）。
   * 返回取消监听函数；取消后 handler 不得再收到任何事件。
   */
  onFileDrag(handler: (event: FileDragEvent) => void): Unsubscribe;

  // --- 入站传输 -----------------------------------------------------------

  /** 统一导入：文件与目录路径混排进入后端同一协调器，目录保留相对层级。 */
  importSources(
    paths: string[],
    currentFolder: string | null,
    onProgress: (progress: TransferProgress) => void,
  ): Promise<ImportOutcome>;
  /** 窗口级 Ctrl+V 的剪贴板导入意图：分流在后端裁决，前端不见像素。无可导入内容时全零报告。 */
  pasteImport(
    currentFolder: string | null,
    onProgress: (progress: TransferProgress) => void,
  ): Promise<ImportOutcome>;
  /** 请求停止当前库级传输任务；解析为提交后的后端任务状态（只有它确认 stopped）。 */
  stopTransfer(taskId: string): Promise<TransferRunStatus>;

  // --- 出站传输 -----------------------------------------------------------

  /** 原图导出到使用者选择的目录。policy 为 overwrite 前界面必须已取得阻断式确认。 */
  exportAssets(
    hashes: string[],
    targetDir: string,
    policy: ConflictPolicy,
    onProgress: (progress: TransferProgress) => void,
  ): Promise<ExportOutcome>;
  /** 把单张图片的位图写入系统剪贴板。入参是单个哈希——多选不合成由形状锁死。 */
  copyImageToClipboard(hash: string): Promise<void>;
  /** 用系统默认程序打开单张图的只读临时副本；库内本体路径绝不离开 Rust 侧。 */
  openWithDefaultApp(hash: string): Promise<void>;
}
