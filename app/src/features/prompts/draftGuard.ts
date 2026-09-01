/**
 * 未保存主字段草稿的全局守卫。
 *
 * 聚焦编辑器挂载在工作区深处，而"切换库（一级入口）/关闭窗口"发生在 App 层：
 * 两层之间不为此提升状态——编辑器在挂载期间登记一个脏探针，App 层在放行导航前
 * 查询它；脏则请求编辑器弹出"保存/放弃/留在当前页"，并拦下本次导航。
 *
 * 探针是单槽位：同一时刻最多有一个聚焦编辑器实例（中央区互斥），后登记者覆盖，
 * 卸载时清空。jsdom 测试直接调用本模块的纯函数；Tauri 的关闭事件在 App 层做
 * 特性检测后接入，不在组件树里传播。
 */

export type PromptDraftGuard = {
  /** 是否存在未保存的主字段修改。 */
  isDirty: () => boolean;
  /** 请求编辑器呈现保存/放弃/留在当前页的选择。 */
  requestResolve: (continueAction: () => void) => void;
};

let guard: PromptDraftGuard | null = null;

/** 编辑器挂载时登记、卸载时以 null 注销。 */
export function setPromptDraftGuard(next: PromptDraftGuard | null): void {
  guard = next;
}

/**
 * 导航放行前的统一闸口：有未保存修改时请求解决并返回 true（调用方必须拦截）；
 * 无守卫或无修改时返回 false（放行）。
 */
export function blockIfPromptDraftDirty(continueAction: () => void): boolean {
  if (guard === null) return false;
  if (!guard.isDirty()) return false;
  guard.requestResolve(continueAction);
  return true;
}
