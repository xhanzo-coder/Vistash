/**
 * 模态对话框的键盘可访问性（任务 11.3）。
 *
 * 三条纪律一次落实：
 * - 焦点陷阱：Tab/Shift+Tab 只在对话框内可聚焦元素间循环，不泄漏到底层页面；
 * - Esc 走安全侧：转交调用者的关闭回调（通常是"留在当前页/取消"），并阻断冒泡，
 *   底层容器的全局 Esc 语法（清空选择、退出聚焦模式）不会同时触发；
 * - 触发器归还：挂载时记住打开前的活跃元素，卸载时把焦点还回去——关闭对话框
 *   的键盘使用者回到他出发的位置，而不是丢回文档开头。
 */

import { useEffect, useRef, type RefObject } from "react";

/** 圈内候选：对话框内常见的可聚焦控件。disabled 的不可停留。 */
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function useDialogFocusTrap(
  dialogRef: RefObject<HTMLElement | null>,
  onEscape: () => void,
): void {
  // 关闭回调经 ref 取最新值：钩子的键监听只在挂载时装一次，避免每轮渲染
  // 重装监听、更避免把"触发器"误记成对话框自己的默认聚焦按钮。
  const escapeRef = useRef(onEscape);
  useEffect(() => {
    escapeRef.current = onEscape;
  });

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) throw new Error("对话框元素在挂载后不存在");
    const trigger = document.activeElement;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        escapeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (first === undefined || last === undefined) return;
      // 全托管：每一站都手动算出并 preventDefault，不依赖浏览器的自然 Tab 序
      // （jsdom 没有该行为；真实环境里 disabled 态变化也不会让圈漏人）。
      event.preventDefault();
      const current = document.activeElement;
      const index = focusable.findIndex((el) => el === current);
      let next: HTMLElement;
      if (index === -1) {
        // 焦点不在圈内（含 body）：Shift 从圈尾进，正向从圈首进。
        next = event.shiftKey ? last : first;
      } else if (event.shiftKey) {
        const previous = focusable[(index - 1 + focusable.length) % focusable.length];
        next = previous ?? last;
      } else {
        const following = focusable[(index + 1) % focusable.length];
        next = following ?? first;
      }
      next.focus();
    };

    dialog.addEventListener("keydown", onKeyDown);
    return () => {
      dialog.removeEventListener("keydown", onKeyDown);
      // 归还条件：焦点仍在圈内（含 body 默认态）。已被显式移走的不抢。
      const current = document.activeElement;
      if (
        trigger instanceof HTMLElement &&
        (current === null || current === document.body || dialog.contains(current))
      ) {
        trigger.focus();
      }
    };
  }, [dialogRef]);
}
