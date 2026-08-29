/** 提示词详情列表的纯文本摘要展示变换；权威正文仍由提示词文件保存。 */
export function noteSummary(note: string, maxLength: number): string {
  const firstLine = note
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .find((line) => line !== "");
  if (firstLine === undefined || maxLength <= 0) return "";
  if (firstLine.length <= maxLength) return firstLine;
  return `${firstLine.slice(0, maxLength)}…`;
}
