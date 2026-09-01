"""多选检查器与批量编辑浏览器验收；仅操作开发内存库。"""
import argparse
import json
from pathlib import Path
import sys
from playwright.sync_api import expect, sync_playwright


def toggle_failure(page):
    # 模拟外部磁盘故障变化：只激活开发展台的内存故障开关，不操作生产数据。
    page.get_by_role("button", name="模拟部分失败", exact=True, include_hidden=True).evaluate("button => button.click()")


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True)
    args = parser.parse_args()
    artifacts = Path(__file__).resolve().parent.parent / "artifacts" / "multi-inspector"
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
                        narrow = width <= 780
                        collection = page.get_by_role("listbox", name="图片集合", exact=True)
                        first = collection.get_by_role("option", name="甲库测试图-0.png", exact=True)
                        second = collection.get_by_role("option", name="甲库测试图-1.png", exact=True)
                        bar = page.get_by_role("toolbar", name="批量操作", exact=True)
                        information = page.get_by_role("dialog", name="图片信息", exact=True)
                        scope = information if narrow else page.get_by_role("complementary", name="图片检查器", exact=True)
                        first.click()
                        if narrow:
                            page.get_by_role("button", name="图片信息", exact=True).click()
                        scope.get_by_role("combobox", name="图片所在文件夹").select_option("folder:配色")
                        expect(scope.get_by_role("combobox", name="图片所在文件夹")).to_be_enabled()
                        scope.get_by_role("textbox", name="添加图片标签", exact=True).fill("单图标签")
                        scope.get_by_role("button", name="添加标签", exact=True).click()
                        expect(scope.get_by_role("button", name="移除图片标签 单图标签", exact=True)).to_be_enabled()
                        if narrow:
                            information.get_by_role("button", name="关闭", exact=True).click()
                        second.click(modifiers=["Control"])
                        if narrow:
                            page.get_by_role("button", name="图片信息", exact=True).click()
                        expect(scope.get_by_role("heading", name="已选 2 张图片", exact=True)).to_be_visible()
                        expect(scope).to_contain_text("混合值（2 个位置）")
                        expect(scope.locator('[aria-label="部分图片标签"]')).to_contain_text("单图标签（1/2）")
                        expect(scope.locator("textarea, img")).to_have_count(0)
                        page.screenshot(path=str(artifacts / f"summary-{theme}-{width}.png"), animations="disabled")
                        if narrow:
                            information.get_by_role("button", name="关闭", exact=True).click()
                        bar.get_by_role("button", name="收藏", exact=True).click()
                        if narrow:
                            page.get_by_role("button", name="图片信息", exact=True).click()
                            scope = page.get_by_role("dialog", name="图片信息", exact=True)
                            expect(scope).to_contain_text("全部已收藏")
                            information.get_by_role("button", name="关闭", exact=True).click()
                        else:
                            expect(scope).to_contain_text("全部已收藏")
                        edit_button = page.get_by_role("toolbar", name="批量操作", exact=True).get_by_role("button", name="标签", exact=True)
                        edit_button.click()
                        editor = page.get_by_role("dialog", name="批量编辑标签", exact=True)
                        field = editor.get_by_role("textbox", name="标签名称", exact=True)
                        field.fill("共同")
                        toggle_failure(page)
                        editor.get_by_role("button", name="添加到所选图片", exact=True).click()
                        expect(editor).to_contain_text("成功 1 项，失败 1 项")
                        expect(editor).to_contain_text("library.io_failed")
                        expect(field).to_be_disabled()
                        expect(field).to_have_value("共同")
                        page.screenshot(path=str(artifacts / f"partial-{theme}-{width}.png"), animations="disabled")
                        toggle_failure(page)
                        editor.get_by_role("button", name="重试失败项", exact=True).click()
                        expect(editor).to_have_count(0)
                        expect(edit_button).to_be_focused()
                        if narrow:
                            page.get_by_role("button", name="图片信息", exact=True).click()
                            scope = page.get_by_role("dialog", name="图片信息", exact=True)
                        expect(scope.locator('[aria-label="共同标签"]')).to_have_text("共同")
                        if narrow:
                            scope.get_by_role("button", name="关闭", exact=True).click()
                        more = bar.get_by_role("button", name="更多批量操作", exact=True)
                        more.click()
                        page.get_by_role("menuitem", name="关联提示词", exact=True).click()
                        links = page.get_by_role("dialog", name="批量关联提示词", exact=True)
                        links.get_by_role("radio", name="光影参考", exact=True).check()
                        expect(links.get_by_role("radio", name="归档提示词", exact=True)).to_have_count(0)
                        links.get_by_role("button", name="关联到所选图片", exact=True).click()
                        expect(links).to_have_count(0)
                        expect(more).to_be_focused()
                        if narrow:
                            page.get_by_role("button", name="图片信息", exact=True).click()
                            page.set_viewport_size({"width": 1440, "height": 900})
                            information.get_by_role("button", name="关闭", exact=True).click()
                            expect(page.get_by_role("heading", name="已选 2 张图片", exact=True)).to_be_focused()
                            page.set_viewport_size({"width": width, "height": height})
                            page.get_by_role("button", name="图片导航", exact=True).click()
                        page.locator('[data-tag="共同"]:visible').click()
                        expect(collection.get_by_role("option")).to_have_count(2)
                        bar.get_by_role("button", name="标签", exact=True).click()
                        editor.get_by_role("radio", name="移除标签", exact=True).check()
                        field.fill("共同")
                        toggle_failure(page)
                        editor.get_by_role("button", name="从所选图片移除", exact=True).click()
                        expect(editor).to_contain_text("待处理 1 张图片")
                        expect(editor).to_contain_text("library.io_failed")
                        toggle_failure(page)
                        editor.get_by_role("button", name="重试失败项", exact=True).click()
                        expect(editor).to_have_count(0)
                        expect(page.get_by_text("没有符合条件的图片", exact=True)).to_be_visible()
                        expect(page.get_by_role("searchbox", name="按文件名搜索", exact=True)).to_be_focused()
                        expect(page.get_by_role("region", name="操作结果", exact=True)).to_contain_text("library.io_failed")
                        if narrow:
                            page.get_by_role("button", name="图片导航", exact=True).click()
                        empty_filter = page.locator('[data-tag="共同"]:visible')
                        expect(empty_filter).to_have_attribute("aria-pressed", "true")
                        expect(empty_filter).to_have_text("共同0")
                        empty_filter.click()
                        expect(first).to_be_visible()
                        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "水平溢出"
                        assert not errors, errors
                        result = {"theme": theme, "width": width, "summary": True, "partial_retry": True, "filter_exit": True, "focus_restored": True, "errors": errors}
                        reports.append(result)
                        print(json.dumps(result, ensure_ascii=False), flush=True)
                    finally:
                        context.close()
        finally:
            browser.close()
    (artifacts / "report.json").write_text(json.dumps(reports, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
