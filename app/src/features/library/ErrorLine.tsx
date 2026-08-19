import { formatError } from "../../shared/errors";
import type { AppError } from "../../shared/types";

/**
 * 一条带错误码的失败。
 *
 * `app-shell` 规格要求任何携带错误码的失败都必须同时呈现错误码本身与可读说明，禁止只显示
 * 通用失败文案。因此本项目里**没有**一个"只显示一句话"的错误组件——那种组件一旦存在，
 * 就一定会有视图用它把错误码吃掉。
 */
export function ErrorLine({ error }: { error: AppError }) {
  return (
    <p role="alert" data-error-code={error.code}>
      {formatError(error)}
    </p>
  );
}
