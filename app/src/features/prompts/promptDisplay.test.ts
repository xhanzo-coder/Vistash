import { describe, expect, test } from "vitest";

import { firstBodyLine, promptDisplayTitle } from "./promptDisplay";

describe("提示词展示标题", () => {
  test("显式标题优先于正文", () => {
    expect(promptDisplayTitle({ title: "电影感夜景", body: "cinematic night, rim light" })).toBe(
      "电影感夜景",
    );
  });

  test("标题缺省时用正文首个非空行", () => {
    expect(promptDisplayTitle({ title: null, body: "\n  \ncinematic night\nrim light" })).toBe(
      "cinematic night",
    );
  });

  test("纯空白标题视同缺省", () => {
    expect(promptDisplayTitle({ title: "   ", body: "a lone lighthouse" })).toBe(
      "a lone lighthouse",
    );
  });

  test("正文全是空行时回退到去空白正文而不是空串", () => {
    expect(firstBodyLine("\n \n\t\n")).toBe("");
    // 空串会让卡片失去可识别名称，因此调用方拿到的值仍可安全渲染。
    expect(promptDisplayTitle({ title: null, body: "" })).toBe("");
  });
});
