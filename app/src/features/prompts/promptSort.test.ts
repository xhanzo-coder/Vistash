import { describe, expect, test } from "vitest";

import type { PromptRow } from "../../shared/types";
import { DEFAULT_PROMPT_SORT, sortPrompts } from "./promptSort";

function makePrompt(id: string, overrides: Partial<PromptRow> = {}): PromptRow {
  return {
    id,
    body: `正文 ${id}`,
    title: null,
    model: null,
    parameters: null,
    note: "",
    favorite: false,
    folders: [],
    tags: [],
    linked_image_hashes: [],
    cover_image_hash: null,
    resolved_cover_hash: null,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    deleted_at: null,
    ...overrides,
  };
}

describe("提示词列表排序", () => {
  test("默认按更新时间降序", () => {
    const rows = [
      makePrompt("a", { updated_at: "2026-08-10T00:00:00Z" }),
      makePrompt("b", { updated_at: "2026-08-20T00:00:00Z" }),
      makePrompt("c", { updated_at: "2026-08-15T00:00:00Z" }),
    ];
    expect(sortPrompts(rows, DEFAULT_PROMPT_SORT).map((row) => row.id)).toEqual(["b", "c", "a"]);
  });

  test("标题列用展示标题：缺省标题回落正文首行参与比较", () => {
    const rows = [
      makePrompt("x", { title: null, body: "乙方案" }),
      makePrompt("y", { title: "甲标题", body: "无关正文" }),
      makePrompt("z", { title: null, body: "丙方案" }),
    ];
    // zh 排序按拼音：丙(bing) < 甲(jia) < 乙(yi)。
    const sorted = sortPrompts(rows, { column: "title", direction: "asc" });
    expect(sorted.map((row) => row.id)).toEqual(["z", "y", "x"]);
  });

  test("模型列把缺省值恒排在有值之后且不打乱相对顺序", () => {
    const rows = [
      makePrompt("n1", { model: null }),
      makePrompt("m2", { model: "sd-xl" }),
      makePrompt("n2", { model: null }),
      makePrompt("m1", { model: "flux" }),
    ];
    const sorted = sortPrompts(rows, { column: "model", direction: "asc" });
    expect(sorted.map((row) => row.id)).toEqual(["m1", "m2", "n1", "n2"]);

    // 降序与图片侧 sortAssets 同构：乘子统一作用于比较结果，缺省组随之翻到
    // 前面但仍保持成组，顺序确定不打乱。
    const desc = sortPrompts(rows, { column: "model", direction: "desc" });
    expect(desc.map((row) => row.id)).toEqual(["n1", "n2", "m2", "m1"]);
  });

  test("不修改输入数组，空结果返回空数组", () => {
    const rows = [makePrompt("b"), makePrompt("a")];
    const sorted = sortPrompts(rows, { column: "title", direction: "asc" });
    expect(rows.map((row) => row.id)).toEqual(["b", "a"]);
    expect(sorted).not.toBe(rows);
    expect(sortPrompts([], DEFAULT_PROMPT_SORT)).toEqual([]);
  });
});
