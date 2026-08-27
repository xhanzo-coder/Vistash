import type { Unsubscribe } from "../../app/common";

export const THEME_STORAGE_KEY = "vistash.appearance.theme.v1";

export type ThemePreference = "system" | "dark" | "light";
export type ResolvedTheme = Exclude<ThemePreference, "system">;

export type ThemeSnapshot = Readonly<{
  preference: ThemePreference;
  resolved: ResolvedTheme;
}>;

type ThemeRoot = Pick<HTMLElement, "dataset" | "style">;
type ThemeStorage = Pick<Storage, "getItem" | "setItem">;
type ThemeMediaChangeEvent = { readonly matches: boolean };
type ThemeMedia = {
  readonly matches: boolean;
  addEventListener(type: "change", listener: (event: ThemeMediaChangeEvent) => void): void;
  removeEventListener(type: "change", listener: (event: ThemeMediaChangeEvent) => void): void;
};

export type ThemeController = {
  snapshot(): ThemeSnapshot;
  setPreference(preference: ThemePreference): void;
  subscribe(listener: () => void): Unsubscribe;
  dispose(): void;
};

export type ThemeControllerEnvironment = {
  root: ThemeRoot;
  media: ThemeMedia;
  storage: ThemeStorage;
  updateThemeColor: (theme: ResolvedTheme) => void;
};

function parseThemePreference(value: string | null): ThemePreference {
  if (value === null) return "system";
  if (value === "system" || value === "dark" || value === "light") return value;
  throw new TypeError(`未知主题偏好：${value}`);
}

function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  return preference === "system" ? (systemDark ? "dark" : "light") : preference;
}

/**
 * 建立一个主题控制器。它只持有外观偏好，不拥有任何业务状态；深浅主题通过根节点
 * 的语义属性切换，因此不会重建工作区、查询、选择或滚动上下文。
 */
export function createThemeController(environment: ThemeControllerEnvironment): ThemeController {
  const { media, root, storage, updateThemeColor } = environment;
  const listeners = new Set<() => void>();
  let preference = parseThemePreference(storage.getItem(THEME_STORAGE_KEY));
  let snapshot: ThemeSnapshot = {
    preference,
    resolved: resolveTheme(preference, media.matches),
  };

  const apply = (next: ThemeSnapshot): void => {
    snapshot = next;
    root.dataset.themePreference = next.preference;
    root.dataset.theme = next.resolved;
    root.style.colorScheme = next.resolved;
    updateThemeColor(next.resolved);
  };

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  const handleSystemChange = (event: ThemeMediaChangeEvent): void => {
    if (preference !== "system") return;
    const resolved = event.matches ? "dark" : "light";
    if (snapshot.resolved === resolved) return;
    apply({ preference, resolved });
    notify();
  };

  apply(snapshot);
  media.addEventListener("change", handleSystemChange);

  return {
    snapshot: () => snapshot,
    setPreference(nextPreference) {
      storage.setItem(THEME_STORAGE_KEY, nextPreference);
      const next = {
        preference: nextPreference,
        resolved: resolveTheme(nextPreference, media.matches),
      } satisfies ThemeSnapshot;
      if (snapshot.preference === next.preference && snapshot.resolved === next.resolved) return;
      preference = nextPreference;
      apply(next);
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      media.removeEventListener("change", handleSystemChange);
      listeners.clear();
    },
  };
}

/** 在浏览器组合根同步应用主题，避免 React 首次绘制后再闪烁换色。 */
export function createBrowserThemeController(): ThemeController {
  const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (themeColor === null) throw new Error("index.html 缺少 theme-color meta");
  return createThemeController({
    root: document.documentElement,
    media: window.matchMedia("(prefers-color-scheme: dark)"),
    storage: window.localStorage,
    updateThemeColor: () => {
      const color = window
        .getComputedStyle(document.documentElement)
        .getPropertyValue("--surface-canvas")
        .trim();
      if (color.length === 0) throw new Error("主题缺少 --surface-canvas token");
      themeColor.content = color;
    },
  });
}
