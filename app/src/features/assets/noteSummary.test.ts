import { describe, expect, test } from "vitest";

import { noteSummary } from "./noteSummary";

describe("noteSummary", () => {
  test("空备注摘要为空字符串", () => {
    expect(noteSummary("", 40)).toBe("");
  });

  test("多行备注取首个非空行并折叠内部空白", () => {
    expect(noteSummary("\n  第一行说明  \n第二行 \n\n", 40)).toBe("第一行说明");
    expect(noteSummary("一   二\t三", 40)).toBe("一 二 三");
  });

  test("超长首行截断并追加省略号", () => {
    const summary = noteSummary("一二三四五六七", 5);
    expect(summary).toBe("一二三四五…");
    expect(summary.length).toBe(6);
  });

  test("恰好等于上限时不追加省略号", () => {
    expect(noteSummary("一二三四五", 5)).toBe("一二三四五");
  });

  test("全部为空白行的备注摘要为空字符串", () => {
    expect(noteSummary("  \n \n ", 40)).toBe("");
  });
});
