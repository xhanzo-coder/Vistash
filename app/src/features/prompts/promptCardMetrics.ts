/**
 * 提示词卡片的确定性几何估算（任务 10.1）。
 *
 * 窗口化必须在不测量 DOM 的前提下估算卡片高度，滚动恢复才稳定，因此高度只能
 * 完全由行数据与列宽决定：封面按固定宽高比、标题固定一行（CSS 省略）、正文
 * 预览截断到 `PROMPT_CARD_MAX_BODY_LINES` 行。`styles.css` 里正文预览的
 * `-webkit-line-clamp` 与行高必须与本文件的常量保持一致——估算和裁剪说的是
 * 同一件事，两边各说各话滚动位置就会漂移。
 *
 * 正文字符宽度按 CJK 为主的内容取近似值；这是估算而非排版，误差由过扫缓冲区
 * 吸收，不追求像素级精确。
 */

/** 封面区域的宽高比（宽 / 高）。 */
export const PROMPT_CARD_COVER_ASPECT = 3 / 2;

/** 正文预览的最大行数；CSS 的 line-clamp 使用同一常量语义。 */
export const PROMPT_CARD_MAX_BODY_LINES = 4;

const CARD_PADDING = 20;
const SECTION_GAP = 8;
const TITLE_LINE_HEIGHT = 20;
const BODY_LINE_HEIGHT = 20;
/** 参与行数估算的正文长度上限：更长的正文反正只会被裁到同样的四行。 */
const PREVIEW_CHAR_BUDGET = 240;
/** 每行可容纳的近似字符宽度（px / 字符），按 CJK 全角为主估。 */
const CHAR_WIDTH = 13;
/** 单字符宽度的最小防线：列宽极窄时不让除法结果发散。 */
const MIN_CHARS_PER_LINE = 8;

function previewLineCount(body: string, laneWidth: number): number {
  const charsPerLine = Math.max(MIN_CHARS_PER_LINE, Math.floor((laneWidth - CARD_PADDING) / CHAR_WIDTH));
  const budget = body.slice(0, PREVIEW_CHAR_BUDGET).length;
  const lines = Math.ceil(budget / charsPerLine);
  return Math.min(Math.max(lines, 1), PROMPT_CARD_MAX_BODY_LINES);
}

/** 卡片内容高度（不含行间 GAP；调用方按资产瀑布流同款约定自行扣除）。 */
export function estimatedPromptCardHeight(
  laneWidth: number,
  prompt: { readonly body: string; readonly linked_image_hashes: readonly string[] },
): number {
  const coverHeight =
    prompt.linked_image_hashes.length > 0 ? laneWidth / PROMPT_CARD_COVER_ASPECT : 0;
  const bodyLines = previewLineCount(prompt.body, laneWidth);
  return (
    CARD_PADDING +
    coverHeight +
    SECTION_GAP +
    TITLE_LINE_HEIGHT +
    SECTION_GAP +
    bodyLines * BODY_LINE_HEIGHT
  );
}
