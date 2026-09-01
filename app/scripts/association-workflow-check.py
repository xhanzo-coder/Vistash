"""图片—提示词普通关联工作流的浏览器视觉与交互验收。"""

from __future__ import annotations

import json
from pathlib import Path

from playwright.sync_api import Page, expect, sync_playwright


BASE_URL = "http://127.0.0.1:1420"
WIDTHS = (1440, 960, 760)
THEMES = ("light", "dark")
OUTPUT_DIR = Path(__file__).resolve().parents[1] / "artifacts" / "association-workflow"


def install_theme(page: Page, theme: str) -> None:
    serialized_theme = json.dumps(theme)
    page.add_init_script(
        f"window.localStorage.setItem('vistash.appearance.theme.v1', {serialized_theme})"
    )


def assert_no_horizontal_overflow(page: Page, selector: str) -> None:
    overflow = page.locator(selector).evaluate(
        "element => element.scrollWidth > element.clientWidth",
    )
    if overflow:
        raise AssertionError(f"{selector} 存在水平溢出")


def open_asset_association(page: Page) -> None:
    page.goto(f"{BASE_URL}/?dev=asset-library", wait_until="networkidle")
    first_asset = page.locator('[role="option"]').first
    expect(first_asset).to_be_visible()
    first_asset.click()
    information = page.get_by_role("button", name="图片信息", exact=True)
    if information.is_visible():
        information.click()
    add_existing = page.get_by_role("button", name="添加已有提示词", exact=True)
    expect(add_existing).to_be_visible()
    add_existing.click()
    dialog = page.get_by_role("dialog", name="图片 × 提示词关联")
    expect(dialog).to_be_visible()
    expect(dialog.get_by_text("已选图片", exact=True)).to_be_visible()
    expect(dialog.locator('input[name="association-prompt-search"]')).to_be_visible()
    dialog.get_by_role("button", name="新建提示词", exact=True).click()
    body = dialog.locator('textarea[name="association-create-body"]')
    expect(body).to_be_visible()
    if body.input_value() != "":
        raise AssertionError("图片上下文提示词正文被自动预填")
    body.fill("浏览器验收手写提示词，不执行图片分析。")
    expect(dialog.get_by_role("button", name="创建提示词并关联到 1 张图片", exact=True)).to_be_enabled()
    dialog.get_by_role("button", name="选择已有", exact=True).click()
    assert_no_horizontal_overflow(page, '[role="dialog"][data-size="wide"]')


def open_asset_unlink(page: Page) -> None:
    page.goto(f"{BASE_URL}/?dev=asset-library", wait_until="networkidle")
    first_asset = page.locator('[role="option"]').first
    expect(first_asset).to_be_visible()
    first_asset.click()
    information = page.get_by_role("button", name="图片信息", exact=True)
    if information.is_visible():
        information.click()
    relation = page.get_by_role(
        "button",
        name="打开提示词 归档提示词",
        exact=True,
    )
    relation.scroll_into_view_if_needed()
    relation.focus()
    direct_unlink = page.get_by_role(
        "button",
        name="解除与提示词 归档提示词 的关联",
        exact=True,
    )
    expect(direct_unlink).to_be_visible()
    expect(direct_unlink).to_have_attribute("title", "解除关联")
    assert_no_horizontal_overflow(page, 'section[aria-label="图片工作区"]:not([hidden])')


def open_prompt_gallery(page: Page) -> None:
    page.goto(f"{BASE_URL}/?dev=prompt-library", wait_until="networkidle")
    page.locator('select[name="prompt-sort"]').select_option("title:asc")
    prompt = page.locator('[data-prompt-card][data-id="showcase-prompt-0"]')
    expect(prompt).to_be_visible()
    expect(prompt.locator(".prompt-cover-frame")).to_have_count(1)
    expect(prompt.locator(".prompt-card-count")).to_have_text("3 张")
    prompt.click()
    inspector_button = page.get_by_role("button", name="提示词检查器", exact=True)
    if inspector_button.is_visible():
        inspector_button.click()
    preview = page.locator("[data-preview-hash]")
    expect(preview).to_be_visible()
    second = page.get_by_role("button", name="预览关联图片 柔光人像.png", exact=True)
    expect(second).to_be_visible()
    second.click()
    expect(preview).to_have_attribute("data-preview-hash", "b" * 64)
    direct_unlink = page.get_by_role(
        "button",
        name="解除与图片 柔光人像.png 的关联",
        exact=True,
    )
    expect(direct_unlink).to_be_visible()
    expect(direct_unlink).to_have_attribute("title", "解除关联")
    expect(page.get_by_role("button", name="打开当前图片", exact=True)).to_be_visible()
    expect(page.locator('[data-ui="prompt-workbench"]')).to_be_visible()
    assert_no_horizontal_overflow(page, "[data-ui=\"prompt-workbench\"]")


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    report: dict[str, object] = {"cases": [], "console": []}
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        for theme in THEMES:
            for width in WIDTHS:
                for name, open_state in (
                    ("asset-unlink", open_asset_unlink),
                    ("asset-association", open_asset_association),
                    ("prompt-gallery", open_prompt_gallery),
                ):
                    page = browser.new_page(viewport={"width": width, "height": 900})
                    install_theme(page, theme)
                    messages: list[str] = []
                    page.on(
                        "console",
                        lambda message, sink=messages: sink.append(
                            f"{message.type}: {message.text}"
                        )
                        if message.type in {"warning", "error"}
                        else None,
                    )
                    page.on(
                        "pageerror",
                        lambda error, sink=messages: sink.append(f"pageerror: {error}"),
                    )
                    open_state(page)
                    screenshot = OUTPUT_DIR / f"{name}-{theme}-{width}.png"
                    page.screenshot(path=str(screenshot), full_page=True)
                    report["cases"].append(
                        {
                            "name": name,
                            "theme": theme,
                            "width": width,
                            "screenshot": screenshot.name,
                        }
                    )
                    report["console"].extend(messages)
                    page.close()
        browser.close()

    console_messages = report["console"]
    if not isinstance(console_messages, list):
        raise TypeError("验收报告 console 必须是列表")
    if console_messages:
        raise AssertionError("浏览器控制台不干净：\n" + "\n".join(console_messages))
    with (OUTPUT_DIR / "report.json").open(
        "w",
        encoding="utf-8",
        newline="\n",
    ) as report_file:
        report_file.write(json.dumps(report, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
