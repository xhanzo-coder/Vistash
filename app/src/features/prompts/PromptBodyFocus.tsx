import { promptDisplayTitle } from "./promptDisplay";
import type { PromptRow } from "../../shared/types";

/**
 * 长文本聚焦阅读视图（任务 10.3）。
 *
 * 规格允许长文本进入可扩展聚焦编辑器，但必须保持返回原列表位置的能力。本组件
 * 占满中央区替换集合视图；退出后集合视图重新挂载，滚动偏移由布局偏好经
 * useScrollRestore 恢复——"返回原列表位置"因此由既有滚动恢复机制保证，不需要
 * 额外记忆。编辑与显式保存状态机在任务 10.4 接入本容器。
 */
export function PromptBodyFocus({
  prompt,
  onClose,
}: {
  prompt: PromptRow;
  onClose: () => void;
}) {
  return (
    <section className="prompt-body-focus" aria-label="聚焦阅读">
      <button type="button" className="back-button" onClick={onClose}>
        返回列表
      </button>

      <h2>{promptDisplayTitle(prompt)}</h2>
      <p className="muted">
        {prompt.model ?? "未记录模型"} · 更新于 {prompt.updated_at.slice(0, 10)}
      </p>

      <pre className="focus-body">{prompt.body}</pre>
    </section>
  );
}
