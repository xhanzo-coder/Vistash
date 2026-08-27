/**
 * 瀑布流密度与原画幅几何（任务 9.1）。
 *
 * 纯计算：列数由容器宽度与期望瓦片宽度决定，瓦片高度按原画幅比例换算。
 * 位置窗口化交给 @tanstack/react-virtual（设计第八条：虚拟化依赖只负责位置
 * 与可见项），这里只提供它需要的稳定估算值。
 */

export type Aspect = { readonly width: number; readonly height: number };

export type WaterfallMetrics = {
  readonly columnCount: number;
  readonly laneWidth: number;
};

/** 列数随容器宽度增长、至少一列；列宽平分容器并扣除列间间隙。 */
export function waterfallMetrics(
  containerWidth: number,
  targetTileWidth: number,
  gap: number,
): WaterfallMetrics {
  const columnCount = Math.max(1, Math.floor((containerWidth + gap) / (targetTileWidth + gap)));
  const laneWidth = (containerWidth - gap * (columnCount - 1)) / columnCount;
  return { columnCount, laneWidth };
}

/** 按原画幅比例把列宽换算成瓦片高；宽或高非正时回退为正方形。 */
export function estimatedTileHeight(laneWidth: number, aspect: Aspect): number {
  if (!(aspect.width > 0) || !(aspect.height > 0)) return laneWidth;
  return (laneWidth * aspect.height) / aspect.width;
}
