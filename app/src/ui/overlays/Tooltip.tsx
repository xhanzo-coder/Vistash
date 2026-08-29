import type { ReactElement, ReactNode } from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";

import styles from "./Overlays.module.css";

export function TooltipProvider({ children }: { children: ReactNode }): ReactNode {
  return (
    <TooltipPrimitive.Provider delayDuration={800} skipDelayDuration={300}>
      {children}
    </TooltipPrimitive.Provider>
  );
}

export function Tooltip({
  children,
  content,
  side = "bottom",
}: {
  children: ReactElement;
  content: string;
  side?: "top" | "right" | "bottom" | "left";
}): ReactNode {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content className={styles.tooltip} side={side} sideOffset={6}>
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
