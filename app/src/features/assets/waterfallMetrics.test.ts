/**
 * 瀑布流密度与原画幅几何的纯计算合同（任务 9.1）。
 *
 * 列数只由容器宽度与期望瓦片宽度（密度旋钮）决定；每个瓦片的高度按原画幅
 * 比例换算，坏比例安全回退为正方形，绝不让一条脏数据破坏整列布局。
 */

import { describe, expect, test } from "vitest";

import { estimatedTileHeight, waterfallMetrics } from "./waterfallMetrics";

const GAP = 12;

describe("密度列数", () => {
  test("列数随容器宽度增长且不小于 1", () => {
    expect(waterfallMetrics(1200, 280, GAP).columnCount).toBe(4);
    expect(waterfallMetrics(900, 280, GAP).columnCount).toBe(3);
    expect(waterfallMetrics(300, 280, GAP).columnCount).toBe(1);
    // 容器比一块瓦片还窄：仍保持一列，不产生 0 或负数。
    expect(waterfallMetrics(120, 280, GAP).columnCount).toBe(1);
  });

  test("列宽平分容器并扣除间隙，宽度非负", () => {
    const { columnCount, laneWidth } = waterfallMetrics(1200, 280, GAP);
    expect(columnCount).toBe(4);
    expect(laneWidth).toBeCloseTo((1200 - GAP * 3) / 4, 5);
    // 单列时列宽即容器宽。
    expect(waterfallMetrics(500, 280, GAP).laneWidth).toBe(500);
  });
});

describe("原画幅高度换算", () => {
  test("高度按列宽与画幅比例换算", () => {
    expect(estimatedTileHeight(300, { width: 1500, height: 3000 })).toBeCloseTo(600, 5);
    expect(estimatedTileHeight(300, { width: 3000, height: 1500 })).toBeCloseTo(150, 5);
  });

  test("非法画幅安全回退为正方形", () => {
    expect(estimatedTileHeight(300, { width: 0, height: 3000 })).toBe(300);
    expect(estimatedTileHeight(300, { width: 1500, height: 0 })).toBe(300);
    expect(estimatedTileHeight(300, { width: -5, height: 100 })).toBe(300);
    expect(estimatedTileHeight(300, { width: Number.NaN, height: 100 })).toBe(300);
  });
});
