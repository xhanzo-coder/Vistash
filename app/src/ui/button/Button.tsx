import type { ButtonHTMLAttributes, ReactNode } from "react";
import { CircleNotchIcon } from "@phosphor-icons/react/dist/csr/CircleNotch";

import styles from "./Button.module.css";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "compact" | "default";

type LoadingState =
  | { loading: true; loadingLabel: string }
  | { loading?: false; loadingLabel?: never };

export type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> &
  LoadingState & {
    children: ReactNode;
    variant?: ButtonVariant;
    size?: ButtonSize;
    startIcon?: ReactNode;
    endIcon?: ReactNode;
  };

function classes(...values: Array<string | undefined>): string {
  return values.filter((value): value is string => value !== undefined).join(" ");
}

/** Archive Desk 的标准文字按钮。默认 type=button，避免在表单里意外提交。 */
export function Button({
  children,
  className,
  disabled,
  endIcon,
  loading = false,
  loadingLabel,
  size = "default",
  startIcon,
  type = "button",
  variant = "secondary",
  ...props
}: ButtonProps): ReactNode {
  const content = loading ? (
    <>
      <CircleNotchIcon className={styles.spinner} aria-hidden="true" />
      <span>{loadingLabel}</span>
    </>
  ) : (
    <>
      {startIcon === undefined ? null : <span aria-hidden="true">{startIcon}</span>}
      <span className={styles.label}>{children}</span>
      {endIcon === undefined ? null : <span aria-hidden="true">{endIcon}</span>}
    </>
  );

  return (
    <button
      {...props}
      type={type}
      className={classes(styles.button, styles[variant], styles[size], className)}
      disabled={disabled === true || loading}
      aria-busy={loading ? true : undefined}
    >
      {content}
    </button>
  );
}

export type IconButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "aria-label" | "children"
> & {
  label: string;
  icon: ReactNode;
  variant?: Exclude<ButtonVariant, "primary">;
  size?: ButtonSize;
};

/** 只显示图标的按钮。label 是必填公开契约，不允许产生无名称控制。 */
export function IconButton({
  className,
  icon,
  label,
  size = "default",
  type = "button",
  variant = "ghost",
  ...props
}: IconButtonProps): ReactNode {
  return (
    <button
      {...props}
      type={type}
      className={classes(styles.button, styles.iconButton, styles[variant], styles[size], className)}
      aria-label={label}
    >
      <span aria-hidden="true">{icon}</span>
    </button>
  );
}
