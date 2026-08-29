import type { ReactNode } from "react";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { ClipboardIcon } from "@phosphor-icons/react/dist/csr/Clipboard";
import { FileImageIcon } from "@phosphor-icons/react/dist/csr/FileImage";
import { FolderOpenIcon } from "@phosphor-icons/react/dist/csr/FolderOpen";
import { UploadSimpleIcon } from "@phosphor-icons/react/dist/csr/UploadSimple";

import { Button } from "../../ui/button/Button";
import { Menu, MenuItem } from "../../ui/overlays/Menu";

export function ImportMenu({
  onImportFolder,
  onImportImages,
  onImportClipboard,
}: {
  onImportFolder: () => void;
  onImportImages: () => void;
  onImportClipboard: () => void;
}): ReactNode {
  return (
    <Menu
      align="end"
      label="导入"
      trigger={
        <Button
          aria-label="导入"
          variant="primary"
          startIcon={<UploadSimpleIcon />}
          endIcon={<CaretDownIcon />}
        >
          导入
        </Button>
      }
    >
      <MenuItem icon={<FileImageIcon />} onSelect={onImportImages} shortcut="Ctrl O">
        导入图片…
      </MenuItem>
      <MenuItem icon={<FolderOpenIcon />} onSelect={onImportFolder}>
        导入文件夹…
      </MenuItem>
      <MenuItem icon={<ClipboardIcon />} onSelect={onImportClipboard} shortcut="Ctrl V">
        从剪贴板导入
      </MenuItem>
    </Menu>
  );
}
