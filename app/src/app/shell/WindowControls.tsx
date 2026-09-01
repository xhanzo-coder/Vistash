import type { ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { MinusIcon } from "@phosphor-icons/react/dist/csr/Minus";
import { SquareIcon } from "@phosphor-icons/react/dist/csr/Square";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";

import styles from "./TopBar.module.css";

async function toggleMaximizedWindow(): Promise<void> {
  const window = getCurrentWindow();
  if (await window.isMaximized()) {
    await window.unmaximize();
    return;
  }
  await window.maximize();
}

/** Windows 自定义标题栏控制；close 仍会经过 App 根边界的草稿保护。 */
export function WindowControls(): ReactNode {
  return (
    <div className={styles.windowControls} role="group" aria-label="窗口控制">
      <button type="button" className={styles.windowControl} aria-label="最小化" onClick={() => void getCurrentWindow().minimize()}>
        <MinusIcon aria-hidden="true" />
      </button>
      <button type="button" className={styles.windowControl} aria-label="最大化或还原" onClick={() => void toggleMaximizedWindow()}>
        <SquareIcon aria-hidden="true" />
      </button>
      <button type="button" className={`${styles.windowControl} ${styles.closeControl}`} aria-label="关闭窗口" onClick={() => void getCurrentWindow().close()}>
        <XIcon aria-hidden="true" />
      </button>
    </div>
  );
}
