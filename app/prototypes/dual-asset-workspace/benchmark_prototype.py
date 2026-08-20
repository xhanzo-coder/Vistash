"""PROTOTYPE：比较自有定位器与 TanStack Virtual，不代表生产性能承诺。"""

import json
from pathlib import Path
from time import perf_counter

from playwright.sync_api import Page, sync_playwright


ARTIFACTS = Path(__file__).parent / "artifacts"
ARTIFACTS.mkdir(exist_ok=True)
BASE_URL = "http://localhost:1421"


def chromium_metrics(session) -> dict[str, float]:
    raw = session.send("Performance.getMetrics")["metrics"]
    return {entry["name"]: entry["value"] for entry in raw}


def benchmark_engine(page: Page, session, engine: str) -> dict[str, object]:
    page.add_init_script(
        """
        window.__prototypeLongTasks = [];
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) window.__prototypeLongTasks.push(entry.duration);
        }).observe({type: 'longtask', buffered: true});
        """
    )
    started = perf_counter()
    page.goto(f"{BASE_URL}/?variant=A&engine={engine}")
    page.wait_for_load_state("networkidle")
    initial_load_ms = (perf_counter() - started) * 1000
    before_scroll = chromium_metrics(session)
    initial_dom = page.locator("[data-prototype-item]").count()

    scroll_result = page.evaluate(
        """
        async () => {
          const scroller = document.querySelector('.virtual-collection');
          if (!(scroller instanceof HTMLElement)) throw new Error('missing scroller');
          const durations = [];
          for (let step = 1; step <= 45; step += 1) {
            const started = performance.now();
            scroller.scrollTop = step * 900;
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            durations.push(performance.now() - started);
          }
          return {
            maxFramePairMs: Math.max(...durations),
            averageFramePairMs: durations.reduce((sum, value) => sum + value, 0) / durations.length,
            finalScrollTop: scroller.scrollTop,
            renderedItems: document.querySelectorAll('[data-prototype-item]').length,
          };
        }
        """
    )
    after_scroll = chromium_metrics(session)

    scroll_to_samples: list[dict[str, object]] = []
    if engine == "tanstack":
        for target in (0, 4_999, 9_999):
            sample = page.evaluate(
                """
                async (target) => {
                  const scroller = document.querySelector('.virtual-collection');
                  if (!(scroller instanceof HTMLElement)) throw new Error('missing scroller');
                  if (typeof scroller.prototypeScrollToIndex !== 'function') throw new Error('missing scrollToIndex bridge');
                  scroller.prototypeScrollToIndex(target);
                  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                  const rendered = [...document.querySelectorAll('[data-index]')].map((node) => Number(node.dataset.index));
                  return {target, minRendered: Math.min(...rendered), maxRendered: Math.max(...rendered), scrollTop: scroller.scrollTop};
                }
                """,
                target,
            )
            scroll_to_samples.append(sample)

    search = page.locator("[data-current-library-search]")
    search.fill("visual_reference_00001")
    page.wait_for_timeout(120)
    filtered_dom = page.locator("[data-prototype-item]").count()
    filtered_result_text = page.locator(".collection-title span").inner_text()
    search.fill("")
    page.wait_for_timeout(120)
    restored_dom = page.locator("[data-prototype-item]").count()

    switch_started = perf_counter()
    page.get_by_role("button", name="详情列表", exact=True).click()
    page.locator(".virtual-collection.is-details").wait_for()
    details_switch_ms = (perf_counter() - switch_started) * 1000
    details_dom = page.locator("[data-prototype-item]").count()

    resize_samples: dict[str, dict[str, float]] = {}
    for width in (1_200, 900, 720, 1_440):
        resize_started = perf_counter()
        page.set_viewport_size({"width": width, "height": 900})
        page.wait_for_timeout(120)
        resize_samples[str(width)] = {
            "settle_ms": round((perf_counter() - resize_started) * 1000, 2),
            "rendered_items": page.locator("[data-prototype-item]").count(),
            "horizontal_overflow_px": page.evaluate("document.documentElement.scrollWidth - window.innerWidth"),
        }

    long_tasks = page.evaluate("window.__prototypeLongTasks")
    return {
        "fixture_items_per_library": 10_000,
        "implementation": engine,
        "initial_load_ms_including_vite_and_networkidle": round(initial_load_ms, 2),
        "initial_rendered_items": initial_dom,
        "details_rendered_items": details_dom,
        "details_switch_ms": round(details_switch_ms, 2),
        "filter_to_one_dom": filtered_dom,
        "filter_result_text": filtered_result_text,
        "filter_restore_dom": restored_dom,
        "scroll_to_index": scroll_to_samples,
        "scroll": {key: round(value, 2) if isinstance(value, float) else value for key, value in scroll_result.items()},
        "long_tasks_ms": [round(value, 2) for value in long_tasks],
        "js_heap_used_mb_before_scroll": round(before_scroll.get("JSHeapUsedSize", 0) / 1024 / 1024, 2),
        "js_heap_used_mb_after_scroll": round(after_scroll.get("JSHeapUsedSize", 0) / 1024 / 1024, 2),
        "layout_count_delta": round(after_scroll.get("LayoutCount", 0) - before_scroll.get("LayoutCount", 0), 0),
        "recalc_style_count_delta": round(after_scroll.get("RecalcStyleCount", 0) - before_scroll.get("RecalcStyleCount", 0), 0),
        "resize_samples": resize_samples,
    }


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    results: dict[str, object] = {}
    for candidate in ("owned", "tanstack"):
        context = browser.new_context(viewport={"width": 1_440, "height": 900})
        page = context.new_page()
        session = context.new_cdp_session(page)
        session.send("Performance.enable")
        results[candidate] = benchmark_engine(page, session, candidate)
        context.close()

    output = {
        "scope": "throwaway-prototype-only",
        "browser": "Playwright Chromium; WebView2 仍需 Windows 原生壳验收",
        "results": results,
    }
    (ARTIFACTS / "virtualizer-comparison.json").write_text(
        json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    owned = results["owned"]
    tanstack = results["tanstack"]
    if not isinstance(owned, dict) or not isinstance(tanstack, dict):
        raise TypeError("基准结果类型错误")
    (ARTIFACTS / "virtualizer-comparison.md").write_text(
        "# PROTOTYPE — 虚拟化实测比较\n\n"
        "> 可丢弃原型数据，不是生产性能承诺；Chromium 结果需在 Windows WebView2 壳复验。\n\n"
        "| 指标 | 自有基线 | TanStack 3.14.10 |\n"
        "| --- | ---: | ---: |\n"
        f"| 首屏 DOM | {owned['initial_rendered_items']} | {tanstack['initial_rendered_items']} |\n"
        f"| 快速滚动平均双帧 | {owned['scroll']['averageFramePairMs']} ms | {tanstack['scroll']['averageFramePairMs']} ms |\n"
        f"| 快速滚动最慢双帧 | {owned['scroll']['maxFramePairMs']} ms | {tanstack['scroll']['maxFramePairMs']} ms |\n"
        f"| 滚动后 JS heap | {owned['js_heap_used_mb_after_scroll']} MB | {tanstack['js_heap_used_mb_after_scroll']} MB |\n"
        f"| 详情切换 | {owned['details_switch_ms']} ms | {tanstack['details_switch_ms']} ms |\n"
        f"| 长任务 | {owned['long_tasks_ms']} | {tanstack['long_tasks_ms']} |\n",
        encoding="utf-8",
    )
    print(json.dumps(output, ensure_ascii=False, indent=2))
    browser.close()
