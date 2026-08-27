"""合并修复验收：真实浏览器的万项框选，以及隔离标识的 Windows release 工作台。"""

import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time

from playwright.sync_api import expect, sync_playwright


APP = Path(__file__).resolve().parent.parent
ARTIFACTS = APP / "artifacts" / "merge-blockers"


def invoke(page, command, args):
    return page.evaluate("([command, args]) => window.__TAURI_INTERNALS__.invoke(command, args)", [command, args])


def box_select(page, selector, label):
    items = page.locator(selector)
    expect(items.first).to_be_visible()
    boxes = items.evaluate_all("nodes => nodes.slice(0, 2).map(n => { const r=n.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })")
    first, second = boxes
    assert abs(first["y"] - second["y"]) < 2, "验收要求至少两列"
    start_x = (first["x"] + first["width"] + second["x"]) / 2
    start_y = max(first["y"], second["y"]) + 4
    page.mouse.move(start_x, start_y)
    page.mouse.down()
    started = time.perf_counter()
    page.mouse.move(second["x"] + second["width"] - 6, start_y + 60, steps=4)
    expect(page.locator("[data-selection-box]")).to_be_visible()
    expect(items.nth(1)).to_have_attribute("aria-selected", "true")
    expect(items.nth(0)).to_have_attribute("aria-selected", "false")
    duration = (time.perf_counter() - started) * 1000
    page.screenshot(path=str(ARTIFACTS / f"{label}-box.png"))
    page.keyboard.press("Escape")
    page.mouse.up()
    expect(page.locator("[data-selection-box]")).to_have_count(0)
    return {"visible_items": items.count(), "four_moves_and_assertion_ms": round(duration, 2)}


def browser_review(playwright, url):
    # 复用已有性能 fixture；补足本次交互使用的只读详情与事件释放边界。
    bootstrap = subprocess.check_output(
        ["node", "--input-type=module", "-e", "import {buildBootstrap} from './scripts/perfFixture.mjs'; process.stdout.write(buildBootstrap(10000));"],
        cwd=APP, encoding="utf-8",
    )
    browser = playwright.chromium.launch(channel="msedge", headless=True)
    try:
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.add_init_script(bootstrap)
        page.add_init_script("""(() => {
          // 两段 init script 的运行顺序不保证；在页面脚本执行前按需补充 IPC。
          window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {unregisterListener() {}};
        })();""")
        page.goto(url, wait_until="networkidle")
        expect(page.locator("[data-waterfall-item]").first).to_be_visible()
        page.screenshot(path=str(ARTIFACTS / "browser-initial.png"))
        image_result = box_select(page, "[data-waterfall-item]", "images-10000")
        assert image_result["visible_items"] < 80
        page.get_by_role("button", name="提示词库", exact=True).click()
        expect(page.locator("[data-prompt-card]").first).to_be_visible()
        prompt_result = box_select(page, "[data-prompt-card]", "prompts-10000")
        assert prompt_result["visible_items"] < 80
        assert not errors, errors
        return {"images": image_result, "prompts": prompt_result, "page_errors": errors}
    finally:
        browser.close()


def native_review(playwright, cdp):
    browser = playwright.chromium.connect_over_cdp(cdp)
    page = browser.contexts[0].pages[0]
    page.set_default_timeout(8_000)
    page.wait_for_load_state("networkidle")
    identifier = invoke(page, "plugin:app|identifier", {})
    assert identifier == "com.vistash.merge-review-20260827", "拒绝在正式应用标识下运行写入型验收"
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    fixture = Path(tempfile.mkdtemp(prefix="vistash-merge-native-"))
    library = fixture / "library"
    library.mkdir()
    invoke(page, "open_library", {"path": str(library)})
    ids = []
    for index in range(4):
        created = invoke(page, "create_prompt", {"prompt": {
            "body": f"原始正文 {index}", "title": f"验收提示词 {index}", "model": None,
            "parameters": None, "folders": [], "tags": [],
        }})
        ids.append(created["id"])
    page.reload(wait_until="networkidle")
    page.get_by_role("button", name="提示词库", exact=True).click()
    expect(page.locator("[data-prompt-card]")).to_have_count(4)
    page.screenshot(path=str(ARTIFACTS / "native-initial.png"))
    card = page.locator(f'[data-prompt-card][data-id="{ids[0]}"]')
    card.dblclick()
    expect(page.get_by_label("聚焦阅读", exact=True)).to_be_visible()
    page.keyboard.press("Escape")
    expect(page.get_by_label("聚焦阅读", exact=True)).to_have_count(0)
    card.click()
    page.get_by_role("button", name="编辑主字段", exact=True).click()
    editor = page.locator('textarea[name="prompt-body"]')
    editor.fill("筛选前需要保护的正文")
    page.get_by_role("button", name="★ 只看收藏", exact=True).click()
    expect(page.get_by_role("dialog")).to_be_visible()
    page.get_by_role("button", name="留在当前页", exact=True).click()
    expect(editor).to_have_value("筛选前需要保护的正文")
    page.get_by_role("button", name="★ 只看收藏", exact=True).click()
    page.get_by_role("button", name="保存并离开", exact=True).click()
    expect(editor).to_have_count(0)
    saved = invoke(page, "prompt_detail", {"id": ids[0]})
    assert saved["body"] == "筛选前需要保护的正文"
    page.get_by_role("button", name="移除收藏条件", exact=True).click()
    expect(page.locator("[data-prompt-card]")).to_have_count(4)
    box_result = box_select(page, "[data-prompt-card]", "native-prompts")

    page.get_by_role("button", name="详情列表", exact=True).click()
    row = page.locator(f'[data-list-item][data-id="{ids[0]}"]')
    row.focus()
    row.press("Enter")
    expect(page.get_by_label("聚焦阅读", exact=True)).to_be_visible()
    page.keyboard.press("Escape")
    expect(page.get_by_label("聚焦阅读", exact=True)).to_have_count(0)
    row.click()
    page.get_by_role("button", name="编辑主字段", exact=True).click()
    editor = page.locator('textarea[name="prompt-body"]')
    editor.fill("窗口关闭前未保存的正文")
    invoke(page, "plugin:window|close", {"label": "main"})
    expect(page.get_by_role("dialog")).to_be_visible()
    page.get_by_role("button", name="留在当前页", exact=True).click()
    expect(editor).to_have_value("窗口关闭前未保存的正文")
    page.screenshot(path=str(ARTIFACTS / "native-draft-protected.png"))
    assert not errors, errors
    invoke(page, "plugin:window|close", {"label": "main"})
    expect(page.get_by_role("dialog")).to_be_visible()
    with page.expect_event("close"):
        page.get_by_role("button", name="放弃修改", exact=True).click()
    return {"library": str(library), "prompt_count": len(ids), "box": box_result, "close_after_discard": True, "page_errors": errors}


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--url", help="已启动的 production preview 地址")
    mode.add_argument("--cdp", help="使用隔离 identifier 启动的 release WebView2 CDP 地址")
    args = parser.parse_args()
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        report = browser_review(playwright, args.url) if args.url else native_review(playwright, args.cdp)
    output = ARTIFACTS / ("browser-report.json" if args.url else "native-report.json")
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
