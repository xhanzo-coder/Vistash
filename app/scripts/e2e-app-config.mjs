import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * 为 release E2E 安装隔离配置。
 *
 * 既有配置先以同卷原子 rename 移到备份路径；测试配置建立失败时立即回滚。返回值
 * 记录运行前是否存在配置，恢复阶段据此决定删除测试目录还是放回原目录。
 */
export function prepareE2eAppConfig({ appData, backup, library }) {
  if (existsSync(backup)) {
    throw new Error(`${backup} 已存在：上次验收可能未正常收尾，请人工确认后删除再跑`);
  }

  const hadOriginal = existsSync(appData);
  if (hadOriginal) renameSync(appData, backup);

  try {
    mkdirSync(appData, { recursive: true });
    const settings = JSON.stringify({ format_version: 1, last_library_path: library });
    writeFileSync(join(appData, "settings.json"), settings, { encoding: "utf8" });
  } catch (error) {
    if (existsSync(appData)) rmSync(appData, { recursive: true });
    if (hadOriginal) renameSync(backup, appData);
    throw error;
  }

  return { hadOriginal };
}

/**
 * 先确认应用已经停止，再删除测试配置并恢复原目录。
 *
 * 停止失败时不会触碰任何文件；有原配置时也会先验证备份仍存在，避免删除测试目录
 * 后才发现无法恢复。
 */
export function restoreE2eAppConfig({ appData, backup, hadOriginal, stopApp }) {
  stopApp();
  if (hadOriginal && !existsSync(backup)) {
    throw new Error(`无法恢复使用者配置：备份不存在 ${backup}`);
  }
  if (existsSync(appData)) rmSync(appData, { recursive: true });
  if (hadOriginal) renameSync(backup, appData);
}

/**
 * 在隔离配置中执行异步应用生命周期，并保证启动/场景失败仍进入恢复。
 * 场景与恢复同时失败时保留两条错误，避免恢复异常覆盖最初根因。
 */
export async function withE2eAppConfig(
  { appData, backup, library, stopApp },
  run,
) {
  const prepared = prepareE2eAppConfig({ appData, backup, library });
  let value;
  let runFailed = false;
  let runError;
  try {
    value = await run();
  } catch (error) {
    runFailed = true;
    runError = error;
  }

  let restoreFailed = false;
  let restoreError;
  try {
    restoreE2eAppConfig({ appData, backup, hadOriginal: prepared.hadOriginal, stopApp });
  } catch (error) {
    restoreFailed = true;
    restoreError = error;
  }

  if (runFailed && restoreFailed) {
    throw new AggregateError([runError, restoreError], "E2E 场景与配置恢复同时失败");
  }
  if (runFailed) throw runError;
  if (restoreFailed) throw restoreError;
  return value;
}

/** 测试与诊断读取 UTF-8 配置原文，禁止依赖操作系统默认编码。 */
export function readUtf8(path) {
  return readFileSync(path, { encoding: "utf8" });
}
