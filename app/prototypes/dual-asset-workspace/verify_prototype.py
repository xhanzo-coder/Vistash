"""PROTOTYPE 验证：双素材工作台不连接真实数据。"""

import os
from pathlib import Path

from playwright.sync_api import sync_playwright


ARTIFACTS = Path(__file__).parent / "artifacts"
ARTIFACTS.mkdir(exist_ok=True)
BASE_URL = "http://localhost:1421"
ENGINE = os.environ.get("PROTOTYPE_ENGINE", "owned")


def prototype_url(variant: str) -> str:
    return f"{BASE_URL}/?variant={variant}&engine={ENGINE}"


def assert_no_horizontal_overflow(page) -> None:
    overflow = page.evaluate("document.documentElement.scrollWidth - window.innerWidth")
    assert overflow <= 1, f"存在水平溢出：{overflow}px"


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
    console_errors: list[str] = []
    page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)

    page.goto(prototype_url("A"))
    page.wait_for_load_state("networkidle")
    page.get_by_role("heading", name="图片素材", exact=True).wait_for()
    assert "10,000" in page.locator(".prototype-switcher span").inner_text()
    image_dom_count = page.locator("[data-prototype-item]").count()
    assert image_dom_count < 160, f"图片首屏 DOM 过多：{image_dom_count}"
    assert_no_horizontal_overflow(page)
    left_before = page.locator(".left-shell").bounding_box()
    resize_handle = page.locator(".left-shell .resize-handle")
    handle_box = resize_handle.bounding_box()
    assert left_before is not None and handle_box is not None
    page.mouse.move(handle_box["x"] + handle_box["width"] / 2, handle_box["y"] + 120)
    page.mouse.down()
    page.mouse.move(handle_box["x"] + 42, handle_box["y"] + 120)
    page.mouse.up()
    page.wait_for_timeout(200)
    left_after = page.locator(".left-shell").bounding_box()
    assert left_after is not None and left_after["width"] > left_before["width"] + 20, (left_before, left_after, handle_box)
    page.reload()
    page.wait_for_load_state("networkidle")
    left_reloaded = page.locator(".left-shell").bounding_box()
    assert left_reloaded is not None and abs(left_reloaded["width"] - left_after["width"]) < 3
    page.get_by_role("button", name="折叠分类栏").click()
    page.get_by_role("button", name="分类", exact=True).wait_for()
    page.get_by_role("button", name="分类", exact=True).click()
    page.locator(".left-shell").wait_for()
    page.screenshot(path=ARTIFACTS / "variant-a-images-masonry.png")

    first_cards = page.locator("[data-prototype-item]")
    first_cards.nth(0).click()
    first_cards.nth(1).click(modifiers=["Control"])
    page.get_by_role("toolbar", name="批量操作").wait_for()
    assert "已选 2" in page.get_by_role("toolbar", name="批量操作").inner_text()
    page.get_by_role("button", name="详情列表", exact=True).click()
    page.locator(".virtual-collection.is-details").wait_for()
    assert "已选 2" in page.get_by_role("toolbar", name="批量操作").inner_text()
    page.get_by_role("button", name="瀑布流", exact=True).click()
    page.locator(".virtual-collection.is-masonry").wait_for()
    page.locator("[data-prototype-item]").nth(0).dblclick()
    page.get_by_role("dialog").wait_for()
    page.get_by_role("button", name="Esc 返回", exact=True).click()
    page.get_by_role("dialog").wait_for(state="detached")
    keyboard_surface = page.locator(".collection-keyboard-surface")
    keyboard_surface.focus()
    keyboard_surface.press("Escape")
    boxes = [page.locator("[data-prototype-item]").nth(index).bounding_box() for index in range(3)]
    assert all(box is not None for box in boxes)
    first_box, second_box, third_box = boxes
    assert first_box is not None and second_box is not None and third_box is not None
    start_x = (second_box["x"] + second_box["width"] + third_box["x"]) / 2
    start_y = min(first_box["y"], second_box["y"]) + 6
    end_x = first_box["x"] + 5
    end_y = min(first_box["y"] + first_box["height"], second_box["y"] + second_box["height"]) - 6
    page.mouse.move(start_x, start_y)
    page.mouse.down()
    page.mouse.move(end_x, end_y, steps=8)
    page.mouse.up()
    page.get_by_role("toolbar", name="批量操作").wait_for()
    assert "已选 2" in page.get_by_role("toolbar", name="批量操作").inner_text()

    page.locator(".library-switcher").get_by_role("button", name="提示词", exact=True).click()
    page.get_by_role("heading", name="提示词", exact=True).wait_for()
    prompt_dom_count = page.locator("[data-prototype-item]").count()
    assert prompt_dom_count < 160, f"提示词首屏 DOM 过多：{prompt_dom_count}"
    page.locator("[data-prototype-item]").nth(0).click()
    page.get_by_role("button", name="关联图片", exact=True).click()
    page.get_by_role("button", name="从图片库选择", exact=True).click()
    picker_item = page.locator(".picker-grid button").nth(0)
    picker_item.click()
    assert "is-selected" in (picker_item.get_attribute("class") or "")
    page.get_by_role("button", name="完成", exact=True).click()
    page.locator(".relation-thumbnails button").nth(0).wait_for()
    assert "封面" in page.locator(".relation-thumbnails button").nth(0).inner_text()
    test_image = Path(__file__).parents[3] / "test" / "pinterest_images" / "pinterest_001.png"
    if test_image.exists():
        page.locator(".file-action input[type=file]").set_input_files(test_image)
        page.get_by_text("已“入库并关联”", exact=False).wait_for()
    page.screenshot(path=ARTIFACTS / "prompt-relations-and-cover.png")
    page.screenshot(path=ARTIFACTS / "variant-a-prompts-masonry.png")

    page.get_by_role("button", name="详情列表", exact=True).click()
    page.locator(".virtual-collection.is-details").wait_for()
    page.screenshot(path=ARTIFACTS / "variant-a-prompts-details.png")

    page.get_by_role("button", name="全局搜索", exact=False).click()
    search = page.get_by_placeholder("搜索图片和提示词…")
    search.fill("cinematic")
    page.get_by_role("heading", name="图片素材（0）").wait_for()
    page.get_by_role("heading", name="提示词（4）").wait_for()
    page.screenshot(path=ARTIFACTS / "global-search-grouped.png")
    page.get_by_role("button", name="Esc", exact=True).click()

    for variant in ("B", "C"):
        page.goto(prototype_url(variant))
        page.wait_for_load_state("networkidle")
        page.get_by_role("heading", name="图片素材", exact=True).wait_for()
        assert_no_horizontal_overflow(page)
        page.screenshot(path=ARTIFACTS / f"variant-{variant.lower()}-images.png")

    for width, label in ((1024, "medium"), (720, "narrow")):
        page.set_viewport_size({"width": width, "height": 820})
        page.goto(prototype_url("A"))
        page.wait_for_load_state("networkidle")
        page.get_by_role("heading", name="图片素材", exact=True).wait_for()
        assert page.locator("[data-prototype-item]").count() > 0, f"{label} 窗口未渲染中央集合"
        assert_no_horizontal_overflow(page)
        if width <= 1024:
            page.get_by_role("button", name="分类", exact=True).wait_for()
            page.get_by_role("button", name="检查器", exact=True).wait_for()
            page.get_by_role("button", name="分类", exact=True).click()
            page.locator(".balanced-workspace .prototype-sidebar").wait_for()
            page.get_by_role("button", name="折叠分类栏").click()
            page.get_by_role("button", name="检查器", exact=True).click()
            page.locator(".balanced-workspace .prototype-inspector").wait_for()
        page.screenshot(path=ARTIFACTS / f"responsive-{label}.png")

    assert not console_errors, f"浏览器控制台错误：{console_errors}"
    print(
        {
            "image_dom_count": image_dom_count,
            "prompt_dom_count": prompt_dom_count,
            "console_errors": console_errors,
            "screenshots": len(list(ARTIFACTS.glob("*.png"))),
        }
    )
    browser.close()
