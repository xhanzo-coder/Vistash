import type { ReactElement, ReactNode } from "react";
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";

import styles from "./Overlays.module.css";

export type MenuProps = {
  trigger: ReactElement;
  children: ReactNode;
  label?: string;
  align?: "start" | "center" | "end";
  defaultOpen?: boolean;
};

export function Menu({ align = "end", children, defaultOpen, label, trigger }: MenuProps): ReactNode {
  return (
    <DropdownMenuPrimitive.Root {...(defaultOpen === undefined ? {} : { defaultOpen })}>
      <DropdownMenuPrimitive.Trigger asChild>{trigger}</DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          className={styles.menu}
          align={align}
          sideOffset={6}
          {...(label === undefined ? {} : { "aria-label": label })}
        >
          {children}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

export type MenuItemProps = {
  children: ReactNode;
  onSelect?: () => void;
  disabled?: boolean;
  destructive?: boolean;
  icon?: ReactNode;
  shortcut?: string;
};

export function MenuItem({
  children,
  destructive = false,
  disabled,
  icon,
  onSelect,
  shortcut,
}: MenuItemProps): ReactNode {
  return (
    <DropdownMenuPrimitive.Item
      className={destructive ? styles.dangerItem : styles.menuItem}
      disabled={disabled ?? false}
      {...(onSelect === undefined ? {} : { onSelect: () => onSelect() })}
    >
      {icon === undefined ? null : <span className={styles.itemIcon} aria-hidden="true">{icon}</span>}
      <span className={styles.itemLabel}>{children}</span>
      {shortcut === undefined ? null : <kbd className={styles.shortcut}>{shortcut}</kbd>}
    </DropdownMenuPrimitive.Item>
  );
}

export function MenuCheckboxItem({
  checked,
  children,
  onCheckedChange,
}: {
  checked: boolean;
  children: ReactNode;
  onCheckedChange: (checked: boolean) => void;
}): ReactNode {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      className={styles.menuItem}
      checked={checked}
      onCheckedChange={onCheckedChange}
    >
      <DropdownMenuPrimitive.ItemIndicator className={styles.indicator}>
        <CheckIcon aria-hidden="true" />
      </DropdownMenuPrimitive.ItemIndicator>
      <span className={styles.itemLabel}>{children}</span>
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

export function MenuLabel({ children }: { children: ReactNode }): ReactNode {
  return <DropdownMenuPrimitive.Label className={styles.menuLabel}>{children}</DropdownMenuPrimitive.Label>;
}

export function MenuSeparator(): ReactNode {
  return <DropdownMenuPrimitive.Separator className={styles.separator} />;
}

export function ContextMenu({ children, content }: { children: ReactElement; content: ReactNode }): ReactNode {
  return (
    <ContextMenuPrimitive.Root>
      <ContextMenuPrimitive.Trigger asChild>{children}</ContextMenuPrimitive.Trigger>
      <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.Content className={styles.menu}>
          {content}
        </ContextMenuPrimitive.Content>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Root>
  );
}

export function ContextMenuItem({
  children,
  destructive = false,
  disabled,
  onSelect,
}: Omit<MenuItemProps, "icon" | "shortcut">): ReactNode {
  return (
    <ContextMenuPrimitive.Item
      className={destructive ? styles.dangerItem : styles.menuItem}
      disabled={disabled ?? false}
      {...(onSelect === undefined ? {} : { onSelect: () => onSelect() })}
    >
      <span className={styles.itemLabel}>{children}</span>
    </ContextMenuPrimitive.Item>
  );
}
