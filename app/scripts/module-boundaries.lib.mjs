/**
 * 模块边界结构检查（任务 6.4，设计第二条与第三条）。
 *
 * 规则只有三条，全部由 `src/modules/<name>/` 的路径形态推导：
 * 1. 跨模块导入落到其他模块的 `internal/` 下——违规。
 * 2. 跨模块导入没有落在该模块的 `index.ts` 上——违规（唯一公共出口）。
 * 3. `src/shared/` 是传输层，不得反向导入任何模块。
 *
 * 说明符提取按本仓库受控代码风格做正则解析（TypeScript 7 不再暴露 JS 编译器
 * API），覆盖多行具名导入、type-only、副作用导入、re-export 与动态 import；
 * 解析与裁决行为由 scripts/module-boundaries.test.mjs 的夹具钉死。
 */

import { posix } from "node:path";

const MODULES_ROOT = "src/modules/";
const SHARED_ROOT = "src/shared/";

const SPECIFIER_PATTERNS = [
  // import ... from "..."（含 type-only 与多行具名导入）
  /\bimport\s[^;"']*?from\s*["']([^"'\n]+)["']/g,
  // export ... from "..."
  /\bexport\s[^;"']*?from\s*["']([^"'\n]+)["']/g,
  // await import("...")
  /\bimport\s*\(\s*["']([^"'\n]+)["']/g,
  // 副作用导入 import "..."
  /\bimport\s*["']([^"'\n]+)["']/g,
];

/** 从一份源码文本提取全部静态/动态导入说明符。 */
export function extractImportSpecifiers(text) {
  const specifiers = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match !== null) {
      specifiers.push(match[1]);
      match = pattern.exec(text);
    }
  }
  return specifiers;
}

function ownerModuleOf(path) {
  if (!path.startsWith(MODULES_ROOT)) return null;
  const rest = path.slice(MODULES_ROOT.length);
  const slash = rest.indexOf("/");
  return slash > 0 ? rest.slice(0, slash) : null;
}

function stripSourceExtension(path) {
  return path.replace(/\.tsx?$/, "");
}

/** 把相对说明符解析为已存在的目标文件；裸包名或无法命中已知文件时返回 null。 */
function resolveTarget(fromPath, specifier, knownFiles) {
  if (!specifier.startsWith(".")) return null;
  const base = posix.normalize(posix.join(posix.dirname(fromPath), specifier));
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    posix.join(base, "index.ts"),
    posix.join(base, "index.tsx"),
  ];
  for (const candidate of candidates) {
    if (knownFiles.has(candidate)) return candidate;
  }
  return null;
}

/**
 * 裁决模块边界。
 *
 * @param {{ files: Array<{ path: string, text: string }> }} input
 *   path 为相对仓库 app 目录的 POSIX 路径（如 `src/App.tsx`）。
 * @returns 违规列表，每条含 file / specifier / target / rule。
 */
export function analyzeBoundaries({ files }) {
  const knownFiles = new Set(files.map((file) => file.path));
  const violations = [];

  for (const file of files) {
    const importerOwner = ownerModuleOf(file.path);
    for (const specifier of extractImportSpecifiers(file.text)) {
      const rawTarget = resolveTarget(file.path, specifier, knownFiles);
      if (rawTarget === null) continue;
      const target = stripSourceExtension(rawTarget);
      const targetOwner = ownerModuleOf(target);

      if (targetOwner === null) continue;

      if (file.path.startsWith(SHARED_ROOT)) {
        violations.push({
          file: file.path,
          specifier,
          target: rawTarget,
          rule: "reverse-dependency-from-shared",
        });
        continue;
      }

      if (targetOwner === importerOwner) continue;

      if (target.startsWith(`${MODULES_ROOT}${targetOwner}/internal/`)) {
        violations.push({
          file: file.path,
          specifier,
          target: rawTarget,
          rule: "cross-module-internal",
        });
        continue;
      }

      if (target !== `${MODULES_ROOT}${targetOwner}/index`) {
        violations.push({
          file: file.path,
          specifier,
          target: rawTarget,
          rule: "non-index-cross-module-import",
        });
      }
    }
  }

  return violations.sort((a, b) => a.file.localeCompare(b.file) || a.specifier.localeCompare(b.specifier));
}
