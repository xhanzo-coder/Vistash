/**
 * [`PlatformPort`] 的内存实现（任务 6.2，设计第三条与第十六条）。
 *
 * 测试与脚本化场景使用它替代真实传输：对话框结果可预置、失败可按方法名武装、
 * 拖放事件可直接投递、租约释放可观察。它与生产 adapter 满足同一套 contract
 * tests——这正是"两个 adapter 的真实 seam"的意义：行为测试不 mock 数十个
 * invoke，而是换掉整个平台。
 *
 * 控制面方法只服务于测试编排，不属于 [`PlatformPort`] 合同的一部分；
 * 它们不做任何产品决策——默认值就是"使用者取消了对话框""任务什么都没处理"。
 */

import { IpcError } from "../shared/errors";
import type { FileDragEvent } from "../shared/ipc";
import type {
  AppError,
  ExportOutcome,
  ImportOutcome,
  TransferRunStatus,
} from "../shared/types";
import type { ImageLease, PlatformPort } from "./platform";

export type MemoryPlatformConfig = {
  /** 图片选择对话框的预置结果；缺省视为使用者取消（空数组）。 */
  pickedImageFiles?: string[];
  /** 图片目录选择对话框的预置结果；null 即使用者取消。 */
  pickedImportDirectory?: string | null;
  /** 导出目录选择对话框的预置结果；null 即使用者取消。 */
  pickedExportDirectory?: string | null;
  /** 库位置对话框的预置结果；null 即使用者取消。 */
  pickedLibraryDirectory?: string | null;
};

export type MemoryPlatform = PlatformPort & {
  /** 覆盖图片选择对话框的下一次结果。 */
  answerImageFiles(paths: string[]): void;
  /** 覆盖库位置对话框的下一次结果。 */
  answerLibraryDirectory(value: string | null): void;
  /** 覆盖导入目录对话框的下一次结果。 */
  answerImportDirectory(value: string | null): void;
  /** 覆盖导出目录对话框的下一次结果。 */
  answerExportDirectory(value: string | null): void;
  /** 武装一次性失败：该方法的下一次调用以携带稳定错误码的 `IpcError` 拒绝，随后自动解除。 */
  failOnce(method: keyof PlatformPort, error: AppError): void;
  /** 向当前全部订阅者投递一条已映射的拖放事件。 */
  emitFileDrag(event: FileDragEvent): void;
  /** 当前拖放订阅者数量。 */
  subscriberCount(): number;
  /** 已经通过 release 归还的租约 url。 */
  releasedUrls(): readonly string[];
  /** 复制到剪贴板的哈希记录（出站意图是否到达平台的观察口）。 */
  copiedHashes(): readonly string[];
  /** 交给默认程序打开的哈希记录。 */
  openedHashes(): readonly string[];
};

export function createMemoryPlatform(config: MemoryPlatformConfig = {}): MemoryPlatform {
  const armedFailures = new Map<keyof PlatformPort, AppError>();
  const dragSubscribers = new Set<(event: FileDragEvent) => void>();
  const released = new Set<string>();
  const copied: string[] = [];
  const opened: string[] = [];
  let imageFiles = config.pickedImageFiles ?? [];
  let importDirectory = config.pickedImportDirectory ?? null;
  let exportDirectory = config.pickedExportDirectory ?? null;
  let libraryDirectory = config.pickedLibraryDirectory ?? null;

  const EMPTY_IMPORT: ImportOutcome = {
    task_id: null,
    imported: 0,
    skipped_non_images: 0,
    duplicates: 0,
    pending_count: 0,
    failures: [],
  };
  const EMPTY_EXPORT: ExportOutcome = {
    task_id: "memory-export-task",
    exported: [],
    skipped_existing: 0,
    failed: [],
    pending_count: 0,
  };

  function takeFailure(method: keyof PlatformPort): AppError | undefined {
    const armed = armedFailures.get(method);
    if (armed !== undefined) armedFailures.delete(method);
    return armed;
  }

  function makeLease(url: string): ImageLease {
    return {
      url,
      release: () => {
        released.add(url);
      },
    };
  }

  const platform: MemoryPlatform = {
    acquireThumbnail: async (hash) => makeLease(`memory://thumb/${hash}`),
    acquireOriginal: async (hash) => makeLease(`memory://original/${hash}`),

    pickImageFiles: async () => {
      const failure = takeFailure("pickImageFiles");
      if (failure !== undefined) throw new IpcError(failure);
      return [...imageFiles];
    },
    pickImportDirectory: async () => {
      const failure = takeFailure("pickImportDirectory");
      if (failure !== undefined) throw new IpcError(failure);
      return importDirectory;
    },
    pickExportDirectory: async () => {
      const failure = takeFailure("pickExportDirectory");
      if (failure !== undefined) throw new IpcError(failure);
      return exportDirectory;
    },
    pickLibraryDirectory: async () => {
      const failure = takeFailure("pickLibraryDirectory");
      if (failure !== undefined) throw new IpcError(failure);
      return libraryDirectory;
    },

    onFileDrag: (handler) => {
      dragSubscribers.add(handler);
      return () => {
        dragSubscribers.delete(handler);
      };
    },

    importSources: async () => {
      const failure = takeFailure("importSources");
      if (failure !== undefined) throw new IpcError(failure);
      return EMPTY_IMPORT;
    },
    pasteImport: async () => {
      const failure = takeFailure("pasteImport");
      if (failure !== undefined) throw new IpcError(failure);
      return EMPTY_IMPORT;
    },
    stopTransfer: async (taskId) => {
      const failure = takeFailure("stopTransfer");
      if (failure !== undefined) throw new IpcError(failure);
      return { task_id: taskId, state: "stopped" } satisfies TransferRunStatus;
    },

    exportAssets: async () => {
      const failure = takeFailure("exportAssets");
      if (failure !== undefined) throw new IpcError(failure);
      return EMPTY_EXPORT;
    },
    copyImageToClipboard: async (hash) => {
      const failure = takeFailure("copyImageToClipboard");
      if (failure !== undefined) throw new IpcError(failure);
      copied.push(hash);
    },
    openWithDefaultApp: async (hash) => {
      const failure = takeFailure("openWithDefaultApp");
      if (failure !== undefined) throw new IpcError(failure);
      opened.push(hash);
    },

    answerImageFiles(paths) {
      imageFiles = [...paths];
    },
    answerImportDirectory(value) {
      importDirectory = value;
    },
    answerExportDirectory(value) {
      exportDirectory = value;
    },
    answerLibraryDirectory(value) {
      libraryDirectory = value;
    },
    failOnce(method, error) {
      armedFailures.set(method, error);
    },
    emitFileDrag(event) {
      for (const subscriber of dragSubscribers) subscriber(event);
    },
    subscriberCount: () => dragSubscribers.size,
    releasedUrls: () => [...released],
    copiedHashes: () => [...copied],
    openedHashes: () => [...opened],
  };

  return platform;
}
