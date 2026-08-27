import type { ReactNode } from "react";

import { TooltipProvider } from "./overlays/Tooltip";
import { ToastProvider } from "./toast/Toast";

/** 应用级无业务 UI provider：只装配 Tooltip 延迟与 Toast live region。 */
export function UiProvider({ children }: { children: ReactNode }): ReactNode {
  return (
    <TooltipProvider>
      <ToastProvider>{children}</ToastProvider>
    </TooltipProvider>
  );
}
