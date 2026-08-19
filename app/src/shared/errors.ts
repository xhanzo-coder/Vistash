import { ERROR_TEXT } from "./errorText";
import type { AppError } from "./types";

/**
 * 判断一个未知值是否是后端的 `AppError`。
 *
 * 用类型守卫而不是 `as AppError`：断言只是让编译器闭嘴，运行时该值仍可能是别的东西，
 * 而随后读 `error.code` 会得到 undefined，界面就会显示一条没有错误码的失败——那正是
 * `app-shell` 规格禁止的"只显示通用失败文案"。
 */
function isAppError(value: unknown): value is AppError {
  if (typeof value !== "object" || value === null) return false;
  // 用 in 收窄而不是断言成 Record：断言只是让编译器闭嘴，in 是运行时真的检查。
  if (!("code" in value) || typeof value.code !== "string") return false;
  if (!("detail" in value)) return true;
  const detail: unknown = value.detail;
  return detail === null || detail === undefined || typeof detail === "string";
}

/** 结构不符时使用的错误码。它不来自后端，因此不在 `ERROR_TEXT` 的覆盖检查范围内。 */
export const UNEXPECTED_SHAPE_CODE = "ipc.unexpected_error_shape";

/**
 * 把 `invoke` 抛出的任意值收敛为 `AppError`。
 *
 * 结构不符时**不伪装成某个已知错误码**，而是造一条明确说"后端返回了非预期结构"的错误并
 * 原样带上那个值。伪装会让一个真正的协议错误看起来像一次普通的库读写失败，从而把排查
 * 引向完全错误的方向。
 */
export function asAppError(value: unknown): AppError {
  if (value instanceof IpcError) return value.appError;
  if (isAppError(value)) {
    return { code: value.code, detail: value.detail ?? null };
  }
  let raw: string;
  try {
    raw = JSON.stringify(value);
  } catch {
    raw = String(value);
  }
  return {
    code: UNEXPECTED_SHAPE_CODE,
    detail: `后端返回了非预期的错误结构：${raw}`,
  };
}

/** 错误码对应的中文说明。表里没有该码时如实说明缺失，而不是给一句含糊的通用文案。 */
export function describeCode(code: string): string {
  if (code === UNEXPECTED_SHAPE_CODE) return "前后端之间的错误结构不一致。";
  return ERROR_TEXT[code] ?? `未登记的错误码。这本身是一个缺陷：文案表缺少 ${code} 的说明。`;
}

/**
 * 供界面直接呈现的一行文本：错误码与可读说明同时出现。
 *
 * 规格要求两者并存，因此这里不提供"只要说明"或"只要码"的变体——那种变体一旦存在，
 * 迟早会有某个视图只用其中一个。
 */
export function formatError(error: AppError): string {
  const text = describeCode(error.code);
  return error.detail === null
    ? `[${error.code}] ${text}`
    : `[${error.code}] ${text}（${error.detail}）`;
}

/**
 * IPC 失败。
 *
 * 用 `Error` 的子类而不是直接抛出裸对象：裸对象抛出会丢掉调用栈，而调用栈是排查
 * "这个失败是从哪个视图发出的"的唯一线索。
 */
export class IpcError extends Error {
  readonly appError: AppError;

  constructor(appError: AppError) {
    super(formatError(appError));
    this.name = "IpcError";
    this.appError = appError;
  }
}
