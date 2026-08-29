/**
 * Windows release 端到端验收（任务 11.5）。
 *
 * 在真实 release WebView2（与系统 Edge 同为 Chromium 内核）里走通：v1→v2 迁移、两库
 * 组织、备注/收藏、多选批量、普通关联、封面、搜索、图片/提示词两类回收站的删除/还原/
 * purge。驱动方式：`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 打开远程调试端口，
 * playwright-core 以 CDP 接管主窗口；IPC 层是真实 Rust 后端，因此每一步都能用库内
 * 权威文件做落盘断言，而不是只看界面自说自话。
 *
 * 使用者配置保护：启动前把 %APPDATA%/com.vistash.app 整体备份，settings.json 指向
 * E 盘合成 v1 库；结束后杀掉应用并原样恢复。备份若已存在则拒绝运行，绝不覆盖。
 *
 * 运行：`pnpm tauri build --no-bundle` 之后 `node scripts/e2e-release.mjs`。必须经
 * Tauri CLI 注入 production 环境；直接 `cargo build --release` 仍会使用 devUrl。
 */

import { spawn, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

import { withE2eAppConfig } from "./e2e-app-config.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const DIST = join(REPO, "app", "dist");
const EXE = join(REPO, "app", "target", "release", "vistash.exe");
const LIBRARY = "E:\\vistash-release-e2e\\v1-library";
const SHOTS = "E:\\vistash-release-e2e\\shots";
const REPORT = "E:\\vistash-release-e2e\\e2e-report.json";
const appDataRoot = process.env.APPDATA;
if (appDataRoot === undefined || appDataRoot === "") {
  throw new Error("Windows release E2E 要求 APPDATA 环境变量");
}
const APP_DATA = join(appDataRoot, "com.vistash.app");
const BACKUP = `${APP_DATA}.e2e-backup`;
const CDP_PORT = 9223;

/* ------------------------------------------------------------------ 工具 */

const results = [];
let shotIndex = 0;
let diagIndex = 0;
let child = null;
/** 最近的前端 console/pageerror 记录，失败时随现场一起倾倒。 */
const consoleLog = [];

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
}

/**
 * 倾倒失败现场的完整状态：截图、错误码、检查器组织分区、checkbox 勾选态、
 * 最近控制台日志。诊断用，不参与断言。
 */
async function dumpState(page, label) {
  diagIndex += 1;
  const id = String(diagIndex).padStart(2, "0");
  const state = {
    label,
    alerts: await page
      .locator('[role="alert"]')
      .all()
      .then((nodes) =>
        Promise.all(
          nodes.map(async (node) => ({
            code: (await node.getAttribute("data-error-code")) ?? "",
            text: (await node.innerText()).trim().slice(0, 200),
          })),
        ),
      )
      .catch(() => []),
    orgSection:
      (await page
        .locator('[data-inspector-section="organization"]')
        .innerHTML()
        .catch(() => "(组织分区不存在)")).slice(0, 1200),
    checkboxes: await page
      .locator('[data-inspector-section="organization"] input[type="checkbox"]')
      .evaluateAll((nodes) =>
        nodes.map((node) => ({
          value: node.value,
          checked: node.checked,
          disabled: node.disabled,
        })),
      )
      .catch(() => []),
    inspectorText: await page
      .locator(".inspector")
      .innerText()
      .then((text) => text.slice(0, 600))
      .catch(() => "(检查器不存在)"),
    workspaceClass: await page
      .locator('section[class*="workspace"]')
      .first()
      .getAttribute("class")
      .catch(() => "(工作区 section 不存在)"),
    promptFolderInputCount: await page
      .locator("#new-prompt-folder")
      .count()
      .catch(() => -1),
    promptNavText: await page
      .locator('nav[aria-label="提示词文件夹"]')
      .innerText()
      .then((text) => text.slice(0, 300))
      .catch(() => "(提示词文件夹 nav 不存在)"),
    workspaceHeading: await page
      .locator(".query-bar h2")
      .first()
      .innerText()
      .catch(() => "(工作台标题不存在)"),
    resultCount: await page
      .locator('[data-result-count]')
      .first()
      .innerText()
      .catch(() => "(结果计数不存在)"),
    trashButtons: await page.locator('button[aria-label="回收站"]').evaluateAll((nodes) =>
      nodes.map((node) => ({
        current: node.getAttribute("aria-current"),
        text: node.textContent?.trim() ?? "",
      })),
    ),
    assetCardCount: await page.locator("[data-waterfall-item]").count(),
    promptCardCount: await page.locator("[data-prompt-card]").count(),
    recentConsole: consoleLog.slice(-25),
  };
  await page.screenshot({ path: join(SHOTS, `diag-${id}-${label}.png`) });
  writeFileSync(
    join(SHOTS, `diag-${id}-${label}.json`),
    JSON.stringify(state, null, 2),
  );
  console.log(`[诊断] ${label}：现场已写入 diag-${id}-${label}.json`);
  return state;
}

async function shot(page, name) {
  shotIndex += 1;
  const id = String(shotIndex).padStart(2, "0");
  await page.screenshot({ path: join(SHOTS, `${id}-${name}.png`) });
}

/** 轮询一个返回真值的异步函数，超时抛出。 */
async function poll(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`轮询超时：${what}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

/** 某素材树（objects/trash，两层 fanout）里全部侧车 JSON 路径。 */
function sidecarPaths(subdir) {
  const root = join(LIBRARY, subdir);
  if (!existsSync(root)) return [];
  const out = [];
  for (const a of readdirSync(root)) {
    for (const b of readdirSync(join(root, a))) {
      for (const f of readdirSync(join(root, a, b))) {
        if (f.endsWith(".json")) out.push(join(root, a, b, f));
      }
    }
  }
  return out;
}

/** 找满足谓词的第一张素材侧车（连同其内容）。 */
async function findSidecar(predicate, subdir = "objects") {
  for (const path of sidecarPaths(subdir)) {
    const meta = await readJson(path);
    if (predicate(meta)) return { path, meta };
  }
  return null;
}

function sourceFilename(meta) {
  const source = meta.source;
  if (source === null || typeof source !== "object" || typeof source.filename !== "string") {
    throw new TypeError("v3 侧车缺少 source.filename");
  }
  return source.filename;
}

/** 提示词权威文件（prompts/objects|trash/<id>.json）。 */
function promptFiles(subdir = "objects") {
  const dir = join(LIBRARY, "prompts", subdir);
  return existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => join(dir, f))
    : [];
}

/* ------------------------------------------------------- 进程停止 */

function spawnReleaseApp() {
  const spawned = spawn(EXE, [], {
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    spawned.once("spawn", () => resolve(spawned));
    spawned.once("error", reject);
  });
}

function stopApp() {
  if (child === null || child.exitCode !== null) return;
  if (child.pid === undefined) throw new Error("release 应用进程缺少 PID，无法安全恢复配置");
  execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  child = null;
}

/* ------------------------------------------------------------------ 场景 */

async function main() {
  assert(existsSync(join(DIST, "index.html")), "缺少 dist（先 pnpm build）");
  assert(existsSync(EXE), "缺少 production exe（先 pnpm tauri build --no-bundle）");
  assert(existsSync(join(LIBRARY, "library.json")), "缺少 E 盘 v1 测试库");
  mkdirSync(SHOTS, { recursive: true });
  let exeOutput = "";

  try {
    await withE2eAppConfig(
      { appData: APP_DATA, backup: BACKUP, library: LIBRARY, stopApp },
      async () => {
    child = await spawnReleaseApp();
    child.stdout.on("data", (d) => (exeOutput += d));
    child.stderr.on("data", (d) => (exeOutput += d));

    await poll(async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
        return res.ok;
      } catch {
        return false;
      }
    }, 30_000, "WebView2 远程调试端口就绪");

    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    const context = browser.contexts()[0];
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    console.log(
      "CDP targets:",
      await Promise.all(
        context.pages().map(async (candidate) => ({
          title: await candidate.title(),
          url: candidate.url(),
        })),
      ),
    );
    // WebView2 可能复用同一用户数据目录下已有的 browser process，CDP context 因此
    // 会同时暴露其他 Vistash dev 窗口。不能按 pages()[0] 猜主窗口，必须用 release
    // 迁移页的可观察语义选中真实目标；创建普通 newPage 也没有 Tauri IPC，禁止兜底。
    const page = await poll(async () => {
      for (const candidate of context.pages()) {
        if ((await candidate.getByRole("heading", { name: "这个库需要升级" }).count()) > 0) {
          return candidate;
        }
      }
      return null;
    }, 20_000, "真实 release 主窗口迁移页");
    page.on("console", (message) => {
      consoleLog.push(`[console.${message.type()}] ${message.text().slice(0, 300)}`);
      if (consoleLog.length > 200) consoleLog.splice(0, consoleLog.length - 200);
    });
    page.on("pageerror", (error) => {
      consoleLog.push(`[pageerror] ${String(error).slice(0, 300)}`);
      if (consoleLog.length > 200) consoleLog.splice(0, consoleLog.length - 200);
    });

    /* S1 迁移阻塞页：连同错误码一起呈现 */
    assert(
      (await page.locator('[data-error-code="library.format_too_old"]').count()) >= 1,
      "迁移页必须连同 library.format_too_old 错误码一起呈现",
    );
    await shot(page, "migration-page");

    /* S2 执行迁移：先生成只读冲突方案，再提交 v3 格式 */
    await page.getByRole("button", { name: "准备迁移" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "检查迁移方案" }).click();
    await page.getByRole("heading", { name: "选择唯一图片文件夹" }).waitFor({ timeout: 60_000 });
    await page.getByRole("button", { name: "确认迁移" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "开始迁移" }).click();
    await page.locator('[data-workspace="assets"]').waitFor({ timeout: 60_000 });
    await poll(async () => {
      const meta = await readJson(join(LIBRARY, "library.json"));
      return meta.format_version === 3 && /^[0-9a-f-]{36}$/.test(meta.library_id ?? "");
    }, 10_000, "library.json 升级为 v3 且带 UUID library_id");
    assert(!existsSync(join(LIBRARY, "migration-journal.json")), "journal 必须在成功后清理");
    for (const dir of ["prompts", join("prompts", "objects"), join("prompts", "trash")]) {
      assert(existsSync(join(LIBRARY, dir)), `迁移应建立 ${dir}`);
    }
    assert(existsSync(join(LIBRARY, "prompt-folders.json")), "迁移应建立提示词文件夹清单");
    const sidecars = sidecarPaths("objects");
    assert(sidecars.length === 8, `正常素材应为 8 张，实际 ${sidecars.length}`);
    for (const path of sidecars) {
      const meta = await readJson(path);
      assert(meta.format_version === 3, `侧车应升级 v3：${path}`);
      assert("source" in meta && "display_filename" in meta && "folder" in meta, "v3 侧车应包含来源、显示名和单一文件夹字段");
    }
    const trashed = sidecarPaths("trash");
    assert(trashed.length === 1, "回收站素材应保留 1 张");
    assert((await readJson(trashed[0])).deleted_at !== null, "回收站素材仍处回收站态");
    await shot(page, "workspace-after-migration");

    /* S3 瀑布流呈现迁移后的素材 */
    await page.locator("[data-waterfall-item]").first().waitFor({ timeout: 20_000 });
    assert((await page.locator("[data-waterfall-item]").count()) >= 4, "瀑布流应有可见卡片");

    /* S4 选中 → 备注自动保存落盘 → 收藏落盘 */
    await page.locator("[data-waterfall-item]").first().click();
    const noteBox = page.locator('[data-inspector-section="note"] textarea');
    await noteBox.waitFor({ timeout: 10_000 });
    await noteBox.fill("验收备注：迁移后的纯文本备注写入");
    const noted = await poll(
      () => findSidecar((meta) => meta.note.includes("验收备注")),
      10_000,
      "备注经 set_asset_note 落盘",
    );
    await page.getByRole("button", { name: "收藏图片", exact: true }).click();
    const favored = await poll(
      () => findSidecar((meta) => meta.favorite === true),
      10_000,
      "收藏经 set_asset_favorite 落盘",
    );
    assert(favored.meta.hash === noted.meta.hash, "收藏应作用于同一张选中素材");
    await shot(page, "inspector-note-favorite");

    /* S5 Ctrl 多选两张 → 检查器批量分区添加标签 */
    const cards = page.locator("[data-waterfall-item]");
    await cards.nth(1).click({ modifiers: ["Control"] });
    await cards.nth(2).click({ modifiers: ["Control"] });
    const batchToolbar = page.getByRole("toolbar", { name: "批量操作", exact: true });
    await poll(() => batchToolbar.getByRole("button", { name: "编辑标签", exact: true }).isEnabled(), 15_000, "多选检查器写入按钮可用");
    await batchToolbar.getByRole("button", { name: "编辑标签", exact: true }).click();
    const tagDialog = page.getByRole("dialog", { name: "批量编辑标签", exact: true });
    await tagDialog.getByRole("textbox", { name: "标签名称", exact: true }).fill("验收");
    await tagDialog.getByRole("button", { name: "添加到所选图片", exact: true }).click();
    const taggedCount = await poll(
      async () => {
        const count =
          (await Promise.all(sidecarPaths("objects").map(async (p) => (await readJson(p)).tags)))
            .filter((tags) => tags.includes("验收")).length;
        return count >= 2 ? count : null; // 批量逐条落盘：必须等满两张，不能见好就收。
      },
      15_000,
      "批量打标落盘（至少两张）",
    );
    assert(taggedCount >= 2, `至少两张素材应带上“验收”标签，实际 ${taggedCount}`);
    // 磁盘已确认所有目标完成；新版动作报告按动作标题呈现，不再使用旧的“批量完成”文案。
    await poll(
      async () => ((await page.getByText(/添加标签/).count()) >= 1 ? true : null),
      30_000,
      "批量动作报告出现",
    );
    await shot(page, "batch-tagging");

    /* S6 图片文件夹树：新建文件夹并归属选中素材 */
    // 批量后仍是多选：先 Esc 清空选择，再单击建立单选，检查器的组织分区才可用
    //（单击已选中项不会退出多选）。
    await page.keyboard.press("Escape");
    await cards.nth(0).click();
    await page.getByRole("button", { name: "新建文件夹", exact: true }).click();
    const createFolderDialog = page.getByRole("dialog", { name: "新建文件夹", exact: true });
    await createFolderDialog.locator('input[name="folder-name"]').fill("验收集");
    await createFolderDialog.getByRole("button", { name: "创建文件夹", exact: true }).click();
    await poll(async () => (await page.getByRole("button", { name: /验收集/ }).count()) > 0, 10_000, "左栏出现新文件夹");
    // 新建文件夹后查询自动切进该文件夹（此时为空集合），选中项不在查询域、检查器清空：
    // 回到“全部素材”重新建立单选，组织分区才可用。
    await page.getByRole("button", { name: "全部图片", exact: true }).click();
    await cards.first().waitFor({ timeout: 15_000 });
    await page.keyboard.press("Escape");
    await cards.nth(0).click();
    // 受控 checkbox 的勾选态要经 IPC 往返才回填，check() 的即时状态验证会误判失败：
    // 用 click() 触发，落盘结果交给下面的权威文件轮询。
    const folderBox = page
      .locator('[data-inspector-section="organization"]')
      .getByRole("combobox", { name: "图片所在文件夹", exact: true });
    await folderBox.selectOption("folder:验收集");
    await dumpState(page, "s6-after-checkbox-click");
    try {
      await poll(
        () => findSidecar((meta) => meta.folder === "验收集"),
        10_000,
        "素材归属新文件夹落盘",
      );
    } catch (error) {
      await dumpState(page, "s6-poll-timeout");
      throw error;
    }
    await shot(page, "folder-organization");

    /* S7 Ctrl+F 分库搜索与条件芯片 */
    // S6 最后一次交互是检查器下拉框；先把焦点还给工作区，再验证工作区快捷键，
    // 避免把原生 select 的焦点语义误判成应用快捷键失效。
    await page.locator('section[aria-label="图片工作区"] h1').click();
    await page.evaluate(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
    });
    await page.keyboard.press("Control+f");
    const searchBox = page.locator('input[aria-label="按文件名搜索"]');
    await poll(() => searchBox.evaluate((el) => el === document.activeElement), 5_000, "Ctrl+F 聚焦搜索框");
    await searchBox.fill("晨雾");
    await poll(async () => (await page.locator("[data-waterfall-item]").count()) === 1, 15_000, "分库搜索过滤到 1 项");
    await shot(page, "library-search");
    await searchBox.fill("");
    await poll(
      async () => (await page.locator("[data-waterfall-item]").count()) !== 1,
      15_000,
      "清空查询恢复全集",
    );

    /* S8 Ctrl+K 全局搜索：分组与计数 */
    await page.keyboard.press("Control+k");
    const globalDialog = page.getByRole("dialog");
    await globalDialog.getByRole("searchbox", { name: "搜索全部素材", exact: true }).fill("晨雾");
    await poll(async () => (await globalDialog.getByRole("heading", { name: "图片" }).count()) >= 1, 15_000, "全局搜索出现图片分组");
    assert((await page.getByRole("button", { name: /晨雾/ }).count()) >= 1, "结果里应能点选命中项");
    await shot(page, "global-search");
    await page.keyboard.press("Escape");

    /* S9 种子提示词 + 提示词文件夹 UI 组织 */
    // 创建入口属后续变更，因此只用 IPC 建立无归属种子；文件夹创建与归属必须走真实 UI。
    await page.evaluate(async () => {
      await window.__TAURI_INTERNALS__.invoke("create_prompt", {
        prompt: {
          body: "电影感布光，浅景深，8k 细节。\n负向：低对比，过曝。",
          title: "验收提示词",
          model: "sd-xl",
          parameters: "steps=30 sampler=dpm++",
          folders: [],
          tags: ["验收"],
        },
      });
    });
    const promptDoc = await poll(async () => {
      const [path] = promptFiles();
      return path === undefined ? null : { path, meta: await readJson(path) };
    }, 10_000, "种子提示词权威文件落盘");
    await page.getByRole("button", { name: "提示词", exact: true }).click();
    await page.locator("[data-prompt-card]").first().waitFor({ timeout: 20_000 });
    await dumpState(page, "s9-after-tab-switch");

    try {
      await page.locator("#new-prompt-folder").fill("人像");
    } catch (error) {
      await dumpState(page, "s9-fill-timeout");
      throw error;
    }
    await page.locator('form:has(#new-prompt-folder) button[type="submit"]').click();
    await poll(
      async () => (await page.locator('[data-folder="人像"]').count()) === 1,
      10_000,
      "提示词左栏出现人像文件夹",
    );
    await page.getByRole("button", { name: "全部提示词" }).click();
    await page.locator("[data-prompt-card]").first().waitFor({ timeout: 15_000 });
    await page.locator("[data-prompt-card]").first().click();
    await page
      .locator('[data-inspector-section="organization"]')
      .getByRole("checkbox", { name: /人像/ })
      .click();
    await poll(
      async () => (await readJson(promptDoc.path)).folders.includes("人像"),
      10_000,
      "提示词归属人像文件夹落盘",
    );
    await shot(page, "prompt-folder-organization");

    /* S10 提示词关联两张图 + 显式封面 */
    const linksSection = page.locator('[data-inspector-section="images"]');
    await linksSection.waitFor({ timeout: 10_000 });
    await linksSection.getByRole("button", { name: "从图片库选择" }).click();
    const candidateBoxes = page.locator('.link-candidates input[type="checkbox"]');
    await candidateBoxes.first().waitFor({ timeout: 15_000 });
    // 与 S6 同理：受控勾选经 React 状态回填，click() + 按钮可用性等待代替 check()。
    await candidateBoxes.nth(0).click();
    await candidateBoxes.nth(1).click();
    await page.getByRole("button", { name: "确认关联" }).click();
    await poll(
      async () => (await readJson(promptDoc.path)).linked_image_hashes.length === 2,
      15_000,
      "link_images 落盘两条关联",
    );
    // 第一张正常关联图已经是缺省封面，组件按规格不再为它显示“设为封面”。
    // 选择任一其余正常图的显式封面动作，不把默认封面的序号写死进验收脚本。
    const coverButton = linksSection.getByRole("button", { name: /设为封面$/ }).first();
    await coverButton.waitFor({ timeout: 15_000 });
    await coverButton.click();
    await poll(async () => (await readJson(promptDoc.path)).cover_image_hash !== null, 10_000, "显式封面落盘");
    await shot(page, "prompt-links-cover");

    /* S11 提示词备注自动保存与收藏 */
    const promptNote = page.locator('[data-inspector-section="note"] textarea');
    await promptNote.waitFor({ timeout: 10_000 });
    await promptNote.fill("提示词侧的验收备注");
    await poll(async () => (await readJson(promptDoc.path)).note.includes("提示词侧的验收备注"), 10_000, "set_prompt_note 落盘");
    await page.locator(".favorite-toggle").click();
    await poll(async () => (await readJson(promptDoc.path)).favorite === true, 10_000, "set_prompt_favorite 落盘");
    await shot(page, "prompt-note-favorite");

    /* S12 图片回收站：删除 → 还原 → purge */
    await page.getByRole("button", { name: "图片", exact: true }).click();
    await page.keyboard.press("Escape"); // 清掉上一场景可能残留的选择
    const assetCards = page.locator("[data-waterfall-item]");
    await assetCards.first().waitFor({ timeout: 20_000 });
    await page.locator("[data-waterfall-item]", { hasText: "晨雾.png" }).click();
    await page.getByRole("button", { name: "移入回收站" }).first().click();
    await poll(
      async () => {
        const deleted = await findSidecar(
          (meta) => sourceFilename(meta) === "晨雾.png",
          "trash",
        );
        return deleted !== null && deleted.meta.deleted_at !== null;
      },
      10_000,
      "晨雾进入回收站态",
    );
    await page.getByRole("button", { name: "回收站", exact: true }).click();
    const trashCards = page.locator("[data-waterfall-item]");
    try {
      await poll(
        async () => (await trashCards.count()) === 2,
        15_000,
        "回收站呈现迁移废片与晨雾两张素材",
      );
    } catch (error) {
      await dumpState(page, "s12-trash-count-timeout");
      throw error;
    }
    await page.locator("[data-waterfall-item]", { hasText: "废片.png" }).click();
    await page.getByRole("button", { name: "还原图片" }).click();
    await poll(
      async () => {
        const restored = await findSidecar((meta) => sourceFilename(meta) === "废片.png");
        if (restored === null) return false;
        return (
          restored.meta.deleted_at === null &&
          restored.meta.folder === "参考/构图"
        );
      },
      10_000,
      "废片还原并回到删除前归属",
    );
    await page.getByRole("button", { name: "清空图片回收站" }).click();
    const purgeDialog = page.getByRole("alertdialog");
    await purgeDialog.waitFor({ timeout: 5_000 });
    await purgeDialog.getByRole("button", { name: "永久清空" }).click();
    await poll(async () => (await page.getByText(/已永久删除 1 张图片/).count()) >= 1, 15_000, "purge 报告逐项数量");
    assert(sidecarPaths("trash").length === 0, "purge 后 trash 树应为空");
    assert(
      (await findSidecar((meta) => sourceFilename(meta) === "晨雾.png")) === null,
      "晨雾本体与侧车应被永久移除",
    );
    assert(
      (await findSidecar((meta) => sourceFilename(meta) === "废片.png")) !== null,
      "还原过的废片不受 purge 影响",
    );
    await shot(page, "asset-trash-purge");

    /* S13 提示词回收站：删除 → 还原 → 再删除 → purge */
    await page.getByRole("button", { name: "提示词", exact: true }).click();
    await page.locator("[data-prompt-card]").first().waitFor({ timeout: 20_000 });
    await page.locator("[data-prompt-card]").first().click();
    await page.getByRole("button", { name: "移入回收站" }).first().click();
    const promptTrashDialog = page.getByRole("dialog");
    await promptTrashDialog.waitFor({ timeout: 5_000 });
    await promptTrashDialog.getByRole("button", { name: "移入回收站" }).click();
    await poll(async () => {
      const [path] = promptFiles("trash");
      return path === undefined ? false : (await readJson(path)).deleted_at !== null;
    }, 10_000, "提示词进入回收站态");
    await page.getByRole("button", { name: "回收站", exact: true }).click();
    await page.locator("[data-prompt-card]").first().waitFor({ timeout: 15_000 });
    await page.locator("[data-prompt-card]").first().click();
    await page.getByRole("button", { name: "还原提示词" }).click();
    await poll(async () => {
      const [path] = promptFiles();
      if (path === undefined) return false;
      const meta = await readJson(path);
      return meta.deleted_at === null && meta.folders.includes("人像");
    }, 10_000, "提示词还原到原文件夹");

    await page.getByRole("button", { name: "全部提示词" }).click();
    await page.locator("[data-prompt-card]").first().waitFor({ timeout: 15_000 });
    await page.locator("[data-prompt-card]").first().click();
    await page.getByRole("button", { name: "移入回收站" }).first().click();
    const secondPromptTrashDialog = page.getByRole("dialog");
    await secondPromptTrashDialog.waitFor({ timeout: 5_000 });
    await secondPromptTrashDialog.getByRole("button", { name: "移入回收站" }).click();
    await poll(() => promptFiles("trash").length === 1, 10_000, "提示词再次进入回收站");
    await page.getByRole("button", { name: "回收站", exact: true }).click();
    await page.getByRole("button", { name: "清空回收站", exact: true }).click();
    const promptPurgeDialog = page.getByRole("dialog");
    await promptPurgeDialog.waitFor({ timeout: 5_000 });
    await promptPurgeDialog.getByRole("button", { name: "永久删除" }).click();
    await poll(async () => (await page.getByText(/已永久删除 1 条/).count()) >= 1, 15_000, "提示词 purge 报告数量");
    assert(promptFiles().length === 0, "purge 后提示词权威文件应被移除");
    await shot(page, "prompt-trash-purge");

      },
    );
    results.push({ step: "全部场景", status: "通过" });
  } catch (error) {
    results.push({
      step: "失败",
      status: String(error && error.stack ? error.stack : error),
      exeOutput: exeOutput.slice(-2000),
    });
    process.exitCode = 1;
  }

  writeFileSync(REPORT, JSON.stringify(results, null, 2));
  console.table(results.map(({ step, status }) => ({ step, status })));
  console.log(`报告已写入 ${REPORT}，截图在 ${SHOTS}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
