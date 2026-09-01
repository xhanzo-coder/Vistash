"""单选检查器真实浏览器验收；仅访问开发内存库，不读写用户素材。"""
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
    artifacts = Path(__file__).resolve().parent.parent / "artifacts" / "inspector"
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
                        asset = page.get_by_role("listbox", name="图片集合", exact=True).locator('[data-hash="' + "0" * 64 + '"]')
                        asset.click()
                        narrow = width <= 780
                        if narrow:
                            page.get_by_role("button", name="图片信息", exact=True).click()
                        scope = page.get_by_role("dialog", name="图片信息", exact=True) if narrow else page.get_by_role("complementary", name="图片检查器", exact=True)
                        expect(scope.locator("[data-inspector-section]")).to_have_count(6)
                        expect(scope.locator('[data-inspector-section="summary"] img')).to_be_visible()
                        expect(scope).to_contain_text("#E8664A")
                        page.screenshot(path=str(artifacts / f"summary-{theme}-{width}.png"), animations="disabled")
                        scope.get_by_role("button", name="色卡", exact=True).click()
                        expect(scope.get_by_role("button", name="色卡", exact=True)).to_have_attribute("aria-expanded", "false")
                        expect(scope.get_by_role("navigation", name="检查器分区定位", exact=True)).to_have_count(0)
                        expect(scope.get_by_role("button", name="色卡", exact=True)).to_be_focused()
                        scope.get_by_role("combobox", name="图片所在文件夹").select_option("folder:配色")
                        expect(scope.get_by_role("combobox", name="图片所在文件夹")).to_be_enabled()
                        expect(scope.get_by_role("combobox", name="图片所在文件夹")).to_have_value("folder:配色")
                        tag = scope.get_by_role("textbox", name="添加图片标签", exact=True)
                        tag.fill("构图参考")
                        scope.get_by_role("button", name="添加标签", exact=True).click()
                        expect(scope.get_by_role("button", name="移除图片标签 构图参考", exact=True)).to_be_enabled()
                        expect(tag).to_have_value("")
                        note = scope.get_by_role("textbox", name="图片备注", exact=True)
                        note.fill("# 纯文本备注\n保存后保留中文 **标记**")
                        note.press("Control+Enter")
                        expect(scope.get_by_text("已保存", exact=True)).to_be_visible()
                        expect(note).to_have_value("# 纯文本备注\n保存后保留中文 **标记**")
                        scope.get_by_role("button", name="建立关联", exact=True).click()
                        scope.get_by_role("radio", name="光影参考", exact=True).check()
                        scope.get_by_role("button", name="确认关联", exact=True).click()
                        expect(scope.get_by_role("button", name="解除关联 光影参考", exact=True)).to_be_enabled()
                        scope.get_by_role("button", name="解除关联 光影参考", exact=True).click()
                        expect(scope.get_by_role("button", name="解除关联 光影参考", exact=True)).to_have_count(0)
                        expect(scope).to_contain_text("归档提示词")
                        if narrow:
                            scope.get_by_role("button", name="关闭", exact=True).click()
                        page.get_by_role("button", name="模拟保存失败", exact=True).click()
                        if narrow:
                            page.get_by_role("button", name="图片信息", exact=True).click()
                        note.fill("失败后保留：这段备注不可丢失")
                        note.press("Control+Enter")
                        expect(scope.locator('[data-inspector-section="note"]').get_by_role("alert")).to_contain_text("library.asset_metadata_write_failed")
                        expect(note).to_have_value("失败后保留：这段备注不可丢失")
                        scope.locator('[data-inspector-section="note"]').get_by_role("alert").scroll_into_view_if_needed()
                        expect(scope.locator('[data-inspector-section="note"]').get_by_role("alert")).to_be_visible()
                        page.screenshot(path=str(artifacts / f"note-error-{theme}-{width}.png"), animations="disabled")
                        if narrow:
                            scope.get_by_role("button", name="关闭", exact=True).click()
                        page.get_by_role("button", name="模拟保存失败", exact=True).click()
                        if narrow:
                            page.get_by_role("button", name="图片信息", exact=True).click()
                        expect(note).to_have_value("失败后保留：这段备注不可丢失")
                        scope.get_by_role("button", name="保存备注", exact=True).click()
                        expect(scope.get_by_text("已保存", exact=True)).to_be_visible()
                        file_heading = scope.get_by_role("button", name="文件信息", exact=True)
                        file_heading.scroll_into_view_if_needed()
                        file_heading.focus()
                        expect(file_heading).to_be_focused()
                        expect(scope.get_by_role("region", name="图片文件信息", exact=True)).to_contain_text("fixture-0.png")
                        page.screenshot(path=str(artifacts / f"files-{theme}-{width}.png"), animations="disabled")
                        assert scope.evaluate("e => e.scrollWidth <= e.clientWidth"), "检查器水平溢出"
                        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "页面水平溢出"
                        if narrow:
                            scope.get_by_role("button", name="关闭", exact=True).click()
                            expect(page.get_by_role("button", name="图片信息", exact=True)).to_be_focused()
                        assert not errors, errors
                        result = {"theme": theme, "width": width, "height": height, "sections": 6, "errors": errors, "passed": True}
                        reports.append(result)
                        print(json.dumps(result, ensure_ascii=False), flush=True)
                    finally:
                        context.close()
        finally:
            browser.close()
    (artifacts / "report.json").write_text(json.dumps(reports, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
