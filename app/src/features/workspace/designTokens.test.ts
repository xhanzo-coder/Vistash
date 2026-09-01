/**
 * 生产设计基础合同。
 *
 * 测试只观察公开 CSS 入口与冻结的品牌语义：业务组件可以彻底重写，只要继续
 * 通过相同 token 获得主题、焦点与动效行为，本合同就不会被实现细节牵动。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const stylesRoot = join(import.meta.dirname, "..", "..", "styles");
const tokensCss = readFileSync(join(stylesRoot, "tokens.css"), "utf8");
const globalsCss = readFileSync(join(stylesRoot, "globals.css"), "utf8");

function tokenBlock(selector: string): Map<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = tokensCss.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1];
  if (body === undefined) throw new Error(`tokens.css 缺少 ${selector} token 块`);
  const tokens = new Map<string, string>();
  for (const entry of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    const name = entry[1];
    const value = entry[2];
    if (name !== undefined && value !== undefined) tokens.set(name, value.trim());
  }
  return tokens;
}

const light = tokenBlock(":root");
const darkOverrides = tokenBlock('[data-theme="dark"]');
const dark = new Map([...light, ...darkOverrides]);

function channel(value: string): number {
  const raw = Number.parseInt(value, 16) / 255;
  return raw <= 0.03928 ? raw / 12.92 : ((raw + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) throw new Error(`token 取值不是六位 hex：${hex}`);
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

function resolve(tokens: Map<string, string>, name: string): string {
  const value = tokens.get(name);
  if (value === undefined) throw new Error(`缺少语义 token：${name}`);
  const target = value.match(/^var\((--[\w-]+)\)$/)?.[1];
  return target === undefined ? value : resolve(tokens, target);
}

test("品牌锚点、字体与完整语义 token 已冻结", () => {
  const required = [
    "--surface-canvas",
    "--surface-panel",
    "--surface-raised",
    "--surface-sunken",
    "--surface-input",
    "--surface-backdrop",
    "--text-primary",
    "--text-secondary",
    "--text-tertiary",
    "--text-on-accent",
    "--border-subtle",
    "--border-strong",
    "--accent",
    "--accent-hover",
    "--selection-surface",
    "--selection-edge",
    "--focus-ring",
    "--status-success",
    "--status-warning",
    "--status-danger",
    "--space-1",
    "--space-2",
    "--space-3",
    "--space-4",
    "--space-6",
    "--radius-control",
    "--radius-panel",
    "--shadow-panel",
    "--motion-fast",
    "--motion-layout",
    "--z-sticky",
    "--z-dialog",
    "--font-ui",
    "--font-display",
    "--font-mono",
  ];
  expect(required.filter((name) => !light.has(name))).toEqual([]);
  expect(resolve(dark, "--surface-canvas")).toBe("#111313");
  expect(resolve(dark, "--surface-panel")).toBe("#171919");
  expect(resolve(dark, "--text-primary")).toBe("#ebe7dd");
  expect(resolve(light, "--accent")).toBe("#e8664a");
  expect(resolve(dark, "--status-success")).toBe("#6e9b73");
  expect(resolve(light, "--font-ui")).toBe('Bahnschrift, "Microsoft YaHei UI", sans-serif');
  expect(resolve(light, "--font-display")).toBe("Georgia, SimSun, serif");
});

test("深浅主题正文、次级文本、主操作与焦点环达到对比度门禁", () => {
  for (const theme of [light, dark]) {
    const panel = resolve(theme, "--surface-panel");
    expect(contrast(resolve(theme, "--text-primary"), panel)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(resolve(theme, "--text-secondary"), panel)).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(resolve(theme, "--text-on-accent"), resolve(theme, "--accent")),
    ).toBeGreaterThanOrEqual(4.5);
    expect(contrast(resolve(theme, "--focus-ring"), panel)).toBeGreaterThanOrEqual(3);
  }
});

test("全局规则没有散落主题颜色，组件只能消费语义 token", () => {
  const offenders = globalsCss.match(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/g) ?? [];
  expect(offenders).toEqual([]);
});

test("减少动态效果会取消位移距离并把非必要过渡归零", () => {
  expect(tokensCss).toContain("@media (prefers-reduced-motion: reduce)");
  expect(tokensCss).toContain("--motion-fast: 0ms");
  expect(tokensCss).toContain("--motion-layout: 0ms");
  expect(tokensCss).toContain("--motion-distance: 0px");
});
