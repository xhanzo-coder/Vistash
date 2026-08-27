import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  prepareE2eAppConfig,
  readUtf8,
  restoreE2eAppConfig,
  withE2eAppConfig,
} from "./e2e-app-config.mjs";

function withTempRoot(run) {
  const root = mkdtempSync(join(tmpdir(), "vistash-e2e-config-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true });
  }
}

test("有原配置时完整备份并逐字恢复", () => {
  withTempRoot((root) => {
    const appData = join(root, "app-data");
    const backup = join(root, "app-data.backup");
    mkdirSync(appData);
    writeFileSync(join(appData, "settings.json"), "原配置：中文", { encoding: "utf8" });

    const prepared = prepareE2eAppConfig({ appData, backup, library: "E:\\测试库" });
    assert.equal(prepared.hadOriginal, true);
    assert.match(readUtf8(join(appData, "settings.json")), /E:\\\\测试库/);
    restoreE2eAppConfig({ appData, backup, ...prepared, stopApp: () => {} });

    assert.equal(readUtf8(join(appData, "settings.json")), "原配置：中文");
    assert.equal(existsSync(backup), false);
  });
});

test("没有原配置时恢复只删除测试目录", () => {
  withTempRoot((root) => {
    const appData = join(root, "app-data");
    const backup = join(root, "app-data.backup");
    const prepared = prepareE2eAppConfig({ appData, backup, library: "E:\\测试库" });

    restoreE2eAppConfig({ appData, backup, ...prepared, stopApp: () => {} });

    assert.equal(existsSync(appData), false);
    assert.equal(existsSync(backup), false);
  });
});

test("停止应用失败时不删除测试配置或原配置备份", () => {
  withTempRoot((root) => {
    const appData = join(root, "app-data");
    const backup = join(root, "app-data.backup");
    mkdirSync(appData);
    writeFileSync(join(appData, "settings.json"), "原配置", { encoding: "utf8" });
    const prepared = prepareE2eAppConfig({ appData, backup, library: "E:\\测试库" });

    assert.throws(
      () =>
        restoreE2eAppConfig({
          appData,
          backup,
          ...prepared,
          stopApp: () => {
            throw new Error("应用仍在运行");
          },
        }),
      /应用仍在运行/,
    );

    assert.equal(existsSync(appData), true);
    assert.equal(readUtf8(join(backup, "settings.json")), "原配置");
  });
});

test("应用异步启动失败仍恢复原配置", async () => {
  const root = mkdtempSync(join(tmpdir(), "vistash-e2e-config-"));
  try {
    const appData = join(root, "app-data");
    const backup = join(root, "app-data.backup");
    mkdirSync(appData);
    writeFileSync(join(appData, "settings.json"), "启动前配置", { encoding: "utf8" });

    await assert.rejects(
      withE2eAppConfig(
        { appData, backup, library: "E:\\测试库", stopApp: () => {} },
        async () => {
          throw new Error("spawn EACCES");
        },
      ),
      /spawn EACCES/,
    );

    assert.equal(readUtf8(join(appData, "settings.json")), "启动前配置");
    assert.equal(existsSync(backup), false);
  } finally {
    rmSync(root, { recursive: true });
  }
});
