/**
 * 窗口级 Ctrl+V 的认领规则（任务 5.3 接线，规则冻结于任务 5.2 失败测试）。
 *
 * asset-transfer 规格：文本输入控件获得焦点时 Ctrl+V 必须保持普通文本粘贴，
 * 只有事件目标不属于可编辑控件时，图片工作区才认领这次粘贴并尝试导入剪贴板。
 * 抢走备注框、搜索框里的原生粘贴等于破坏普通文本工作流。
 */
export function shouldClaimPaste(target: EventTarget | null): boolean {
  if (target instanceof HTMLElement) {
    // jsdom 不实现 isContentEditable（恒为 false），测试环境里靠 contenteditable
    // 特性兜底；真实 WebView 中两者判定一致。特性存在且不为 "false" 即可编辑。
    const attribute = target.getAttribute("contenteditable");
    if (
      target.isContentEditable ||
      (attribute !== null && attribute !== "false")
    ) {
      return false;
    }
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") {
      return false;
    }
  }
  // 键盘事件可能派发到 window 本身：没有具体目标也按"工作区在焦点"处理。
  return true;
}
