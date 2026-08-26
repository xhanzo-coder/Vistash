import { describe, expect, expectTypeOf, test } from "vitest";

import type { ImageLease, PlatformPort } from "./platform";
import type { ImportOutcome, ImportProgress } from "../shared/types";

/**
 * 任务 6.1 只锁 port 的形状与合同基线；Tauri/Memory 双 adapter 与完整
 * contract tests（错误码、媒体租约、文件对话框、拖放、取消监听）在任务 6.2。
 */

const EMPTY_IMPORT: ImportOutcome = {
  imported: 0,
  skipped_non_images: 0,
  duplicates: 0,
  pending_count: 0,
  failures: [],
};

function stubPort(): PlatformPort {
  return {
    acquireThumbnail: async (hash) => ({ url: `memory://thumb/${hash}`, release() {} }),
    acquireOriginal: async (hash) => ({ url: `memory://original/${hash}`, release() {} }),
    pickImageFiles: async () => [],
    pickLibraryDirectory: async () => null,
    onFileDrag: () => () => {},
    importSources: async () => EMPTY_IMPORT,
    pasteImport: async () => EMPTY_IMPORT,
    stopTransfer: async () => "stopped",
    exportAssets: async () => ({ exported: [], skipped_existing: 0, failed: [], pending_count: 0 }),
    copyImageToClipboard: async () => {},
    openWithDefaultApp: async () => {},
  };
}

describe("PlatformPort 形状", () => {
  test("一个无依赖的最小对象即可满足整个 port——Memory adapter 的可实现性证明", async () => {
    const port = stubPort();
    await expect(port.pickImageFiles()).resolves.toEqual([]);
    await expect(port.pasteImport(null, () => {})).resolves.toEqual(EMPTY_IMPORT);
    await expect(port.stopTransfer()).resolves.toBe("stopped");
  });

  test("媒体租约携带 url 并提供可调用的 release", async () => {
    const port = stubPort();
    const lease: ImageLease = await port.acquireThumbnail("a".repeat(64));
    expect(typeof lease.url).toBe("string");
    expect(typeof lease.release).toBe("function");
    // 释放是幂等的借用归还：这里只验证形状，释放时机的合同在任务 10.5 验证。
    expect(() => lease.release()).not.toThrow();
  });

  test("拖放订阅返回取消监听函数", () => {
    const unsubscribe = stubPort().onFileDrag(() => {});
    expect(typeof unsubscribe).toBe("function");
    expect(() => unsubscribe()).not.toThrow();
  });
});

describe("类型锁（设计第三条与第十四条）", () => {
  test("ImageLease 就是设计冻结的显式租约形状", () => {
    expectTypeOf<ImageLease>().toEqualTypeOf<{ url: string; release(): void }>();
  });

  test("复制图像与默认程序打开都只接受单个哈希——多选不合成由参数面锁死", () => {
    expectTypeOf<PlatformPort["copyImageToClipboard"]>().parameter(0).toBeString();
    expectTypeOf<PlatformPort["openWithDefaultApp"]>().parameter(0).toBeString();
  });

  test("进度通道是类型化回调而不是字符串主题订阅", () => {
    expectTypeOf<Parameters<PlatformPort["pasteImport"]>[1]>().toEqualTypeOf<
      (progress: ImportProgress) => void
    >();
  });
});
