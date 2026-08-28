"""验收图片多选与部分成功反馈；只操作开发入口的内存库。"""
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
    artifacts = Path(__file__).resolve().parent.parent / "artifacts" / "asset-selection"
    artifacts.mkdir(parents=True, exist_ok=True)
    reports = []
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge", headless=True)
        try:
            for theme in ["dark", "light"]:
                for width, height in [(1440, 900), (760, 600)]:
                    context = browser.new_context(viewport={"width": width, "height": height}, color_scheme=theme)
                    try:
                        page = context.new_page()
                        errors = []
                        page.on("pageerror", lambda error: errors.append(str(error)))
                        page.goto(f"{args.base_url.rstrip('/')}/?dev=asset-library", wait_until="networkidle")
                        collection = page.get_by_role("listbox", name="图片集合", exact=True)
                        first = collection.get_by_role("option", name="甲库测试图-0.png", exact=True)
                        second = collection.get_by_role("option", name="甲库测试图-1.png", exact=True)
                        bar = page.get_by_role("toolbar", name="批量操作", exact=True)
                        expect(first).to_be_visible()
                        first.click()
                        second.click(modifiers=["Control"])
                        expect(bar).to_contain_text("已选中 2 项")
                        second.press("Control+a")
                        expect(bar).to_contain_text("已选中 1000 项")
                        second.press("Escape")
                        expect(bar).to_have_count(0)
                        expect(collection.locator('[aria-current="true"]')).to_have_count(0)
                        first.click()
                        first.press("Shift+ArrowDown")
                        expect(bar).to_contain_text("已选中 2 项")
                        expect(second).to_be_focused()
                        page.get_by_role("button", name="详情列表", exact=True).click()
                        expect(bar).to_contain_text("已选中 2 项")
                        expect(page.locator('[data-list-item][aria-selected="true"]')).to_have_count(2)
                        first.click()
                        first.click(button="right")
                        menu = page.get_by_role("menu", name="素材快捷菜单", exact=True)
                        expect(menu).to_be_visible()
                        menu.get_by_role("menuitem", name="收藏", exact=True).click()
                        expect(page.get_by_role("region", name="操作结果")).to_contain_text("成功 1 项")
                        second.click(modifiers=["Control"])
                        page.get_by_role("button", name="模拟部分失败", exact=True).click()
                        bar.get_by_role("button", name="收藏", exact=True).click()
                        results = page.get_by_role("region", name="操作结果", exact=True)
                        expect(results).to_contain_text("library.io_failed")
                        expect(results).to_contain_text("失败 1 项")
                        page.screenshot(path=str(artifacts / f"partial-{theme}-{width}.png"), animations="disabled")
                        second.press("Escape")
                        expect(bar).to_have_count(0)
                        expect(results).to_contain_text("library.io_failed")
                        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "水平溢出"
                        assert not errors, errors
                        result = {"theme": theme, "width": width, "keyboard": True, "selection_retained": True, "partial_report_retained": True}
                        reports.append(result)
                        print(json.dumps(result, ensure_ascii=False), flush=True)
                    finally:
                        context.close()
        finally:
            browser.close()
    (artifacts / "report.json").write_text(json.dumps(reports, ensure_ascii=False, indent=2), encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
