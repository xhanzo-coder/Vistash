// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

import type { AssetRow } from "../../shared/types";
import { AssetGrid } from "./AssetGrid";

const ASSET: AssetRow = {
  hash: "a".repeat(64),
  hash_algo: "sha256",
  media_type: "jpeg",
  ext: "jpg",
  byte_size: 1024,
  width: 736,
  height: 1288,
  imported_at: "2026-08-19T00:00:00Z",
  original_filename: "pinterest_001.jpg",
  source_path: null,
  deleted_at: null,
  color_card_status: "ok",
  color_card_algo_version: 1,
  color_card_failure_reason: null,
  color_card_sampled_pixel_count: 100,
  note: "",
  favorite: false,
  tags: [],
  folders: [],
  colors: [],
};

let intersectionCallback: IntersectionObserverCallback | null;
let observedElement: Element | null;
let observerInstances: ControlledIntersectionObserver[];

class ControlledIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin: string;
  readonly scrollMargin = "0px";
  readonly thresholds = [0];

  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    intersectionCallback = callback;
    this.rootMargin = options?.rootMargin ?? "0px";
    observerInstances.push(this);
  }

  disconnect(): void {}

  observe(target: Element): void {
    observedElement = target;
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  unobserve(): void {}
}

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  intersectionCallback = null;
  observedElement = null;
  observerInstances = [];
  vi.stubGlobal("IntersectionObserver", ControlledIntersectionObserver);
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => "blob:thumbnail"),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  clearMocks();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function required<T>(value: T | null | undefined, name: string): T {
  if (value === null || value === undefined) {
    throw new Error(`${name} 未由组件建立`);
  }
  return value;
}

test("离屏素材接近视口前不请求缩略图", async () => {
  const commands: string[] = [];
  mockIPC((command) => {
    commands.push(command);
    return new ArrayBuffer(8);
  });

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(<AssetGrid assets={[ASSET]} onSelect={vi.fn()} />);
  });

  expect(commands).toEqual([]);
  expect(observedElement).not.toBeNull();
  expect(intersectionCallback).not.toBeNull();
  expect(observerInstances).toHaveLength(1);

  const target = required(observedElement, "被观察元素");
  const observer = required(observerInstances[0], "IntersectionObserver");
  const callback = required(intersectionCallback, "IntersectionObserver callback");
  await act(async () => {
    callback(
      [
        {
          boundingClientRect: target.getBoundingClientRect(),
          intersectionRatio: 1,
          intersectionRect: target.getBoundingClientRect(),
          isIntersecting: true,
          rootBounds: null,
          target,
          time: 0,
        },
      ],
      observer,
    );
    await Promise.resolve();
  });

  expect(commands).toEqual(["asset_thumbnail"]);

  await act(async () => {
    root.unmount();
  });
});
