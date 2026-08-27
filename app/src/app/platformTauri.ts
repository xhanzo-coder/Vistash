/**
 * [`PlatformPort`] 的生产实现（任务 6.2，设计第三条与第十六条）。
 *
 * 只做一件事：把集中式共享 IPC 的传输原语装配成领域 port。这里没有产品
 * 规则、没有自动重试、没有默认值——那些属于各模块的协调器。错误原样向上
 * 传播为带稳定错误码的 `IpcError`，adapter 不吞也不改写。
 *
 * 拖放订阅直接挂在 Tauri webview 事件上，用本文件的纯映射函数把原生载荷
 * 转成应用级判别联合；旧版 `shared/ipc.onFileDragEvent` 内联了同一套规则，
 * 随阶段 11 一并删除，在此之前两处必须保持一致（contract tests 已钉死）。
 */

import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { DragDropEvent } from "@tauri-apps/api/webview";

import {
  copyAssetToClipboard,
  exportAssets,
  importSources,
  importStop,
  loadOriginal,
  loadThumbnail,
  openWithDefaultApp,
  pasteImport,
  pickImageFiles,
  pickLibraryDirectory,
  releaseImageUrl,
} from "../shared/ipc";
import type { FileDragEvent } from "../shared/ipc";
import type { ImageLease, PlatformPort } from "./platform";

/**
 * 把 Tauri 原生拖放载荷映射为应用级判别联合。
 *
 * Tauri 把"拖动经过"报作 over 且不带路径；本应用的语义是 move，命中判定
 * 只需要坐标，路径以空列表占位。位置是物理像素，逻辑像素换算由消费方按
 * devicePixelRatio 自行完成——这是传输事实，不是产品规则。
 */
export function fileDragEventFromTauriPayload(payload: DragDropEvent): FileDragEvent {
  if (payload.type === "leave") {
    return { type: "leave" };
  }
  if (payload.type === "over") {
    return { type: "move", paths: [], x: payload.position.x, y: payload.position.y };
  }
  return { type: payload.type, paths: payload.paths, x: payload.position.x, y: payload.position.y };
}

/** 等待字节到达后包成显式租约：release 归还底层 blob URL。 */
function toLease(pending: Promise<string>): Promise<ImageLease> {
  return pending.then((url) => ({
    url,
    release: () => {
      releaseImageUrl(url);
    },
  }));
}

/** 生产 adapter。调用方在应用组合根创建一次并向下传递。 */
export function createTauriPlatform(): PlatformPort {
  return {
    acquireThumbnail: (hash) => toLease(loadThumbnail(hash)),
    acquireOriginal: (hash) => toLease(loadOriginal(hash)),

    pickImageFiles,
    pickLibraryDirectory,

    onFileDrag: (handler) => {
      // 订阅本身异步落地；取消函数保持同步可用——在订阅完成后转发 unlisten。
      const unlisten = getCurrentWebview().onDragDropEvent((event) => {
        handler(fileDragEventFromTauriPayload(event.payload));
      });
      return () => {
        void unlisten.then((dispose) => dispose());
      };
    },

    importSources,
    pasteImport,
    stopTransfer: (taskId) => importStop(taskId),

    exportAssets,
    copyImageToClipboard: (hash) => copyAssetToClipboard(hash),
    openWithDefaultApp: (hash) => openWithDefaultApp(hash),
  };
}
