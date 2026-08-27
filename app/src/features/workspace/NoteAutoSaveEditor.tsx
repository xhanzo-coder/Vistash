import { useEffect, useRef, useState } from "react";

import { asAppError } from "../../shared/errors";
import type { AppError } from "../../shared/types";
import { ErrorLine } from "../library/ErrorLine";

/** 停止输入到自动保存的间隔（ms）。设计只约定"延迟自动保存"，未定数值。 */
const DEBOUNCE_MS = 800;

type RetainedDraft = {
  text: string;
  error: AppError | null;
  revision: number;
};

/** 未落盘备注按素材身份保留，跨检查器卸载恢复；成功写入后立即移除。 */
const retainedDrafts = new Map<string, RetainedDraft>();
let nextDraftRevision = 0;

function retainDraft(draftKey: string, text: string, error: AppError | null): RetainedDraft {
  nextDraftRevision += 1;
  const retained = { text, error, revision: nextDraftRevision };
  retainedDrafts.set(draftKey, retained);
  return retained;
}

function claimRetainedRevision(
  draftKey: string,
  text: string,
  ownedRevision: number | null,
): number | null {
  const retained = retainedDrafts.get(draftKey);
  if (retained === undefined) return retainDraft(draftKey, text, null).revision;
  return retained.revision === ownedRevision ? retained.revision : null;
}

function deleteRetainedRevision(draftKey: string, revision: number): boolean {
  const retained = retainedDrafts.get(draftKey);
  if (retained === undefined || retained.revision !== revision) return false;
  retainedDrafts.delete(draftKey);
  return true;
}

function failRetainedRevision(draftKey: string, revision: number, error: AppError): boolean {
  const retained = retainedDrafts.get(draftKey);
  if (retained === undefined || retained.revision !== revision) return false;
  retainedDrafts.set(draftKey, { ...retained, error });
  return true;
}

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
  draftKey,
  label,
  initial,
  save,
}: {
  /** 图片 hash 或提示词 ID；两类包装必须加领域前缀避免碰撞。 */
  draftKey: string;
  /** 编辑框的 aria-label，由各侧包装提供（如"图片备注"）。 */
  label: string;
  /** 权威备注初值；仅在挂载时读取。 */
  initial: string;
  /** 权威写入路径；失败抛错由本组件转为稳定错误呈现，草稿不动。 */
  save: (text: string) => Promise<void>;
}) {
  const retained = retainedDrafts.get(draftKey);
  const revisionRef = useRef<number | null>(retained?.revision ?? null);
  const [draft, setDraft] = useState(() => retained?.text ?? initial);
  const [status, setStatus] = useState<SaveStatus>(() =>
    retained?.error === undefined || retained.error === null
      ? retained === undefined
        ? { kind: "idle" }
        : { kind: "editing" }
      : { kind: "failed", error: retained.error },
  );

  // 写入路径只读 ref：防抖回调、失焦、快捷键共享同一份最新值，无闭包过期问题；
  // 卸载补写的 effect 因此可以只挂载一次。
  const draftRef = useRef(draft);
  const dirtyRef = useRef(retained !== undefined);
  const saveRef = useRef(save);
  saveRef.current = save;
  const mountedRef = useRef(true);
  const inFlightRef = useRef<Promise<void> | null>(null);
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
    const revision = claimRetainedRevision(draftKey, text, revisionRef.current);
    if (revision === null) return;
    revisionRef.current = revision;
    if (mountedRef.current) setStatus({ kind: "saving" });
    const write = saveRef.current(text);
    inFlightRef.current = write;
    try {
      await write;
      if (draftRef.current === text) {
        // 保存期间没有新输入：权威值已等于草稿。
        if (deleteRetainedRevision(draftKey, revision)) {
          dirtyRef.current = false;
          revisionRef.current = null;
          if (mountedRef.current) setStatus({ kind: "saved" });
        }
      } else {
        // 保存期间又有输入：保持编辑态并重新排队。
        if (mountedRef.current) setStatus({ kind: "editing" });
        scheduleSave();
      }
    } catch (raw) {
      // 失败不动草稿：dirty 保持 true，下一次输入/失焦/快捷键都会重试。
      const error = asAppError(raw);
      if (failRetainedRevision(draftKey, revision, error) && mountedRef.current) {
        setStatus({ kind: "failed", error });
      }
    } finally {
      if (inFlightRef.current === write) inFlightRef.current = null;
    }
  }

  // 卸载时还有未落盘草稿：保留草稿并补写。失败进入注册表，返回同一素材时
  // 恢复原文与稳定错误；成功才删除，绝不静默丢弃。
  useEffect(() => {
    // StrictMode 会执行 setup→cleanup→setup；每次 setup 都重新取得界面状态更新资格。
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      if (dirtyRef.current && inFlightRef.current === null) {
        const text = draftRef.current;
        const revision = claimRetainedRevision(draftKey, text, revisionRef.current);
        if (revision === null) return;
        revisionRef.current = revision;
        void saveRef.current(text).then(
          () => {
            if (deleteRetainedRevision(draftKey, revision)) revisionRef.current = null;
            return undefined;
          },
          (raw: unknown) => {
            failRetainedRevision(draftKey, revision, asAppError(raw));
            return undefined;
          },
        );
      }
    };
  }, [draftKey]);

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
          revisionRef.current = retainDraft(draftKey, event.target.value, null).revision;
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
