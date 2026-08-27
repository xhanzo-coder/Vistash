import type { ReactElement, ReactNode } from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";

import { IconButton } from "../button/Button";
import styles from "./Overlays.module.css";

export type PopoverProps = {
  trigger: ReactElement;
  label: string;
  children: ReactNode;
  align?: "start" | "center" | "end";
  showClose?: boolean;
};

export function Popover({
  align = "start",
  children,
  label,
  showClose = false,
  trigger,
}: PopoverProps): ReactNode {
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          className={styles.popover}
          align={align}
          sideOffset={7}
          aria-label={label}
          data-ui="popover"
        >
          {showClose ? (
            <PopoverPrimitive.Close asChild>
              <IconButton className={styles.popoverClose} size="compact" label="关闭" icon={<XIcon />} />
            </PopoverPrimitive.Close>
          ) : null}
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
