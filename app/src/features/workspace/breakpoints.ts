import { useEffect, useState } from "react";

/**
 * 窗口层级断点。
 *
 * 断点按中央内容最小可用宽度确定：大于 1,080 CSS px 三栏齐备；小于等于 1,080
 * 左右栏默认收起经边缘入口开抽屉；小于等于 720 进一步压缩顶栏、工具条与详情列。
 * 只认 CSS px 视口宽度，不按物理像素或系统缩放百分比另建分支。数值必须与
 * styles.css 的媒体查询保持一致——breakpoints.test.ts 把两者钉在一起。
 */

export const BREAKPOINTS = {
  /** 小于等于此值：左右栏收起为抽屉。 */
  medium: 1080,
  /** 小于等于此值：进一步压缩顶栏、工具条与详情列。 */
  narrow: 720,
} as const;

export type WindowTier = "wide" | "medium" | "narrow";

export function tierOf(width: number): WindowTier {
  if (width <= BREAKPOINTS.narrow) return "narrow";
  if (width <= BREAKPOINTS.medium) return "medium";
  return "wide";
}

/** 订阅窗口宽度跨越断点的变化，返回当前层级。 */
export function useWindowTier(): WindowTier {
  const [tier, setTier] = useState<WindowTier>(() => tierOf(window.innerWidth));

  useEffect(() => {
    const queries = [
      window.matchMedia(`(max-width: ${BREAKPOINTS.medium}px)`),
      window.matchMedia(`(max-width: ${BREAKPOINTS.narrow}px)`),
    ];
    // 以实际视口宽度为准同步层级：两条查询的任何一条翻转都意味着跨过了断点。
    const sync = () => setTier(tierOf(window.innerWidth));
    for (const query of queries) query.addEventListener("change", sync);
    return () => {
      for (const query of queries) query.removeEventListener("change", sync);
    };
  }, []);

  return tier;
}
