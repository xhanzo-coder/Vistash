// @vitest-environment jsdom

import { expect, test } from "vitest";

import { shouldClaimPaste } from "./pasteClaim";

/**
 * 窗口级 Ctrl+V 的认领规则（任务 5.2，接线随任务 5.3）。
 *
 * asset-transfer 规格：文本输入控件获得焦点时 Ctrl+V 必须保持普通文本粘贴，
 * 只有事件目标不属于可编辑控件时，图片工作区才认领这次粘贴并尝试导入剪贴板。
 */
function editable(tag: string, attributes: Record<string, string> = {}): EventTarget {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  document.body.append(element);
  return element;
}

test("文本编辑控件不认领 Ctrl+V", () => {
  // 输入框、多行文本与可编辑区域都保持原生粘贴：备注、搜索框里的
  // Ctrl+V 与图片导入无关，抢走它等于破坏普通文本工作流。
  expect(shouldClaimPaste(editable("input"))).toBe(false);
  expect(shouldClaimPaste(editable("input", { readonly: "" }))).toBe(false);
  expect(shouldClaimPaste(editable("textarea"))).toBe(false);
  expect(shouldClaimPaste(editable("div", { contenteditable: "true" }))).toBe(false);
});

test("普通位置与无目标时由图片工作区认领", () => {
  expect(shouldClaimPaste(editable("div"))).toBe(true);
  expect(shouldClaimPaste(document.body)).toBe(true);
  // 键盘事件可能派发到 window 本身：没有具体目标也按"工作区在焦点"处理。
  expect(shouldClaimPaste(null)).toBe(true);
});
