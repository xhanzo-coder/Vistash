import type { ReactNode } from "react";
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";

import styles from "./ScrollArea.module.css";

export function ScrollArea({
  children,
  className,
  label,
}: {
  children: ReactNode;
  label: string;
  className?: string;
}): ReactNode {
  const rootClassName = className === undefined ? styles.root : `${styles.root} ${className}`;
  return (
    <ScrollAreaPrimitive.Root className={rootClassName}>
      <ScrollAreaPrimitive.Viewport className={styles.viewport} role="region" aria-label={label}>
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollAreaPrimitive.Scrollbar className={styles.scrollbar} orientation="vertical">
        <ScrollAreaPrimitive.Thumb className={styles.thumb} />
      </ScrollAreaPrimitive.Scrollbar>
      <ScrollAreaPrimitive.Scrollbar className={styles.scrollbar} orientation="horizontal">
        <ScrollAreaPrimitive.Thumb className={styles.thumb} />
      </ScrollAreaPrimitive.Scrollbar>
      <ScrollAreaPrimitive.Corner className={styles.corner} />
    </ScrollAreaPrimitive.Root>
  );
}
