"""通过真实组件展台验收 UI 基础；只操作内存 fixture，不访问使用者素材库。"""
import argparse
import json
from pathlib import Path
import sys

from playwright.sync_api import expect, sync_playwright


ARTIFACTS = Path(__file__).resolve().parent.parent / "artifacts" / "ui-foundation"


def visit(page, base_url, query):
    page.goto(f"{base_url}/?{query}", wait_until="networkidle")
    page.locator("main").first.wait_for(state="visible")


def migration_check(page, base_url, label):
    visit(page, base_url, "dev=library-lifecycle&state=migration-many")
    page.get_by_role("button", name="准备迁移", exact=True).click()
    page.get_by_role("button", name="检查迁移方案", exact=True).click()
    groups = page.locator("fieldset")
    expect(groups).to_have_count(60)
    footer = page.locator("footer")
    confirm = page.get_by_role("button", name="确认迁移", exact=True)
    expect(confirm).to_be_disabled()
    rect = footer.bounding_box()
    viewport_height = page.evaluate("innerHeight")
    page.screenshot(path=str(ARTIFACTS / f"migration-{label}.png"))
    assert rect is not None, "迁移页缺少底部操作区"
    assert rect["y"] >= 0 and rect["y"] + rect["height"] <= viewport_height + 1, f"确认区离开窗口：{rect}，窗口高度 {viewport_height}"
    scroll_area = groups.first.locator("..")
    scroll_bounds = scroll_area.bounding_box()
    assert scroll_bounds is not None
    page.mouse.move(scroll_bounds["x"] + scroll_bounds["width"] / 2, scroll_bounds["y"] + scroll_bounds["height"] / 2)
    page.mouse.wheel(0, 20_000)
    expect(groups.last).to_be_in_viewport()
    assert scroll_area.evaluate("e => e.scrollTop") > 0, "冲突列表没有独立滚动"
    expect(page.get_by_role("heading", name="选择唯一图片文件夹", exact=True)).to_be_in_viewport()
    expect(footer).to_be_in_viewport()
    page.screenshot(path=str(ARTIFACTS / f"migration-bottom-{label}.png"))
    groups.last.get_by_text("构图参考", exact=True).click()
    expect(confirm).to_be_disabled()
    for index in range(59):
        groups.nth(index).get_by_text("构图参考", exact=True).click()
    expect(confirm).to_be_enabled()
    confirm.click()
    page.get_by_role("button", name="开始迁移", exact=True).click()
    expect(page.get_by_test_id("ready-workspace")).to_be_visible()
    return {"conflicts": 60, "footer_bottom": round(rect["y"] + rect["height"], 2), "viewport_height": viewport_height, "completed": True}


def showcase_check(page, base_url, label):
    visit(page, base_url, "dev=ui-kit")
    page.mouse.move(500, 300)
    page.mouse.wheel(0, 5_000)
    expect(page.get_by_role("heading", name="还没有图片", exact=True)).to_be_in_viewport()
    panel = page.locator('section[aria-label="滚动区域"]')
    viewport = panel.get_by_role("region", name="文件夹列表", exact=True)
    panel_bounds = panel.bounding_box()
    viewport_bounds = viewport.bounding_box()
    assert panel_bounds is not None and viewport_bounds is not None
    assert viewport_bounds["y"] + viewport_bounds["height"] <= panel_bounds["y"] + panel_bounds["height"], "展台内部列表溢出面板"
    page.mouse.move(viewport_bounds["x"] + viewport_bounds["width"] / 2, viewport_bounds["y"] + viewport_bounds["height"] / 2)
    page.mouse.wheel(0, 2_000)
    last = viewport.get_by_role("button", name="参考资料 / 集合 14", exact=True)
    expect(last).to_be_in_viewport()
    assert viewport.evaluate("e => e.scrollTop") > 0, "展台内部列表无法独立滚动"
    page.screenshot(path=str(ARTIFACTS / f"showcase-{label}.png"))
    return {"bottom_visible": True, "nested_scroll_contained": True}


def search_check(page, base_url, label):
    visit(page, base_url, "dev=ui-kit")
    search = page.get_by_role("searchbox", name="搜索图片", exact=True)
    clear = page.get_by_role("button", name="清除搜索", exact=True)
    field = search.locator("..")
    adjacent = page.get_by_role("combobox", name="排序方式", exact=True)
    before = {"field": field.bounding_box(), "adjacent": adjacent.bounding_box()}
    for activation in ["mouse", "Enter", "Space"]:
        search.fill("雨夜")
        if activation == "mouse":
            clear.click()
        else:
            search.press("Tab")
            expect(clear).to_be_focused()
            clear.press(activation)
        expect(search).to_have_value("")
        expect(clear).to_have_count(0)
        expect(search).to_be_focused()
        after = {"field": field.bounding_box(), "adjacent": adjacent.bounding_box()}
        for target in before:
            for dimension in ["x", "y", "width", "height"]:
                assert abs(before[target][dimension] - after[target][dimension]) <= 1, f"清除引发布局跳动：{before} → {after}"
        page.keyboard.type("sunset")
        expect(search).to_have_value("sunset")
        search.press("Escape")
        expect(search).to_have_value("")
        expect(search).to_be_focused()
        search.press("Tab")
        expect(adjacent).to_be_focused()
    page.screenshot(path=str(ARTIFACTS / f"search-{label}.png"))
    return {"activation": ["mouse", "Enter", "Space", "Escape"], "focus_retained": True, "layout_shift": 0}


def theme_check(page, base_url, label):
    visit(page, base_url, "dev=app-shell")
    page.get_by_role("button", name="设置", exact=True).click()
    dialog = page.get_by_role("dialog", name="设置", exact=True)
    group = dialog.get_by_role("radiogroup", name="主题", exact=True)
    system = group.get_by_role("radio", name="跟随系统", exact=True)
    dark = group.get_by_role("radio", name="深色", exact=True)
    light = group.get_by_role("radio", name="浅色", exact=True)
    expect(system).to_be_checked()
    # 从组前的最后一个分类按钮 Tab 进入，只访问当前选中项。
    dialog.get_by_role("button", name="关于", exact=True).focus()
    page.keyboard.press("Tab")
    expect(system).to_be_focused()
    for key, target, preference in [
        ("ArrowRight", dark, "dark"),
        ("ArrowRight", light, "light"),
        ("ArrowRight", system, "system"),
        ("ArrowLeft", light, "light"),
        ("ArrowUp", dark, "dark"),
        ("ArrowDown", light, "light"),
    ]:
        page.keyboard.press(key)
        expect(target).to_be_checked()
        expect(target).to_be_focused()
        expect(page.locator("html")).to_have_attribute("data-theme-preference", preference)
        if preference != "system":
            expect(page.locator("html")).to_have_attribute("data-theme", preference)
    page.keyboard.press("Tab")
    assert not group.evaluate("e => e.contains(document.activeElement)"), "Tab 没有离开单选组"
    page.keyboard.press("Shift+Tab")
    expect(light).to_be_focused()
    system.focus()
    page.keyboard.press("Space")
    expect(system).to_be_checked()
    # 标签点击同样可用；最后回到系统主题，截图与当前测试主题一致。
    group.locator("label").filter(has_text="深色").click()
    expect(dark).to_be_checked()
    group.locator("label").filter(has_text="跟随系统").click()
    expect(system).to_be_checked()
    system.focus()
    page.keyboard.press("Tab")
    page.keyboard.press("Shift+Tab")
    expect(system).to_be_focused()
    page.screenshot(path=str(ARTIFACTS / f"theme-{label}.png"))
    group.locator("label").filter(has_text="深色").click()
    page.keyboard.press("Escape")
    expect(dialog).to_have_count(0)
    page.reload(wait_until="networkidle")
    page.get_by_role("button", name="设置", exact=True).click()
    expect(dark).to_be_checked()
    expect(page.locator("html")).to_have_attribute("data-theme", "dark")
    group.locator("label").filter(has_text="跟随系统").click()
    page.keyboard.press("Escape")
    return {"arrows": True, "single_tab_stop": True, "space_and_label": True, "persisted": True}


def typography_check(page, base_url, label):
    visit(page, base_url, "dev=ui-kit")
    buttons = page.get_by_role("group", name="主题预览", exact=True).get_by_role("button")
    expect(buttons).to_have_count(3)
    measurements = buttons.evaluate_all("""elements => elements.map(e => {
        const rect = e.getBoundingClientRect();
        const label = e.querySelector('span');
        return {text: e.textContent, font: parseFloat(getComputedStyle(e).fontSize),
            x: rect.x, right: rect.right, y: rect.y, height: rect.height,
            textFits: label.scrollWidth <= label.clientWidth};
    })""")
    previous_right = 0
    for button in measurements:
        assert button["font"] >= 12, f"紧凑按钮字号不足：{button}"
        assert abs(button["height"] - 28) <= 1, f"紧凑按钮高度改变：{button}"
        assert button["textFits"], f"按钮文字被截断：{button}"
        assert button["x"] >= previous_right, "相邻主题按钮发生重叠"
        assert button["y"] == measurements[0]["y"], "主题按钮意外换行"
        previous_right = button["right"]
    page.screenshot(path=str(ARTIFACTS / f"typography-{label}.png"))
    return {"buttons": measurements}


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--case", choices=["all", "migration", "showcase", "search", "theme", "typography"], default="all")
    args = parser.parse_args()
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    checks = {"migration": migration_check, "showcase": showcase_check, "search": search_check, "theme": theme_check, "typography": typography_check}
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
                        for name, check in checks.items():
                            if args.case not in ("all", name):
                                continue
                            result = check(page, args.base_url.rstrip("/"), f"{theme}-{width}")
                            report = {"case": name, "theme": theme, "width": width, **result}
                            reports.append(report)
                            print(json.dumps(report, ensure_ascii=False), flush=True)
                        assert not errors, errors
                    finally:
                        context.close()
        finally:
            browser.close()
    (ARTIFACTS / f"{args.case}-report.json").write_text(json.dumps(reports, ensure_ascii=False, indent=2), encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
