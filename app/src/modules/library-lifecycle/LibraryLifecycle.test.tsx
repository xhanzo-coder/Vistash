// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";

import { UiProvider } from "../../ui/UiProvider";
import type { LibraryStatus, MigrationProgress, V3MigrationPlan } from "../../shared/types";
import {
  LibraryLifecycle,
  type LibraryLifecyclePort,
  type OpenLibraryContext,
} from "./index";

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

beforeAll(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
});

afterAll(() => {
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function readyStatus(): LibraryStatus {
  return {
    path: "E:\\视觉档案",
    library_id: "018f3c9e-6c00-7000-8000-0000000000aa",
    recorded_path: "E:\\视觉档案",
    problem: null,
  };
}

function port(status: LibraryStatus): LibraryLifecyclePort {
  return {
    status: vi.fn(async () => status),
    pickLibraryDirectory: vi.fn(async () => null),
    open: vi.fn(async () => status),
    migrateLegacy: vi.fn(async (_path: string, _progress: (value: MigrationProgress) => void) => status),
    planV3: vi.fn(async () => ({ entries: [] }) satisfies V3MigrationPlan),
    commitV3: vi.fn(async () => status),
  };
}

function mount(node: ReactNode): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <UiProvider>{node}</UiProvider>
      </QueryClientProvider>,
    );
  });
}

test("兼容库直接产生会话并恢复工作现场，不显示欢迎页", async () => {
  const lifecyclePort = port(readyStatus());
  mount(
    <LibraryLifecycle port={lifecyclePort}>
      {(context: OpenLibraryContext) => (
        <div data-testid="workspace">{context.session.displayName}|{context.path}</div>
      )}
    </LibraryLifecycle>,
  );

  await vi.waitFor(() => {
    expect(container?.querySelector('[data-testid="workspace"]')?.textContent).toBe(
      "视觉档案|E:\\视觉档案",
    );
  });
  expect(container?.textContent).not.toContain("创建新库");
  expect(container?.textContent).not.toContain("打开已有库");
  expect(lifecyclePort.status).toHaveBeenCalledTimes(1);
});

test("首次运行解释本地库语义，创建新库后直接进入图片工作现场", async () => {
  const firstRun: LibraryStatus = {
    path: null,
    library_id: null,
    recorded_path: null,
    problem: null,
  };
  const pickLibraryDirectory = vi.fn(async () => "E:\\新视觉档案");
  const open = vi.fn(async () => ({
    ...readyStatus(),
    path: "E:\\新视觉档案",
    recorded_path: "E:\\新视觉档案",
  }));
  const lifecyclePort: LibraryLifecyclePort = {
    ...port(firstRun),
    pickLibraryDirectory,
    open,
  };
  mount(
    <LibraryLifecycle port={lifecyclePort}>
      {(context) => <div data-testid="workspace">{context.session.displayName}</div>}
    </LibraryLifecycle>,
  );

  await vi.waitFor(() => expect(container?.textContent).toContain("创建新库"));
  expect(container?.textContent).toContain("图片会复制进库");
  expect(container?.textContent).toContain("库会占用磁盘空间");
  expect(container?.textContent).toContain("源文件不会被修改");
  const create = [...(container?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
    (button) => button.textContent === "创建新库",
  );
  await act(async () => create?.click());

  await vi.waitFor(() => expect(container?.querySelector('[data-testid="workspace"]')?.textContent).toBe("新视觉档案"));
  expect(pickLibraryDirectory).toHaveBeenCalledWith("create");
  expect(open).toHaveBeenCalledWith("E:\\新视觉档案");
});

test("上次库路径失效时显示原路径与错误码，并允许重新定位", async () => {
  const missing: LibraryStatus = {
    path: null,
    library_id: null,
    recorded_path: "E:\\已移动的视觉档案",
    problem: { code: "library.path_unreadable", detail: "目录不存在" },
  };
  const pickLibraryDirectory = vi.fn(async () => "F:\\视觉档案");
  const open = vi.fn(async () => ({
    ...readyStatus(),
    path: "F:\\视觉档案",
    recorded_path: "F:\\视觉档案",
  }));
  const lifecyclePort: LibraryLifecyclePort = {
    ...port(missing),
    pickLibraryDirectory,
    open,
  };
  mount(
    <LibraryLifecycle port={lifecyclePort}>
      {(context) => <div data-testid="workspace">{context.path}</div>}
    </LibraryLifecycle>,
  );

  await vi.waitFor(() => expect(container?.textContent).toContain("E:\\已移动的视觉档案"));
  expect(container?.textContent).toContain("library.path_unreadable");
  const relocate = [...(container?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
    (button) => button.textContent === "重新定位该库",
  );
  await act(async () => relocate?.click());

  await vi.waitFor(() => expect(container?.querySelector('[data-testid="workspace"]')?.textContent).toBe("F:\\视觉档案"));
  expect(pickLibraryDirectory).toHaveBeenCalledWith("relocate");
});

test("多归属旧库必须完成唯一文件夹选择并二次确认后才提交", async () => {
  const old: LibraryStatus = {
    path: null,
    library_id: null,
    recorded_path: "E:\\旧视觉档案",
    problem: { code: "library.format_too_old", detail: "需要迁移" },
  };
  const plan: V3MigrationPlan = {
    entries: [
      {
        hash: "a".repeat(64),
        original_filename: "自动归类.png",
        kind: "automatic",
        folder: "参考",
      },
      {
        hash: "b".repeat(64),
        original_filename: "雨夜街道.png",
        kind: "conflict",
        candidates: ["参考", "配色"],
      },
    ],
  };
  const migrateLegacy = vi.fn<LibraryLifecyclePort["migrateLegacy"]>(async (_path, onProgress) => {
    onProgress({ stage: "sidecars_rewritten", done: 2, total: 2, current_filename: "雨夜街道.png" });
    return old;
  });
  const planV3 = vi.fn(async () => plan);
  const commitV3 = vi.fn<LibraryLifecyclePort["commitV3"]>(async (_path, _resolutions, onProgress) => {
    onProgress({ stage: "replaced", done: 2, total: 2, current_filename: "雨夜街道.png" });
    return { ...readyStatus(), path: "E:\\旧视觉档案", recorded_path: "E:\\旧视觉档案" };
  });
  const lifecyclePort: LibraryLifecyclePort = {
    ...port(old),
    migrateLegacy,
    planV3,
    commitV3,
  };
  mount(
    <LibraryLifecycle port={lifecyclePort}>
      {(context) => <div data-testid="workspace">{context.path}</div>}
    </LibraryLifecycle>,
  );

  await vi.waitFor(() => expect(container?.textContent).toContain("准备迁移"));
  const prepare = [...(container?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
    (button) => button.textContent === "准备迁移",
  );
  await act(async () => prepare?.click());
  expect(migrateLegacy).not.toHaveBeenCalled();
  const inspect = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "检查迁移方案",
  );
  await act(async () => inspect?.click());

  await vi.waitFor(() => expect(container?.textContent).toContain("雨夜街道.png"));
  const taskTrigger = container?.querySelector<HTMLButtonElement>('button[aria-label^="任务中心"]');
  if (taskTrigger === null || taskTrigger === undefined) throw new Error("迁移页缺少任务中心入口");
  await act(async () => taskTrigger.click());
  expect(document.body.querySelector('[data-ui="task-center"]')?.textContent).toContain("库迁移");
  const commit = [...(container?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
    (button) => button.textContent === "确认迁移",
  );
  expect(commit?.disabled).toBe(true);
  const choice = container?.querySelector<HTMLInputElement>('input[type="radio"][value="配色"]');
  await act(async () => choice?.click());
  expect(commit?.disabled).toBe(false);
  expect(commitV3).not.toHaveBeenCalled();

  await act(async () => commit?.click());
  const finalConfirm = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "开始迁移",
  );
  await act(async () => finalConfirm?.click());

  await vi.waitFor(() => expect(container?.querySelector('[data-testid="workspace"]')?.textContent).toBe("E:\\旧视觉档案"));
  expect(commitV3).toHaveBeenCalledWith(
    "E:\\旧视觉档案",
    [{ hash: "b".repeat(64), folder: "配色" }],
    expect.any(Function),
  );
});
