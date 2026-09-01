import { useEffect, useRef } from "react";

import { useDialogFocusTrap } from "./dialogFocus";

/**
 * 危险操作的二次确认对话框（图片侧与提示词侧共用）。
 *
 * 规格钉死两条：取消是默认焦点（Enter/空格的失手落在安全侧），取消绝不触发
 * 任何写入。挂载即聚焦取消按钮；busy 期间两个按钮都不可再点，Esc 同样被忽略。
 * 焦点陷阱、Esc 关闭与触发器归还由 useDialogFocusTrap 统一落实。
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocusTrap(dialogRef, () => {
    if (!busy) onCancel();
  });

  useEffect(() => {
    const button = cancelRef.current;
    if (button === null) throw new Error("确认对话框取消按钮不存在");
    button.focus();
  }, []);

  return (
    <div className="dialog-backdrop">
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        className="confirm-dialog"
      >
        <p className="eyebrow">CONFIRM</p>
        <h2 id="confirm-title">{title}</h2>
        <p>{body}</p>
        <div className="dialog-actions">
          <button ref={cancelRef} type="button" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button type="button" className="danger-button" onClick={onConfirm} disabled={busy}>
            {confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
