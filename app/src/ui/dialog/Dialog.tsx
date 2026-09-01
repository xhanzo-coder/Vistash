import type { ReactElement, ReactNode } from "react";
import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";

import { Button, IconButton } from "../button/Button";
import styles from "./Dialog.module.css";

export type DialogProps = {
  trigger?: ReactElement;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  onOpenAutoFocus?: (event: Event) => void;
  onCloseAutoFocus?: (event: Event) => void;
  size?: "default" | "wide";
};

/**
 * 通用模态 Dialog。业务只提供标题、描述、内容和操作，焦点陷阱、Escape 与
 * 触发器焦点恢复全部由 Radix 负责。
 */
export function Dialog({
  children,
  defaultOpen,
  description,
  footer,
  onOpenChange,
  onOpenAutoFocus,
  onCloseAutoFocus,
  open,
  size = "default",
  title,
  trigger,
}: DialogProps): ReactNode {
  return (
    <DialogPrimitive.Root
      {...(defaultOpen === undefined ? {} : { defaultOpen })}
      {...(open === undefined ? {} : { open })}
      {...(onOpenChange === undefined ? {} : { onOpenChange })}
    >
      {trigger === undefined ? null : <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger>}
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={styles.overlay} />
        <DialogPrimitive.Content className={styles.content} data-size={size}
          {...(onOpenAutoFocus === undefined ? {} : { onOpenAutoFocus })}
          {...(onCloseAutoFocus === undefined ? {} : { onCloseAutoFocus })}>
          <header className={styles.header}>
            <div className={styles.heading}>
              <DialogPrimitive.Title className={styles.title}>{title}</DialogPrimitive.Title>
              {description === undefined ? null : (
                <DialogPrimitive.Description className={styles.description}>
                  {description}
                </DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close asChild>
              <IconButton label="关闭" icon={<XIcon />} />
            </DialogPrimitive.Close>
          </header>
          <div className={styles.body}>{children}</div>
          {footer === undefined ? null : <footer className={styles.footer}>{footer}</footer>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function DialogClose({ children }: { children: ReactElement }): ReactNode {
  return <DialogPrimitive.Close asChild>{children}</DialogPrimitive.Close>;
}

export type ConfirmDialogProps = {
  trigger: ReactElement;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCloseAutoFocus?: (event: Event) => void;
};

/** 高风险操作的阻断式确认；取消与确认均为明确按钮，不用浏览器 alert。 */
export function ConfirmDialog({
  cancelLabel = "取消",
  confirmLabel,
  description,
  onConfirm,
  onCloseAutoFocus,
  title,
  trigger,
}: ConfirmDialogProps): ReactNode {
  return (
    <AlertDialogPrimitive.Root>
      <AlertDialogPrimitive.Trigger asChild>{trigger}</AlertDialogPrimitive.Trigger>
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay className={styles.overlay} />
        <AlertDialogPrimitive.Content className={styles.confirmContent} {...(onCloseAutoFocus === undefined ? {} : { onCloseAutoFocus })}>
          <AlertDialogPrimitive.Title className={styles.title}>{title}</AlertDialogPrimitive.Title>
          <AlertDialogPrimitive.Description className={styles.description}>
            {description}
          </AlertDialogPrimitive.Description>
          <div className={styles.confirmActions}>
            <AlertDialogPrimitive.Cancel asChild>
              <Button>{cancelLabel}</Button>
            </AlertDialogPrimitive.Cancel>
            <AlertDialogPrimitive.Action asChild>
              <Button variant="danger" onClick={onConfirm}>{confirmLabel}</Button>
            </AlertDialogPrimitive.Action>
          </div>
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );
}
