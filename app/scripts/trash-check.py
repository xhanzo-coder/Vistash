"""回收站还原与永久清空浏览器验收；仅操作开发展台内存数据。"""
import argparse
import json
from pathlib import Path
import sys
from playwright.sync_api import expect, sync_playwright


def navigate(page, label, narrow):
    if narrow:
        page.get_by_role("button", name="图片导航", exact=True).click()
    page.get_by_role("navigation", name="图片导航", exact=True).get_by_role("button", name=label, exact=True).click()


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True)
    args = parser.parse_args()
    artifacts = Path(__file__).resolve().parent.parent / "artifacts" / "trash"
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
                        if narrow:
                            information.get_by_role("button", name="关闭", exact=True).click()
                        second.click(modifiers=["Control"])
                        bar.get_by_role("button", name="移入回收站", exact=True).click()
                        expect(first).to_have_count(0)
                        navigate(page, "回收站", narrow)
                        expect(collection.get_by_role("option")).to_have_count(2)
                        page.get_by_role("button", name="删除文件夹", exact=True).click()
                        folder_editor = page.get_by_role("dialog", name="删除文件夹", exact=True)
                        folder_editor.get_by_role("combobox", name="目标文件夹").select_option("配色")
                        folder_editor.get_by_role("button", name="继续删除", exact=True).click()
                        page.get_by_role("alertdialog").get_by_role("button", name="确认删除文件夹", exact=True).click()
                        expect(folder_editor).to_have_count(0)
                        first.click()
                        second.click(modifiers=["Control"])
                        page.get_by_role("button", name="模拟部分失败", exact=True).click()
                        bar.get_by_role("button", name="还原所选图片", exact=True).click()
                        results = page.get_by_role("region", name="回收站操作结果", exact=True)
                        expect(results).to_contain_text("已还原 1 张图片，失败 1 张")
                        expect(results).to_contain_text("trash.restore_failed")
                        expect(first).to_be_visible()
                        expect(second).to_have_count(0)
                        page.get_by_role("button", name="模拟部分失败", exact=True).click()
                        if narrow:
                            page.get_by_role("button", name="图片信息", exact=True).click()
                        scope.get_by_role("button", name="还原图片", exact=True).click()
                        if narrow:
                            information.get_by_role("button", name="关闭", exact=True).click()
                        expect(page.get_by_text("图片回收站为空", exact=True)).to_be_visible()
                        expect(results).to_contain_text("已还原到未分类")
                        expect(results).to_contain_text("原文件夹「配色」不存在")
                        results.get_by_text("原文件夹「配色」不存在", exact=False).scroll_into_view_if_needed()
                        page.screenshot(path=str(artifacts / f"restore-{theme}-{width}.png"), animations="disabled")
                        navigate(page, "全部图片", narrow)
                        first.click()
                        second.click(modifiers=["Control"])
                        bar.get_by_role("button", name="移入回收站", exact=True).click()
                        expect(first).to_have_count(0)
                        navigate(page, "回收站", narrow)
                        expect(collection.get_by_role("option")).to_have_count(2)
                        search = page.get_by_role("searchbox", name="按文件名搜索", exact=True)
                        search.fill("甲库测试图-1.png")
                        expect(collection.get_by_role("option")).to_have_count(1)
                        purge = page.get_by_role("button", name="清空图片回收站", exact=True)
                        purge.click()
                        confirmation = page.get_by_role("alertdialog", name="永久清空图片回收站？", exact=True)
                        expect(confirmation).to_contain_text("全部 2 张图片")
                        expect(confirmation).to_contain_text("包括当前筛选未显示的图片")
                        page.screenshot(path=str(artifacts / f"confirm-{theme}-{width}.png"), animations="disabled")
                        confirmation.get_by_role("button", name="取消", exact=True).click()
                        expect(second).to_be_visible()
                        page.get_by_role("button", name="模拟部分失败", exact=True).click()
                        purge.click()
                        confirmation.get_by_role("button", name="永久清空", exact=True).click()
                        expect(results).to_contain_text("已永久删除 1 张图片，失败 1 张")
                        expect(results).to_contain_text("甲库测试图-0.png")
                        expect(results).to_contain_text("trash.purge_failed")
                        page.screenshot(path=str(artifacts / f"purge-partial-{theme}-{width}.png"), animations="disabled")
                        search.fill("")
                        expect(first).to_be_visible()
                        expect(second).to_have_count(0)
                        page.get_by_role("button", name="模拟部分失败", exact=True).click()
                        purge.click()
                        confirmation.get_by_role("button", name="永久清空", exact=True).click()
                        expect(page.get_by_text("图片回收站为空", exact=True)).to_be_visible()
                        expect(purge).to_be_disabled()
                        expect(search).to_be_focused()
                        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "页面水平溢出"
                        assert not errors, errors
                        result = {"theme": theme, "width": width, "restore": True, "missing_folder": True, "purge_confirmation": True, "partial_report": True, "errors": errors}
                        reports.append(result)
                        print(json.dumps(result, ensure_ascii=False), flush=True)
                    finally:
                        context.close()
        finally:
            browser.close()
    (artifacts / "report.json").write_text(json.dumps(reports, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
