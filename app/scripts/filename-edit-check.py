"""验证显示文件名编辑，只操作内存演示库及品牌测试图。"""
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
    artifacts = Path(__file__).resolve().parent.parent / "artifacts" / "filename-edit"
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
                        asset = collection.locator('[data-hash="' + "0" * 64 + '"]')
                        search = page.get_by_role("searchbox", name="按文件名搜索", exact=True)
                        search.fill("甲库测试图-0.png")
                        expect(collection.get_by_role("option")).to_have_count(1)
                        asset.click()
                        asset.press("F2")
                        editor = page.get_by_role("dialog", name="修改显示文件名", exact=True)
                        field = editor.get_by_role("textbox", name="名称主体", exact=True)
                        expect(field).to_be_focused()
                        expect(field).to_have_value("甲库测试图-0")
                        assert field.evaluate("e => e.selectionStart === 0 && e.selectionEnd === e.value.length")
                        field.fill("参考.jpg")
                        editor.get_by_role("button", name="保存文件名", exact=True).click()
                        expect(editor.get_by_role("alert")).to_contain_text("library.filename_invalid")
                        expect(field).to_be_focused()
                        expect(field).to_have_value("参考.jpg")
                        expect(editor).to_contain_text(".png")
                        field.fill("雨夜参考")
                        editor.get_by_role("button", name="保存文件名", exact=True).click()
                        expect(editor).to_have_count(0)
                        expect(search).to_be_focused()
                        expect(search).to_have_value("甲库测试图-0.png")
                        expect(page.get_by_text("没有符合条件的图片", exact=True)).to_be_visible()
                        search.fill("FIXTURE-0.PNG")
                        expect(asset).to_have_attribute("aria-label", "雨夜参考.png")
                        asset.click()
                        if width <= 780:
                            page.get_by_role("button", name="图片信息", exact=True).click()
                        information = page.get_by_role("region", name="图片文件信息", exact=True)
                        expect(information).to_contain_text("fixture-0.png")
                        expect(information).to_contain_text("雨夜参考.png")
                        inspector = page.get_by_role("dialog", name="图片信息", exact=True) if width <= 780 else page.get_by_role("complementary", name="图片检查器", exact=True)
                        edit_button = inspector.get_by_role("button", name="修改显示文件名", exact=True)
                        edit_button.click()
                        expect(field).to_have_value("雨夜参考")
                        field.fill("暂存草稿")
                        page.screenshot(path=str(artifacts / f"editing-{theme}-{width}.png"), animations="disabled")
                        field.press("Escape")
                        expect(editor).to_have_count(0)
                        expect(edit_button).to_be_focused()
                        if width <= 780:
                            page.get_by_role("dialog", name="图片信息", exact=True).get_by_role("button", name="关闭", exact=True).click()
                        page.get_by_role("button", name="模拟保存失败", exact=True).click()
                        asset.click()
                        asset.press("F2")
                        field.fill("未保存名称")
                        editor.get_by_role("button", name="保存文件名", exact=True).click()
                        expect(editor.get_by_role("alert")).to_contain_text("library.asset_metadata_write_failed")
                        expect(field).to_have_value("未保存名称")
                        page.screenshot(path=str(artifacts / f"error-{theme}-{width}.png"), animations="disabled")
                        field.press("Escape")
                        expect(editor).to_have_count(0)
                        expect(asset).to_have_attribute("aria-label", "雨夜参考.png")
                        page.get_by_role("button", name="模拟保存失败", exact=True).click()
                        asset.click()
                        asset.press("F2")
                        expect(field).to_have_value("雨夜参考")
                        expect(editor.get_by_role("alert")).to_have_count(0)
                        field.fill("最终名称")
                        editor.get_by_role("button", name="保存文件名", exact=True).click()
                        expect(editor).to_have_count(0)
                        expect(asset).to_have_attribute("aria-label", "最终名称.png")
                        search.fill("最终名称")
                        expect(collection.get_by_role("option")).to_have_count(1)
                        search.fill("")
                        second = collection.locator('[data-hash="' + "0" * 63 + '1"]')
                        asset.click()
                        second.click(modifiers=["Control"])
                        second.press("F2")
                        expect(editor).to_have_count(0)
                        expect(page.get_by_role("button", name="修改显示文件名", exact=True)).to_have_count(0)
                        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "水平溢出"
                        assert not errors, errors
                        report = {"theme": theme, "width": width, "f2": True, "inspector": True, "source_search": True, "failure_retained": True, "focus_restored": True}
                        reports.append(report)
                        print(json.dumps(report, ensure_ascii=False), flush=True)
                    finally:
                        context.close()
        finally:
            browser.close()
    (artifacts / "report.json").write_text(json.dumps(reports, ensure_ascii=False, indent=2), encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
