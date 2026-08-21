// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test } from "vitest";

import { WorkspaceTopBar, type WorkspaceSection } from "./WorkspaceTopBar";

afterEach(() => {
  document.body.replaceChildren();
});

function renderTopBar(
  section: WorkspaceSection,
  onSectionChange: (next: WorkspaceSection) => void,
): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <WorkspaceTopBar
        section={section}
        onSectionChange={onSectionChange}
        // JSX 属性字符串不处理反斜杠转义，含反斜杠的 Windows 路径必须走表达式。
        libraryPath={"E:\\素材库"}
      />,
    );
  });
  return container;
}

function buttonWithText(container: ParentNode, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (button === undefined) throw new Error(`缺少按钮：${text}`);
  return button;
}

test("顶栏是一行紧凑 banner，双库入口以 aria-current 区分当前库", () => {
  const container = renderTopBar("assets", () => {});

  const banner = container.querySelector("header");
  if (banner === null) throw new Error("缺少 banner 顶栏");
  expect(banner.className).toContain("topbar");

  const assets = buttonWithText(container, "素材");
  const prompts = buttonWithText(container, "提示词库");
  expect(assets.getAttribute("aria-current")).toBe("page");
  expect(prompts.getAttribute("aria-current")).toBeNull();
  // 两个一级入口属于同一导航地标，屏幕阅读器才能把它们读成一组切换项。
  expect(assets.closest("nav")?.getAttribute("aria-label")).toBe("主导航");
});

test("点击另一库入口回调对应的 section", () => {
  const received: WorkspaceSection[] = [];
  const container = renderTopBar("assets", (next) => received.push(next));

  act(() => {
    buttonWithText(container, "提示词库").click();
  });
  act(() => {
    buttonWithText(container, "素材").click();
  });

  expect(received).toEqual(["prompts", "assets"]);
});

test("切换后 aria-current 跟随当前库，库路径始终可见", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const rerender = (section: WorkspaceSection) => {
    act(() => {
      root.render(
        <WorkspaceTopBar
          section={section}
          onSectionChange={() => {}}
          libraryPath={"E:\\素材库"}
        />,
      );
    });
  };

  rerender("assets");
  expect(buttonWithText(container, "素材").getAttribute("aria-current")).toBe("page");
  rerender("prompts");
  expect(buttonWithText(container, "素材").getAttribute("aria-current")).toBeNull();
  expect(buttonWithText(container, "提示词库").getAttribute("aria-current")).toBe("page");

  const library = container.querySelector(".topbar-library");
  if (library === null) throw new Error("缺少库路径指示");
  expect(library.textContent).toContain("E:\\素材库");

  // 品牌名是顶栏里唯一的 h1：紧凑不等于失去页面主标题。
  const brand = container.querySelector("h1");
  if (brand === null) throw new Error("顶栏缺少 h1 品牌");
  expect(brand.textContent).toContain("Vistash");
});
