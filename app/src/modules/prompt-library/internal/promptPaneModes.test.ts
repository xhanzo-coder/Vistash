import { expect, test } from "vitest";

import { promptPaneModes } from "./promptPaneModes";

test("提示词栏位按 1050/780 两个独立断点切换", () => {
  expect(promptPaneModes(1200)).toEqual({ rail: "inline", inspector: "inline" });
  expect(promptPaneModes(1050)).toEqual({ rail: "drawer", inspector: "inline" });
  expect(promptPaneModes(900)).toEqual({ rail: "drawer", inspector: "inline" });
  expect(promptPaneModes(780)).toEqual({ rail: "drawer", inspector: "drawer" });
  expect(promptPaneModes(700)).toEqual({ rail: "drawer", inspector: "drawer" });
});
