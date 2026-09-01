"""PROTOTYPE QA：截图并检查三套图片库视觉方案。"""

from pathlib import Path

from playwright.sync_api import sync_playwright


APP_URL = "http://127.0.0.1:1420/?prototype=image-library"
EDGE_CANDIDATES = (
    Path("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"),
    Path("C:/Program Files/Microsoft/Edge/Application/msedge.exe"),
)
OUTPUT = Path(__file__).resolve().parents[1] / "artifacts" / "prototype-image-library"


def edge_path() -> str:
    return str(next(path for path in EDGE_CANDIDATES if path.exists()))


def assert_no_horizontal_overflow(page) -> None:
    overflow = page.evaluate(
        """() => ({
            viewport: window.innerWidth,
            body: document.body.scrollWidth,
            root: document.documentElement.scrollWidth,
        })"""
    )
    assert overflow["body"] <= overflow["viewport"], overflow
    assert overflow["root"] <= overflow["viewport"], overflow


def assert_key_contrast(page) -> None:
    ratios = page.evaluate(
        """() => {
            const parse = (value) => value.match(/[\\d.]+/g).slice(0, 3).map(Number);
            const luminance = (rgb) => {
                const values = rgb.map((value) => {
                    const channel = value / 255;
                    return channel <= 0.04045
                        ? channel / 12.92
                        : Math.pow((channel + 0.055) / 1.055, 2.4);
                });
                return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2];
            };
            const ratio = (selector) => {
                const style = getComputedStyle(document.querySelector(selector));
                const foreground = luminance(parse(style.color));
                const background = luminance(parse(style.backgroundColor));
                return (Math.max(foreground, background) + 0.05)
                    / (Math.min(foreground, background) + 0.05);
            };
            return {
                shell: ratio('.variant-a'),
                activeNavigation: ratio('.a-rail nav button.active'),
                primaryAction: ratio('.a-import'),
            };
        }"""
    )
    assert ratios["shell"] >= 4.5, ratios
    assert ratios["activeNavigation"] >= 4.5, ratios
    assert ratios["primaryAction"] >= 4.5, ratios


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    problems: list[str] = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True,
            executable_path=edge_path(),
        )
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.on("pageerror", lambda error: problems.append(f"pageerror: {error}"))
        page.on(
            "console",
            lambda message: problems.append(f"console: {message.text}")
            if message.type == "error" and "Failed to load resource" not in message.text
            else None,
        )

        for variant in ("A", "B", "C"):
            page.goto(f"{APP_URL}&variant={variant}", wait_until="networkidle", timeout=60_000)
            page.locator(".prototype-root").wait_for(state="visible")
            assert page.locator(".prototype-switcher").get_by_text(f"{variant} —").count() == 1
            assert_no_horizontal_overflow(page)
            page.screenshot(path=OUTPUT / f"variant-{variant.lower()}-1440x900.png")

        for screen in ("welcome", "empty", "settings", "light", "multi", "brand"):
            page.goto(
                f"{APP_URL}&variant=A&screen={screen}",
                wait_until="networkidle",
                timeout=60_000,
            )
            page.locator(".prototype-root").wait_for(state="visible")
            assert_no_horizontal_overflow(page)
            page.screenshot(path=OUTPUT / f"variant-a-{screen}-1440x900.png")

        page.goto(f"{APP_URL}&variant=A", wait_until="networkidle", timeout=60_000)
        assert_key_contrast(page)
        page.keyboard.press("Tab")
        focus = page.evaluate(
            """() => {
                const style = getComputedStyle(document.activeElement);
                return {
                    tag: document.activeElement.tagName,
                    outlineStyle: style.outlineStyle,
                    outlineWidth: parseFloat(style.outlineWidth),
                };
            }"""
        )
        assert focus["tag"] != "BODY", focus
        assert focus["outlineStyle"] != "none" and focus["outlineWidth"] >= 2, focus

        page.emulate_media(reduced_motion="reduce")
        reduced_motion_seconds = page.evaluate(
            """() => parseFloat(getComputedStyle(
                document.querySelector('.task-spinner')
            ).animationDuration)"""
        )
        assert reduced_motion_seconds <= 0.001, reduced_motion_seconds
        page.emulate_media(reduced_motion="no-preference")

        page.get_by_role("button", name="详情列表").click()
        page.locator(".detail-table").wait_for(state="visible")
        page.locator(".detail-table > button").nth(2).dblclick()
        page.locator(".prototype-lightbox").wait_for(state="visible")
        page.keyboard.press("Escape")
        page.locator(".prototype-lightbox").wait_for(state="detached")

        page.set_viewport_size({"width": 760, "height": 760})
        for variant in ("A", "C"):
            page.goto(f"{APP_URL}&variant={variant}", wait_until="networkidle", timeout=60_000)
            page.locator(".prototype-root").wait_for(state="visible")
            assert_no_horizontal_overflow(page)
            page.screenshot(path=OUTPUT / f"variant-{variant.lower()}-760x760.png")

        browser.close()

    if problems:
        raise AssertionError("\n".join(problems))

    print(f"原型视觉检查通过，截图位于：{OUTPUT}")


if __name__ == "__main__":
    main()
