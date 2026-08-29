"""大图灯箱浏览器验收，只使用开发内存库和本地品牌原图。"""
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
    artifacts = Path(__file__).resolve().parent.parent / "artifacts" / "lightbox"
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
                        page.add_init_script("""window.releasedImageUrls = []; const revoke = URL.revokeObjectURL.bind(URL); URL.revokeObjectURL = url => { window.releasedImageUrls.push(url); revoke(url); };""")
                        errors = []
                        page.on("pageerror", lambda error: errors.append(str(error)))
                        page.goto(f"{args.base_url.rstrip('/')}/?dev=asset-library", wait_until="networkidle")
                        gallery = page.get_by_role("listbox", name="图片集合", exact=True)
                        first = gallery.get_by_role("option", name="甲库测试图-0.png", exact=True)
                        first.click()
                        expect(page.locator("[data-lightbox]")).to_have_count(0)
                        scroll_top = gallery.evaluate("element => element.scrollTop")
                        first.dblclick()
                        viewer = page.locator('[data-lightbox="true"]')
                        canvas = viewer.locator('[aria-label="原图画布"]')
                        photo = viewer.get_by_role("img", name="甲库测试图-0.png", exact=True)
                        expect(photo).to_be_visible()
                        expect(viewer.get_by_role("button", name="上一张", exact=True)).to_be_disabled()
                        size = photo.bounding_box()
                        canvas_size = canvas.bounding_box()
                        assert size["width"] <= canvas_size["width"] + 1 and size["height"] <= canvas_size["height"] + 1, "适合窗口超界"
                        page.screenshot(path=str(artifacts / f"fit-{theme}-{width}.png"), animations="disabled")
                        viewer.get_by_role("button", name="100%", exact=True).click()
                        expect(viewer.locator('[aria-label="缩放比例"]')).to_have_text("100%")
                        assert abs(photo.bounding_box()["width"] - 1024) < 1, "100% 未使用原图固有尺寸"
                        assert abs(photo.bounding_box()["height"] - 1024) < 1
                        before = photo.evaluate("element => element.style.transform")
                        point_x = canvas_size["x"] + canvas_size["width"] / 2
                        point_y = canvas_size["y"] + canvas_size["height"] / 2
                        page.mouse.move(point_x, point_y)
                        page.mouse.down()
                        page.mouse.move(point_x + 80, point_y + 80, steps=5)
                        page.mouse.up()
                        assert photo.evaluate("element => element.style.transform") != before, "拖动未平移图片"
                        page.mouse.move(point_x, point_y)
                        page.mouse.wheel(0, -200)
                        page.wait_for_function("Number(document.querySelector('[aria-label=\"缩放比例\"]').textContent.replace('%', '')) > 100")
                        canvas.focus()
                        before_key = photo.evaluate("element => element.style.transform")
                        canvas.press("Shift+ArrowDown")
                        assert photo.evaluate("element => element.style.transform") != before_key, "键盘未平移图片"
                        canvas.press("Home")
                        expect(viewer.get_by_role("button", name="适合窗口", exact=True)).to_have_attribute("aria-pressed", "true")
                        background = viewer.get_by_role("combobox", name="灯箱背景", exact=True)
                        background.select_option("checker")
                        expect(canvas).to_have_attribute("data-background", "checker")
                        assert "conic-gradient" in canvas.evaluate("element => getComputedStyle(element).backgroundImage")
                        page.screenshot(path=str(artifacts / f"checker-{theme}-{width}.png"), animations="disabled")
                        background.select_option("light")
                        expect(canvas).to_have_attribute("data-background", "light")
                        canvas.focus()
                        for _ in range(15):
                            canvas.press("ArrowRight")
                        final_photo = viewer.get_by_role("img", name="甲库测试图-15.png", exact=True)
                        expect(final_photo).to_be_visible()
                        final_url = final_photo.get_attribute("src")
                        canvas.press("Escape")
                        expect(viewer).to_have_count(0)
                        expect(gallery).to_be_focused()
                        assert abs(gallery.evaluate("element => element.scrollTop") - scroll_top) < 1, "退出灯箱改变了原滚动位置"
                        assert page.evaluate("url => window.releasedImageUrls.includes(url)", final_url), "关闭未释放原图租约"
                        gallery.press("Enter")
                        expect(viewer.get_by_role("img", name="甲库测试图-15.png", exact=True)).to_be_visible()
                        viewer.get_by_role("button", name="关闭灯箱", exact=True).click()
                        expect(viewer).to_have_count(0)
                        page.get_by_role("button", name="模拟原图失败", exact=True).click()
                        gallery.focus()
                        gallery.press("Enter")
                        expect(viewer.get_by_role("alert")).to_contain_text("library.io_failed")
                        expect(viewer.locator("img")).to_have_count(0)
                        page.screenshot(path=str(artifacts / f"error-{theme}-{width}.png"), animations="disabled")
                        # 只解除开发内存故障，模拟外部文件重新可读。
                        page.get_by_role("button", name="模拟原图失败", exact=True, include_hidden=True).evaluate("button => button.click()")
                        viewer.get_by_role("button", name="重试读取原图", exact=True).click()
                        expect(viewer.get_by_role("img", name="甲库测试图-15.png", exact=True)).to_be_visible()
                        assert viewer.evaluate("element => element.contains(document.activeElement)"), "重试后焦点离开灯箱"
                        viewer.get_by_role("button", name="关闭灯箱", exact=True).click()
                        expect(viewer).to_have_count(0)
                        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "水平溢出"
                        assert not errors, errors
                        result = {"theme": theme, "width": width, "fit_and_original_size": True, "wheel_and_pan": True, "backgrounds": True, "scroll_restored": True, "lease_released": True, "errors": errors}
                        reports.append(result)
                        print(json.dumps(result, ensure_ascii=False), flush=True)
                    finally:
                        context.close()
        finally:
            browser.close()
    (artifacts / "report.json").write_text(json.dumps(reports, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
