import { useCallback, useSyncExternalStore, type ReactNode } from "react";

import type { LibraryId } from "../common";
import type { GlobalSearch } from "../globalSearch";
import type { WorkspaceId, WorkspaceNavigation } from "../navigation";
import { TopBar } from "./TopBar";
import { GlobalSearchDialog } from "./GlobalSearchDialog";
import { ImportMenu } from "./ImportMenu";
import { SettingsDialog } from "./SettingsDialog";
import { LibrarySwitcher } from "./LibrarySwitcher";
import styles from "./AppShell.module.css";

export type ShellLibraryInfo = {
  id: LibraryId;
  displayName: string;
  path: string;
  formatVersion: number;
};

export type AppShellProps = {
  navigation: WorkspaceNavigation;
  globalSearch: GlobalSearch;
  library: ShellLibraryInfo;
  appVersion: string;
  onImportImages: () => void;
  onImportFolder: () => void;
  onCreateNewLibrary: () => void;
  onOpenOtherLibrary: () => void;
  assets: ReactNode;
  prompts: ReactNode;
};

function useActiveWorkspace(navigation: WorkspaceNavigation): WorkspaceId {
  const subscribe = useCallback(
    (listener: () => void) => navigation.subscribe(listener),
    [navigation],
  );
  const snapshot = useCallback(() => navigation.active, [navigation]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** 新工作区的组合外壳。两个一级工作区始终挂载，只有可见性发生变化。 */
export function AppShell(props: AppShellProps): ReactNode {
  const active = useActiveWorkspace(props.navigation);
  const activate = useCallback(
    (workspace: WorkspaceId): void => {
      props.navigation.activate(workspace);
    },
    [props.navigation],
  );

  return (
    <div className={styles.shell}>
      <a className={styles.skipLink} href="#workspace-main">跳到主内容</a>
      <TopBar
        active={active}
        onActivate={activate}
        libraryControl={<LibrarySwitcher library={props.library} onCreateNewLibrary={props.onCreateNewLibrary} onOpenOtherLibrary={props.onOpenOtherLibrary} />}
        actions={
          <>
            <GlobalSearchDialog search={props.globalSearch} navigation={props.navigation} />
            <ImportMenu
              onImportImages={props.onImportImages}
              onImportFolder={props.onImportFolder}
            />
            <SettingsDialog
              appVersion={props.appVersion}
              library={props.library}
              onCreateNewLibrary={props.onCreateNewLibrary}
              onOpenOtherLibrary={props.onOpenOtherLibrary}
            />
          </>
        }
      />
      <main id="workspace-main" className={styles.workspaceStack}>
        <section
          className={styles.workspace}
          data-workspace="assets"
          hidden={active !== "assets"}
          inert={active !== "assets"}
          aria-label="图片工作区"
        >
          {props.assets}
        </section>
        <section
          className={styles.workspace}
          data-workspace="prompts"
          hidden={active !== "prompts"}
          inert={active !== "prompts"}
          aria-label="提示词工作区"
        >
          {props.prompts}
        </section>
      </main>
    </div>
  );
}
