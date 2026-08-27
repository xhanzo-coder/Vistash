"""7.4 应用外壳的真实浏览器交互、焦点与响应式取证。"""

from pathlib import Path
import re

from playwright.sync_api import sync_playwright


ARTIFACT_DIR = Path(__file__).resolve().parents[1] / "artifacts" / "app-shell"
URL = "http://127.0.0.1:1420/?dev=app-shell"


def main() -> None:
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    console_errors: list[str] = []
    page_errors: list[str] = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.goto(URL)
        page.wait_for_load_state("networkidle")

        topbar = page.locator("header").first
        assert topbar.bounding_box()["height"] <= 80
        page.get_by_role("button", name="设置", exact=True).click()
        page.get_by_role("radio", name="深色").click()
        page.keyboard.press("Escape")
        assert page.locator('meta[name="theme-color"]').get_attribute("content") == page.evaluate(
            "getComputedStyle(document.documentElement).getPropertyValue('--surface-canvas').trim()"
        )
        page.screenshot(path=ARTIFACT_DIR / "dark-1440x900.png")

        page.get_by_role("button", name="提示词", exact=True).click()
        assert page.locator('[data-workspace="prompts"]').is_visible()
        assert not page.locator('[data-workspace="assets"]').is_visible()

        page.keyboard.press("Control+k")
        search_dialog = page.get_by_role("dialog", name="搜索全部素材")
        search_dialog.wait_for()
        search_dialog.get_by_role("searchbox", name="搜索全部素材").fill("雨夜")
        result = search_dialog.get_by_role("button", name=re.compile("雨夜街道"))
        result.wait_for()
        result.click()
        assert page.locator('[data-workspace="assets"]').is_visible()

        page.get_by_role("button", name="导入", exact=True).click()
        page.get_by_role("menuitem", name=re.compile("导入文件夹")).click()
        page.get_by_role("status").wait_for()

        page.get_by_role("button", name="任务中心，1 个运行中").click()
        task_center = page.locator('[data-ui="task-center"]')
        task_center.wait_for()
        assert "雨夜街道.png" in task_center.inner_text()
        page.keyboard.press("Escape")

        page.get_by_role("button", name="设置", exact=True).click()
        settings = page.get_by_role("dialog", name="设置")
        settings.wait_for()
        settings.get_by_role("radio", name="浅色").click()
        assert page.locator('meta[name="theme-color"]').get_attribute("content") == page.evaluate(
            "getComputedStyle(document.documentElement).getPropertyValue('--surface-canvas').trim()"
        )
        settings.get_by_role("button", name="素材库", exact=True).click()
        assert "E:\\视觉档案" in settings.inner_text()
        page.screenshot(path=ARTIFACT_DIR / "settings-light-1440x900.png")
        page.keyboard.press("Escape")

        page.set_viewport_size({"width": 760, "height": 760})
        page.get_by_role("button", name="设置", exact=True).click()
        page.get_by_role("button", name="外观", exact=True).click()
        page.get_by_role("radio", name="深色").click()
        page.keyboard.press("Escape")
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
        page.screenshot(path=ARTIFACT_DIR / "dark-760x760.png")

        assert console_errors == [], console_errors
        assert page_errors == [], page_errors
        browser.close()


if __name__ == "__main__":
    main()
