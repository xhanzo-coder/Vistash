/**
 * 集合视图的 roving focus（任务 8.5/9.1/9.2 共用）。
 *
 * 键盘导航改变活动项后：把目标滚进虚拟化窗口，再把 DOM 焦点交给对应卡片。
 * 两条纪律：
 * - 焦点本就不在集合容器内时不抢焦点（使用者在别处打字/操作不被打断）；
 * - scrollToIndex 触发的重渲染可能尚未落出目标卡片，下一帧再补一次。
 *
 * 卡片查找与滚动由视图以稳定回调注入（useCallback 包住各自的资产数组和
 * 虚拟化实例），钩子据此保持与单视图实现一致的重跑节奏，不额外抢焦点。
 */

import { useEffect, type RefObject } from "react";

export function useRovingFocus(
  containerRef: RefObject<HTMLElement | null>,
  focusedId: string | null,
  findById: (id: string) => number,
  scrollToIndex: (index: number) => void,
  findItem: (id: string) => HTMLElement | null,
): void {
  useEffect(() => {
    const container = containerRef.current;
    if (container === null || focusedId === null) return undefined;
    if (!container.contains(document.activeElement)) return undefined;
    const index = findById(focusedId);
    if (index === -1) return undefined;
    scrollToIndex(index);
    const focusTarget = () => {
      findItem(focusedId)?.focus();
    };
    focusTarget();
    const frame = requestAnimationFrame(focusTarget);
    return () => cancelAnimationFrame(frame);
  }, [containerRef, focusedId, findById, scrollToIndex, findItem]);
}
