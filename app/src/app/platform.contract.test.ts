// @vitest-environment jsdom

/*
 * PlatformPort 的共享合同套件（任务 6.2，设计第三条与第十六条）。
 *
 * 同一组场景分别对 Memory 与 Tauri 两个 adapter 运行：错误码保留、媒体租约、
 * 文件对话框、拖放事件与取消监听。生产侧经官方 mockIPC 走真实 invoke 路径，
 * 只有 webview 事件源被替换成可注入的桩——adapter 的装配逻辑本身被完整执行。
 * 真实 Windows 拖放与对话框行为由任务 11.5 的 release 构建验收兜底。
 */

import { afterEach, describe, expect, test, vi } from "vitest";

import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { DragDropEvent } from "@tauri-apps/api/webview";

import type { AppError, ExportOutcome, ImportOutcome } from "../shared/types";
import { IpcError } from "../shared/errors";
import { fileDragEventFromTauriPayload, createTauriPlatform } from "./platformTauri";
import { createMemoryPlatform } from "./platformMemory";
import type { PlatformPort } from "./platform";

// ---------------------------------------------------------------------------
// webview 事件桩：捕获 adapter 注册的回调，让测试能直接投递原生载荷。
// ---------------------------------------------------------------------------

const dragBus = vi.hoisted(() => {
  type DragCallback = (event: { payload: unknown }) => void;
  let callback: DragCallback | null = null;
  let unlistened = 0;
  return {
    attach(cb: DragCallback): void {
      callback = cb;
    },
    deliver(payload: unknown): void {
      // 与真实 unlisten 语义一致：取消之后事件仍在系统里发生，只是不再投递。
      if (callback !== null) callback({ payload });
    },
    markUnlistened(): void {
      callback = null;
      unlistened += 1;
    },
    unlistenCount(): number {
      return unlistened;
    },
    reset(): void {
      callback = null;
      unlistened = 0;
    },
  };
});

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (handler: (event: { payload: unknown }) => void) => {
      dragBus.attach(handler);
      return Promise.resolve(() => {
        dragBus.markUnlistened();
      });
    },
  }),
}));

// jsdom 没有 blob URL 能力；用可观察的桩替代，租约释放断言读这份记录。
const revokedUrlLog: string[] = [];
let urlSequence = 0;
Object.defineProperty(URL, "createObjectURL", {
  configurable: true,
  value: (_blob: Blob): string => {
    urlSequence += 1;
    return `blob:contract-${urlSequence}`;
  },
});
Object.defineProperty(URL, "revokeObjectURL", {
  configurable: true,
  value: (url: string): void => {
    revokedUrlLog.push(url);
  },
});

afterEach(() => {
  revokedUrlLog.length = 0;
});

// ---------------------------------------------------------------------------
// 统一的合同夹具：两个 provider 各自实现同一套控制面。
// ---------------------------------------------------------------------------

type MethodKey =
  | keyof Pick<
      PlatformPort,
      | "acquireThumbnail"
      | "acquireOriginal"
      | "pickImageFiles"
      | "pickImportDirectory"
      | "pickExportDirectory"
      | "pickLibraryDirectory"
      | "importSources"
      | "pasteImport"
      | "stopTransfer"
      | "exportAssets"
      | "copyImageToClipboard"
      | "openWithDefaultApp"
    >;

type PlatformFixture = {
  port: PlatformPort;
  answerImageFiles(paths: string[]): void;
  answerImportDirectory(value: string | null): void;
  answerExportDirectory(value: string | null): void;
  answerLibraryDirectory(value: string | null): void;
  failOnce(method: MethodKey, error: AppError): void;
  /** 以原生形态投递一次 drop 事件。 */
  deliverDrop(drop: { paths: string[]; x: number; y: number }): void;
  /** 已经被 release 归还的租约 url。 */
  releasedUrls(): readonly string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const EMPTY_IMPORT: ImportOutcome = {
  task_id: null,
  imported: 0,
  skipped_non_images: 0,
  duplicates: 0,
  pending_count: 0,
  failures: [],
};

const EMPTY_EXPORT: ExportOutcome = {
  task_id: "contract-export-task",
  exported: [],
  skipped_existing: 0,
  failed: [],
  pending_count: 0,
};

function memoryFixture(): PlatformFixture {
  const memory = createMemoryPlatform();
  return {
    port: memory,
    answerImageFiles: (paths) => memory.answerImageFiles(paths),
    answerImportDirectory: (value) => memory.answerImportDirectory(value),
    answerExportDirectory: (value) => memory.answerExportDirectory(value),
    answerLibraryDirectory: (value) => memory.answerLibraryDirectory(value),
    failOnce: (method, error) => memory.failOnce(method, error),
    deliverDrop: ({ paths, x, y }) => memory.emitFileDrag({ type: "drop", paths, x, y }),
    releasedUrls: () => memory.releasedUrls(),
  };
}

function tauriFixture(): PlatformFixture {
  dragBus.reset();
  const armed = new Map<MethodKey, AppError>();
  let imageFilesAnswer: string[] = [];
  let libraryDirectoryAnswer: string | null = null;
  let importDirectoryAnswer: string | null = null;
  let exportDirectoryAnswer: string | null = null;

  const takeFailure = (method: MethodKey): AppError | undefined => {
    const armed_error = armed.get(method);
    if (armed_error !== undefined) armed.delete(method);
    return armed_error;
  };

  mockIPC((command, payload) => {
    if (command === "plugin:dialog|open") {
      const options = isRecord(payload) && isRecord(payload.options) ? payload.options : {};
      if (options.directory === true) {
        const failure = takeFailure("pickLibraryDirectory");
        if (failure !== undefined) throw failure;
        if (options.title === "选择要导入的图片文件夹") return importDirectoryAnswer;
        if (options.title === "选择图片导出目录") return exportDirectoryAnswer;
        return libraryDirectoryAnswer;
      }
      const failure = takeFailure("pickImageFiles");
      if (failure !== undefined) throw failure;
      return imageFilesAnswer;
    }
    switch (command) {
      case "asset_thumbnail": {
        const failure = takeFailure("acquireThumbnail");
        if (failure !== undefined) throw failure;
        return [82, 73, 70, 70, 13];
      }
      case "asset_original": {
        const failure = takeFailure("acquireOriginal");
        if (failure !== undefined) throw failure;
        return [1, 2, 3, 4];
      }
      case "import_sources":
      case "paste_import": {
        const failure = takeFailure(command === "import_sources" ? "importSources" : "pasteImport");
        if (failure !== undefined) throw failure;
        return EMPTY_IMPORT;
      }
      case "import_stop": {
        const failure = takeFailure("stopTransfer");
        if (failure !== undefined) throw failure;
        const taskId = isRecord(payload) ? payload.taskId : undefined;
        return { task_id: taskId, state: "stopped" };
      }
      case "export_assets": {
        const failure = takeFailure("exportAssets");
        if (failure !== undefined) throw failure;
        return EMPTY_EXPORT;
      }
      case "copy_asset_to_clipboard": {
        const failure = takeFailure("copyImageToClipboard");
        if (failure !== undefined) throw failure;
        return null;
      }
      case "open_with_default_app": {
        const failure = takeFailure("openWithDefaultApp");
        if (failure !== undefined) throw failure;
        return null;
      }
      default:
        throw new TypeError(`平台合同测试未覆盖的命令：${command}`);
    }
  });

  return {
    port: createTauriPlatform(),
    answerImageFiles: (paths) => {
      imageFilesAnswer = [...paths];
    },
    answerLibraryDirectory: (value) => {
      libraryDirectoryAnswer = value;
    },
    answerImportDirectory: (value) => {
      importDirectoryAnswer = value;
    },
    answerExportDirectory: (value) => {
      exportDirectoryAnswer = value;
    },
    failOnce: (method, error) => {
      armed.set(method, error);
    },
    deliverDrop: ({ paths, x, y }) => {
      dragBus.deliver({ type: "drop", paths, position: { x, y } });
    },
    releasedUrls: () => [...revokedUrlLog],
  };
}

// ---------------------------------------------------------------------------
// 共享合同：五个领域各一组断言，两个 adapter 都必须满足。
// ---------------------------------------------------------------------------

function testPlatformContract(build: () => PlatformFixture): void {
  test("未预置的文件与库位置对话框按使用者取消解析", async () => {
    const fixture = build();
    await expect(fixture.port.pickImageFiles()).resolves.toEqual([]);
    await expect(fixture.port.pickLibraryDirectory()).resolves.toBeNull();
    await expect(fixture.port.pickImportDirectory()).resolves.toBeNull();
    await expect(fixture.port.pickExportDirectory()).resolves.toBeNull();
  });

  test("预置的文件与库位置结果原样转交", async () => {
    const fixture = build();
    const paths = ["E:\\素材\\逆光.png", "E:\\素材\\顺光.jpg"];
    fixture.answerImageFiles(paths);
    fixture.answerLibraryDirectory("E:\\Vistash 库");
    fixture.answerImportDirectory("E:\\待导入");
    fixture.answerExportDirectory("E:\\导出");

    await expect(fixture.port.pickImageFiles()).resolves.toEqual(paths);
    await expect(fixture.port.pickLibraryDirectory()).resolves.toBe("E:\\Vistash 库");
    await expect(fixture.port.pickImportDirectory()).resolves.toBe("E:\\待导入");
    await expect(fixture.port.pickExportDirectory()).resolves.toBe("E:\\导出");
  });

  test("失败以稳定错误码原样传播，不被吞掉或改写", async () => {
    const fixture = build();
    fixture.failOnce("pickImageFiles", {
      code: "library.tag_invalid",
      detail: "注入的合同失败",
    });

    const thrown = await fixture.port.pickImageFiles().then(
      () => null,
      (value: unknown) => value,
    );
    if (!(thrown instanceof IpcError)) {
      throw new TypeError("对话框失败必须是携带 AppError 的 IpcError");
    }
    expect(thrown.appError).toEqual({ code: "library.tag_invalid", detail: "注入的合同失败" });

    // 换一个领域再验一次：错误码逐字保留，detail 允许为 null。
    fixture.failOnce("openWithDefaultApp", { code: "external.open_failed", detail: null });
    const outbound = await fixture.port.openWithDefaultApp("a".repeat(64)).then(
      () => null,
      (value: unknown) => value,
    );
    if (!(outbound instanceof IpcError)) {
      throw new TypeError("出站失败必须是携带 AppError 的 IpcError");
    }
    expect(outbound.appError).toEqual({ code: "external.open_failed", detail: null });
  });

  test("媒体租约携带可用 url，release 归还后可被观察", async () => {
    const fixture = build();
    const lease = await fixture.port.acquireThumbnail("a".repeat(64));
    expect(lease.url.length).toBeGreaterThan(0);
    expect(fixture.releasedUrls()).not.toContain(lease.url);

    lease.release();
    expect(fixture.releasedUrls()).toContain(lease.url);

    const original = await fixture.port.acquireOriginal("b".repeat(64));
    original.release();
    expect(fixture.releasedUrls()).toContain(original.url);
  });

  test("拖放 drop 事件映射为类型化判别联合，取消监听后不再投递", async () => {
    const fixture = build();
    const handler = vi.fn<(event: { type: string }) => void>();
    const unsubscribe = fixture.port.onFileDrag(handler);

    fixture.deliverDrop({ paths: ["E:\\素材\\逆光.png"], x: 12, y: 34 });
    expect(handler).toHaveBeenCalledExactlyOnceWith({
      type: "drop",
      paths: ["E:\\素材\\逆光.png"],
      x: 12,
      y: 34,
    });

    unsubscribe();
    // 生产侧的 unlisten 在微任务中落地；冲刷后再投递必须静默。
    await Promise.resolve();
    fixture.deliverDrop({ paths: ["E:\\素材\\顺光.png"], x: 56, y: 78 });
    expect(handler).toHaveBeenCalledExactlyOnceWith({
      type: "drop",
      paths: ["E:\\素材\\逆光.png"],
      x: 12,
      y: 34,
    });
    // 二次取消是幂等的安全操作。
    expect(() => unsubscribe()).not.toThrow();
  });
}

describe("MemoryPlatformAdapter 的平台合同", () => {
  testPlatformContract(memoryFixture);

  test("emitFileDrag 投递给全部订阅者且随订阅数量增减", () => {
    const memory = createMemoryPlatform();
    const first = vi.fn<() => void>();
    const second = vi.fn<() => void>();
    memory.onFileDrag(first);
    const stopSecond = memory.onFileDrag(second);
    expect(memory.subscriberCount()).toBe(2);

    stopSecond();
    memory.emitFileDrag({ type: "move", paths: [], x: 1, y: 2 });

    expect(first).toHaveBeenCalledExactlyOnceWith({ type: "move", paths: [], x: 1, y: 2 });
    expect(second).not.toHaveBeenCalled();
  });

  test("出站单图意图到达平台并被记录", async () => {
    const memory = createMemoryPlatform();
    await memory.copyImageToClipboard("c".repeat(64));
    await memory.openWithDefaultApp("d".repeat(64));
    expect(memory.copiedHashes()).toEqual(["c".repeat(64)]);
    expect(memory.openedHashes()).toEqual(["d".repeat(64)]);
  });
});

describe("TauriPlatformAdapter 的平台合同", () => {
  testPlatformContract(tauriFixture);

  test("取消监听转发到 webview 的 unlisten", async () => {
    dragBus.reset();
    const port = createTauriPlatform();
    const unsubscribe = port.onFileDrag(() => {});
    expect(dragBus.unlistenCount()).toBe(0);

    unsubscribe();
    await Promise.resolve();
    expect(dragBus.unlistenCount()).toBe(1);
  });

  test("fileDragEventFromTauriPayload 把四种原生载荷映射为应用级判别联合", () => {
    expect(
      fileDragEventFromTauriPayload({
        type: "enter",
        paths: ["E:\\素材\\逆光.png"],
        position: new PhysicalPosition(1, 2),
      } satisfies DragDropEvent),
    ).toEqual({ type: "enter", paths: ["E:\\素材\\逆光.png"], x: 1, y: 2 });

    // over 不带路径：本应用语义是 move，路径以空列表占位。
    expect(
      fileDragEventFromTauriPayload({ type: "over", position: new PhysicalPosition(3, 4) } satisfies DragDropEvent),
    ).toEqual({ type: "move", paths: [], x: 3, y: 4 });

    expect(
      fileDragEventFromTauriPayload({
        type: "drop",
        paths: ["E:\\素材\\顺光.jpg", "E:\\参考"],
        position: new PhysicalPosition(5, 6),
      } satisfies DragDropEvent),
    ).toEqual({ type: "drop", paths: ["E:\\素材\\顺光.jpg", "E:\\参考"], x: 5, y: 6 });

    expect(fileDragEventFromTauriPayload({ type: "leave" } satisfies DragDropEvent)).toEqual({
      type: "leave",
    });
  });
});
