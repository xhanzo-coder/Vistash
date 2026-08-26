import { describe, expect, expectTypeOf, test } from "vitest";

import {
  assetLocationScope,
  locateRequestFromSelection,
  type GlobalSearch,
  type GlobalSearchSelection,
} from "./globalSearch";
import { visitNavigationEntry } from "./navigation";
import type { AssetRow, PromptRow } from "../shared/types";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function assetRow(opts?: { deletedAt?: string | null; hash?: string }): AssetRow {
  return {
    hash: opts?.hash ?? "a".repeat(64),
    hash_algo: "blake3",
    media_type: "image/png",
    ext: "png",
    byte_size: 1024,
    width: 32,
    height: 32,
    imported_at: "2026-08-26T00:00:00Z",
    original_filename: "逆光.png",
    display_filename: "逆光.png",
    source_path: null,
    deleted_at: opts?.deletedAt ?? null,
    color_card_status: "ok",
    color_card_algo_version: 1,
    color_card_failure_reason: null,
    color_card_sampled_pixel_count: 1024,
    note: "",
    favorite: false,
    tags: [],
    folder: null,
    colors: [],
  };
}

function promptRow(opts?: { id?: string; deletedAt?: string | null }): PromptRow {
  return {
    id: opts?.id ?? "018f3c9e-6c00-7000-8000-000000000001",
    body: "电影感布光",
    title: null,
    model: null,
    parameters: null,
    note: "",
    favorite: false,
    folders: [],
    tags: ["布光"],
    linked_image_hashes: [],
    cover_image_hash: null,
    resolved_cover_hash: null,
    created_at: "2026-08-26T00:00:00Z",
    updated_at: "2026-08-26T00:00:00Z",
    deleted_at: opts?.deletedAt ?? null,
  };
}

describe("assetLocationScope", () => {
  test("deleted_at 是活动/回收站的唯一事实来源，不做任何改道 fallback", () => {
    expect(assetLocationScope(assetRow())).toBe("active");
    expect(assetLocationScope(assetRow({ deletedAt: "2026-08-26T01:00:00Z" }))).toBe("trash");
  });
});

describe("locateRequestFromSelection", () => {
  test("图片结果映射为 locate_asset：哈希与回收站范围原样携带", () => {
    const entry = locateRequestFromSelection({
      kind: "asset",
      row: assetRow({ hash: "b".repeat(64), deletedAt: "2026-08-26T01:00:00Z" }),
    });

    // 回收站里的图片照常可定位——范围由侧车事实决定。
    expect(entry).toMatchObject({
      kind: "locate_asset",
      hash: "b".repeat(64),
      location: "trash",
    });
    expect(entry.requestId).toMatch(UUID_PATTERN);
  });

  test("提示词结果映射为 locate_prompt", () => {
    const promptId = "018f3c9e-6c00-7000-8000-0000000000aa";
    const entry = locateRequestFromSelection({ kind: "prompt", row: promptRow({ id: promptId }) });

    expect(entry).toMatchObject({
      kind: "locate_prompt",
      promptId,
    });
    expect(entry.requestId).toMatch(UUID_PATTERN);
  });

  test("每次选择生成独立的请求身份", () => {
    const first = locateRequestFromSelection({ kind: "asset", row: assetRow() });
    const second = locateRequestFromSelection({ kind: "asset", row: assetRow() });
    expect(first.requestId).not.toBe(second.requestId);
  });

  test("与导航 seam 组合：搜索产物可以直接被穷尽访问器消费", () => {
    const entry = locateRequestFromSelection({
      kind: "prompt",
      row: promptRow({ id: "p-compose" }),
    });
    const label = visitNavigationEntry(entry, {
      resume: () => "resume",
      locateAsset: (e) => `asset:${e.location}`,
      locatePrompt: (e) => `prompt:${e.promptId}`,
    });
    expect(label).toBe("prompt:p-compose");
  });
});

describe("GlobalSearch interface 可实现性", () => {
  test("一个脚本化的最小实现即可满足执行 interface", async () => {
    const result = { assets: [assetRow()], prompts: [promptRow()] };
    const search: GlobalSearch = {
      run: async (text) => (text === "" ? { assets: [], prompts: [] } : result),
    };

    await expect(search.run("逆光")).resolves.toEqual(result);
    await expect(search.run("")).resolves.toEqual({ assets: [], prompts: [] });
  });

  test("选中项的判别键恰好两种——新增素材类型必须显式扩展此处", () => {
    expectTypeOf<GlobalSearchSelection["kind"]>().toEqualTypeOf<"asset" | "prompt">();
  });
});
