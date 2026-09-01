/**
 * 提示词的可识别标题。
 *
 * 规格要求：标题缺省时，中央视图与全局搜索必须用正文首行标识该素材。这条推导
 * 如果散在各个视图里，同一素材就会在不同界面拿到不同名字，因此收敛在这里作为
 * 唯一推导点。
 */

/** 正文首个非空行；全部为空行时回退到去除首尾空白的正文。 */
export function firstBodyLine(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed !== "") return trimmed;
  }
  return body.trim();
}

/** 卡片、详情列表与搜索共用的展示标题：显式标题优先（含纯空白视同缺省）。 */
export function promptDisplayTitle(prompt: { readonly title: string | null; readonly body: string }): string {
  const title = prompt.title?.trim() ?? "";
  return title !== "" ? title : firstBodyLine(prompt.body);
}

const PROMPT_DATE_FORMAT = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });

export function formatPromptDate(value: string): string {
  return PROMPT_DATE_FORMAT.format(new Date(value));
}
