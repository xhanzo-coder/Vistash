"""验收图片栏位宽度/折叠与详情列表列；只操作开发内存库。"""
import argparse
import json
from pathlib import Path
import re
import sys

from playwright.sync_api import expect, sync_playwright


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True)
    args = parser.parse_args()
    artifacts = Path(__file__).resolve().parent.parent / "artifacts" / "panel-and-list"
    artifacts.mkdir(parents=True, exist_ok=True)
    reports = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel="msedge", headless=True)
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
                        expect(collection.get_by_role("option").first).to_be_visible()
                        if width > 1050:
                            navigation_separator = page.get_by_role("separator", name="调整图片导航宽度", exact=True)
                            inspector_separator = page.get_by_role("separator", name="调整图片检查器宽度", exact=True)
                            expect(navigation_separator).to_have_attribute("aria-valuenow", "216")
                            expect(inspector_separator).to_have_attribute("aria-valuenow", "288")
                            navigation_separator.focus()
                            navigation_separator.press("ArrowRight")
                            expect(navigation_separator).to_have_attribute("aria-valuenow", "224")
                            page.get_by_role("button", name="收起图片导航", exact=True).click()
                            expect(page.get_by_role("button", name="展开图片导航", exact=True)).to_be_visible()
                            navigation = page.get_by_role("navigation", name="图片导航", exact=True)
                            expect(navigation.locator('[class*="folderSection"]')).to_be_hidden()
                            expect(navigation.locator('[class*="tagSection"]')).to_be_hidden()
                            assert navigation.evaluate("element => element.scrollWidth <= element.clientWidth"), "折叠导航出现横向滚动"
                            page.screenshot(path=str(artifacts / f"collapsed-{theme}-{width}.png"), animations="disabled")
                            page.get_by_role("button", name="展开图片导航", exact=True).click()
                            expect(page.get_by_role("button", name="收起图片导航", exact=True)).to_be_visible()
                            box = inspector_separator.bounding_box()
                            assert box is not None
                            page.mouse.move(box["x"] + box["width"] / 2, box["y"] + 120)
                            page.mouse.down()
                            page.mouse.move(box["x"] - 32, box["y"] + 120, steps=8)
                            page.mouse.up()
                            expect(inspector_separator).to_have_attribute("aria-valuenow", re.compile(r"^3[12][0-9]$"))
                            page.get_by_role("button", name="收起图片检查器", exact=True).click()
                            expect(page.get_by_role("button", name="展开图片检查器", exact=True)).to_be_visible()
                            page.get_by_role("button", name="展开图片检查器", exact=True).click()
                            expect(page.get_by_role("button", name="收起图片检查器", exact=True)).to_be_visible()
                        else:
                            expect(page.get_by_role("separator")).to_have_count(0)
                            expect(page.get_by_role("button", name="图片导航", exact=True)).to_be_visible()
                            expect(page.get_by_role("button", name="图片信息", exact=True)).to_be_visible()

                        page.get_by_role("button", name="详情列表", exact=True).click()
                        header = page.locator('[aria-label="详情列表列标题"]')
                        expect(header).to_be_visible()
                        row = collection.get_by_role("option").first
                        expect(row.locator('[data-column="folder"]')).to_have_text("未分类")
                        expect(row.locator('[data-column="format"]')).to_have_text("PNG")
                        expect(row.locator('[data-column="note"]')).to_have_text("开发专用品牌测试图")
                        if width == 1440:
                            expect(header.get_by_text("备注", exact=True)).to_be_visible()
                            expect(header.get_by_text("导入时间", exact=True)).to_be_visible()
                        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "页面水平溢出"
                        assert not errors, errors
                        page.screenshot(path=str(artifacts / f"details-{theme}-{width}.png"), animations="disabled")
                        report = {"theme": theme, "width": width, "panels": True, "keyboard_resize": width > 1050, "details": True, "overflow": False}
                        reports.append(report)
                        print(json.dumps(report, ensure_ascii=False), flush=True)
                    finally:
                        context.close()
        finally:
            browser.close()
    (artifacts / "report.json").write_text(json.dumps(reports, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
