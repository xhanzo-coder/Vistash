/** 启停真实 Windows release UI 的隔离人工验收会话。 */

import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { prepareE2eAppConfig, restoreE2eAppConfig } from "./e2e-app-config.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const EXE = join(REPO, "app", "target", "release", "vistash.exe");
const BASE_LIBRARY = "E:\\vistash-release-e2e\\v1-library";
const SESSION_ROOT = resolve("E:\\vistash-native-ui-session");
const LIBRARY = join(SESSION_ROOT, "library");
const SESSION_FILE = join(SESSION_ROOT, "session.json");
const APPDATA_ROOT = process.env.APPDATA;
if (APPDATA_ROOT === undefined || APPDATA_ROOT.length === 0) throw new Error("原生验收要求 APPDATA");
const APP_DATA = join(APPDATA_ROOT, "com.vistash.app");
const BACKUP = `${APP_DATA}.native-ui-backup`;

function assertSessionRoot(path) {
  if (resolve(path) !== SESSION_ROOT || !SESSION_ROOT.startsWith("E:\\vistash-native-ui-session")) {
    throw new Error(`拒绝操作未验证的原生验收目录：${path}`);
  }
}

function start() {
  if (!existsSync(EXE)) throw new Error(`缺少 release 可执行文件：${EXE}`);
  if (!existsSync(join(BASE_LIBRARY, "library.json"))) throw new Error(`缺少原生验收基线库：${BASE_LIBRARY}`);
  if (existsSync(SESSION_ROOT)) throw new Error(`${SESSION_ROOT} 已存在；请先执行 stop 并核对旧会话`);
  mkdirSync(SESSION_ROOT, { recursive: true });
  cpSync(BASE_LIBRARY, LIBRARY, { recursive: true, errorOnExist: true });
  const prepared = prepareE2eAppConfig({ appData: APP_DATA, backup: BACKUP, library: LIBRARY });
  const child = spawn(EXE, [], {
    cwd: dirname(EXE),
    detached: true,
    env: process.env,
    stdio: "ignore",
    windowsHide: false,
  });
  if (child.pid === undefined) throw new Error("原生验收进程缺少 PID");
  writeFileSync(
    SESSION_FILE,
    JSON.stringify({ pid: child.pid, root: SESSION_ROOT, library: LIBRARY, appData: APP_DATA, backup: BACKUP, hadOriginal: prepared.hadOriginal }, null, 2),
    { encoding: "utf8" },
  );
  child.unref();
  console.log(JSON.stringify({ pid: child.pid, library: LIBRARY, appData: APP_DATA, backup: BACKUP }));
}

function stop() {
  if (!existsSync(SESSION_FILE)) throw new Error(`缺少会话记录：${SESSION_FILE}`);
  const session = JSON.parse(readFileSync(SESSION_FILE, { encoding: "utf8" }));
  if (session.root !== SESSION_ROOT || typeof session.pid !== "number") throw new TypeError("原生验收会话记录非法");
  try {
    execFileSync("taskkill", ["/PID", String(session.pid), "/T", "/F"], { stdio: "ignore" });
  } catch (error) {
    if (error?.status !== 128) throw error;
  }
  const originalAlreadyRestored =
    session.hadOriginal && !existsSync(session.backup) && existsSync(session.appData);
  if (!originalAlreadyRestored) {
    restoreE2eAppConfig({
      appData: session.appData,
      backup: session.backup,
      hadOriginal: session.hadOriginal,
      stopApp: () => {},
    });
  }
  assertSessionRoot(session.root);
  rmSync(SESSION_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  console.log("原生验收会话已停止并删除隔离目录");
}

function status() {
  if (!existsSync(SESSION_FILE)) {
    console.log("没有活动的原生验收会话");
    return;
  }
  console.log(readFileSync(SESSION_FILE, { encoding: "utf8" }));
}

const command = process.argv[2];
if (command === "start") start();
else if (command === "stop") stop();
else if (command === "status") status();
else throw new Error("用法：node scripts/native-ui-session.mjs <start|stop|status>");
