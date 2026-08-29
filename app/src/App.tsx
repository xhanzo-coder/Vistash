import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { appTaskCenter } from "./app/runtime";
import { createRequestId } from "./app/common";
import type { NavigationEntry, WorkspaceNavigation } from "./app/navigation";
import { createWorkspaceNavigation } from "./app/navigation";
import { AppShell } from "./app/shell/AppShell";
import type { GlobalSearch } from "./app/globalSearch";
import { globalSearch as runGlobalSearch } from "./shared/ipc";
import {
  AssetLibraryWorkspace,
  canStopTransferTask,
  getTransferTaskStopError,
  stopAssetTransferTask,
  type AssetImportRequest,
  type AssetLibraryEntry,
} from "./modules/asset-library";
import {
  LibraryLifecycle,
  createTauriLibraryLifecyclePort,
  type LibraryLifecycleControls,
  type OpenLibraryContext,
} from "./modules/library-lifecycle";
import {
  blockIfPromptDraftDirty,
  PromptLibraryWorkspace,
  type PromptLibraryEntry,
} from "./modules/prompt-library";

/** 生产应用只装配一次生命周期 port；它本身不持有 React 状态。 */
const lifecyclePort = createTauriLibraryLifecyclePort();
const globalSearch: GlobalSearch = { run: runGlobalSearch };

type NavigationSnapshot = {
  active: WorkspaceNavigation["active"];
  assets: NavigationEntry;
  prompts: NavigationEntry;
};

function readNavigation(navigation: WorkspaceNavigation): NavigationSnapshot {
  return {
    active: navigation.active,
    assets: navigation.entryFor("assets"),
    prompts: navigation.entryFor("prompts"),
  };
}

/** 订阅完整导航快照；仅工作区切换而不改变 active 的定位请求也必须触发重渲染。 */
function useNavigationSnapshot(navigation: WorkspaceNavigation): NavigationSnapshot {
  const [snapshot, setSnapshot] = useState(() => readNavigation(navigation));
  useEffect(
    () => navigation.subscribe(() => setSnapshot(readNavigation(navigation))),
    [navigation],
  );
  return snapshot;
}

function useGuardedNavigation(navigation: WorkspaceNavigation): WorkspaceNavigation {
  const runAfterDraftGuard = useCallback((action: () => void): boolean => {
    if (blockIfPromptDraftDirty(action)) return false;
    action();
    return true;
  }, []);
  return useMemo<WorkspaceNavigation>(() => ({
    get active() {
      return navigation.active;
    },
    entryFor(workspace) {
      return navigation.entryFor(workspace);
    },
    activate(workspace) {
      if (workspace === navigation.active) return navigation.activate(workspace);
      runAfterDraftGuard(() => navigation.activate(workspace));
      return navigation.entryFor(workspace);
    },
    requestLocate(entry) {
      runAfterDraftGuard(() => navigation.requestLocate(entry));
    },
    subscribe(listener) {
      return navigation.subscribe(listener);
    },
  }), [navigation, runAfterDraftGuard]);
}

function toAssetEntry(entry: NavigationEntry): AssetLibraryEntry {
  switch (entry.kind) {
    case "resume":
      return { kind: "resume" };
    case "locate_asset":
      return {
        kind: "locate",
        requestId: entry.requestId,
        hash: entry.hash,
        location: entry.location,
      };
    case "locate_prompt":
      throw new Error("图片工作区收到提示词定位条目，导航作用域已损坏");
  }
  throw new Error(`未知的图片导航条目：${JSON.stringify(entry)}`);
}

function toPromptEntry(entry: NavigationEntry): PromptLibraryEntry {
  switch (entry.kind) {
    case "resume":
      return { kind: "resume" };
    case "locate_prompt":
      return {
        kind: "locate",
        requestId: entry.requestId,
        id: entry.promptId,
        inTrash: entry.location === "trash",
      };
    case "locate_asset":
      throw new Error("提示词工作区收到图片定位条目，导航作用域已损坏");
  }
  throw new Error(`未知的提示词导航条目：${JSON.stringify(entry)}`);
}

/**
 * 原生窗口关闭保护与工作区无关，放在应用根边界保证选库页和工作台使用同一语义。
 * 只有能处理的原生关闭错误在这里转成就地提示；其余编程/协议错误继续抛出。
 */
function CloseProtectionNotice(): ReactNode {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return undefined;
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const currentWindow = getCurrentWindow();
        const reportCloseFailure = (raw: unknown): void => {
          if (!cancelled) setError(String(raw));
        };
        const listener = await currentWindow.onCloseRequested((event) => {
          event.preventDefault();
          const continueClose = (): void => {
            void currentWindow.close().catch(reportCloseFailure);
          };
          if (!blockIfPromptDraftDirty(continueClose)) {
            void currentWindow.destroy().catch(reportCloseFailure);
          }
        });
        if (cancelled) {
          listener();
          return;
        }
        unlisten = listener;
      } catch (raw) {
        if (!cancelled) setError(String(raw));
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return error === null ? null : (
    <p role="alert">关闭保护不可用，请先保存正文再关闭窗口。原因：{error}</p>
  );
}

function WorkspaceApp({
  context,
  controls,
  navigation,
}: {
  context: OpenLibraryContext;
  controls: LibraryLifecycleControls;
  navigation: WorkspaceNavigation;
}): ReactNode {
  const navigationSnapshot = useNavigationSnapshot(navigation);
  const guardedNavigation = useGuardedNavigation(navigation);
  const active = navigationSnapshot.active;
  const [importRequest, setImportRequest] = useState<AssetImportRequest | undefined>();

  const queueImport = useCallback(
    (kind: AssetImportRequest["kind"]): void => {
      const request = { requestId: createRequestId(), kind };
      if (navigation.active === "assets") {
        setImportRequest(request);
        return;
      }
      if (blockIfPromptDraftDirty(() => {
        navigation.activate("assets");
        setImportRequest(request);
      })) return;
      navigation.activate("assets");
      setImportRequest(request);
    },
    [navigation],
  );
  const onImportRequestHandled = useCallback((requestId: string): void => {
    setImportRequest((current) =>
      current?.requestId === requestId ? undefined : current,
    );
  }, []);
  const assetEntry = useMemo(
    () => toAssetEntry(navigationSnapshot.assets),
    [navigationSnapshot.assets],
  );
  const promptEntry = useMemo(
    () => toPromptEntry(navigationSnapshot.prompts),
    [navigationSnapshot.prompts],
  );

  return (
    <AppShell
      navigation={guardedNavigation}
      globalSearch={globalSearch}
      taskCenter={appTaskCenter}
      library={{
        id: context.session.id,
        displayName: context.session.displayName,
        path: context.path,
        formatVersion: context.formatVersion,
      }}
      appVersion="0.1.0"
      onImportImages={() => queueImport("images")}
      onImportFolder={() => queueImport("folder")}
      onImportClipboard={() => queueImport("clipboard")}
      onStopTask={stopAssetTransferTask}
      canStopTask={canStopTransferTask}
      getStopError={getTransferTaskStopError}
      onOpenOtherLibrary={() => {
        if (blockIfPromptDraftDirty(controls.openOtherLibrary)) return;
        controls.openOtherLibrary();
      }}
      assets={
        <AssetLibraryWorkspace
          session={context.session}
          active={active === "assets"}
          entry={assetEntry}
          {...(importRequest === undefined ? {} : { importRequest })}
          onImportRequestHandled={onImportRequestHandled}
        />
      }
      prompts={
        <PromptLibraryWorkspace
          session={context.session}
          active={active === "prompts"}
          entry={promptEntry}
        />
      }
    />
  );
}

function AppContent(): ReactNode {
  const navigation = useMemo(() => createWorkspaceNavigation(), []);

  return (
    <>
      <CloseProtectionNotice />
      <LibraryLifecycle port={lifecyclePort}>
        {(context, controls) => (
          <WorkspaceApp
            key={context.session.id}
            context={context}
            controls={controls}
            navigation={navigation}
          />
        )}
      </LibraryLifecycle>
    </>
  );
}

/** 生产入口由 `main.tsx` 提供唯一 QueryClient；单元测试显式提供同一层 provider。 */
export function App(): ReactNode {
  return <AppContent />;
}
