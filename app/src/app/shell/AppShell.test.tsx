// @vitest-environment jsdom

import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import { createWorkspaceNavigation } from "../navigation";
import { createTaskCenterStore } from "../taskCenterStore";
import { parseLibraryId } from "../common";
import { UiProvider } from "../../ui/UiProvider";
import { ThemeProvider } from "../../ui/theme/ThemeProvider";
import { createThemeController } from "../../ui/theme/theme";
import type { GlobalSearch } from "../globalSearch";
import { AppShell } from "./AppShell";
import type { GlobalSearchResult, PromptRow } from "../../shared/types";

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
  document.body.querySelectorAll('[role="dialog"], [role="menu"], [data-ui="popover"]').forEach((node) => node.remove());
  root = null;
  container = null;
});

function mount(node: ReactNode): void {
  const media = {
    matches: true,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const storage = {
    getItem: () => "dark",
    setItem: () => {},
  };
  const theme = createThemeController({
    root: document.documentElement,
    media,
    storage,
    updateThemeColor: () => {},
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <ThemeProvider controller={theme}>
        <UiProvider>{node}</UiProvider>
      </ThemeProvider>,
    );
  });
}

function shell(overrides: Partial<ComponentProps<typeof AppShell>> = {}): ReactNode {
  const navigation = createWorkspaceNavigation();
  const globalSearch: GlobalSearch = { run: async () => ({ assets: [], prompts: [] }) };
  return (
    <AppShell
      navigation={navigation}
      globalSearch={globalSearch}
      taskCenter={createTaskCenterStore()}
      library={{
        id: parseLibraryId("018f3c9e-6c00-7000-8000-0000000000aa"),
        displayName: "视觉档案",
        path: "E:\\视觉档案",
        formatVersion: 3,
      }}
      appVersion="0.1.0"
      onImportImages={() => {}}
      onImportFolder={() => {}}
      onOpenOtherLibrary={() => {}}
      assets={<div data-testid="assets-workspace">图片工作区</div>}
      prompts={<div data-testid="prompts-workspace">提示词工作区</div>}
      {...overrides}
    />
  );
}

function promptResult(): PromptRow {
  return {
    id: "018f3c9e-6c00-7000-8000-000000000001",
    body: "电影感逆光，低饱和冷色调",
    title: "雨夜构图提示词",
    model: null,
    parameters: null,
    note: "",
    favorite: false,
    folders: [],
    tags: ["电影感"],
    linked_image_hashes: [],
    cover_image_hash: null,
    resolved_cover_hash: null,
    created_at: "2026-08-27T00:00:00Z",
    updated_at: "2026-08-27T00:00:00Z",
    deleted_at: null,
  };
}

function setInputValue(input: HTMLInputElement, value: string): void {
  // oxlint-disable-next-line typescript/unbound-method -- React 的受控输入测试必须调用原生 value setter；Reflect.apply 显式提供 this。
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter === undefined) throw new Error("测试环境缺少 HTMLInputElement.value setter");
  Reflect.apply(setter, input, [value]);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("AppShell 一级工作区", () => {
  test("两个工作区始终挂载，切换只改变可见性并同步导航 seam", () => {
    const navigation = createWorkspaceNavigation();
    mount(shell({ navigation }));

    const assets = container?.querySelector<HTMLElement>('[data-workspace="assets"]');
    const prompts = container?.querySelector<HTMLElement>('[data-workspace="prompts"]');
    expect(assets?.hidden).toBe(false);
    expect(prompts?.hidden).toBe(true);

    act(() => {
      container?.querySelector<HTMLButtonElement>('button[aria-label="提示词"]')?.click();
    });

    expect(navigation.active).toBe("prompts");
    expect(container?.querySelector('[data-workspace="assets"]')).toBe(assets);
    expect(container?.querySelector('[data-workspace="prompts"]')).toBe(prompts);
    expect(assets?.hidden).toBe(true);
    expect(prompts?.hidden).toBe(false);
    expect(container?.querySelector('button[aria-label="提示词"]')?.getAttribute("aria-current")).toBe("page");
  });
});

describe("AppShell 全局搜索", () => {
  test("Ctrl+K 打开跨库搜索，选择提示词结果后经导航 seam 定位", async () => {
    const navigation = createWorkspaceNavigation();
    const run = vi.fn<(text: string) => Promise<GlobalSearchResult>>(async () => ({
      assets: [],
      prompts: [promptResult()],
    }));
    mount(shell({ navigation, globalSearch: { run } }));

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ctrlKey: true, key: "k" }));
    });
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.textContent).toContain("搜索全部素材");
    const input = dialog?.querySelector<HTMLInputElement>('input[type="search"]');
    if (input === undefined || input === null) throw new Error("全局搜索缺少输入框");

    await act(async () => setInputValue(input, "电影感"));
    // 请求开始不等于结果已提交到 DOM；把防抖及异步结果更新一并交给 act 冲刷。
    await act(async () => {
      await vi.waitFor(() => expect(run).toHaveBeenCalledWith("电影感"));
    });
    const result = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.includes("雨夜构图提示词"),
    );
    expect(result).toBeDefined();
    await act(async () => result?.click());

    expect(navigation.active).toBe("prompts");
    expect(navigation.entryFor("prompts")).toMatchObject({
      kind: "locate_prompt",
      promptId: "018f3c9e-6c00-7000-8000-000000000001",
    });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe("AppShell 导入入口", () => {
  test("顶栏明确区分导入图片与导入文件夹，并转交各自意图", async () => {
    const onImportImages = vi.fn<() => void>();
    const onImportFolder = vi.fn<() => void>();
    mount(shell({ onImportImages, onImportFolder }));

    const trigger = container?.querySelector<HTMLButtonElement>('button[aria-label="导入"]');
    trigger?.focus();
    await act(async () => {
      trigger?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));
    });
    const imageItem = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent?.includes("导入图片"),
    );
    const folderItem = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent?.includes("导入文件夹"),
    );
    expect(imageItem).toBeDefined();
    expect(folderItem).toBeDefined();

    await act(async () => imageItem?.click());
    expect(onImportImages).toHaveBeenCalledTimes(1);
    expect(onImportFolder).not.toHaveBeenCalled();

    await act(async () => {
      trigger?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));
    });
    const reopenedFolderItem = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent?.includes("导入文件夹"),
    );
    await act(async () => reopenedFolderItem?.click());
    expect(onImportFolder).toHaveBeenCalledTimes(1);
  });
});

describe("AppShell 任务中心", () => {
  test("顶栏聚合运行任务，关闭详情不会停止或移除任务", async () => {
    const taskCenter = createTaskCenterStore();
    const registration = taskCenter.register({
      kind: "import",
      title: "导入参考图片",
      libraryId: "018f3c9e-6c00-7000-8000-0000000000aa",
      stoppable: true,
      concurrencyKey: "library:018f3c9e-6c00-7000-8000-0000000000aa:transfer",
    });
    if (registration.kind !== "registered") throw new Error("任务注册失败");
    taskCenter.reportProgress(registration.record.id, {
      kind: "transfer",
      done: 42,
      total: 100,
      currentFilename: "雨夜街道.png",
    });
    mount(shell({ taskCenter }));

    const trigger = container?.querySelector<HTMLButtonElement>('button[aria-label="任务中心，1 个运行中"]');
    expect(trigger).not.toBeNull();
    await act(async () => trigger?.click());
    const popover = document.body.querySelector('[data-ui="task-center"]');
    expect(popover?.textContent).toContain("导入参考图片");
    expect(popover?.textContent).toContain("42%");
    expect(popover?.textContent).toContain("雨夜街道.png");

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    });
    expect(taskCenter.snapshot()).toHaveLength(1);
    expect(taskCenter.snapshot()[0]?.state).toBe("running");
  });
});

describe("AppShell 设置", () => {
  test("设置只呈现真实能力，主题立即切换且素材库入口转交切库意图", async () => {
    const onOpenOtherLibrary = vi.fn<() => void>();
    mount(shell({ onOpenOtherLibrary }));

    const settings = container?.querySelector<HTMLButtonElement>('button[aria-label="设置"]');
    await act(async () => settings?.click());
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.textContent).toContain("外观");
    expect(dialog?.textContent).toContain("素材库");
    expect(dialog?.textContent).toContain("快捷键");
    expect(dialog?.textContent).toContain("关于");
    expect(dialog?.textContent).not.toContain("Provider");
    expect(dialog?.textContent).not.toContain("API Key");
    expect(dialog?.textContent).not.toContain("云同步");

    const group = dialog?.querySelector<HTMLElement>('[role="radiogroup"][aria-label="主题"]');
    if (group === undefined || group === null) throw new Error("设置缺少主题单选组");
    const radios = [...group.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios).toHaveLength(3);
    expect(new Set(radios.map((radio) => radio.name)).size).toBe(1);
    expect(radios.every((radio) => radio.name.length > 0)).toBe(true);
    expect(radios.filter((radio) => radio.checked).map((radio) => radio.value)).toEqual(["dark"]);
    expect(radios.filter((radio) => radio.tabIndex === 0).map((radio) => radio.value)).toEqual(["dark"]);
    const light = group.querySelector<HTMLInputElement>('input[value="light"]');
    if (light === null) throw new Error("设置缺少浅色单选控件");
    expect(light.labels?.[0]?.textContent).toBe("浅色");
    await act(async () => light.click());
    expect(radios.filter((radio) => radio.checked).map((radio) => radio.value)).toEqual(["light"]);
    expect(radios.filter((radio) => radio.tabIndex === 0).map((radio) => radio.value)).toEqual(["light"]);
    expect(document.documentElement.dataset.theme).toBe("light");

    const libraryTab = [...(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
      (button) => button.textContent === "素材库",
    );
    await act(async () => libraryTab?.click());
    expect(dialog?.textContent).toContain("E:\\视觉档案");
    expect(dialog?.textContent).toContain("格式版本 3");
    const openOther = [...(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
      (button) => button.textContent === "打开其他库",
    );
    await act(async () => openOther?.click());
    expect(onOpenOtherLibrary).toHaveBeenCalledTimes(1);
  });
});
