// 模块边界结构检查的测试（任务 6.4，设计第二条与第三条）。
//
// 前半部分用合成文件钉死分析器的解析与裁决规则；后半部分扫描真实 src 树，
// 保证当前代码零违规，并确认四个模块的唯一公共出口已经建立。

import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { analyzeBoundaries } from "./module-boundaries.lib.mjs";

const APP_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SRC_ROOT = join(APP_ROOT, "src");

function collectSourceFiles(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

test("同模块内部可以自由导入自己的 internal 实现", () => {
  const violations = analyzeBoundaries({
    files: [
      {
        path: "src/modules/asset-library/index.ts",
        text: `export { CollectionView } from "./internal/collection";\n`,
      },
      {
        path: "src/modules/asset-library/internal/collection/session.ts",
        text: `import { queryKey } from "../keys";\nexport const x = queryKey;\n`,
      },
      {
        path: "src/modules/asset-library/internal/collection/keys.ts",
        text: `export const queryKey = ["assets"];\n`,
      },
    ],
  });
  assert.deepEqual(violations, []);
});

test("跨模块导入 internal 是违规并指明双方", () => {
  const violations = analyzeBoundaries({
    files: [
      {
        path: "src/modules/prompt-library/internal/workspace.ts",
        text: `import { selectionStore } from "../../asset-library/internal/selection/store";\n`,
      },
      {
        path: "src/modules/asset-library/internal/selection/store.ts",
        text: `export const selectionStore = {};\n`,
      },
    ],
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, "cross-module-internal");
  assert.equal(violations[0].file, "src/modules/prompt-library/internal/workspace.ts");
  assert.equal(violations[0].target, "src/modules/asset-library/internal/selection/store.ts");
});

test("跨模块绕过 index 导入深部文件是违规", () => {
  const violations = analyzeBoundaries({
    files: [
      {
        path: "src/App.tsx",
        text: `import { session } from "./modules/asset-library/session";\n`,
      },
      {
        path: "src/modules/asset-library/session.ts",
        text: `export const session = {};\n`,
      },
    ],
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, "non-index-cross-module-import");
});

test("经 index 的跨模块导入合法：根形式与显式 index 形式等价", () => {
  for (const specifier of ['./modules/asset-library', './modules/asset-library/index.ts']) {
    const violations = analyzeBoundaries({
      files: [
        { path: "src/App.tsx", text: `import { AssetLibraryWorkspace } from "${specifier}";\n` },
        {
          path: "src/modules/asset-library/index.ts",
          text: `export function AssetLibraryWorkspace() { return null; }\n`,
        },
      ],
    });
    assert.deepEqual(violations, [], `specifier ${specifier} 应当合法`);
  }
});

test("shared 层不得反向导入任何模块", () => {
  const violations = analyzeBoundaries({
    files: [
      {
        path: "src/shared/ipc.ts",
        text: `import { keys } from "../modules/asset-library";\n`,
      },
      { path: "src/modules/asset-library/index.ts", text: `export const keys = [];\n` },
    ],
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, "reverse-dependency-from-shared");
});

test("解析器覆盖多行具名导入、type-only、副作用、re-export 与动态 import", () => {
  const importerText = [
    `import {`,
    `  AssetRow,`,
    `} from "./modules/asset-library/internal/types";`,
    ``,
    `import type { PromptRow } from "./modules/prompt-library/internal/types";`,
    ``,
    `import "./modules/library-lifecycle/internal/bootstrap";`,
    ``,
    `export { reuse } from "./modules/asset-library/internal/reuse";`,
    ``,
    `void import("./modules/asset-library/internal/lazy");`,
  ].join("\n");
  const violations = analyzeBoundaries({
    files: [
      { path: "src/App.tsx", text: importerText },
      { path: "src/modules/asset-library/internal/types.ts", text: "" },
      { path: "src/modules/prompt-library/internal/types.ts", text: "" },
      { path: "src/modules/library-lifecycle/internal/bootstrap.ts", text: "" },
      { path: "src/modules/asset-library/internal/reuse.ts", text: "" },
      { path: "src/modules/asset-library/internal/lazy.ts", text: "" },
    ],
  });
  // 五种形态全部命中：五个目标都在其他模块的 internal/ 下；副作用导入也在内。
  assert.equal(violations.length, 5);
  for (const violation of violations) {
    assert.equal(violation.rule, "cross-module-internal");
    assert.equal(violation.file, "src/App.tsx");
  }
});

test("裸包说明符不参与边界裁决", () => {
  const violations = analyzeBoundaries({
    files: [
      {
        path: "src/main.tsx",
        text: [
          `import React from "react";`,
          `import { createRoot } from "react-dom/client";`,
          `import { invoke } from "@tauri-apps/api/core";`,
        ].join("\n"),
      },
    ],
  });
  assert.deepEqual(violations, []);
});

test("四个模块的唯一公共出口已建立且自述边界契约", () => {
  for (const name of ["library-lifecycle", "asset-library", "prompt-library", "image-prompt-relations"]) {
    const indexPath = join(SRC_ROOT, "modules", name, "index.ts");
    assert.ok(existsSync(indexPath), `${name}/index.ts 必须存在`);
    const text = readFileSync(indexPath, "utf8");
    assert.match(text, /唯一公共出口/, `${name}/index.ts 必须声明自己是唯一公共出口`);
  }
});

test("真实 src 树当前零违规", () => {
  const files = collectSourceFiles(SRC_ROOT).map((full) => ({
    path: full.replaceAll("\\", "/").slice(APP_ROOT.length + 1),
    text: readFileSync(full, "utf8"),
  }));
  const violations = analyzeBoundaries({ files });
  assert.deepEqual(
    violations.map((v) => `${v.file} -> ${v.specifier}`),
    [],
  );
});
