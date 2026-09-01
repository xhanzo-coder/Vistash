/** 应用级运行时 seam：图片模块与新的 AppShell 共享同一平台 adapter 和任务中心。 */
import { createTauriPlatform } from "./platformTauri";
import { createTaskCenterStore } from "./taskCenterStore";

export const appPlatform = createTauriPlatform();
export const appTaskCenter = createTaskCenterStore();
