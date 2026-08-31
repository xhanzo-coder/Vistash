import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function readJson(path) {
  return JSON.parse(readFileSync(path, { encoding: "utf8" }));
}

function readWorkspaceVersion(path) {
  const source = readFileSync(path, { encoding: "utf8" });
  const marker = /^\[workspace\.package\]\s*$/m.exec(source);
  if (marker === null) {
    throw new Error(`${path} 缺少 [workspace.package]`);
  }
  const tail = source.slice(marker.index + marker[0].length);
  const nextSection = /^\[/m.exec(tail);
  const workspacePackage = tail.slice(0, nextSection?.index ?? tail.length);
  const versions = [...workspacePackage.matchAll(/^version\s*=\s*"([^"]+)"\s*$/gm)];
  if (versions.length !== 1) {
    throw new Error(`${path} 的 [workspace.package] 必须恰好声明一个 version`);
  }
  return versions[0][1];
}

function assertSemver(label, value) {
  if (typeof value !== "string" || !SEMVER_PATTERN.test(value)) {
    throw new Error(`${label} 不是合法 SemVer：${String(value)}`);
  }
}

export function verifyReleaseContract({ appRoot, tag }) {
  const resolvedRoot = resolve(appRoot);
  const packagePath = resolve(resolvedRoot, "package.json");
  const cargoPath = resolve(resolvedRoot, "Cargo.toml");
  const tauriPath = resolve(resolvedRoot, "src-tauri", "tauri.conf.json");
  const packageJson = readJson(packagePath);
  const tauriConfig = readJson(tauriPath);
  const versions = {
    [packagePath]: packageJson.version,
    [cargoPath]: readWorkspaceVersion(cargoPath),
    [tauriPath]: tauriConfig.version,
  };

  for (const [path, version] of Object.entries(versions)) assertSemver(path, version);
  const uniqueVersions = new Set(Object.values(versions));
  if (uniqueVersions.size !== 1) {
    throw new Error(
      `发布版本不一致：${Object.entries(versions)
        .map(([path, version]) => `${path}=${version}`)
        .join("，")}`,
    );
  }

  const version = packageJson.version;
  if (tag !== undefined && tag !== `v${version}`) {
    throw new Error(`发布标签必须为 v${version}，实际为 ${tag}`);
  }
  if (tauriConfig.identifier !== "com.vistash.app") {
    throw new Error(`0.1.0 必须保留 identifier com.vistash.app，实际为 ${String(tauriConfig.identifier)}`);
  }
  if (!Array.isArray(tauriConfig.bundle?.targets)) {
    throw new TypeError("tauri.conf.json 的 bundle.targets 必须是数组");
  }
  const targets = [...tauriConfig.bundle.targets].sort();
  if (targets.length !== 2 || targets[0] !== "msi" || targets[1] !== "nsis") {
    throw new Error(`bundle.targets 必须且只能包含 msi 与 nsis，实际为 ${targets.join(",")}`);
  }

  const updaterEvidence = [
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.devDependencies ?? {}),
    ...Object.keys(packageJson.optionalDependencies ?? {}),
    ...Object.keys(tauriConfig.plugins ?? {}),
    ...readJson(resolve(resolvedRoot, "src-tauri", "capabilities", "default.json")).permissions,
  ].some((value) => JSON.stringify(value).toLowerCase().includes("updater"));
  const cargoHasUpdater = readFileSync(resolve(resolvedRoot, "src-tauri", "Cargo.toml"), {
    encoding: "utf8",
  }).includes("tauri-plugin-updater");
  if (updaterEvidence || cargoHasUpdater) {
    throw new Error("0.1.0 不得包含 updater 依赖、插件或权限");
  }

  return { identifier: tauriConfig.identifier, targets, version };
}

function listFilesRecursively(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? listFilesRecursively(path) : [path];
  });
}

function requireSingleArtifact(files, label, predicate) {
  const matches = files.filter(predicate);
  if (matches.length !== 1) {
    throw new Error(`${label} 必须恰好有一个候选，实际为 ${matches.length} 个`);
  }
  return matches[0];
}

export function writeReleaseChecksums({ bundleDir, outputPath, version }) {
  assertSemver("release version", version);
  const versionMarker = `_${version}_`;
  const files = listFilesRecursively(resolve(bundleDir));
  const nsis = requireSingleArtifact(files, "NSIS", (path) => basename(path).endsWith("-setup.exe"));
  const msi = requireSingleArtifact(files, "MSI", (path) => basename(path).endsWith(".msi"));
  for (const [label, path] of [
    ["NSIS", nsis],
    ["MSI", msi],
  ]) {
    if (!basename(path).includes(versionMarker)) {
      throw new Error(`${label} 候选版本必须为 ${version}，实际文件为 ${basename(path)}`);
    }
  }
  const artifacts = [nsis, msi].sort((left, right) =>
    basename(left).localeCompare(basename(right), "en"),
  );
  const entries = artifacts.map((path) => ({
    filename: basename(path),
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
  }));
  const manifest = `${entries.map(({ filename, sha256 }) => `${sha256}  ${filename}`).join("\n")}\n`;
  writeFileSync(resolve(outputPath), manifest, { encoding: "utf8" });
  return entries;
}

function readOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new TypeError(`${name} 缺少值`);
  return value;
}

function runCli() {
  const [, , command, ...args] = process.argv;
  if (command === "verify") {
    const appRoot = readOption(args, "--app-root") ?? process.cwd();
    const tag = readOption(args, "--tag");
    const result = verifyReleaseContract({ appRoot, tag });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "checksums") {
    const bundleDir = readOption(args, "--bundle-dir");
    const outputPath = readOption(args, "--output");
    const appRoot = readOption(args, "--app-root") ?? process.cwd();
    if (bundleDir === undefined || outputPath === undefined) {
      throw new TypeError("checksums 必须提供 --bundle-dir 与 --output");
    }
    const { version } = verifyReleaseContract({ appRoot });
    const result = writeReleaseChecksums({ bundleDir, outputPath, version });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  throw new Error(
    "用法：node scripts/release.mjs verify [--app-root <path>] [--tag <vX.Y.Z>] | checksums --bundle-dir <path> --output <path> [--app-root <path>]",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) runCli();
