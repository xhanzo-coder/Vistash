"""新版默认 App 的壳层、一级导航、导入入口和公开工作区组合验收。"""
import argparse
import json
from pathlib import Path
import subprocess
import sys

from playwright.sync_api import expect, sync_playwright


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True)
    args = parser.parse_args()
    app = Path(__file__).resolve().parent.parent
    bootstrap = subprocess.check_output(
        ["node", "--input-type=module", "-e", "import {buildBootstrap} from './scripts/perfFixture.mjs'; process.stdout.write(buildBootstrap(100));"],
        cwd=app,
        encoding="utf-8",
    )
    artifact = app / "artifacts" / "app-shell-integration"
    artifact.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="msedge", headless=True)
        try:
            page = browser.new_page(viewport={"width": 1440, "height": 900})
            page.add_init_script(bootstrap)
            page.add_init_script("window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };")
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(f"{args.base_url.rstrip('/')}/", wait_until="networkidle")
            expect(page.locator('[data-workspace="assets"]')).to_be_visible()
            expect(page.locator("[data-waterfall-item]").first).to_be_visible()

            page.get_by_role("button", name="导入", exact=True).click()
            expect(page.get_by_role("menuitem", name="导入图片")).to_be_visible()
            expect(page.get_by_role("menuitem", name="导入文件夹")).to_be_visible()
            expect(page.get_by_role("menuitem", name="从剪贴板导入")).to_be_visible()
            page.keyboard.press("Escape")

            page.get_by_role("button", name="提示词", exact=True).click()
            expect(page.locator('[data-workspace="prompts"]')).to_be_visible()
            expect(page.locator("[data-prompt-card]").first).to_be_visible()
            page.get_by_role("button", name="图片", exact=True).click()
            expect(page.locator('[data-workspace="assets"]')).to_be_visible()

            page.keyboard.press("Control+K")
            dialog = page.get_by_role("dialog")
            expect(dialog).to_contain_text("搜索全部素材")
            dialog.get_by_role("searchbox", name="搜索全部素材", exact=True).fill("压测")
            expect(dialog.get_by_role("button").filter(has_text="压测提示词 0")).to_be_visible()
            dialog.get_by_role("button").filter(has_text="压测提示词 0").click()
            expect(page.locator('[data-workspace="prompts"]')).to_be_visible()
            expect(page.locator('[data-prompt-card][aria-selected="true"]')).to_have_count(1)

            page.get_by_role("button", name="任务中心，0 个运行中", exact=True).click()
            expect(page.locator('[data-ui="task-center"]')).to_contain_text("当前没有任务")
            page.keyboard.press("Escape")
            page.get_by_role("button", name="设置", exact=True).click()
            expect(page.get_by_role("dialog")).to_contain_text("素材库")
            page.keyboard.press("Escape")
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "出现水平溢出"
            assert not errors, errors
            page.screenshot(path=str(artifact / "default-app.png"), animations="disabled")
            report = {"shell": True, "workspace_switch": True, "import_menu": True, "global_locate": True, "task_center": True, "settings": True, "errors": errors}
            (artifact / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            print(json.dumps(report, ensure_ascii=False))
        finally:
            browser.close()


if __name__ == "__main__":
    main()
