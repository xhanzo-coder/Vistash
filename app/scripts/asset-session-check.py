"""验收 8.2 图片会话切片，只操作开发入口与独立的测试偏好。"""
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
    artifacts = Path(__file__).resolve().parent.parent / "artifacts" / "asset-session"
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
                        expect(collection.get_by_role("option").first).to_be_visible()
                        page.wait_for_function("document.querySelectorAll('[role=option] img').length > 0 && [...document.querySelectorAll('[role=option] img')].every(i => i.complete && i.naturalWidth > 0)")
                        initial_dom = collection.get_by_role("option").count()
                        assert 0 < initial_dom < 40, initial_dom
                        page.screenshot(path=str(artifacts / f"waterfall-{theme}-{width}.png"))
                        search = page.get_by_role("searchbox", name="按文件名搜索", exact=True)
                        search.fill("测试图-80.png")
                        expect(collection.get_by_role("option")).to_have_count(1)
                        collection.get_by_role("option").click()
                        page.get_by_role("button", name="收藏图片", exact=True).click()
                        expect(page.get_by_role("toolbar", name="图片查询与视图").get_by_role("button", name="取消收藏", exact=True)).to_be_visible()
                        page.get_by_role("button", name="详情列表", exact=True).click()
                        expect(page.locator('[data-list-item][aria-selected="true"]')).to_have_count(1)
                        page.get_by_role("button", name="切换测试库", exact=True).click()
                        # 库身份位于侧栏；集合标题只表示当前查询范围。
                        expect(page.get_by_role("navigation", name="图片导航", exact=True)).to_contain_text("图片会话 · 乙库")
                        expect(page.get_by_role("heading", name="全部图片", exact=True)).to_be_visible()
                        expect(search).to_have_value("")
                        expect(page.get_by_role("button", name="瀑布流", exact=True)).to_have_attribute("aria-pressed", "true")
                        page.get_by_role("button", name="切换测试库", exact=True).click()
                        expect(search).to_have_value("测试图-80.png")
                        expect(page.get_by_role("button", name="详情列表", exact=True)).to_have_attribute("aria-pressed", "true")
                        search.fill("不会匹配的查询")
                        expect(page.get_by_text("没有符合条件的图片", exact=True)).to_be_visible()
                        page.get_by_role("button", name="定位第 81 项", exact=True).click()
                        target = collection.get_by_role("option", name="甲库测试图-80.png", exact=True)
                        expect(target).to_be_in_viewport()
                        expect(target).to_have_attribute("aria-selected", "true")
                        expect(search).to_have_value("")
                        page.screenshot(path=str(artifacts / f"located-list-{theme}-{width}.png"))
                        page.get_by_role("button", name="模拟保存失败", exact=True).click()
                        search.fill("测试图-9")
                        expect(page.get_by_role("alert")).to_contain_text("library.io_failed")
                        expect(search).to_have_value("测试图-9")
                        page.get_by_role("button", name="模拟保存失败", exact=True).click()
                        page.get_by_role("button", name="重试保存布局", exact=True).click()
                        expect(page.get_by_role("alert")).to_have_count(0)
                        page.reload(wait_until="networkidle")
                        expect(search).to_have_value("测试图-9")
                        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "窗口出现水平溢出"
                        assert not errors, errors
                        result = {"theme": theme, "width": width, "height": height, "fixture_count": 1000, "initial_dom": initial_dom, "isolation": True, "locate": True, "save_retry": True}
                        reports.append(result)
                        print(json.dumps(result, ensure_ascii=False), flush=True)
                    finally:
                        context.close()
        finally:
            browser.close()
    (artifacts / "report.json").write_text(json.dumps(reports, ensure_ascii=False, indent=2), encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
