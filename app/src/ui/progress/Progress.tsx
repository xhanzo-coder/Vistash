import type { ReactNode } from "react";

import styles from "./Progress.module.css";

const PERCENT_FORMAT = new Intl.NumberFormat("zh-CN", {
  style: "percent",
  maximumFractionDigits: 0,
});

export type ProgressProps = {
  label: string;
  /** null 表示后端尚未给出可计算总量，不得伪造百分比。 */
  value: number | null;
  max?: number;
  compact?: boolean;
};

export function Progress({ label, value, max = 100, compact = false }: ProgressProps): ReactNode {
  if (!Number.isFinite(max) || max <= 0) throw new RangeError(`进度总量必须大于 0：${max}`);
  if (value !== null && (!Number.isFinite(value) || value < 0 || value > max)) {
    throw new RangeError(`进度值必须位于 0 到 ${max}：${value}`);
  }

  const ratio = value === null ? null : value / max;
  const percentage = ratio === null ? null : PERCENT_FORMAT.format(ratio);

  return (
    <div
      className={compact ? styles.compact : styles.root}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={value === null ? undefined : max}
      aria-valuenow={value === null ? undefined : value}
      aria-valuetext={percentage ?? undefined}
    >
      <div className={styles.meta}>
        <span>{label}</span>
        {percentage === null ? null : <span className={styles.value}>{percentage}</span>}
      </div>
      <span className={styles.track} aria-hidden="true">
        <span
          className={ratio === null ? styles.indeterminate : styles.indicator}
          style={ratio === null ? undefined : { transform: `scaleX(${ratio})` }}
        />
      </span>
    </div>
  );
}
