import {
  createContext,
  useCallback,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import type { ThemeController, ThemeSnapshot } from "./theme";

const ThemeControllerContext = createContext<ThemeController | null>(null);

export function ThemeProvider({
  children,
  controller,
}: {
  children: ReactNode;
  controller: ThemeController;
}): ReactNode {
  return (
    <ThemeControllerContext.Provider value={controller}>
      {children}
    </ThemeControllerContext.Provider>
  );
}

/** 设置 Dialog 通过此公开 hook 读取与修改三态主题，不接触存储或媒体查询。 */
export function useTheme(): {
  snapshot: ThemeSnapshot;
  setPreference: ThemeController["setPreference"];
} {
  const controller = useContext(ThemeControllerContext);
  if (controller === null) {
    throw new Error("useTheme 必须在 ThemeProvider 内使用");
  }
  const subscribe = useCallback(
    (listener: () => void) => controller.subscribe(listener),
    [controller],
  );
  const getSnapshot = useCallback(() => controller.snapshot(), [controller]);
  const setPreference = useCallback(
    (preference: Parameters<ThemeController["setPreference"]>[0]) =>
      controller.setPreference(preference),
    [controller],
  );
  const snapshot = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot,
  );
  return { snapshot, setPreference };
}
