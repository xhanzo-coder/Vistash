"""图片工作区导入入口浏览器验收，只使用内存演示库。"""
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
    artifacts = Path(__file__).resolve().parent.parent / "artifacts" / "import-entry"
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
                        workspace_toolbar = page.get_by_role("toolbar", name="图片查询与视图", exact=True)
                        expect(workspace_toolbar.get_by_role("button", name="导入图片", exact=True)).to_have_count(0)
                        import_trigger = page.get_by_role("button", name="导入", exact=True)
                        import_trigger.click()
                        expect(page.get_by_role("menuitem", name=re.compile("^导入图片"))).to_be_visible()
                        expect(page.get_by_role("menuitem", name=re.compile("^导入文件夹"))).to_be_visible()
                        expect(page.get_by_role("menuitem", name=re.compile("^从剪贴板导入"))).to_be_visible()
                        page.get_by_role("menuitem", name=re.compile("^导入图片")).click()
                        task_trigger = page.get_by_role("button", name="任务中心，0 个运行中", exact=True)
                        task_trigger.click()
                        task_panel = page.locator('[data-ui="task-center"]')
                        expect(task_panel).to_contain_text("导入图片")
                        expect(task_panel).to_contain_text("成功 2")
                        task_panel.locator('button[aria-label^="关闭任务记录"]').click()
                        page.keyboard.press("Escape")
                        import_trigger.click()
                        page.get_by_role("menuitem", name=re.compile("^导入文件夹")).click()
                        task_trigger.click()
                        expect(task_panel).to_contain_text("导入图片文件夹")
                        task_panel.locator('button[aria-label^="关闭任务记录"]').click()
                        page.keyboard.press("Escape")
                        search = page.get_by_role("searchbox", name="按文件名搜索", exact=True)
                        search.focus()
                        search.press("Control+V")
                        expect(page.locator('[data-ui="task-center"]')).to_have_count(0)
                        import_trigger.click()
                        page.get_by_role("menuitem", name=re.compile("^从剪贴板导入")).click()
                        task_trigger.click()
                        expect(task_panel).to_contain_text("粘贴导入")
                        task_panel.locator('button[aria-label^="关闭任务记录"]').click()
                        page.keyboard.press("Escape")
                        search.fill("不存在的图片")
                        expect(page.get_by_text("没有符合条件的图片", exact=True)).to_be_visible()
                        expect(page.get_by_role("heading", name="建立本地视觉档案", exact=True)).to_be_visible()
                        page.screenshot(path=str(artifacts / f"empty-{theme}-{width}.png"), animations="disabled")
                        expect(page.get_by_role("button", name="导入图片", exact=True)).to_have_count(1)
                        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "水平溢出"
                        assert not errors, errors
                        result = {"theme": theme, "width": width, "file_picker": True, "folder_picker": True, "clipboard": True, "task_center": True, "empty_guide": True, "errors": errors}
                        reports.append(result)
                        print(json.dumps(result, ensure_ascii=False), flush=True)
                    finally:
                        context.close()
        finally:
            browser.close()
    (artifacts / "report.json").write_text(json.dumps(reports, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
