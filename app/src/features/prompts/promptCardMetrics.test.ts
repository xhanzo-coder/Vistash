import { describe, expect, test } from "vitest";

import { PROMPT_CARD_MAX_BODY_LINES, estimatedPromptCardHeight } from "./promptCardMetrics";

const SHORT_BODY = "cinematic night";
/** 足以超过最大行数预算的长正文。 */
const LONG_BODY = "很长的提示词。".repeat(120);
/** 无图、单行正文时的基准高度：内边距 + 标题行 + 两段间距 + 一行正文。 */
const CARD_BASE = 20 + 8 + 20 + 8 + 18 + 8;

describe("提示词卡片高度估算", () => {
  test("有封面的卡片比同正文的无图卡片高出一个封面比例的高度", () => {
    const textOnly = estimatedPromptCardHeight(280, { body: SHORT_BODY, linked_image_hashes: [] });
    const withCover = estimatedPromptCardHeight(280, {
      body: SHORT_BODY,
      linked_image_hashes: ["a".repeat(64)],
    });
    expect(withCover - textOnly).toBeCloseTo(280 / (3 / 2), 5);
  });

  test("正文行数随长度增长但截断到最大行数", () => {
    const short = estimatedPromptCardHeight(280, { body: SHORT_BODY, linked_image_hashes: [] });
    const medium = estimatedPromptCardHeight(280, { body: SHORT_BODY + SHORT_BODY, linked_image_hashes: [] });
    expect(medium).toBeGreaterThan(short);

    const longA = estimatedPromptCardHeight(280, { body: LONG_BODY, linked_image_hashes: [] });
    const longB = estimatedPromptCardHeight(560, { body: LONG_BODY + LONG_BODY, linked_image_hashes: [] });
    // 两者都触顶：增量只可能来自封面/标题等与正文无关的项，这里都没有。
    const capped = CARD_BASE + PROMPT_CARD_MAX_BODY_LINES * 20;
    expect(longA).toBe(capped);
    expect(longB).toBe(capped);
  });

  test("列宽为 0 或极窄时不产生非有限值", () => {
    for (const width of [0, 1, 40]) {
      const height = estimatedPromptCardHeight(width, {
        body: LONG_BODY,
        linked_image_hashes: ["a".repeat(64)],
      });
      expect(Number.isFinite(height)).toBe(true);
      expect(height).toBeGreaterThan(0);
    }
  });
});
