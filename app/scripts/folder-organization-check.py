"""验证 9.1 文件夹组织，仅操作开发内存库，不接触真实文件或图片。"""
import argparse
import json
from pathlib import Path
import sys
from playwright.sync_api import expect, sync_playwright


def choose_folder(page, path, width):
    if width <= 1050:
        page.get_by_role("button", name="图片导航", exact=True).click()
    page.get_by_role("navigation", name="图片导航", exact=True).locator(f'[data-folder="{path}"]').click()
    expect(page.get_by_role("dialog")).to_have_count(0)


def open_navigation(page, width):
    if width <= 1050:
        page.get_by_role("button", name="图片导航", exact=True).click()


def close_navigation(page, width):
    if width <= 1050:
        page.get_by_role("dialog", name="图片导航", exact=True).get_by_role("button", name="关闭", exact=True).click()


def drag(page, source, target, cancel=False):
    start = source.bounding_box()
    end = target.bounding_box()
    assert start is not None and end is not None
    page.mouse.move(start["x"] + start["width"] / 2, start["y"] + 25)
    page.mouse.down()
    page.mouse.move(end["x"] + end["width"] / 2, end["y"] + end["height"] / 2, steps=12)
    if cancel:
        page.keyboard.press("Escape")
    page.mouse.up()


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True)
    args = parser.parse_args()
    artifacts = Path(__file__).resolve().parent.parent / "artifacts" / "folder-organization"
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
                        first = page.get_by_role("option", name="甲库测试图-0.png", exact=True)
                        second = page.get_by_role("option", name="甲库测试图-1.png", exact=True)
                        expect(first).to_be_visible()
                        first.click()
                        second.click(modifiers=["Control"])
                        if width > 1050:
                            target = page.get_by_role("navigation", name="图片导航").locator('[data-folder="参考"]')
                            drag(page, first, target, cancel=True)
                            expect(page.get_by_role("region", name="操作结果")).to_have_count(0)
                            drag(page, first, target)
                        else:
                            page.get_by_role("button", name="移动", exact=True).click()
                            move = page.get_by_role("dialog", name="移动图片", exact=True)
                            move.locator('select[name="move-target"]').select_option("folder:参考")
                            move.get_by_role("button", name="确认移动", exact=True).click()
                            expect(move).to_have_count(0)
                        expect(page.get_by_role("region", name="操作结果")).to_contain_text("成功 2 项")
                        choose_folder(page, "参考", width)
                        expect(page.get_by_role("listbox", name="图片集合").get_by_role("option")).to_have_count(2)
                        open_navigation(page, width)
                        page.get_by_role("button", name="新建文件夹", exact=True).click()
                        create = page.get_by_role("dialog", name="新建文件夹", exact=True)
                        name = create.locator('input[name="folder-name"]')
                        name.fill("非法/名称")
                        create.get_by_role("button", name="创建文件夹", exact=True).click()
                        expect(create.get_by_role("alert")).to_contain_text("library.folder_invalid")
                        expect(name).to_have_value("非法/名称")
                        name.fill("灵感")
                        create.get_by_role("button", name="创建文件夹", exact=True).click()
                        expect(create).to_have_count(0)
                        close_navigation(page, width)
                        expect(page.get_by_role("heading", name="参考/灵感", exact=True)).to_be_visible()
                        open_navigation(page, width)
                        page.get_by_role("button", name="重命名文件夹", exact=True).click()
                        rename = page.get_by_role("dialog", name="重命名文件夹", exact=True)
                        rename.locator("select").select_option("参考")
                        rename.locator('input[name="folder-name"]').fill("档案")
                        page.screenshot(path=str(artifacts / f"rename-{theme}-{width}.png"), animations="disabled")
                        rename.get_by_role("button", name="保存名称", exact=True).click()
                        expect(rename).to_have_count(0)
                        close_navigation(page, width)
                        expect(page.get_by_role("heading", name="档案/灵感", exact=True)).to_be_visible()
                        choose_folder(page, "档案", width)
                        expect(page.get_by_role("listbox", name="图片集合").get_by_role("option")).to_have_count(2)
                        open_navigation(page, width)
                        page.get_by_role("button", name="删除文件夹", exact=True).click()
                        remove = page.get_by_role("dialog", name="删除文件夹", exact=True)
                        remove.get_by_role("button", name="继续删除", exact=True).click()
                        confirmation = page.get_by_role("alertdialog")
                        expect(confirmation).to_contain_text("不会删除图片")
                        confirmation.get_by_role("button", name="取消", exact=True).click()
                        remove.get_by_role("button", name="继续删除", exact=True).click()
                        page.get_by_role("alertdialog").get_by_role("button", name="确认删除文件夹", exact=True).click()
                        expect(remove).to_have_count(0)
                        close_navigation(page, width)
                        expect(page.get_by_role("heading", name="未分类", exact=True)).to_be_visible()
                        expect(page.locator('[data-folder="档案"]')).to_have_count(0)
                        expect(first).to_be_visible()
                        expect(second).to_be_visible()
                        page.screenshot(path=str(artifacts / f"completed-{theme}-{width}.png"), animations="disabled")
                        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "水平溢出"
                        assert not errors, errors
                        report = {"theme": theme, "width": width, "create_rename_delete": True, "invalid_name_retained": True, "move": "pointer" if width > 1050 else "dialog", "images_preserved": True}
                        reports.append(report)
                        print(json.dumps(report, ensure_ascii=False), flush=True)
                    finally:
                        context.close()
        finally:
            browser.close()
    (artifacts / "report.json").write_text(json.dumps(reports, ensure_ascii=False, indent=2), encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
