import type { ReactNode } from "react";

import styles from "./AppRoot.module.css";

/** CSS Modules 的生产根边界；后续业务模块不再向全局命名空间增加选择器。 */
export function AppRoot({ children }: { children: ReactNode }): ReactNode {
  return <div className={styles.root}>{children}</div>;
}
