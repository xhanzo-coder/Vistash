/**
 * 共同/混合检查器摘要的纯计算合同（任务 8.5，v3 单归属语义）。
 *
 * 多选时检查器只呈现组织事实的交集与分歧：完全一致原样展示；标签这类多值字段
 * 存在分歧时标记为混合但仍携带共同子集。图片的文件夹是单值——全等（含同为未
 * 分类）即共同；提示词仍多归属，沿用列表共同子集。空集没有摘要可言。
 */

import { describe, expect, test } from "vitest";

import { summarizeCommon, summarizePromptCommon } from "./inspectorSummary";

describe("图片多选摘要（单归属）", () => {
  test("空集没有任何共同值", () => {
    expect(summarizeCommon([])).toEqual({
      tags: { kind: "empty" },
      folder: { kind: "empty" },
      favorite: { kind: "empty" },
    });
  });

  test("单项选择即该项的全部组织事实", () => {
    const summary = summarizeCommon([
      { tags: ["夜景", "人像"], folder: "人物", favorite: true },
    ]);
    expect(summary.tags).toEqual({ kind: "common", values: ["夜景", "人像"] });
    expect(summary.folder).toEqual({ kind: "common", value: "人物" });
    expect(summary.favorite).toEqual({ kind: "common", value: true });
  });

  test("共有标签作为共同子集保留；存在分歧时标记混合但不丢失共同值", () => {
    const summary = summarizeCommon([
      { tags: ["夜景", "人像", "胶片"], folder: "人物", favorite: false },
      { tags: ["人像", "街拍"], folder: "人物", favorite: false },
      { tags: ["人像"], folder: null, favorite: false },
    ]);
    // 共同标签保持首项出现顺序；三项标签并不完全一致 → 混合。
    expect(summary.tags).toEqual({ kind: "mixed", values: ["人像"] });
    // 归属不一致就是不一致：单归属没有"部分共同"，也不携带子集。
    expect(summary.folder).toEqual({ kind: "mixed" });
    expect(summary.favorite).toEqual({ kind: "common", value: false });
  });

  test("同为未分类是合法的共同值", () => {
    const summary = summarizeCommon([
      { tags: [], folder: null, favorite: false },
      { tags: [], folder: null, favorite: false },
    ]);
    expect(summary.folder).toEqual({ kind: "common", value: null });
  });

  test("一方未分类而另一方有归属判为混合", () => {
    const summary = summarizeCommon([
      { tags: [], folder: null, favorite: false },
      { tags: [], folder: "人物", favorite: false },
    ]);
    expect(summary.folder).toEqual({ kind: "mixed" });
  });

  test("收藏二值不一致时报告混合", () => {
    const summary = summarizeCommon([
      { tags: [], folder: null, favorite: true },
      { tags: [], folder: null, favorite: false },
    ]);
    expect(summary.favorite).toEqual({ kind: "mixed" });
  });
});

describe("提示词多选摘要（多归属）", () => {
  test("文件夹集合完全一致报共同，部分重叠带共同子集判为混合", () => {
    const same = summarizePromptCommon([
      { tags: [], folders: ["人物", "室内"], favorite: false },
      { tags: [], folders: ["人物", "室内"], favorite: false },
    ]);
    expect(same.folders).toEqual({ kind: "common", values: ["人物", "室内"] });

    const partial = summarizePromptCommon([
      { tags: [], folders: ["人物"], favorite: false },
      { tags: [], folders: ["人物", "室内"], favorite: false },
    ]);
    expect(partial.folders).toEqual({ kind: "mixed", values: ["人物"] });
  });
});
