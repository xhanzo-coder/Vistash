// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

import type { AssetRow } from "../../shared/types";
import { AssetPreview } from "./AssetPreview";

const ASSET: AssetRow = {
  hash: "a".repeat(64),
  hash_algo: "sha256",
  media_type: "png",
  ext: "png",
  byte_size: 68,
  width: 1,
  height: 1,
  imported_at: "2026-08-19T00:00:00Z",
  original_filename: "acceptance-sample.png",
  display_filename: "acceptance-sample.png",
  source_path: null,
  deleted_at: null,
  color_card_status: "ok",
  color_card_algo_version: 1,
  color_card_failure_reason: null,
  color_card_sampled_pixel_count: 1,
  note: "",
  favorite: false,
  tags: [],
  folder: null,
  colors: [
    {
      hex: "#ff0000",
      oklab_l: 0.6279,
      oklab_a: 0.2249,
      oklab_b: 0.1258,
      share: 1,
      role: "dominant",
    },
  ],
};

let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => "blob:original"),
    revokeObjectURL: vi.fn(),
  });
  writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});

afterEach(() => {
  clearMocks();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.deleteProperty(navigator, "clipboard");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

test("单图预览呈现原图和色卡并复制 HEX", async () => {
  mockIPC((command) => {
    if (command !== "asset_original") {
      throw new Error(`未预期的 IPC 命令：${command}`);
    }
    return new ArrayBuffer(8);
  });

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(<AssetPreview asset={ASSET} onClose={vi.fn()} />);
    await Promise.resolve();
  });

  const image = container.querySelector<HTMLImageElement>(
    'img[alt="acceptance-sample.png"]',
  );
  expect(image?.src).toBe("blob:original");
  expect(container.textContent).toContain("色卡");
  expect(container.textContent).toContain("#ff0000");

  const colorButton = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("#ff0000"),
  );
  if (colorButton === undefined) {
    throw new Error("色卡复制按钮不存在");
  }

  await act(async () => {
    colorButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });

  expect(writeText).toHaveBeenCalledExactlyOnceWith("#ff0000");
  expect(container.textContent).toContain("已复制");

  await act(async () => {
    root.unmount();
  });
});
