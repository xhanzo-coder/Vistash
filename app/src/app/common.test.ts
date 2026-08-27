import { describe, expect, expectTypeOf, test } from "vitest";

import {
  parseAssetId,
  parseLibraryId,
  type AssetId,
  type LibraryId,
} from "./common";

describe("跨模块身份类型", () => {
  test("库 UUID 与素材哈希在进入模块边界时分别校验", () => {
    expect(parseLibraryId("018f3c9e-6c00-7000-8000-0000000000aa")).toBe(
      "018f3c9e-6c00-7000-8000-0000000000aa",
    );
    expect(parseAssetId("a".repeat(64))).toBe("a".repeat(64));

    expect(() => parseLibraryId("a".repeat(64))).toThrow(TypeError);
    expect(() => parseAssetId("018f3c9e-6c00-7000-8000-0000000000aa")).toThrow(TypeError);
    expect(() => parseAssetId("A".repeat(64))).toThrow(TypeError);
  });

  test("LibraryId 与 AssetId 是不相等的品牌类型", () => {
    expectTypeOf<LibraryId>().not.toEqualTypeOf<AssetId>();
    expectTypeOf<AssetId>().not.toEqualTypeOf<LibraryId>();
  });
});
