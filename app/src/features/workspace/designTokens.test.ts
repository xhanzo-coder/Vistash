/**
 * 设计 token 门禁（任务 8.2）。
 *
 * 设计第九条要求视觉层只确定语义 token：组件样式只允许引用语义名称，占位取值
 * 必须达到对比度门禁。这两条都做成自动检查而不是一次性目视——目视只在写下这条
 * 时有效，而门禁要长期成立：
 *
 * 1. `styles.css` 的 `:root` 之外不得出现任何裸颜色（hex 或 rgb/hsl 函数），
 *    结构与视觉的隔离因此可以被机器验证；
 * 2. 关键前景/背景组合的 WCAG 对比度不低于 4.5（正文）或 3（非文本边界与焦点环）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

// 门禁检查的是仓库里这份 styles.css 原文（浏览器加载的正是它的产物），
// 经 Vite 管道反而会被测试环境的 CSS 桩替换成空串。
const css = readFileSync(join(import.meta.dirname, "..", "..", "styles.css"), "utf8");

/** 从 :root 块提取全部语义 token 取值。 */
function rootTokens(): Map<string, string> {
  const body = css.match(/:root\s*\{([^}]*)\}/)?.[1];
  if (body === undefined) throw new Error("styles.css 缺少 :root token 块");
  const tokens = new Map<string, string>();
  for (const entry of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    const name = entry[1];
    const value = entry[2];
    if (name === undefined || value === undefined) continue;
    tokens.set(name, value.trim());
  }
  return tokens;
}

const tokens = rootTokens();

function channel(value: string): number {
  const raw = Number.parseInt(value, 16) / 255;
  return raw <= 0.03928 ? raw / 12.92 : ((raw + 0.055) / 1.055) ** 2.4;
}

/** 六位 hex 的相对亮度。 */
function luminance(hex: string): number {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) {
    throw new Error(`token 取值不是六位 hex：${hex}`);
  }
  return (
    0.2126 * channel(hex.slice(1, 3)) +
    0.7152 * channel(hex.slice(3, 5)) +
    0.0722 * channel(hex.slice(5, 7))
  );
}

function contrast(foregroundHex: string, backgroundHex: string): number {
  const a = luminance(foregroundHex);
  const b = luminance(backgroundHex);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function resolve(name: string): string {
  const value = tokens.get(name);
  if (value === undefined) throw new Error(`缺少语义 token：${name}`);
  // token 允许引用另一个 token；这里只处理单层引用，占位主题不嵌套更深。
  const target = value.match(/^var\((--[\w-]+)\)$/)?.[1];
  return target === undefined ? value : (tokens.get(target) ?? value);
}

test("语义 token 覆盖表面/文本/边界/强调/选中/焦点/危险/间距/字号/字体/阴影/动效", () => {
  const required = [
    "--surface-canvas",
    "--surface-paper",
    "--surface-card",
    "--surface-raised",
    "--surface-sunken",
    "--surface-rail",
    "--surface-backdrop",
    "--text-primary",
    "--text-secondary",
    "--text-on-accent",
    "--text-on-rail",
    "--text-on-rail-muted",
    "--border-subtle",
    "--border-strong",
    "--accent",
    "--accent-strong",
    "--selected-bg-on-rail",
    "--focus-ring",
    "--focus-ring-on-rail",
    "--danger",
    "--danger-strong",
    "--space-1",
    "--space-2",
    "--space-3",
    "--space-4",
    "--space-6",
    "--text-size-xs",
    "--text-size-sm",
    "--text-size-lg",
    "--font-body",
    "--font-display",
    "--font-mono",
    "--shadow-panel",
    "--shadow-dialog",
    "--motion-fast",
    "--motion-base",
    "--motion-ease",
  ];
  const missing = required.filter((name) => !tokens.has(name));
  expect(missing).toEqual([]);
});

test(":root 之外不得出现任何裸颜色", () => {
  const outside = css.replace(/:root\s*\{[^}]*\}/, "");
  const offenders = outside.match(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/g) ?? [];
  expect(offenders).toEqual([]);
});

test("正文与次级文本对纸面至少 4.5:1", () => {
  const paper = resolve("--surface-paper");
  expect(contrast(resolve("--text-primary"), paper)).toBeGreaterThanOrEqual(4.5);
  expect(contrast(resolve("--text-secondary"), paper)).toBeGreaterThanOrEqual(4.5);
});

test("强调面上的文字、强调色文本与危险文本至少 4.5:1", () => {
  expect(contrast(resolve("--text-on-accent"), resolve("--accent"))).toBeGreaterThanOrEqual(4.5);
  expect(contrast(resolve("--danger-strong"), resolve("--surface-paper"))).toBeGreaterThanOrEqual(
    4.5,
  );
});

test("深色左栏上的两级文本至少 4.5:1", () => {
  const rail = resolve("--surface-rail");
  expect(contrast(resolve("--text-on-rail"), rail)).toBeGreaterThanOrEqual(4.5);
  expect(contrast(resolve("--text-on-rail-muted"), rail)).toBeGreaterThanOrEqual(4.5);
});

test("焦点环对其相邻表面至少 3:1，边界强色对纸面至少 3:1", () => {
  expect(contrast(resolve("--focus-ring"), resolve("--surface-paper"))).toBeGreaterThanOrEqual(3);
  expect(
    contrast(resolve("--focus-ring-on-rail"), resolve("--surface-rail")),
  ).toBeGreaterThanOrEqual(3);
  expect(contrast(resolve("--border-strong"), resolve("--surface-paper"))).toBeGreaterThanOrEqual(
    3,
  );
});

test("动效时长尊重 prefers-reduced-motion：reduce 下归零", () => {
  // reduce 分支重新定义同一批 token 为 0ms——组件无需写两份过渡规则。
  const reduceBlock = css.match(/prefers-reduced-motion:\s*reduce[^{]*\{([^}]*)\}/);
  if (reduceBlock === null) throw new Error("缺少 prefers-reduced-motion: reduce 的 token 归零块");
  expect(reduceBlock[1]).toContain("--motion-fast: 0ms");
  expect(reduceBlock[1]).toContain("--motion-base: 0ms");
});
