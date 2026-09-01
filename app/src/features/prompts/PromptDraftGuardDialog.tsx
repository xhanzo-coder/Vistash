import { useEffect, useRef, type ReactNode } from "react";

import { useDialogFocusTrap } from "../workspace/dialogFocus";

/** 提示词编辑/创建共享的脏草稿三选一对话框。 */
export function PromptDraftGuardDialog({ saving, description = "保存后离开、放弃修改，还是留在当前页面？", discardLabel = "放弃修改", saveLabel = "保存并离开", onStay, onDiscard, onSaveAndLeave }: {
  saving: boolean;
  description?: string;
  discardLabel?: string;
  saveLabel?: string;
  onStay: () => void;
  onDiscard: () => void;
  onSaveAndLeave: () => void;
}): ReactNode {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocusTrap(dialogRef, onStay);

  useEffect(() => {
    const button = cancelRef.current;
    if (button === null) throw new Error("草稿对话框取消按钮不存在");
    button.focus();
  }, []);

  return (
    <div className="dialog-backdrop">
      <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="prompt-draft-dialog-title" className="confirm-dialog">
        <h2 id="prompt-draft-dialog-title">有未保存的修改</h2>
        <p>{description}</p>
        <div className="dialog-actions">
          <button ref={cancelRef} type="button" onClick={onStay}>留在当前页</button>
          <button type="button" className="danger-ghost" onClick={onDiscard}>{discardLabel}</button>
          <button type="button" className="primary-button" disabled={saving} onClick={onSaveAndLeave}>{saveLabel}</button>
        </div>
      </section>
    </div>
  );
}
