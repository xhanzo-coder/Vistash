/** 提示词瀑布流的纯几何计算；位置窗口化交给 @tanstack/react-virtual。 */
export type WaterfallMetrics = {
  readonly columnCount: number;
  readonly laneWidth: number;
};

export function waterfallMetrics(
  containerWidth: number,
  targetTileWidth: number,
  gap: number,
): WaterfallMetrics {
  const columnCount = Math.max(1, Math.floor((containerWidth + gap) / (targetTileWidth + gap)));
  const laneWidth = (containerWidth - gap * (columnCount - 1)) / columnCount;
  return { columnCount, laneWidth };
}
