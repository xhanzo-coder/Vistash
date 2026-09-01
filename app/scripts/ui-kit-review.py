"""7.3 组件展台的真实浏览器交互与视觉取证。"""

from pathlib import Path

from playwright.sync_api import sync_playwright


ARTIFACT_DIR = Path(__file__).resolve().parents[1] / "artifacts" / "ui-kit"
URL = "http://127.0.0.1:1420/?dev=ui-kit"


def main() -> None:
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    console_errors: list[str] = []
    page_errors: list[str] = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
        page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.goto(URL)
        page.wait_for_load_state("networkidle")

        page.get_by_role("heading", name="Archive Desk 组件系统").wait_for()
        page.get_by_role("button", name="深色", exact=True).click()
        page.screenshot(path=ARTIFACT_DIR / "dark-1440x900.png", full_page=True)

        dialog_trigger = page.get_by_role("button", name="打开 Dialog")
        dialog_trigger.click()
        page.get_by_role("dialog", name="素材设置").wait_for()
        page.keyboard.press("Escape")
        assert dialog_trigger.evaluate("element => element === document.activeElement")

        page.get_by_role("button", name="更多操作").click()
        page.get_by_role("menu").wait_for()
        page.keyboard.press("Escape")

        page.get_by_role("button", name="筛选").click()
        page.locator('[data-ui="popover"]').wait_for()
        page.keyboard.press("Escape")

        page.get_by_role("combobox", name="排序方式").click()
        page.get_by_role("option", name="文件名").click()

        page.get_by_role("button", name="显示 Toast").click()
        page.get_by_role("status").wait_for()
        page.screenshot(path=ARTIFACT_DIR / "dark-toast-1440x900.png", full_page=True)

        page.get_by_role("button", name="浅色", exact=True).click()
        page.screenshot(path=ARTIFACT_DIR / "light-1440x900.png", full_page=True)

        page.emulate_media(reduced_motion="reduce")
        dialog_trigger.click()
        dialog = page.get_by_role("dialog", name="素材设置")
        dialog.wait_for()
        assert dialog.evaluate("element => getComputedStyle(element).animationName") == "none"

        assert console_errors == [], console_errors
        assert page_errors == [], page_errors
        browser.close()


if __name__ == "__main__":
    main()
