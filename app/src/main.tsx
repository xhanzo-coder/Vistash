import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { AppRoot } from "./app/AppRoot";
import { createAppQueryClient } from "./app/queryClient";
import { ThemeProvider } from "./ui/theme/ThemeProvider";
import { createBrowserThemeController } from "./ui/theme/theme";
import { UiProvider } from "./ui/UiProvider";
import "./styles.css";
import "./styles/reset.css";
import "./styles/tokens.css";
import "./styles/globals.css";

const container = document.getElementById("root");
if (!container) {
  // 挂载点缺失意味着构建产物与 index.html 不一致。此处必须抛出而不是静默返回：
  // 静默返回的结果是一个纯白窗口，看不出白屏的原因是挂载失败还是渲染失败。
  throw new Error("找不到 #root 挂载点，index.html 与构建产物不一致");
}

const search = new URLSearchParams(window.location.search);
const showImageLibraryPrototype =
  import.meta.env.DEV && search.get("prototype") === "image-library";
const showUiKit = import.meta.env.DEV && search.get("dev") === "ui-kit";
const showAppShell = import.meta.env.DEV && search.get("dev") === "app-shell";
const showLibraryLifecycle = import.meta.env.DEV && search.get("dev") === "library-lifecycle";
const showAssetLibrary = import.meta.env.DEV && search.get("dev") === "asset-library";
const showPromptLibrary = import.meta.env.DEV && search.get("dev") === "prompt-library";
const root = createRoot(container);

if (showImageLibraryPrototype) {
  void import("./prototypes/image-library/ImageLibraryPrototype").then(
    ({ ImageLibraryPrototype }) =>
      root.render(
        <StrictMode>
          <ImageLibraryPrototype />
        </StrictMode>,
      ),
  );
} else {
  const queryClient = createAppQueryClient();
  const themeController = createBrowserThemeController();
  const render = (content: ReactNode): void => {
    root.render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider controller={themeController}>
            <UiProvider>
              <AppRoot>{content}</AppRoot>
            </UiProvider>
          </ThemeProvider>
        </QueryClientProvider>
      </StrictMode>,
    );
  };
  if (showUiKit) {
    void import("./dev/ui-kit/UiKitShowcase").then(({ UiKitShowcase }) => render(<UiKitShowcase />));
  } else if (showAppShell) {
    void import("./dev/app-shell/AppShellShowcase").then(({ AppShellShowcase }) =>
      render(<AppShellShowcase />),
    );
  } else if (showLibraryLifecycle) {
    void import("./dev/library-lifecycle/LibraryLifecycleShowcase").then(
      ({ LibraryLifecycleShowcase }) => render(<LibraryLifecycleShowcase />),
    );
  } else if (showAssetLibrary) {
    void import("./dev/asset-library/AssetLibraryShowcase").then(
      ({ AssetLibraryShowcase }) => render(<AssetLibraryShowcase />),
    );
  } else if (showPromptLibrary) {
    void import("./dev/prompt-library/PromptLibraryShowcase").then(
      ({ PromptLibraryShowcase }) => render(<PromptLibraryShowcase />),
    );
  } else {
    render(<App />);
  }
}
