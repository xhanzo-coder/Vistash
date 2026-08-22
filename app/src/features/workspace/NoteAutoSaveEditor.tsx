import { useEffect, useRef, useState } from "react";

import { asAppError } from "../../shared/errors";
import type { AppError } from "../../shared/types";
import { ErrorLine } from "../library/ErrorLine";

/** 停止输入到自动保存的间隔（ms）。设计只约定"延迟自动保存"，未定数值。 */
const DEBOUNCE_MS = 800;

type SaveStatus =
  | { kind: "idle" }
  | { kind: "editing" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "failed"; error: AppError };

/**
 * 备注自动保存编辑器的共享状态机（任务 9.4/10.4）。
 *
 * 多行纯文本，不做任何 Markdown/富文本解析。保存时机有三：停止输入 800ms、
 * 失焦、Ctrl+Enter；三者共用同一条写入路径，失败时草稿原样留在编辑框并显示
 * 后端稳定错误码（规格：失败 MUST NOT 丢弃当前编辑文本）。图片侧与提示词侧
 * 各以薄包装注入自己的写入命令与无障碍命名——机器只实现一次。
 *
 * 调用方以条目身份作 key 渲染本组件——换活动项即重新挂载，草稿与状态从权威值
 * 重新开始。
 */
export function NoteAutoSaveEditor({
  label,
  initial,
  save,
}: {
  /** 编辑框的 aria-label，由各侧包装提供（如"图片备注"）。 */
  label: string;
  /** 权威备注初值；仅在挂载时读取。 */
  initial: string;
  /** 权威写入路径；失败抛错由本组件转为稳定错误呈现，草稿不动。 */
  save: (text: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(initial);
  const [status, setStatus] = useState<SaveStatus>({ kind: "idle" });

  // 写入路径只读 ref：防抖回调、失焦、快捷键共享同一份最新值，无闭包过期问题；
  // 卸载补写的 effect 因此可以只挂载一次。
  const draftRef = useRef(draft);
  const dirtyRef = useRef(false);
  const saveRef = useRef(save);
  saveRef.current = save;
  /** 待触发的防抖计时器；null 表示没有排队的自动保存。 */
  const timerRef = useRef<number | null>(null);

  function scheduleSave() {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void attemptSave();
    }, DEBOUNCE_MS);
  }

  async function attemptSave() {
    if (!dirtyRef.current) return;
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const text = draftRef.current;
    setStatus({ kind: "saving" });
    try {
      await saveRef.current(text);
      if (draftRef.current === text) {
        // 保存期间没有新输入：权威值已等于草稿。
        dirtyRef.current = false;
        setStatus({ kind: "saved" });
      } else {
        // 保存期间又有输入：保持编辑态并重新排队。
        setStatus({ kind: "editing" });
        scheduleSave();
      }
    } catch (raw) {
      // 失败不动草稿：dirty 保持 true，下一次输入/失焦/快捷键都会重试。
      setStatus({ kind: "failed", error: asAppError(raw) });
    }
  }

  // 卸载时还有未落盘的草稿（例如使用者直接点了另一项）：尽力补一次写入。
  // 失败静默——下次回到该条目时编辑框会从权威值重建，不会显示过期成功。
  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      if (dirtyRef.current) {
        void saveRef.current(draftRef.current).catch(() => {});
      }
    },
    [],
  );

  return (
    <div className="note-editor">
      <textarea
        aria-label={label}
        rows={5}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          draftRef.current = event.target.value;
          dirtyRef.current = true;
          setStatus({ kind: "editing" });
          scheduleSave();
        }}
        onBlur={() => void attemptSave()}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            void attemptSave();
          }
        }}
      />
      <p role="status" aria-live="polite" className="note-status">
        {status.kind === "editing" && "有未保存的修改"}
        {status.kind === "saving" && "正在保存…"}
        {status.kind === "saved" && "已保存"}
      </p>
      {status.kind === "failed" && (
        <>
          {/* 草稿仍在上方编辑框里，这里只负责稳定错误码。 */}
          <ErrorLine error={status.error} />
          <p className="muted">内容尚未保存；再次修改、移出焦点或按 Ctrl+Enter 都会重试。</p>
        </>
      )}
    </div>
  );
}
