import { useId, useState, type ReactNode } from "react";
import { GearIcon } from "@phosphor-icons/react/dist/csr/Gear";

import { Button, IconButton } from "../../ui/button/Button";
import { Dialog, DialogClose } from "../../ui/dialog/Dialog";
import { useTheme } from "../../ui/theme/ThemeProvider";
import type { ThemePreference } from "../../ui/theme/theme";
import type { ShellLibraryInfo } from "./AppShell";
import styles from "./SettingsDialog.module.css";

type SettingsSection = "appearance" | "library" | "shortcuts" | "about";

const SECTIONS: ReadonlyArray<{ id: SettingsSection; label: string }> = [
  { id: "appearance", label: "外观" },
  { id: "library", label: "素材库" },
  { id: "shortcuts", label: "快捷键" },
  { id: "about", label: "关于" },
];

const THEMES: ReadonlyArray<{ id: ThemePreference; label: string }> = [
  { id: "system", label: "跟随系统" },
  { id: "dark", label: "深色" },
  { id: "light", label: "浅色" },
];

function SettingsContent({
  appVersion,
  library,
  onCreateNewLibrary,
  onOpenOtherLibrary,
  section,
}: {
  appVersion: string;
  library: ShellLibraryInfo;
  onCreateNewLibrary: () => void;
  onOpenOtherLibrary: () => void;
  section: SettingsSection;
}): ReactNode {
  const { setPreference, snapshot } = useTheme();
  const themeGroupName = useId();
  switch (section) {
    case "appearance":
      return (
        <section className={styles.contentSection} aria-labelledby="settings-appearance-title">
          <h3 id="settings-appearance-title">外观</h3>
          <p>主题会立即应用，不改变当前查询、选择或滚动位置。</p>
          <div className={styles.themeOptions} role="radiogroup" aria-label="主题">
            {THEMES.map((theme) => (
              <label key={theme.id}>
                <input
                  type="radio"
                  name={themeGroupName}
                  value={theme.id}
                  checked={snapshot.preference === theme.id}
                  // 弹窗按 tabIndex 计算循环边界；未选项仍由原生方向键访问。
                  tabIndex={snapshot.preference === theme.id ? 0 : -1}
                  onChange={() => setPreference(theme.id)}
                />
                <span>{theme.label}</span>
              </label>
            ))}
          </div>
        </section>
      );
    case "library":
      return (
        <section className={styles.contentSection} aria-labelledby="settings-library-title">
          <h3 id="settings-library-title">素材库</h3>
          <dl className={styles.libraryDetails}>
            <div><dt>名称</dt><dd>{library.displayName}</dd></div>
            <div><dt>位置</dt><dd>{library.path}</dd></div>
            <div><dt>格式</dt><dd>格式版本 {library.formatVersion}</dd></div>
          </dl>
          <div className={styles.libraryActions}>
            <DialogClose><Button onClick={onCreateNewLibrary}>新建素材库</Button></DialogClose>
            <DialogClose><Button onClick={onOpenOtherLibrary}>打开其他库</Button></DialogClose>
          </div>
        </section>
      );
    case "shortcuts":
      return (
        <section className={styles.contentSection} aria-labelledby="settings-shortcuts-title">
          <h3 id="settings-shortcuts-title">快捷键</h3>
          <dl className={styles.shortcuts}>
            <div><dt>搜索全部素材</dt><dd><kbd>Ctrl K</kbd></dd></div>
            <div><dt>搜索当前集合</dt><dd><kbd>Ctrl F</kbd></dd></div>
            <div><dt>粘贴导入</dt><dd><kbd>Ctrl V</kbd></dd></div>
            <div><dt>修改显示文件名</dt><dd><kbd>F2</kbd></dd></div>
            <div><dt>打开灯箱</dt><dd><kbd>Enter</kbd></dd></div>
            <div><dt>返回</dt><dd><kbd>Esc</kbd></dd></div>
          </dl>
        </section>
      );
    case "about":
      return (
        <section className={styles.contentSection} aria-labelledby="settings-about-title">
          <h3 id="settings-about-title" translate="no">Vistash</h3>
          <p>Windows 优先、本地优先的图片素材管理工具。</p>
          <p className={styles.version} translate="no">版本 {appVersion}</p>
        </section>
      );
  }
  throw new Error(`未知设置分类：${String(section)}`);
}

export function SettingsDialog({
  appVersion,
  library,
  onCreateNewLibrary,
  onOpenOtherLibrary,
}: {
  appVersion: string;
  library: ShellLibraryInfo;
  onCreateNewLibrary: () => void;
  onOpenOtherLibrary: () => void;
}): ReactNode {
  const [section, setSection] = useState<SettingsSection>("appearance");
  return (
    <Dialog
      trigger={
        <IconButton label="设置" icon={<GearIcon />} />
      }
      title="设置"
      description="只显示当前版本真实可用的选项。"
    >
      <div className={styles.layout}>
        <nav className={styles.navigation} aria-label="设置分类">
          {SECTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-current={section === item.id ? "page" : undefined}
              onClick={() => setSection(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <SettingsContent
          appVersion={appVersion}
          library={library}
          onCreateNewLibrary={onCreateNewLibrary}
          onOpenOtherLibrary={onOpenOtherLibrary}
          section={section}
        />
      </div>
    </Dialog>
  );
}
