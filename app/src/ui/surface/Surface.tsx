import type { HTMLAttributes, ReactNode } from "react";

import styles from "./Surface.module.css";

export function Panel({
  children,
  className,
  label,
  ...props
}: HTMLAttributes<HTMLElement> & { label: string }): ReactNode {
  const mergedClassName = className === undefined ? styles.panel : `${styles.panel} ${className}`;
  return (
    <section {...props} className={mergedClassName} aria-label={label}>
      {children}
    </section>
  );
}

export function Toolbar({
  children,
  className,
  label,
  ...props
}: HTMLAttributes<HTMLDivElement> & { label: string }): ReactNode {
  const mergedClassName = className === undefined ? styles.toolbar : `${styles.toolbar} ${className}`;
  return (
    <div {...props} className={mergedClassName} role="toolbar" aria-label={label}>
      {children}
    </div>
  );
}

export function EmptyState({
  description,
  icon,
  primaryAction,
  secondaryAction,
  title,
}: {
  title: string;
  description: string;
  icon?: ReactNode;
  primaryAction?: ReactNode;
  secondaryAction?: ReactNode;
}): ReactNode {
  return (
    <div className={styles.emptyState}>
      {icon === undefined ? null : <div className={styles.emptyIcon} aria-hidden="true">{icon}</div>}
      <h2>{title}</h2>
      <p>{description}</p>
      {primaryAction === undefined && secondaryAction === undefined ? null : (
        <div className={styles.emptyActions}>
          {primaryAction}
          {secondaryAction}
        </div>
      )}
    </div>
  );
}
