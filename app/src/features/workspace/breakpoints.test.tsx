// @vitest-environment jsdom

import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { BREAKPOINTS, useWindowTier, type WindowTier } from "./breakpoints";

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

type TierHook = WindowTier;

/** matchMedia 桩：记录各查询注册的 change 监听，供测试手动触发。 */
function stubMatchMedia() {
  const listeners = new Map<string, Set<(event: { matches: boolean }) => void>>();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: (_type: string, cb: (event: { matches: boolean }) => void) => {
        const set = listeners.get(query) ?? new Set();
        set.add(cb);
        listeners.set(query, set);
      },
      removeEventListener: (_type: string, cb: (event: { matches: boolean }) => void) => {
        listeners.get(query)?.delete(cb);
      },
    }),
  });
  return {
    fire(query: string, matches: boolean) {
      act(() => {
        for (const cb of listeners.get(query) ?? []) cb({ matches });
      });
    },
    count(query: string) {
      return listeners.get(query)?.size ?? 0;
    },
  };
}

function setWindowWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
}

/** 裸 createRoot 探针：与其他测试同一套无 testing-library 的挂载方式。 */
function setupHook() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const latest: { tier?: TierHook } = {};
  function Probe() {
    const tier = useWindowTier();
    useEffect(() => {
      latest.tier = tier;
    });
    return null;
  }
  return {
    current: () => {
      if (latest.tier === undefined) throw new Error("探针尚未完成首次渲染");
      return latest.tier;
    },
    render: () =>
      act(async () => {
        root.render(<Probe />);
      }),
    unmount: () =>
      act(() => {
        root.unmount();
      }),
  };
}

test("初始层级取自当前窗口宽度", async () => {
  stubMatchMedia();

  setWindowWidth(BREAKPOINTS.medium + 1);
  const wide = setupHook();
  await wide.render();
  expect(wide.current()).toBe("wide");
  wide.unmount();

  setWindowWidth(BREAKPOINTS.medium);
  const medium = setupHook();
  await medium.render();
  expect(medium.current()).toBe("medium");
  medium.unmount();

  setWindowWidth(BREAKPOINTS.narrow);
  const narrow = setupHook();
  await narrow.render();
  expect(narrow.current()).toBe("narrow");
  narrow.unmount();
});

test("媒体查询变化驱动层级更新，卸载后移除监听", async () => {
  const media = stubMatchMedia();
  setWindowWidth(1400);
  const hook = setupHook();
  await hook.render();
  expect(hook.current()).toBe("wide");
  // 两条断点查询都已注册监听。
  expect(media.count(`(max-width: ${BREAKPOINTS.medium}px)`)).toBe(1);
  expect(media.count(`(max-width: ${BREAKPOINTS.narrow}px)`)).toBe(1);

  // 用户把窗口拖窄跨过 1080：进入中档（真实浏览器里查询翻转时视口宽度已变）。
  setWindowWidth(1000);
  media.fire(`(max-width: ${BREAKPOINTS.medium}px)`, true);
  expect(hook.current()).toBe("medium");

  // 继续跨过 720：进入窄档。
  setWindowWidth(680);
  media.fire(`(max-width: ${BREAKPOINTS.narrow}px)`, true);
  expect(hook.current()).toBe("narrow");

  // 拖回宽屏：恢复宽档。
  setWindowWidth(1400);
  media.fire(`(max-width: ${BREAKPOINTS.narrow}px)`, false);
  media.fire(`(max-width: ${BREAKPOINTS.medium}px)`, false);
  expect(hook.current()).toBe("wide");

  hook.unmount();
  expect(media.count(`(max-width: ${BREAKPOINTS.medium}px)`)).toBe(0);
  expect(media.count(`(max-width: ${BREAKPOINTS.narrow}px)`)).toBe(0);
});

test("断点常量与 styles.css 的媒体查询保持同步", () => {
  // 钩子与样式表各自持有断点数值，这里把它们钉在一起：改一处不改另一处会在此失败。
  const css = readFileSync(join(import.meta.dirname, "..", "..", "styles.css"), "utf8");
  expect(css).toContain(`(max-width: ${BREAKPOINTS.medium}px)`);
  expect(css).toContain(`(max-width: ${BREAKPOINTS.narrow}px)`);
});
