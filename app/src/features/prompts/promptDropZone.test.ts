// @vitest-environment jsdom

import { afterEach, beforeEach, expect, test } from "vitest";

import type { FileDragEvent } from "../../shared/ipc";
import {
  handleFileDragEvent,
  promptDropClaimsLatestPoint,
  setPromptDropZone,
  subscribePromptDropHover,
  type PromptDropZoneRegistration,
} from "./promptDropZone";

/** 在指定位置合成一个 100×60 的目标矩形。 */
function rectAt(x: number, y: number): DOMRect {
  return {
    x,
    y,
    width: 100,
    height: 60,
    top: y,
    left: x,
    right: x + 100,
    bottom: y + 60,
    toJSON: () => ({}),
  };
}

let registration: PromptDropZoneRegistration | null = null;

function register(rect: DOMRect, drops: string[][]): void {
  registration = {
    rect: () => rect,
    drop: (paths) => {
      drops.push(paths);
    },
  };
  setPromptDropZone(registration);
}

beforeEach(() => {
  // jsdom 的 devicePixelRatio 恒为 1：物理坐标即逻辑坐标。
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 1 });
});

afterEach(() => {
  setPromptDropZone(null);
  registration = null;
});

test("悬停命中切换高亮，离开与未命中都复位", () => {
  const drops: string[][] = [];
  register(rectAt(0, 0), drops);
  const seen: boolean[] = [];
  const unsubscribe = subscribePromptDropHover((hovering) => seen.push(hovering));

  handleFileDragEvent({ type: "enter", paths: ["E:\\a.png"], x: 50, y: 30 });
  handleFileDragEvent({ type: "move", paths: ["E:\\a.png"], x: 80, y: 40 });
  expect(seen).toEqual([false, true]);

  // 拖出目标范围：高亮复位。
  handleFileDragEvent({ type: "move", paths: ["E:\\a.png"], x: 500, y: 400 });
  expect(seen.at(-1)).toBe(false);

  // 回到范围内再离开窗口：同样复位。
  handleFileDragEvent({ type: "move", paths: ["E:\\a.png"], x: 10, y: 10 });
  handleFileDragEvent({ type: "leave" });
  expect(seen.at(-1)).toBe(false);
  expect(promptDropClaimsLatestPoint()).toBe(false);

  unsubscribe();
});

test("落点命中才把路径交给关联区，未命中不认领", () => {
  const drops: string[][] = [];
  register(rectAt(0, 0), drops);

  handleFileDragEvent({ type: "move", paths: ["E:\\a.png"], x: 50, y: 30 });
  handleFileDragEvent({
    type: "drop",
    paths: ["E:\\a.png", "E:\\b.png"],
    x: 50,
    y: 30,
  });
  expect(drops).toEqual([["E:\\a.png", "E:\\b.png"]]);

  // 移出后落下：关联区不认领，App 的默认导入语义保留。
  handleFileDragEvent({ type: "move", paths: ["E:\\a.png"], x: 900, y: 700 });
  handleFileDragEvent({ type: "drop", paths: ["E:\\a.png"], x: 900, y: 700 });
  expect(drops).toHaveLength(1);
  expect(promptDropClaimsLatestPoint()).toBe(false);
});

test("App 的认领查询只读最新落点，与事件触发顺序无关", () => {
  const drops: string[][] = [];
  register(rectAt(0, 0), drops);

  // 尚无任何拖动事件：不认领。
  expect(promptDropClaimsLatestPoint()).toBe(false);

  handleFileDragEvent({ type: "move", paths: ["E:\\a.png"], x: 20, y: 20 });
  // 即使关联区自己的 drop 处理器还没跑，App 也能先查到同一份落点快照。
  expect(promptDropClaimsLatestPoint()).toBe(true);

  handleFileDragEvent({ type: "drop", paths: ["E:\\a.png"], x: 20, y: 20 });
  expect(drops).toEqual([["E:\\a.png"]]);
});

test("注销后一切落点都回到默认导入语义", () => {
  const drops: string[][] = [];
  register(rectAt(0, 0), drops);
  handleFileDragEvent({ type: "move", paths: ["E:\\a.png"], x: 10, y: 10 });
  expect(promptDropClaimsLatestPoint()).toBe(true);

  setPromptDropZone(null);
  expect(promptDropClaimsLatestPoint()).toBe(false);
  // 注销后事件不再产生高亮或路由。
  const seen: boolean[] = [];
  subscribePromptDropHover((hovering) => seen.push(hovering));
  handleFileDragEvent({ type: "enter", paths: [], x: 10, y: 10 });
  expect(seen).toEqual([false]);
});

test("devicePixelRatio 参与命中换算", () => {
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
  const drops: string[][] = [];
  register(rectAt(0, 0), drops);

  // 物理坐标 (150, 50) = 逻辑 (75, 25)，落在 100×60 的矩形内。
  const event: FileDragEvent = {
    type: "move",
    paths: ["E:\\a.png"],
    x: 150,
    y: 50,
  };
  handleFileDragEvent(event);
  expect(promptDropClaimsLatestPoint()).toBe(true);

  // 物理 (250, 50) = 逻辑 (125, 25)：超出右边界。
  handleFileDragEvent({ type: "move", paths: ["E:\\a.png"], x: 250, y: 50 });
  expect(promptDropClaimsLatestPoint()).toBe(false);
});
