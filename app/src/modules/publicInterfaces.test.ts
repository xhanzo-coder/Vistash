import { expectTypeOf, test } from "vitest";

import type { AssetId, LibraryId } from "../app/common";
import type { AssetLibraryEntry } from "./asset-library";
import type { OpenLibrarySession } from "./library-lifecycle";

test("模块唯一公共出口以品牌类型表达库身份与素材身份", () => {
  type LocatedAssetId = Extract<AssetLibraryEntry, { kind: "locate" }>["hash"];

  expectTypeOf<OpenLibrarySession["id"]>().toEqualTypeOf<LibraryId>();
  expectTypeOf<LocatedAssetId>().toEqualTypeOf<AssetId>();
  expectTypeOf<OpenLibrarySession["id"]>().not.toEqualTypeOf<LocatedAssetId>();
});
