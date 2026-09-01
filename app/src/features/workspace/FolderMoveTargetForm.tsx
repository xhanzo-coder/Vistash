import { useId, useState, type ReactNode } from "react";

import { Button } from "../../ui/button/Button";
import { folderMoveCandidates, folderMoveResult, folderParent } from "./folderPath";
import styles from "./FolderMoveTargetForm.module.css";

/** 图片与提示词共享的无业务状态移动目标表单；领域 mutation 由调用方拥有。 */
export function FolderMoveTargetForm({ path, folders, disabled, busy = false, error = null, topLabel, onSubmit }: {
  path: string;
  folders: readonly string[];
  disabled: boolean;
  busy?: boolean;
  error?: ReactNode;
  topLabel: string;
  onSubmit: (destinationParent: string | null) => void;
}): ReactNode {
  const targetId = useId();
  const currentParent = folderParent(path);
  const [target, setTarget] = useState<string | null>(currentParent);
  return (
    <form className={styles.form} onSubmit={(event) => { event.preventDefault(); onSubmit(target); }}>
      <label htmlFor={targetId}>新的父位置</label>
      <select id={targetId} name="folder-move-target" value={target ?? ""} disabled={disabled || busy}
        onChange={(event) => setTarget(event.currentTarget.value === "" ? null : event.currentTarget.value)}>
        <option value="">{topLabel}</option>
        {folderMoveCandidates(path, folders).map((candidate) => <option key={candidate} value={candidate}>{candidate}</option>)}
      </select>
      <p className={styles.preview}>移动后：<strong>{folderMoveResult(path, target)}</strong></p>
      {error}
      <Button type="submit" variant="primary" disabled={disabled || busy || target === currentParent}>{busy ? "正在移动…" : "移动文件夹"}</Button>
    </form>
  );
}
