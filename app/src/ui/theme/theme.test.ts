// @vitest-environment jsdom

import { describe, expect, test, vi } from "vitest";

import {
  THEME_STORAGE_KEY,
  createThemeController,
  type ThemePreference,
} from "./theme";

class ThemeMediaStub {
  readonly media = "(prefers-color-scheme: dark)";
  readonly onchange = null;
  private readonly listeners = new Set<(event: { readonly matches: boolean }) => void>();

  constructor(public matches: boolean) {}

  addEventListener(_type: "change", listener: (event: { readonly matches: boolean }) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "change", listener: (event: { readonly matches: boolean }) => void): void {
    this.listeners.delete(listener);
  }

  emit(matches: boolean): void {
    this.matches = matches;
    for (const listener of this.listeners) listener({ matches });
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}

function storageWith(value: string | null) {
  const values = new Map<string, string>();
  if (value !== null) values.set(THEME_STORAGE_KEY, value);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, next: string) => values.set(key, next),
    read: () => values.get(THEME_STORAGE_KEY) ?? null,
  };
}

function fixture(stored: string | null, systemDark: boolean) {
  const root = document.createElement("html");
  const media = new ThemeMediaStub(systemDark);
  const storage = storageWith(stored);
  const appliedThemes: string[] = [];
  const controller = createThemeController({
    root,
    media,
    storage,
    updateThemeColor: (theme) => appliedThemes.push(theme),
  });
  return { appliedThemes, controller, media, root, storage };
}

describe("主题控制器", () => {
  test("首次运行默认跟随系统，并把偏好与实际主题分别写到根节点", () => {
    const { appliedThemes, controller, root } = fixture(null, true);

    expect(controller.snapshot()).toEqual({ preference: "system", resolved: "dark" });
    expect(root.dataset.themePreference).toBe("system");
    expect(root.dataset.theme).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
    expect(appliedThemes).toEqual(["dark"]);
  });

  test("显式主题立即生效并持久化，之后不受系统主题变化影响", () => {
    const { controller, media, root, storage } = fixture(null, true);

    controller.setPreference("light");
    media.emit(false);
    media.emit(true);

    expect(controller.snapshot()).toEqual({ preference: "light", resolved: "light" });
    expect(root.dataset.theme).toBe("light");
    expect(storage.read()).toBe("light");
  });

  test("跟随系统时响应系统变化、通知订阅者，并在释放后移除监听", () => {
    const { controller, media, root } = fixture("system", false);
    const listener = vi.fn<() => void>();
    const unsubscribe = controller.subscribe(listener);

    media.emit(true);
    expect(controller.snapshot()).toEqual({ preference: "system", resolved: "dark" });
    expect(root.dataset.theme).toBe("dark");
    expect(listener).toHaveBeenCalledExactlyOnceWith();

    unsubscribe();
    controller.dispose();
    expect(media.listenerCount()).toBe(0);
  });

  test("损坏的持久化值显式抛错，不静默回落到 system", () => {
    expect(() => fixture("sepia", false)).toThrowError("未知主题偏好：sepia");
  });

  test("公开偏好类型只允许 system、dark、light", () => {
    const values: ThemePreference[] = ["system", "dark", "light"];
    expect(values).toEqual(["system", "dark", "light"]);
  });
});
