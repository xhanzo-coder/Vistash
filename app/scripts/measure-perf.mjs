/**
 * 生产渲染层的性能基线测量（任务 11.4）。
 *
 * 口径沿用原型阶段（design.md「性能」）：Chromium 内核对 release 构建实测——这里
 * 用系统 Microsoft Edge（WebView2 与它同为 Chromium 内核）加载 `pnpm build` 产出的
 * dist，IPC 层以注入桩应答 10,000 条 fixture，因此测得的是真实的虚拟化、布局与
 * 合成成本（不含 Rust 编目耗时）。
 *
 * 四个场景 × 六项指标：首屏（导航到集合项出现）、集合 DOM、快速滚动双帧
 * （45 次 × 900 px）、DOM 峰值、JS heap、视图切换耗时与切换后 heap。
 *
 * 运行：`node scripts/measure-perf.mjs`（先 `pnpm build`）。
 */

import { accessSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const EDGE_CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];
const ITEM_COUNT = 10_000;
const SCROLL_STEPS = 45;
const SCROLL_PX = 900;
/** 四个集合视图的滚动容器类名：测量时由集合项向上就近匹配。 */
const SCROLLER_CLASSES = '[role="listbox"][aria-label="图片集合"],.prompt-waterfall,.prompt-detail-list';
const VIEWPORT = { width: 1440, height: 900 };
const LIMITS = {
  firstScreenMs: 350,
  initialDom: 24,
  avgDoubleFrameMs: 20,
  worstDoubleFrameMs: 35,
  peakDom: 40,
  heapMiB: 60,
  heapAfterSwitchMiB: 65,
  switchMs: 50,
};

/* ---------------------------------------------------- 共享 fixture 与 IPC 桩 */

import { buildBootstrap } from "./perfFixture.mjs";

/* --------------------------------------------------------------- 基础设施 */

async function serveDist() {
  const mime = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff2": "font/woff2",
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      let path = join(DIST, decodeURIComponent(url.pathname));
      if (url.pathname === "/" || !path.startsWith(DIST)) path = join(DIST, "index.html");
      const body = await readFile(path);
      res.writeHead(200, { "content-type": mime[extname(path)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: /** @type {import("node:net").AddressInfo} */ (server.address()).port };
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function fileExists(path) {
  try {
    accessSync(path);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ 测量 */

/**
 * 单场景流程：进入 → 等首项（记首屏）→ 数 DOM → 快速滚动（双帧/峰值）→ 回顶读
 * heap → 切换到另一视图（记切换耗时与切换后 heap）。每个场景用新页面，互不残留。
 */
async function measure(context, port, scenario) {
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  for (const step of scenario.enter) await step(page);

  // 每个场景从“已进入该视图”开始计时，避免把上一个工作区的启动成本
  // 重复算入切换后的首屏；图片初始场景的 enter 本身就是页面启动。
  const scenarioStart = await page.evaluate(() => performance.now());
  await page.waitForSelector(scenario.itemSelector, { state: "attached" });
  const firstScreenMs = Math.round((await page.evaluate(() => performance.now())) - scenarioStart);
  const initialDom = await page.locator(scenario.itemSelector).count();

  // 快速滚动：45 次 × 900 px；每次等两帧让虚拟化跟上，再采样下一对帧的间隔。
  const scrollResult = await page.evaluate(
    ([selector, scrollerClasses, steps, px]) => {
      const target = document.querySelector(selector)?.closest(scrollerClasses);
      if (target === null || target === undefined) throw new Error(`未找到集合滚动容器：${selector}`);
      if (target.scrollHeight <= target.clientHeight) throw new Error(`性能夹具不可滚动：${selector}`);
      const frames = () =>
        new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return (async () => {
        const frameTimes = [];
        let peakDom = 0;
        for (let step = 0; step < steps; step += 1) {
          const previousOffset = target.scrollTop;
          target.scrollBy(0, px);
          await frames();
          if (target.scrollTop <= previousOffset) throw new Error(`集合没有实际滚动：${selector}，步骤 ${step}`);
          const t0 = performance.now();
          await frames();
          frameTimes.push(performance.now() - t0);
          peakDom = Math.max(peakDom, document.querySelectorAll(selector).length);
        }
        return {
          avgDoubleFrameMs: Math.round((frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length) * 100) / 100,
          worstDoubleFrameMs: Math.round(Math.max(...frameTimes) * 100) / 100,
          peakDom,
          finalScrollTop: target.scrollTop,
        };
      })();
    },
    [scenario.itemSelector, SCROLLER_CLASSES, SCROLL_STEPS, SCROLL_PX],
  );

  // 回滚到顶部，等防抖写入与 blob 释放稳定后读驻留内存。
  await page.evaluate(
    ([selector, scrollerClasses]) => {
      const scroller = document.querySelector(selector)?.closest(scrollerClasses);
      if (scroller === null || scroller === undefined) throw new Error(`未找到集合滚动容器：${selector}`);
      scroller.scrollTop = 0;
    },
    [scenario.itemSelector, SCROLLER_CLASSES],
  );
  await page.waitForTimeout(400);
  const heapMiB = round((await page.evaluate(() => {
    if (typeof globalThis.gc === "function") globalThis.gc();
    return performance.memory.usedJSHeapSize;
  })) / (1024 * 1024));

  let switchMetrics = {};
  if (scenario.switchTo !== undefined) {
    const t0 = Date.now();
    await page.getByRole("button", { name: scenario.switchTo.button }).click();
    await page.waitForSelector(scenario.switchTo.selector, { state: "attached" });
    switchMetrics = {
      switchMs: Date.now() - t0,
      heapAfterSwitchMiB: round((await page.evaluate(() => {
        if (typeof globalThis.gc === "function") globalThis.gc();
        return performance.memory.usedJSHeapSize;
      })) / (1024 * 1024)),
    };
  }

  await page.close();
  return { scenario: scenario.name, firstScreenMs, initialDom, ...scrollResult, heapMiB, ...switchMetrics };
}

async function main() {
  const executablePath = EDGE_CANDIDATES.find(fileExists);
  if (executablePath === undefined) throw new Error("未找到系统 Edge");

  const { server, port } = await serveDist();
  const browser = await chromium.launch({
    executablePath,
    args: ["--enable-precise-memory-info", "--js-flags=--expose-gc"],
  });
  const context = await browser.newContext({ viewport: VIEWPORT });
  await context.addInitScript(buildBootstrap(ITEM_COUNT));

  const waitItem = (selector) => async (page) => {
    await page.waitForLoadState("domcontentloaded");
    await page.waitForSelector(selector, { state: "attached" });
  };

  const scenarios = [
    {
      name: "图片瀑布流",
      enter: [(page) => page.waitForLoadState("domcontentloaded")],
      itemSelector: "[data-waterfall-item]",
      switchTo: { button: "详情列表", selector: "[data-list-item]" },
    },
    {
      name: "图片详情列表",
      enter: [waitItem("[data-waterfall-item]"), (page) => page.getByRole("button", { name: "详情列表" }).click()],
      itemSelector: "[data-list-item]",
      switchTo: { button: "瀑布流", selector: "[data-waterfall-item]" },
    },
    {
      name: "提示词卡片瀑布流",
      enter: [
        waitItem("[data-waterfall-item]"),
        (page) => page.getByRole("button", { name: "提示词", exact: true }).click(),
      ],
      itemSelector: "[data-prompt-card]",
      switchTo: { button: "详情列表", selector: '.prompt-detail-list [role="row"]' },
    },
    {
      name: "提示词详情列表",
      enter: [
        waitItem("[data-waterfall-item]"),
        (page) => page.getByRole("button", { name: "提示词", exact: true }).click(),
        waitItem("[data-prompt-card]"),
        (page) => page.getByRole("button", { name: "详情列表" }).click(),
      ],
      itemSelector: '.prompt-detail-list [role="row"]',
      switchTo: { button: "卡片瀑布流", selector: "[data-prompt-card]" },
    },
  ];

  const results = [];
  for (const scenario of scenarios) results.push(await measure(context, port, scenario));

  console.table(results.map(({ scenario, firstScreenMs, initialDom, avgDoubleFrameMs, worstDoubleFrameMs, peakDom, heapMiB, switchMs }) => ({ scenario, firstScreenMs, initialDom, avgDoubleFrameMs, worstDoubleFrameMs, peakDom, heapMiB, switchMs })));
  // 纠偏证据单独保存，不覆盖先前的历史基线。
  const artifactDir = new URL("../artifacts/archive-desk-correction/", import.meta.url);
  await mkdir(artifactDir, { recursive: true });
  const out = fileURLToPath(new URL("perf-report.json", artifactDir));
  await writeFile(out, JSON.stringify(results, null, 2), "utf8");
  console.log(`已写入 ${out}`);

  const failures = results.flatMap((result) => Object.entries(LIMITS).flatMap(([metric, limit]) => {
    const value = result[metric];
    return typeof value === "number" && value > limit
      ? [`${result.scenario} ${metric}=${value} 超过 ${limit}`]
      : [];
  }));
  if (failures.length > 0) throw new Error(`性能门禁失败：${failures.join("；")}`);

  await browser.close();
  server.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
