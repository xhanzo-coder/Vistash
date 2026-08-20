"""PROTOTYPE 缩放验收：在 Windows Chromium 上模拟 125%/150%/200% device scale。"""

import os
from pathlib import Path

from playwright.sync_api import sync_playwright


ARTIFACTS = Path(__file__).parent / "artifacts"
ARTIFACTS.mkdir(exist_ok=True)
BASE_URL = "http://localhost:1421"
ENGINE = os.environ.get("PROTOTYPE_ENGINE", "owned")


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    results: list[dict[str, float | int]] = []
    for scale in (1.25, 1.5, 2.0):
        context = browser.new_context(
            viewport={"width": 1280, "height": 760},
            device_scale_factor=scale,
        )
        page = context.new_page()
        console_errors: list[str] = []
        page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
        page.goto(f"{BASE_URL}/?variant=A&engine={ENGINE}")
        page.wait_for_load_state("networkidle")
        page.get_by_role("heading", name="图片素材", exact=True).wait_for()
        assert page.locator("[data-prototype-item]").count() > 0
        assert page.evaluate("document.documentElement.scrollWidth - window.innerWidth") <= 1

        page.keyboard.press("Control+k")
        page.get_by_placeholder("搜索图片和提示词…").wait_for()
        page.keyboard.press("Escape")
        page.get_by_placeholder("搜索图片和提示词…").wait_for(state="detached")
        page.keyboard.press("Control+f")
        assert page.locator("[data-current-library-search]").evaluate("element => element === document.activeElement")

        item = page.locator("[data-prototype-item]").nth(0)
        item.click()
        item.press("ArrowRight")
        assert "活动 image-1" in page.locator(".prototype-switcher span").inner_text()
        keyboard_surface = page.locator(".collection-keyboard-surface")
        keyboard_surface.focus()
        keyboard_surface.press("Control+a")
        status = page.locator(".prototype-switcher span").inner_text()
        assert "选中 10000" in status, status
        keyboard_surface.press("Escape")
        assert "选中 0" in page.locator(".prototype-switcher span").inner_text()

        screenshot = ARTIFACTS / f"scale-{str(scale).replace('.', '-')}.png"
        page.screenshot(path=screenshot)
        assert not console_errors, console_errors
        results.append({
            "scale": scale,
            "rendered_items": page.locator("[data-prototype-item]").count(),
            "horizontal_overflow_px": page.evaluate("document.documentElement.scrollWidth - window.innerWidth"),
        })
        context.close()

    print(results)
    browser.close()
