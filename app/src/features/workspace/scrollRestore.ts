/**
 * 集合视图的滚动恢复。
 *
 * 每个滚动键只恢复一次：挂载时按布局偏好里保存的偏移定位，之后滚动位置归还
 * 使用者掌控——偏好的新值不再把视口拽走。视图以库 ID 作 key 重挂载（见两个
 * 工作区），换库即得到全新实例，各自等待自己的读取结果再恢复。
 *
 * 键只在真正应用偏移时才被记账：挂载瞬间布局可能还没从磁盘读回（偏移为默认
 * 值 0），此时不消费键，等真实值到达后仍能恢复；否则首次恢复会被空偏移抢先作废。
 */

import { useEffect, useRef, type RefObject } from "react";

export function useScrollRestore(
  scrollRef: RefObject<HTMLElement | null>,
  scrollKey: string,
  savedOffset: number,
): void {
  const restoredKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el === null || !(savedOffset > 0)) return;
    if (restoredKeyRef.current === scrollKey) return;
    restoredKeyRef.current = scrollKey;
    el.scrollTop = savedOffset;
  }, [scrollKey, savedOffset, scrollRef]);
}
