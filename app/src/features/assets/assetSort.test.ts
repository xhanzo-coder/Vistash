import { describe, expect, test } from "vitest";

import type { AssetRow } from "../../shared/types";
import { DEFAULT_SORT, sortAssets, type AssetSort } from "./assetSort";

function makeAsset(overrides: Partial<AssetRow> & { hash?: string }): AssetRow {
  return {
    hash: overrides.hash ?? "a".repeat(64),
    hash_algo: "sha256",
    media_type: "png",
    ext: "png",
    byte_size: 1,
    width: 100,
    height: 100,
    imported_at: "2026-08-19T00:00:00Z",
    original_filename: "图片.png",
    display_filename: "图片.png",
    source_path: null,
    deleted_at: null,
    color_card_status: "ok",
    color_card_algo_version: 1,
    color_card_failure_reason: null,
    color_card_sampled_pixel_count: 1,
    note: "",
    favorite: false,
    tags: [],
    folder: null,
    colors: [],
    ...overrides,
  };
}

describe("sortAssets", () => {
  const assets = [
    makeAsset({ hash: "b", original_filename: "乙.png", width: 800, height: 600, media_type: "jpg", imported_at: "2026-08-20T00:00:00Z" }),
    makeAsset({ hash: "a", original_filename: "甲.png", width: 1920, height: 1080, media_type: "png", imported_at: "2026-08-21T00:00:00Z" }),
    makeAsset({ hash: "c", original_filename: "丙.webp", width: 500, height: 500, media_type: "webp", imported_at: "2026-08-18T00:00:00Z" }),
  ];

  test("默认排序为导入时间降序（最新在前）", () => {
    expect(DEFAULT_SORT).toEqual({ column: "importedAt", direction: "desc" });
    expect(sortAssets(assets, DEFAULT_SORT).map((asset) => asset.hash)).toEqual(["a", "b", "c"]);
  });

  test("文件名升序按本地化比较，降序恰为升序的反转", () => {
    // 中文 collation 依运行环境而异：断言相邻元素相对有序，不锚定具体字典序。
    const asc = sortAssets(assets, { column: "filename", direction: "asc" });
    const names = asc.map((asset) => asset.original_filename);
    for (let i = 1; i < names.length; i += 1) {
      expect((names[i - 1] ?? "").localeCompare(names[i] ?? "", "zh")).toBeLessThanOrEqual(0);
    }
    const descNames = sortAssets(assets, { column: "filename", direction: "desc" }).map(
      (asset) => asset.original_filename,
    );
    expect(descNames).toHaveLength(names.length);
    names.forEach((_, index) => {
      expect(descNames[index]).toBe(names[names.length - 1 - index]);
    });
  });

  test("尺寸按面积比较，同面积回退到宽度", () => {
    const wide = makeAsset({ hash: "wide", width: 2025, height: 400 });
    const square = makeAsset({ hash: "square", width: 900, height: 900 });
    // 面积同为 810000，宽度大者排前。
    expect(sortAssets([square, wide], { column: "dimensions", direction: "desc" }).map((a) => a.hash)).toEqual(["wide", "square"]);
    expect(sortAssets([makeAsset({ hash: "small" }), makeAsset({ hash: "big", width: 300 })], { column: "dimensions", direction: "asc" }).map((a) => a.hash)).toEqual(["small", "big"]);
  });

  test("格式按媒体类型字符串比较", () => {
    const order = sortAssets(assets, { column: "format", direction: "asc" }).map((asset) => asset.media_type);
    expect(order).toEqual(["jpg", "png", "webp"]);
  });

  test("导入时间按时间先后比较", () => {
    const order = sortAssets(assets, { column: "importedAt", direction: "asc" }).map((asset) => asset.imported_at);
    expect(order).toEqual(["2026-08-18T00:00:00Z", "2026-08-20T00:00:00Z", "2026-08-21T00:00:00Z"]);
  });

  test("相同键值保持原相对顺序（稳定排序）", () => {
    const tied = [makeAsset({ hash: "first", imported_at: "2026-08-19T00:00:00Z" }), makeAsset({ hash: "second", imported_at: "2026-08-19T00:00:00Z" })];
    expect(sortAssets(tied, { column: "importedAt", direction: "asc" }).map((asset) => asset.hash)).toEqual(["first", "second"]);
  });

  test("不修改输入数组", () => {
    const input = [...assets];
    sortAssets(input, { column: "filename", direction: "asc" });
    expect(input.map((asset) => asset.hash)).toEqual(["b", "a", "c"]);
  });

  test("空结果返回空数组且未知列抛错（穷尽保护）", () => {
    expect(sortAssets([], DEFAULT_SORT)).toEqual([]);
    // 经 Reflect.set 伪造编译期类型不允许的非法列，验证穷尽 switch 的保护分支。
    const bogus: AssetSort = { ...DEFAULT_SORT };
    Reflect.set(bogus, "column", "nonexistent");
    expect(() => sortAssets(assets, bogus)).toThrow();
  });
});
