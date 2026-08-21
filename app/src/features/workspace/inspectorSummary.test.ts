/**
 * 共同/混合检查器摘要的纯计算合同（任务 8.5）。
 *
 * 多选时检查器只呈现组织事实的交集与分歧：完全一致原样展示；多值字段存在分歧时
 * 标记为混合但仍携带共同子集（UI 呈现「夜景、人像（混合）」）；空集没有摘要可言。
 */

import { describe, expect, test } from "vitest";

import { summarizeCommon } from "./inspectorSummary";

describe("共同/混合摘要", () => {
  test("空集没有任何共同值", () => {
    expect(summarizeCommon([])).toEqual({
      tags: { kind: "empty" },
      folders: { kind: "empty" },
      favorite: { kind: "empty" },
    });
  });

  test("单项选择即该项的全部组织事实", () => {
    const summary = summarizeCommon([
      { tags: ["夜景", "人像"], folders: ["人物"], favorite: true },
    ]);
    expect(summary.tags).toEqual({ kind: "common", values: ["夜景", "人像"] });
    expect(summary.folders).toEqual({ kind: "common", values: ["人物"] });
    expect(summary.favorite).toEqual({ kind: "common", value: true });
  });

  test("共有标签作为共同子集保留；存在分歧时标记混合但不丢失共同值", () => {
    const summary = summarizeCommon([
      { tags: ["夜景", "人像", "胶片"], folders: ["人物"], favorite: false },
      { tags: ["人像", "街拍"], folders: ["人物"], favorite: false },
      { tags: ["人像"], folders: ["人物", "风景"], favorite: false },
    ]);
    // 共同标签保持首项出现顺序；三项标签并不完全一致 → 混合。
    expect(summary.tags).toEqual({ kind: "mixed", values: ["人像"] });
    expect(summary.folders).toEqual({ kind: "mixed", values: ["人物"] });
    expect(summary.favorite).toEqual({ kind: "common", value: false });
  });

  test("收藏二值不一致时报告混合", () => {
    const summary = summarizeCommon([
      { tags: [], folders: [], favorite: true },
      { tags: [], folders: [], favorite: false },
    ]);
    expect(summary.favorite).toEqual({ kind: "mixed" });
  });

  test("文件夹集合完全一致报共同，部分重叠与单方根位置都判为混合", () => {
    const same = summarizeCommon([
      { tags: [], folders: ["人物", "室内"], favorite: false },
      { tags: [], folders: ["人物", "室内"], favorite: false },
    ]);
    expect(same.folders).toEqual({ kind: "common", values: ["人物", "室内"] });

    const partial = summarizeCommon([
      { tags: [], folders: ["人物"], favorite: false },
      { tags: [], folders: ["人物", "室内"], favorite: false },
    ]);
    expect(partial.folders).toEqual({ kind: "mixed", values: ["人物"] });

    // 一方完全没有文件夹（根位置）而另一方有：同样是混合，且没有共同子集可带。
    const oneRooted = summarizeCommon([
      { tags: [], folders: [], favorite: false },
      { tags: [], folders: ["人物"], favorite: false },
    ]);
    expect(oneRooted.folders).toEqual({ kind: "mixed", values: [] });
  });
});
