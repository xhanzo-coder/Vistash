"""图片工作区出站能力浏览器验收：复制、默认程序打开、导出与冲突决议。"""
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
    artifacts = Path(__file__).resolve().parent.parent / "artifacts" / "outbound"
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
                        gallery = page.get_by_role("listbox", name="图片集合", exact=True)
                        first = gallery.get_by_role("option", name="甲库测试图-0.png", exact=True)
                        first.click()
                        if width <= 760:
                            page.get_by_role("button", name="图片信息", exact=True).click()
                        outbound = page.get_by_role("group", name="图片出站操作", exact=True)
                        outbound.get_by_role("button", name="复制图像", exact=True).click()
                        expect(page.get_by_text("已复制图片到剪贴板", exact=True)).to_be_visible()
                        outbound.get_by_role("button", name="用默认程序打开", exact=True).click()
                        expect(page.get_by_text("已交给 Windows 默认程序打开", exact=True)).to_be_visible()
                        outbound.get_by_role("button", name="导出原图", exact=True).click()
                        expect(page.get_by_text("已导出 1 张图片", exact=True)).to_be_visible()

                        if width <= 760:
                            page.get_by_role("dialog", name="图片信息", exact=True).get_by_role("button", name="关闭", exact=True).click()
                        page.get_by_role("button", name="模拟导出冲突", exact=True).click()
                        if width <= 760:
                            page.get_by_role("button", name="图片信息", exact=True).click()
                        outbound.get_by_role("button", name="导出原图", exact=True).click()
                        conflict = page.get_by_role("dialog")
                        expect(conflict).to_contain_text("导出文件冲突")
                        conflict.get_by_role("button", name="跳过冲突并导出", exact=True).click()
                        expect(page.get_by_text("已导出 0 张图片", exact=True)).to_be_visible()
                        assert not errors, errors
                        page.screenshot(path=str(artifacts / f"outbound-{theme}-{width}.png"), animations="disabled")
                        result = {"theme": theme, "width": width, "copy": True, "open": True, "export": True, "conflict": True, "errors": errors}
                        reports.append(result)
                        print(json.dumps(result, ensure_ascii=False), flush=True)
                    finally:
                        context.close()
        finally:
            browser.close()
    (artifacts / "report.json").write_text(json.dumps(reports, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
