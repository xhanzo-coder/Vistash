import type { ReactNode } from "react";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { FolderOpenIcon } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { StackIcon } from "@phosphor-icons/react/dist/csr/Stack";

import { Button } from "../../ui/button/Button";
import { Popover } from "../../ui/overlays/Popover";
import type { ShellLibraryInfo } from "./AppShell";
import styles from "./LibrarySwitcher.module.css";

/** 库切换是应用级导航，与向当前库导入素材的入站操作严格分开。 */
export function LibrarySwitcher({
  library,
  onCreateNewLibrary,
  onOpenOtherLibrary,
}: {
  library: ShellLibraryInfo;
  onCreateNewLibrary: () => void;
  onOpenOtherLibrary: () => void;
}): ReactNode {
  return (
    <Popover
      align="start"
      label="素材库切换器"
      trigger={
        <button type="button" className={styles.trigger} aria-label={`切换素材库：${library.displayName}`}>
          <StackIcon aria-hidden="true" />
          <span>{library.displayName}</span>
          <CaretDownIcon className={styles.caret} aria-hidden="true" />
        </button>
      }
    >
      <div className={styles.switcher} data-ui="library-switcher">
        <div className={styles.current}>
          <span>当前素材库</span>
          <strong>{library.displayName}</strong>
          <p title={library.path}>{library.path}</p>
        </div>
        <div className={styles.actions}>
          <Button startIcon={<PlusIcon />} onClick={onCreateNewLibrary}>新建素材库</Button>
          <Button startIcon={<FolderOpenIcon />} onClick={onOpenOtherLibrary}>打开其他库</Button>
        </div>
      </div>
    </Popover>
  );
}
