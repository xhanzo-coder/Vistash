// @vitest-environment jsdom

import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

import {
  DEFAULT_LIBRARY_LAYOUT,
  DEFAULT_LAYOUT,
  normalizeLayout,
  useLibraryLayout,
} from "./libraryLayout";

const LIBRARY_A = "018f3c9e-6c00-7000-8000-00000000000a";
const LIBRARY_B = "018f3c9e-6c00-7000-8000-00000000000b";

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
});

afterEach(() => {
  clearMocks();
  vi.useRealTimers();
  document.body.replaceChildren();
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

/**
 * 以库 ID 为键的内存版布局仓库，模拟后端 LayoutStore 的合同：read_layout 未保存
 * 返回 null，write_layout 整体覆盖并记录每次写入供断言。
 */
function fakeStore() {
  const saved = new Map<string, unknown>();
  const writes: Array<{ libraryId: string; layout: unknown }> = [];
  mockIPC((command, args) => {
    if (!isRecord(args)) throw new TypeError(`${command} 的参数不是对象`);
    if (command === "read_layout") {
      return saved.get(String(args.libraryId)) ?? null;
    }
    if (command === "write_layout") {
      writes.push({ libraryId: String(args.libraryId), layout: args.layout });
      saved.set(String(args.libraryId), args.layout);
      return null;
    }
    throw new Error(`意外命令 ${command}`);
  });
  return { saved, writes };
}

type LayoutHook = ReturnType<typeof useLibraryLayout>;

/** 裸 createRoot 探针：与其他测试同一套无 testing-library 的挂载方式。 */
function setupHook() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  // 渲染期不写外部变量：hook 值在 effect 里记录，act 之后必然已完成。
  const latest: { hook?: LayoutHook } = {};
  function Probe({ id, section }: { id: string | null; section: "assets" | "prompts" }) {
    const value = useLibraryLayout(id, section);
    useEffect(() => {
      latest.hook = value;
    });
    return null;
  }
  return {
    current: () => {
      if (latest.hook === undefined) throw new Error("探针尚未完成首次渲染");
      return latest.hook;
    },
    render: (id: string | null, section: "assets" | "prompts" = "assets") =>
      act(async () => {
        root.render(<Probe id={id} section={section} />);
      }),
    unmount: () =>
      act(() => {
        root.unmount();
      }),
  };
}

test("normalizeLayout 把任意保存值安全合并到默认值上", () => {
  // 从未保存或完全不是对象：整份默认。
  expect(normalizeLayout(null)).toEqual(DEFAULT_LAYOUT);
  expect(normalizeLayout(42)).toEqual(DEFAULT_LAYOUT);
  expect(normalizeLayout(["view"])).toEqual(DEFAULT_LAYOUT);

  // 部分保存：合法字段生效，缺的字段补默认；标签去重保序。
  expect(
    normalizeLayout({
      view: "list",
      tags: ["夜景", "夜景", "人像"],
      scrollOffsets: { "assets-waterfall": 1240.5 },
    }),
  ).toEqual({
    ...DEFAULT_LAYOUT,
    view: "list",
    tags: ["夜景", "人像"],
    scrollOffsets: { "assets-waterfall": 1240.5 },
  });

  // 逐字段非法值各自回退，不让一个坏字段拖垮整份布局。
  expect(
    normalizeLayout({
      view: "gallery",
      favorite: "yes",
      folder: { kind: "path" },
      scrollOffsets: { a: "高", b: -1, c: Number.POSITIVE_INFINITY, d: 8 },
    }),
  ).toEqual({
    ...DEFAULT_LAYOUT,
    scrollOffsets: { d: 8 },
  });

  // 合法的 path 文件夹与二值收藏原样保留。
  expect(
    normalizeLayout({ folder: { kind: "root" }, favorite: true }),
  ).toEqual({
    ...DEFAULT_LAYOUT,
    folder: { kind: "root" },
    favorite: true,
  });
});

test("持久化布局为图片与提示词保存彼此独立的完整状态", () => {
  expect(DEFAULT_LIBRARY_LAYOUT).toEqual({
    assets: DEFAULT_LAYOUT,
    prompts: DEFAULT_LAYOUT,
  });
});

test("每个工作台 section 保存查询、栏宽与折叠状态", () => {
  expect(DEFAULT_LAYOUT).toMatchObject({
    text: "",
    location: "active",
    railWidth: 240,
    inspectorWidth: 300,
    railCollapsed: false,
    inspectorCollapsed: false,
  });
});

test("同一库按素材 section 读取各自的视图与筛选", async () => {
  const store = fakeStore();
  store.saved.set(LIBRARY_A, {
    assets: { ...DEFAULT_LAYOUT, view: "list", tags: ["图片"] },
    prompts: { ...DEFAULT_LAYOUT, folder: { kind: "path", path: "人像" }, tags: ["提示词"] },
  });
  const hook = setupHook();
  await hook.render(LIBRARY_A, "prompts");

  expect(hook.current().layout).toEqual({
    ...DEFAULT_LAYOUT,
    folder: { kind: "path", path: "人像" },
    tags: ["提示词"],
  });
  hook.unmount();
});

test("快速切换 section 会等待前一份整表写入并保留两侧最新状态", async () => {
  vi.useFakeTimers();
  let stored: unknown = {
    assets: DEFAULT_LAYOUT,
    prompts: DEFAULT_LAYOUT,
  };
  const firstWrite = deferred<void>();
  const writes: unknown[] = [];
  let writeCount = 0;
  mockIPC((command, args) => {
    if (!isRecord(args)) throw new TypeError(`${command} 的参数不是对象`);
    if (command === "read_layout") return stored;
    if (command === "write_layout") {
      writeCount += 1;
      const value = args.layout;
      writes.push(value);
      if (writeCount === 1) {
        return firstWrite.promise.then(() => {
          stored = value;
          return undefined;
        });
      }
      stored = value;
      return undefined;
    }
    throw new Error(`意外命令 ${command}`);
  });

  const assets = setupHook();
  await assets.render(LIBRARY_A, "assets");
  act(() => assets.current().update({ view: "list" }));
  assets.unmount();

  const prompts = setupHook();
  await prompts.render(LIBRARY_A, "prompts");
  expect(prompts.current().ready).toBe(false);
  act(() => prompts.current().update({ tags: ["提示词"] }));
  await act(async () => vi.advanceTimersByTime(300));

  firstWrite.resolve();
  await act(async () => Promise.resolve());
  expect(prompts.current().ready).toBe(true);

  const latest = writes.at(-1);
  if (!isRecord(latest) || !isRecord(latest.assets) || !isRecord(latest.prompts)) {
    throw new TypeError("布局写入缺少双 section");
  }
  expect(latest.assets.view).toBe("list");
  expect(latest.prompts.tags).toEqual(["提示词"]);
  prompts.unmount();
});

test("从未保存过的库读取后得到默认布局", async () => {
  const store = fakeStore();
  const hook = setupHook();
  await hook.render(LIBRARY_A);

  expect(hook.current().ready).toBe(true);
  expect(hook.current().problem).toBeNull();
  expect(hook.current().layout).toEqual(DEFAULT_LAYOUT);
  expect(store.writes).toEqual([]);
  hook.unmount();
});

test("update 防抖合并：连续多次调整只写最后一次的完整 JSON", async () => {
  vi.useFakeTimers();
  const store = fakeStore();
  const hook = setupHook();
  await hook.render(LIBRARY_A);

  act(() => hook.current().update({ view: "list" }));
  act(() => hook.current().update({ tags: ["夜景"] }));
  expect(store.writes).toEqual([]);

  await act(async () => {
    vi.advanceTimersByTime(300);
  });

  expect(store.writes).toEqual([
    {
      libraryId: LIBRARY_A,
      layout: {
        assets: { ...DEFAULT_LAYOUT, view: "list", tags: ["夜景"] },
        prompts: DEFAULT_LAYOUT,
      },
    },
  ]);
  hook.unmount();
});

test("切换库时旧库的待写先落盘，新库读到自己的偏好", async () => {
  vi.useFakeTimers();
  const store = fakeStore();
  const hook = setupHook();
  await hook.render(LIBRARY_A);

  act(() => hook.current().update({ favorite: true }));
  // 不等防抖到期直接切到 B：A 的最后一次调整必须先落盘。
  await hook.render(LIBRARY_B);

  expect(
    store.writes.some(
      (write) =>
        write.libraryId === LIBRARY_A &&
        isRecord(write.layout) &&
        isRecord(write.layout.assets) &&
        write.layout.assets.favorite === true,
    ),
  ).toBe(true);
  // B 是另一个库：读不到 A 的收藏偏好，也不该把 A 的值写进 B。
  expect(hook.current().layout.favorite).toBeNull();
  expect(store.writes.some((write) => write.libraryId === LIBRARY_B)).toBe(false);
  hook.unmount();
});

test("库目录移动后同一 library_id 仍恢复布局偏好", async () => {
  // 验收核心（任务 8.3）：偏好的键是库身份而非路径。真实场景里库目录从旧路径
  // 搬到新路径，library.json 里的 ID 不变；mock 仓库只认 ID——"路径不参与键"
  // 正是这条恢复语义的结构本身。
  vi.useFakeTimers();
  const store = fakeStore();

  const firstSession = setupHook();
  await firstSession.render(LIBRARY_A);
  act(() =>
    firstSession.current().update({
      view: "list",
      folder: { kind: "path", path: "人物" },
    }),
  );
  await act(async () => {
    vi.advanceTimersByTime(300);
  });
  firstSession.unmount();

  // 第二次会话：库已在新路径打开，但 ID 相同。
  const secondSession = setupHook();
  await secondSession.render(LIBRARY_A);

  expect(secondSession.current().layout).toEqual({
    ...DEFAULT_LAYOUT,
    view: "list",
    folder: { kind: "path", path: "人物" },
  });
  secondSession.unmount();
  expect(store.writes).toHaveLength(1);
});

test("读取失败呈现 problem 且布局停在默认值", async () => {
  mockIPC((command) => {
    if (command === "read_layout") {
      throw new TypeError("布局文件损坏");
    }
    throw new Error(`意外命令 ${command}`);
  });
  const hook = setupHook();
  await hook.render(LIBRARY_A);

  // 损坏报告不静默重置：错误必须可见，但工作台照常以默认布局可用。
  expect(hook.current().ready).toBe(true);
  expect(hook.current().problem).not.toBeNull();
  expect(hook.current().layout).toEqual(DEFAULT_LAYOUT);
  hook.unmount();
});

test("写入失败呈现 problem，不影响界面状态", async () => {
  vi.useFakeTimers();
  mockIPC((command, args) => {
    if (!isRecord(args)) throw new TypeError(`${command} 的参数不是对象`);
    if (command === "read_layout") return null;
    if (command === "write_layout") throw new TypeError("布局目录不可写");
    throw new Error(`意外命令 ${command}`);
  });
  const hook = setupHook();
  await hook.render(LIBRARY_A);

  act(() => hook.current().update({ view: "list" }));
  await act(async () => {
    vi.advanceTimersByTime(300);
  });

  // 界面状态已更新（本会话内生效），保存失败单独可见。
  expect(hook.current().layout.view).toBe("list");
  expect(hook.current().problem).not.toBeNull();
  hook.unmount();
});

test("未选择库时不发起读写，update 只改本地状态", async () => {
  vi.useFakeTimers();
  const store = fakeStore();
  const hook = setupHook();
  await hook.render(null);

  expect(hook.current().ready).toBe(false);
  act(() => hook.current().update({ view: "list" }));
  await act(async () => {
    vi.advanceTimersByTime(300);
  });

  expect(hook.current().layout.view).toBe("list");
  expect(store.writes).toEqual([]);
  hook.unmount();
});
