import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mkdtempSync } from "node:fs";

import { verifyReleaseContract, writeReleaseChecksums } from "./release.mjs";

function createAppFixture({
  packageVersion = "0.1.0",
  cargoVersion = "0.1.0",
  tauriVersion = "0.1.0",
  identifier = "com.vistash.app",
  targets = ["nsis", "msi"],
  packageDependencies = {},
  tauriPlugins,
  cargoDependency = "",
  capabilityPermissions = ["core:default"],
} = {}) {
  const appRoot = mkdtempSync(join(tmpdir(), "vistash-release-contract-"));
  const tauriRoot = join(appRoot, "src-tauri");
  const capabilitiesRoot = join(tauriRoot, "capabilities");
  mkdirSync(capabilitiesRoot, { recursive: true });
  writeFileSync(
    join(appRoot, "package.json"),
    `${JSON.stringify({ name: "vistash", version: packageVersion, dependencies: packageDependencies }, null, 2)}\n`,
    { encoding: "utf8" },
  );
  writeFileSync(
    join(appRoot, "Cargo.toml"),
    `[workspace]\nmembers = ["src-tauri"]\n\n[workspace.package]\nversion = "${cargoVersion}"\nedition = "2021"\n`,
    { encoding: "utf8" },
  );
  writeFileSync(
    join(tauriRoot, "Cargo.toml"),
    `[package]\nname = "vistash"\nversion.workspace = true\n\n[dependencies]\n${cargoDependency}\n`,
    { encoding: "utf8" },
  );
  writeFileSync(
    join(tauriRoot, "tauri.conf.json"),
    `${JSON.stringify({ version: tauriVersion, identifier, bundle: { targets }, plugins: tauriPlugins }, null, 2)}\n`,
    { encoding: "utf8" },
  );
  writeFileSync(
    join(capabilitiesRoot, "default.json"),
    `${JSON.stringify({ permissions: capabilityPermissions }, null, 2)}\n`,
    { encoding: "utf8" },
  );
  return appRoot;
}

test("一致的 0.1.0 Windows 双安装器配置通过发布契约", () => {
  const appRoot = createAppFixture();

  assert.deepEqual(verifyReleaseContract({ appRoot }), {
    identifier: "com.vistash.app",
    targets: ["msi", "nsis"],
    version: "0.1.0",
  });
});

test("版本冲突与错误标签在构建前失败", () => {
  assert.throws(
    () => verifyReleaseContract({ appRoot: createAppFixture({ cargoVersion: "0.1.1" }) }),
    /发布版本不一致/,
  );
  assert.throws(
    () => verifyReleaseContract({ appRoot: createAppFixture(), tag: "v0.1.1" }),
    /发布标签必须为 v0\.1\.0/,
  );
});

test("identifier 或双安装器目标缺失时发布契约失败", () => {
  assert.throws(
    () => verifyReleaseContract({ appRoot: createAppFixture({ identifier: "dev.vistash" }) }),
    /必须保留 identifier com\.vistash\.app/,
  );
  assert.throws(
    () => verifyReleaseContract({ appRoot: createAppFixture({ targets: ["msi"] }) }),
    /必须且只能包含 msi 与 nsis/,
  );
});

test("0.1.0 发布契约拒绝任一层 updater 配置", () => {
  const fixtures = [
    createAppFixture({ packageDependencies: { "@tauri-apps/plugin-updater": "2" } }),
    createAppFixture({ tauriPlugins: { updater: { active: true } } }),
    createAppFixture({ cargoDependency: 'tauri-plugin-updater = "2"' }),
    createAppFixture({ capabilityPermissions: ["core:default", "updater:default"] }),
  ];

  for (const appRoot of fixtures) {
    assert.throws(() => verifyReleaseContract({ appRoot }), /0\.1\.0 不得包含 updater/);
  }
});

test("为当前版本唯一的 NSIS 和 MSI 生成稳定 SHA-256 清单", () => {
  const bundleDir = mkdtempSync(join(tmpdir(), "vistash-release-bundle-"));
  const nsisDir = join(bundleDir, "nsis");
  const msiDir = join(bundleDir, "msi");
  const outputPath = join(bundleDir, "SHA256SUMS.txt");
  mkdirSync(nsisDir);
  mkdirSync(msiDir);
  writeFileSync(join(nsisDir, "Vistash_0.1.0_x64-setup.exe"), "nsis-candidate", { encoding: "utf8" });
  writeFileSync(join(msiDir, "Vistash_0.1.0_x64_en-US.msi"), "msi-candidate", { encoding: "utf8" });

  const entries = writeReleaseChecksums({ bundleDir, outputPath, version: "0.1.0" });

  assert.deepEqual(
    entries.map(({ filename }) => filename),
    ["Vistash_0.1.0_x64_en-US.msi", "Vistash_0.1.0_x64-setup.exe"],
  );
  assert.equal(
    readFileSync(outputPath, { encoding: "utf8" }),
    "0712b49171fa8ecb5870375b2ef00ab859a1b0d77ad4f3d0d482a2bfebb23fc5  Vistash_0.1.0_x64_en-US.msi\n" +
      "66b0c12a65f5539bdf931d016ef0d16019fceb66ef4954bbb6244ef46e3829d0  Vistash_0.1.0_x64-setup.exe\n",
  );
});

test("校验和生成拒绝缺失、重复和其他版本产物", () => {
  const missingBundle = mkdtempSync(join(tmpdir(), "vistash-release-missing-"));
  mkdirSync(join(missingBundle, "msi"));
  writeFileSync(join(missingBundle, "msi", "Vistash_0.1.0_x64_en-US.msi"), "msi", { encoding: "utf8" });
  assert.throws(
    () =>
      writeReleaseChecksums({
        bundleDir: missingBundle,
        outputPath: join(missingBundle, "SHA256SUMS.txt"),
        version: "0.1.0",
      }),
    /NSIS 必须恰好有一个候选/,
  );

  const duplicateBundle = mkdtempSync(join(tmpdir(), "vistash-release-duplicate-"));
  mkdirSync(join(duplicateBundle, "nsis"));
  mkdirSync(join(duplicateBundle, "msi"));
  writeFileSync(join(duplicateBundle, "nsis", "Vistash_0.1.0_x64-setup.exe"), "a", { encoding: "utf8" });
  writeFileSync(join(duplicateBundle, "nsis", "Vistash_0.1.0_x86-setup.exe"), "b", { encoding: "utf8" });
  writeFileSync(join(duplicateBundle, "msi", "Vistash_0.1.0_x64_en-US.msi"), "c", { encoding: "utf8" });
  assert.throws(
    () =>
      writeReleaseChecksums({
        bundleDir: duplicateBundle,
        outputPath: join(duplicateBundle, "SHA256SUMS.txt"),
        version: "0.1.0",
      }),
    /NSIS 必须恰好有一个候选，实际为 2 个/,
  );

  const wrongVersionBundle = mkdtempSync(join(tmpdir(), "vistash-release-version-"));
  mkdirSync(join(wrongVersionBundle, "nsis"));
  mkdirSync(join(wrongVersionBundle, "msi"));
  writeFileSync(join(wrongVersionBundle, "nsis", "Vistash_0.1.1_x64-setup.exe"), "a", { encoding: "utf8" });
  writeFileSync(join(wrongVersionBundle, "msi", "Vistash_0.1.1_x64_en-US.msi"), "b", { encoding: "utf8" });
  assert.throws(
    () =>
      writeReleaseChecksums({
        bundleDir: wrongVersionBundle,
        outputPath: join(wrongVersionBundle, "SHA256SUMS.txt"),
        version: "0.1.0",
      }),
    /NSIS 候选版本必须为 0\.1\.0/,
  );

  const mixedVersionBundle = mkdtempSync(join(tmpdir(), "vistash-release-mixed-"));
  mkdirSync(join(mixedVersionBundle, "nsis"));
  mkdirSync(join(mixedVersionBundle, "msi"));
  writeFileSync(join(mixedVersionBundle, "nsis", "Vistash_0.1.0_x64-setup.exe"), "current", {
    encoding: "utf8",
  });
  writeFileSync(join(mixedVersionBundle, "nsis", "Vistash_0.0.9_x64-setup.exe"), "old", {
    encoding: "utf8",
  });
  writeFileSync(join(mixedVersionBundle, "msi", "Vistash_0.1.0_x64_en-US.msi"), "current", {
    encoding: "utf8",
  });
  writeFileSync(join(mixedVersionBundle, "msi", "Vistash_0.0.9_x64_en-US.msi"), "old", {
    encoding: "utf8",
  });
  assert.throws(
    () =>
      writeReleaseChecksums({
        bundleDir: mixedVersionBundle,
        outputPath: join(mixedVersionBundle, "SHA256SUMS.txt"),
        version: "0.1.0",
      }),
    /NSIS 必须恰好有一个候选，实际为 2 个/,
  );
});
