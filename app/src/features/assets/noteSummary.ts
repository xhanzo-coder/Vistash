/**
 * 备注摘要（任务 9.2）。
 *
 * 详情列表的备注列只呈现一行摘要：备注是多行纯文本，列表里放不下也不该换行。
 * 摘要取首个非空行并折叠行内连续空白；截断追加省略号。这是纯展示变换，
 * 权威备注原文永远在素材元数据里。
 */

export function noteSummary(note: string, maxLength: number): string {
  const firstLine = note
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .find((line) => line !== "");
  if (firstLine === undefined || maxLength <= 0) return "";
  if (firstLine.length <= maxLength) return firstLine;
  return `${firstLine.slice(0, maxLength)}…`;
}
