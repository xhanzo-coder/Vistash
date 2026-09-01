import type { ReactNode } from "react";
import { ImageSquareIcon } from "@phosphor-icons/react/dist/csr/ImageSquare";
import { NotePencilIcon } from "@phosphor-icons/react/dist/csr/NotePencil";

import brandMark from "../../assets/brand/vistash-mark.svg";
import type { WorkspaceId } from "../navigation";
import { WindowControls } from "./WindowControls";
import styles from "./TopBar.module.css";

export function TopBar({
  active,
  actions,
  libraryControl,
  onActivate,
}: {
  active: WorkspaceId;
  actions: ReactNode;
  libraryControl: ReactNode;
  onActivate: (workspace: WorkspaceId) => void;
}): ReactNode {
  return (
    <header className={styles.topbar} data-tauri-drag-region>
      <div className={styles.brand} translate="no" data-tauri-drag-region>
        <img src={brandMark} width="26" height="26" alt="" aria-hidden="true" fetchPriority="high" />
        <span>Vistash</span>
      </div>
      {libraryControl}
      <nav className={styles.navigation} aria-label="一级工作区">
        <button
          type="button"
          aria-label="图片"
          aria-current={active === "assets" ? "page" : undefined}
          onClick={() => onActivate("assets")}
        >
          <ImageSquareIcon aria-hidden="true" />
          <span>图片</span>
        </button>
        <button
          type="button"
          aria-label="提示词"
          aria-current={active === "prompts" ? "page" : undefined}
          onClick={() => onActivate("prompts")}
        >
          <NotePencilIcon aria-hidden="true" />
          <span>提示词</span>
        </button>
      </nav>
      <div className={styles.dragSpacer} data-tauri-drag-region aria-hidden="true" />
      <div className={styles.actions}>{actions}</div>
      <WindowControls />
    </header>
  );
}
