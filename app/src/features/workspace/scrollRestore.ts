/**
 * 集合视图的滚动恢复（任务 9.1/9.2 共用）。
 *
 * 每个滚动键只恢复一次：挂载时按布局偏好里保存的偏移定位，之后滚动位置归还
 * 使用者掌控——偏好的新值不再把视口拽走。键变化（换库、换视图记忆槽）才允许
 * 再次恢复。
 */

import { useEffect, useRef, type RefObject } from "react";

export function useScrollRestore(
  scrollRef: RefObject<HTMLElement | null>,
  scrollKey: string,
  savedOffset: number,
): void {
  const restoredKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (restoredKeyRef.current === scrollKey) return;
    restoredKeyRef.current = scrollKey;
    const el = scrollRef.current;
    if (el === null || !(savedOffset > 0)) return;
    el.scrollTop = savedOffset;
  }, [scrollKey, savedOffset, scrollRef]);
}
