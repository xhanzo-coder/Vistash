"""检查真实图片模块的布局；仅使用内存展台，不读写使用者素材库。"""
import argparse
import json
from pathlib import Path
import sys

from playwright.sync_api import expect, sync_playwright


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True)
    args = parser.parse_args()
    artifacts = Path(__file__).resolve().parent.parent / "artifacts" / "archive-desk-correction"
    artifacts.mkdir(parents=True, exist_ok=True)
    reports = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel="msedge", headless=True)
        try:
            for theme in ["light", "dark"]:
                for width, height in [(1440, 900), (1274, 819), (960, 760), (760, 600)]:
                    context = browser.new_context(viewport={"width": width, "height": height}, color_scheme=theme)
                    try:
                        page = context.new_page()
                        errors = []
                        page.on("pageerror", lambda error: errors.append(str(error)))
                        page.goto(f"{args.base_url.rstrip('/')}/?dev=asset-library", wait_until="networkidle")
                        collection = page.get_by_role("listbox", name="图片集合", exact=True)
                        expect(collection.get_by_role("option").first).to_be_visible()
                        navigation = page.get_by_role("navigation", name="图片导航", exact=True)
                        heading = page.get_by_role("heading", level=1)
                        expect(heading).to_have_text("全部图片")
                        toolbar = page.get_by_role("toolbar", name="图片查询与视图", exact=True)
                        expect(toolbar.get_by_role("button", name="新建文件夹", exact=True)).to_have_count(0)
                        expect(navigation.get_by_role("button", name="全部图片", exact=True)).to_be_visible()
                        geometry = page.evaluate("""() => {
                          const workspace = document.querySelector('[aria-label="图片工作区"]');
                          const nav = workspace.querySelector('nav');
                          const heading = workspace.querySelector('h1').parentElement;
                          const inspector = workspace.querySelector('aside[aria-label="图片检查器"]');
                          const collapseButton = workspace.querySelector('button[aria-label="收起图片导航"]');
                          const firstEntry = nav.querySelector('button[title="全部图片"]');
                          if (collapseButton === null || firstEntry === null) {
                            throw new Error('缺少图片导航收起按钮或全部图片入口');
                          }
                          const collapseRect = collapseButton.getBoundingClientRect();
                          const firstEntryRect = firstEntry.getBoundingClientRect();
                          const verticalOverlap = collapseRect.bottom > firstEntryRect.top && collapseRect.top < firstEntryRect.bottom;
                          const horizontalOverlap = collapseRect.right > firstEntryRect.left && collapseRect.left < firstEntryRect.right;
                          return {
                            workspaceTop: workspace.getBoundingClientRect().top,
                            navigationTop: nav.getBoundingClientRect().top,
                            headingTop: heading.getBoundingClientRect().top,
                            inspectorTop: inspector?.getBoundingClientRect().top,
                            scrollWidth: document.documentElement.scrollWidth,
                            collapseButton: { top: collapseRect.top, right: collapseRect.right, bottom: collapseRect.bottom, left: collapseRect.left },
                            firstEntry: { top: firstEntryRect.top, right: firstEntryRect.right, bottom: firstEntryRect.bottom, left: firstEntryRect.left },
                            collapseOverlapsFirstEntry: verticalOverlap && horizontalOverlap,
                          };
                        }""")
                        assert not geometry["collapseOverlapsFirstEntry"], geometry
                        assert abs(geometry["navigationTop"] - geometry["workspaceTop"]) <= 1, geometry
                        assert abs(geometry["headingTop"] - geometry["workspaceTop"]) <= 1, geometry
                        if width > 780:
                            assert abs(geometry["inspectorTop"] - geometry["workspaceTop"]) <= 1, geometry
                        assert geometry["scrollWidth"] <= width, geometry
                        # 默认档位在宽屏为四列；不是把两三张图片放大填满中央区。
                        if width == 1440:
                            columns = collection.get_by_role("option").evaluate_all("elements => new Set(elements.map(el => Math.round(el.getBoundingClientRect().left))).size")
                            assert columns == 4, {"expected_columns": 4, "actual_columns": columns}
                        if width > 1050:
                            expect(navigation.get_by_role("button", name="新建文件夹", exact=True)).to_be_visible()
                        else:
                            page.get_by_role("button", name="图片导航", exact=True).click()
                            dialog = page.get_by_role("dialog", name="图片导航", exact=True)
                            expect(dialog.get_by_role("button", name="新建文件夹", exact=True)).to_be_visible()
                            page.keyboard.press("Escape")
                            expect(dialog).to_have_count(0)
                        page.screenshot(path=str(artifacts / f"module-fixture-{theme}-{width}.png"))
                        # 名称不能只对鼠标可见：默认弱化，悬停、键盘焦点和选中均呈现。
                        first = collection.get_by_role("option").first
                        caption = first.locator("span").first.locator("..")
                        expect(caption).to_have_css("opacity", "0")
                        first.hover()
                        expect(caption).to_have_css("opacity", "1")
                        page.mouse.move(0, 0)
                        first.focus()
                        expect(caption).to_have_css("opacity", "1")
                        first.click()
                        page.get_by_role("searchbox", name="按文件名搜索", exact=True).focus()
                        expect(first).to_have_attribute("aria-selected", "true")
                        expect(caption).to_have_css("opacity", "1")
                        page.screenshot(path=str(artifacts / f"module-fixture-selected-{theme}-{width}.png"))
                        if width == 1440:
                            page.set_viewport_size({"width": 1400, "height": height})
                            # 正方形 fixture：列数不变时改变列宽仍须刷新高度缓存。
                            page.wait_for_function("""() => {
                              const box = document.querySelector('[data-waterfall-item]').getBoundingClientRect();
                              return Math.abs(box.width - box.height) <= 1;
                            }""")
                        if width > 1050:
                            collapse = page.get_by_role("button", name="收起图片导航", exact=True)
                            expect(collapse).to_be_visible()
                            collapse.click()
                            expand = page.get_by_role("button", name="展开图片导航", exact=True)
                            expect(expand).to_be_visible()
                            collapsed_geometry = page.evaluate("""() => {
                              const workspace = document.querySelector('[aria-label="图片工作区"]');
                              const nav = workspace.querySelector('nav');
                              const collapseButton = workspace.querySelector('button[aria-label="展开图片导航"]');
                              const firstEntry = nav.querySelector('button[title="全部图片"]');
                              if (collapseButton === null || firstEntry === null) {
                                throw new Error('收起态缺少展开按钮或全部图片入口');
                              }
                              const collapseRect = collapseButton.getBoundingClientRect();
                              const firstEntryRect = firstEntry.getBoundingClientRect();
                              return {
                                collapseButton: { top: collapseRect.top, right: collapseRect.right, bottom: collapseRect.bottom, left: collapseRect.left },
                                firstEntry: { top: firstEntryRect.top, right: firstEntryRect.right, bottom: firstEntryRect.bottom, left: firstEntryRect.left },
                                collapseOverlapsFirstEntry: collapseRect.bottom > firstEntryRect.top && collapseRect.top < firstEntryRect.bottom && collapseRect.right > firstEntryRect.left && collapseRect.left < firstEntryRect.right,
                              };
                            }""")
                            assert not collapsed_geometry["collapseOverlapsFirstEntry"], collapsed_geometry
                            expand.click()
                            expect(page.get_by_role("button", name="收起图片导航", exact=True)).to_be_visible()
                        assert not errors, errors
                        report = {"theme": theme, "width": width, "height": height, "source": "production-component-memory-fixture", "geometry": geometry}
                        reports.append(report)
                        print(json.dumps(report, ensure_ascii=False), flush=True)
                    finally:
                        context.close()
        finally:
            browser.close()
    (artifacts / "layout-report.json").write_text(json.dumps(reports, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
