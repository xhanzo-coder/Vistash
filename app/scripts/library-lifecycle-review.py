"""库生命周期欢迎、失败、迁移与直接恢复的浏览器取证。"""

from pathlib import Path
import re

from playwright.sync_api import sync_playwright


ARTIFACT_DIR = Path(__file__).resolve().parents[1] / "artifacts" / "library-lifecycle"
BASE_URL = "http://localhost:1420/?dev=library-lifecycle"


def goto_state(page, state: str) -> None:
    page.goto(f"{BASE_URL}&state={state}")
    page.wait_for_load_state("networkidle")


def main() -> None:
    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    console_errors: list[str] = []
    page_errors: list[str] = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.add_init_script("localStorage.setItem('vistash.appearance.theme.v1', 'dark')")
        page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
        page.on("pageerror", lambda error: page_errors.append(str(error)))

        goto_state(page, "welcome")
        page.get_by_role("heading", name=re.compile(r"把散落的图片.*一座库")).wait_for()
        assert "图片会复制进库" in page.locator("main").inner_text()
        assert "库会占用磁盘空间" in page.locator("main").inner_text()
        assert "源文件不会被修改" in page.locator("main").inner_text()
        page.screenshot(path=ARTIFACT_DIR / "welcome-dark-1440x900.png")
        page.get_by_role("button", name="创建新库", exact=True).click()
        page.get_by_test_id("ready-workspace").wait_for()

        goto_state(page, "failure")
        assert "E:\\已移动的视觉档案" in page.locator("main").inner_text()
        assert "library.path_unreadable" in page.locator("main").inner_text()
        page.screenshot(path=ARTIFACT_DIR / "failure-dark-1440x900.png")

        goto_state(page, "migration")
        page.get_by_role("button", name="准备迁移", exact=True).click()
        page.get_by_role("button", name="检查迁移方案", exact=True).click()
        page.get_by_role("heading", name="选择唯一图片文件夹").wait_for()
        commit = page.get_by_role("button", name="确认迁移", exact=True)
        assert commit.is_disabled()
        page.screenshot(path=ARTIFACT_DIR / "migration-conflicts-dark-1440x900.png")
        page.get_by_role("radio", name="配色参考").click()
        page.get_by_role("radio", name="光影").click()
        assert not commit.is_disabled()
        commit.click()
        page.get_by_role("button", name="开始迁移", exact=True).click()
        page.get_by_test_id("ready-workspace").wait_for()

        goto_state(page, "ready")
        page.get_by_test_id("ready-workspace").wait_for()
        assert "创建新库" not in page.locator("body").inner_text()
        assert "打开已有库" not in page.locator("body").inner_text()

        page.evaluate("localStorage.setItem('vistash.appearance.theme.v1', 'light')")
        goto_state(page, "welcome")
        page.screenshot(path=ARTIFACT_DIR / "welcome-light-1440x900.png")

        page.set_viewport_size({"width": 760, "height": 760})
        page.evaluate("localStorage.setItem('vistash.appearance.theme.v1', 'dark')")
        goto_state(page, "welcome")
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
        page.screenshot(path=ARTIFACT_DIR / "welcome-dark-760x760.png")

        assert console_errors == [], console_errors
        assert page_errors == [], page_errors
        browser.close()


if __name__ == "__main__":
    main()
