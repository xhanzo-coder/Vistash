import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

import { withE2eAppConfig } from "./e2e-app-config.mjs";

const SESSION_ROOT = "E:\\vistash-installer-lifecycle";
const BASELINE_LIBRARY = "E:\\vistash-release-e2e\\v1-library";
const APP_DATA = join(process.env.APPDATA, "com.vistash.app");
const BACKUP = `${APP_DATA}.installer-lifecycle-backup`;
const INSTALL_DIR = join(process.env.LOCALAPPDATA, "Vistash");
const INSTALLED_EXE = join(INSTALL_DIR, "vistash.exe");
const UNINSTALLER = join(INSTALL_DIR, "uninstall.exe");
const TEST_LIBRARY = join(SESSION_ROOT, "library");
const CDP_PORT = 9324;

function readOption(name) {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  if (index === -1 || value === undefined || value.startsWith("--")) {
    throw new TypeError(`${name} 缺少值`);
  }
  return resolve(value);
}

function assertPreconditions(installer) {
  if (resolve(SESSION_ROOT) !== SESSION_ROOT) throw new Error(`隔离目录解析异常：${resolve(SESSION_ROOT)}`);
  if (!existsSync(installer)) throw new Error(`NSIS 候选不存在：${installer}`);
  if (!existsSync(BASELINE_LIBRARY)) throw new Error(`隔离库基线不存在：${BASELINE_LIBRARY}`);
  if (existsSync(INSTALL_DIR)) throw new Error(`检测到既有 Vistash 安装，拒绝覆盖：${INSTALL_DIR}`);
  if (existsSync(BACKUP)) throw new Error(`检测到未恢复的配置备份：${BACKUP}`);
  if (existsSync(SESSION_ROOT)) throw new Error(`检测到未清理的隔离目录：${SESSION_ROOT}`);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function runInstaller(installer) {
  execFileSync(installer, ["/S", "/NS"], { stdio: "inherit", windowsHide: true });
  if (!existsSync(INSTALLED_EXE) || !existsSync(UNINSTALLER)) {
    throw new Error(`NSIS 安装未生成预期文件：${INSTALL_DIR}`);
  }
}

async function runUninstaller() {
  if (!existsSync(UNINSTALLER)) throw new Error(`卸载器不存在：${UNINSTALLER}`);
  execFileSync(UNINSTALLER, ["/S"], { stdio: "inherit", windowsHide: true });
  const deadline = Date.now() + 10_000;
  while (existsSync(INSTALL_DIR) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  if (existsSync(INSTALL_DIR)) throw new Error(`卸载后安装目录仍存在：${INSTALL_DIR}`);
}

async function stopApp(session) {
  if (session === undefined) return;
  if (session.browser !== undefined) await session.browser.close();
  if (session.child.exitCode !== null) return;
  try {
    execFileSync("taskkill", ["/PID", String(session.child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } catch (error) {
    if (error?.status !== 128) throw error;
  }
}

async function launchInstalledApp() {
  const child = spawn(INSTALLED_EXE, [], {
    detached: false,
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
    },
    stdio: "ignore",
    windowsHide: false,
  });
  const deadline = Date.now() + 10_000;
  let cdpReady = false;
  while (!cdpReady && Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      cdpReady = response.ok;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
  if (child.exitCode !== null) throw new Error(`安装后的应用提前退出：${child.exitCode}`);
  if (!cdpReady) throw new Error("安装后的应用未在 10 秒内开放 WebView2 验收端口");

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  const pages = browser.contexts().flatMap((context) => context.pages());
  if (pages.length !== 1) throw new Error(`安装后的应用必须恰好有一个页面，实际为 ${pages.length}`);
  const page = pages[0];
  await page.locator('[data-workspace="assets"]:not([hidden])').waitFor({ timeout: 10_000 });
  await page.getByRole("button", { name: "切换素材库：library" }).waitFor({ timeout: 10_000 });
  await page.getByRole("heading", { name: "全部图片", exact: true }).waitFor({ timeout: 10_000 });
  return { browser, child };
}

async function exerciseLifecycle(installer, upgradeInstaller) {
  let appSession;
  let installed = false;
  let runError;
  try {
    runInstaller(installer);
    installed = true;
    appSession = await launchInstalledApp();
    await stopApp(appSession);
    appSession = undefined;
    const initialExecutableHash = sha256(INSTALLED_EXE);

    const settingsPath = join(APP_DATA, "settings.json");
    const settingsBeforeReinstall = readFileSync(settingsPath, { encoding: "utf8" });
    runInstaller(installer);
    if (sha256(INSTALLED_EXE) !== initialExecutableHash) {
      throw new Error("同版本重装改变了已安装可执行文件");
    }
    if (readFileSync(settingsPath, { encoding: "utf8" }) !== settingsBeforeReinstall) {
      throw new Error("同版本重装修改了隔离 settings.json");
    }
    appSession = await launchInstalledApp();
    await stopApp(appSession);
    appSession = undefined;

    runInstaller(upgradeInstaller);
    if (sha256(INSTALLED_EXE) === initialExecutableHash) {
      throw new Error("补丁升级没有替换已安装可执行文件");
    }
    appSession = await launchInstalledApp();
    await stopApp(appSession);
    appSession = undefined;
    if (readFileSync(settingsPath, { encoding: "utf8" }) !== settingsBeforeReinstall) {
      throw new Error("补丁升级修改了隔离 settings.json");
    }

    await runUninstaller();
    installed = false;
    if (readFileSync(settingsPath, { encoding: "utf8" }) !== settingsBeforeReinstall) {
      throw new Error("卸载修改了隔离 settings.json");
    }
    if (!existsSync(join(TEST_LIBRARY, "library.json"))) {
      throw new Error("卸载删除了隔离素材库");
    }

    runInstaller(upgradeInstaller);
    installed = true;
    appSession = await launchInstalledApp();
    await stopApp(appSession);
    appSession = undefined;
    if (readFileSync(settingsPath, { encoding: "utf8" }) !== settingsBeforeReinstall) {
      throw new Error("卸载后重装修改了隔离 settings.json");
    }
  } catch (error) {
    runError = error;
  }

  let cleanupError;
  try {
    await stopApp(appSession);
    if (installed && existsSync(UNINSTALLER)) await runUninstaller();
  } catch (error) {
    cleanupError = error;
  }
  if (runError !== undefined && cleanupError !== undefined) {
    throw new AggregateError([runError, cleanupError], "安装生命周期与清理同时失败");
  }
  if (runError !== undefined) throw runError;
  if (cleanupError !== undefined) throw cleanupError;
}

async function main() {
  const installer = readOption("--nsis");
  const upgradeInstaller = readOption("--upgrade-nsis");
  assertPreconditions(installer);
  if (!existsSync(upgradeInstaller)) throw new Error(`NSIS 补丁升级候选不存在：${upgradeInstaller}`);
  if (upgradeInstaller === installer) throw new Error("补丁升级候选必须不同于初始候选");
  mkdirSync(SESSION_ROOT, { recursive: false });
  cpSync(BASELINE_LIBRARY, TEST_LIBRARY, { recursive: true, errorOnExist: true });

  let lifecycleError;
  try {
    await withE2eAppConfig(
      {
        appData: APP_DATA,
        backup: BACKUP,
        library: TEST_LIBRARY,
        stopApp: () => {},
      },
      () => exerciseLifecycle(installer, upgradeInstaller),
    );
  } catch (error) {
    lifecycleError = error;
  }

  let directoryCleanupError;
  try {
    rmSync(SESSION_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  } catch (error) {
    directoryCleanupError = error;
  }
  if (lifecycleError !== undefined && directoryCleanupError !== undefined) {
    throw new AggregateError([lifecycleError, directoryCleanupError], "安装验收与隔离目录清理同时失败");
  }
  if (lifecycleError !== undefined) throw lifecycleError;
  if (directoryCleanupError !== undefined) throw directoryCleanupError;

  process.stdout.write(
    `${JSON.stringify({
      appDataRestored: existsSync(APP_DATA) && !existsSync(BACKUP),
      installDirectoryRemoved: !existsSync(INSTALL_DIR),
      library: TEST_LIBRARY,
      scenarios: [
        "install",
        "launch-and-open-library",
        "same-version-reinstall",
        "launch-and-reopen-library",
        "patch-upgrade",
        "launch-and-reopen-library",
        "uninstall",
        "data-preserved",
        "reinstall",
        "launch-and-reopen-library",
      ],
    })}\n`,
  );
}

await main();
