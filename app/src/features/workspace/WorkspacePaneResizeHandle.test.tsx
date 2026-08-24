// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

import { WorkspacePaneResizeHandle } from "./WorkspacePaneResizeHandle";

afterEach(() => {
  document.body.replaceChildren();
});

test("栏位分隔器支持键盘调整并公开当前宽度", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onResize = vi.fn<(width: number) => void>();
  await act(async () => {
    root.render(
      <WorkspacePaneResizeHandle
        side="start"
        label="调整分类栏宽度"
        width={240}
        min={180}
        max={420}
        onResize={onResize}
      />,
    );
  });

  const handle = container.querySelector<HTMLElement>('[role="separator"]');
  if (handle === null) throw new Error("缺少栏位分隔器");
  expect(handle.getAttribute("aria-valuenow")).toBe("240");
  await act(async () => handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));

  expect(onResize).toHaveBeenCalledExactlyOnceWith(256);
  await act(async () => root.unmount());
});
