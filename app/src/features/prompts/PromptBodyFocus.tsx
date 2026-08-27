import { useEffect, useRef, useState } from "react";

import { asAppError } from "../../shared/errors";
import { updatePrompt } from "../../shared/ipc";
import type { AppError, PromptRow } from "../../shared/types";
import { ErrorLine } from "../library/ErrorLine";
import { useDialogFocusTrap } from "../workspace/dialogFocus";
import { setPromptDraftGuard } from "./draftGuard";
import { promptDisplayTitle } from "./promptDisplay";

type SaveStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "failed"; error: AppError };

/** 主字段草稿。权威里的可空字段在编辑态一律用空字符串表示"未填写"。 */
type FieldDrafts = {
  body: string;
  title: string;
  model: string;
  parameters: string;
};

function draftsOf(prompt: PromptRow): FieldDrafts {
  return {
    body: prompt.body,
    title: prompt.title ?? "",
    model: prompt.model ?? "",
    parameters: prompt.parameters ?? "",
  };
}

/** 空白等价于未填写：保存时空串归一为 null，脏检查同样按归一后比较。 */
function nullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : value;
}

function isDirty(prompt: PromptRow, drafts: FieldDrafts): boolean {
  return (
    drafts.body !== prompt.body ||
    (drafts.title.trim() === "" ? null : drafts.title) !== prompt.title ||
    (drafts.model.trim() === "" ? null : drafts.model) !== prompt.model ||
    (drafts.parameters.trim() === "" ? null : drafts.parameters) !== prompt.parameters
  );
}

/**
 * 长文本聚焦编辑器（任务 10.3 只读呈现，任务 10.4 升级为显式保存编辑）。
 *
 * 主字段（正文/标题/模型/参数）只在明确编辑状态中修改，由"保存"或 Ctrl+S 显式
 * 写入；保存失败不退出编辑状态也不丢弃草稿（规格硬约束）。备注是独立自动保存流，
 * 不进本状态机——它留在检查器里由 NoteAutoSaveEditor 负责。
 *
 * 导航拦截的结构性分工：编辑发生在占满中央区的聚焦视图里，此时集合视图不可达，
 * "切换素材"与脏草稿在结构上不会共存；而折叠编辑器（返回列表/Esc）、切换一级
 * 入口与关闭窗口都经 `draftGuard` 的脏探针拦下，弹出保存/放弃/留在当前页。
 *
 * 权威刷新把当前提示词移除后本视图自动卸载退回列表——这是唯一可能静默丢失草稿
 * 的路径（目标已不存在），属可接受边缘。
 */
export function PromptBodyFocus({
  prompt,
  initialEditing = false,
  onClose,
  onSaved,
}: {
  prompt: PromptRow;
  /** 由检查器"编辑主字段"进入时直接落在编辑状态。 */
  initialEditing?: boolean;
  onClose: () => void;
  /** 显式保存成功后调用：工作区据此刷新权威快照。 */
  onSaved: () => Promise<void> | void;
}) {
  const [editing, setEditing] = useState(initialEditing);
  const [drafts, setDrafts] = useState<FieldDrafts>(() => draftsOf(prompt));
  const [status, setStatus] = useState<SaveStatus>({ kind: "idle" });
  const [confirmClose, setConfirmClose] = useState(false);
  const pendingContinuationRef = useRef<(() => void) | null>(null);
  const focusRegionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const region = focusRegionRef.current;
    if (region === null) throw new Error("聚焦阅读区域未挂载");
    // 集合项目已卸载，必须显式接住键盘焦点，Esc 才会到达当前阅读上下文。
    region.focus({ preventScroll: true });
  }, []);

  const dirty = editing && isDirty(prompt, drafts);
  // 脏探针镜像：全局守卫在事件回调里查询，不能依赖渲染期闭包。
  const dirtyRef = useRef(false);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  useEffect(() => {
    setPromptDraftGuard({
      isDirty: () => dirtyRef.current,
      requestResolve: (continueAction) => {
        pendingContinuationRef.current = continueAction;
        setConfirmClose(true);
      },
    });
    return () => setPromptDraftGuard(null);
  }, []);

  // 只被事件回调调用：闭包里的 drafts 即当前渲染的最新值。
  async function attemptSave(): Promise<boolean> {
    if (!dirty || status.kind === "saving") return false;
    setStatus({ kind: "saving" });
    try {
      await updatePrompt(prompt.id, {
        body: drafts.body,
        title: nullable(drafts.title),
        model: nullable(drafts.model),
        parameters: nullable(drafts.parameters),
      });
      // 权威刷新后 props 更新，草稿与新权威一致，脏状态自然解除。
      await onSaved();
      dirtyRef.current = false;
      setStatus({ kind: "saved" });
      return true;
    } catch (raw) {
      // 失败不退出编辑、不清草稿：稳定错误码就地呈现。
      setStatus({ kind: "failed", error: asAppError(raw) });
      return false;
    }
  }

  /** 折叠/退出请求：干净则直接离开；有未保存修改先要三选一。 */
  function requestClose() {
    if (dirtyRef.current) {
      pendingContinuationRef.current = null;
      setConfirmClose(true);
      return;
    }
    onClose();
  }

  function leaveAfterResolution() {
    const continuation = pendingContinuationRef.current;
    pendingContinuationRef.current = null;
    setConfirmClose(false);
    if (continuation !== null) {
      continuation();
      return;
    }
    onClose();
  }

  function discardAndClose() {
    dirtyRef.current = false;
    setDrafts(draftsOf(prompt));
    setEditing(false);
    setStatus({ kind: "idle" });
    leaveAfterResolution();
  }

  /** 字段更新的唯一入口：任何新输入都让"已保存"失效回编辑态。 */
  function updateField(key: keyof FieldDrafts, value: string) {
    setDrafts((current): FieldDrafts => ({ ...current, [key]: value }));
    setStatus((current) => (current.kind === "saving" ? current : { kind: "idle" }));
  }

  // 初始聚焦与键盘纪律都在 DraftGuardDialog 内部落实（任务 11.3 抽出）。


  return (
    <section
      ref={focusRegionRef}
      tabIndex={-1}
      className="prompt-body-focus"
      aria-label="聚焦阅读"
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          if (editing) void attemptSave();
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          requestClose();
        }
      }}
    >
      <button type="button" className="back-button" onClick={requestClose}>
        返回列表
      </button>

      <h2>{promptDisplayTitle(prompt)}</h2>
      <p className="muted">
        {prompt.model ?? "未记录模型"} · 更新于 {prompt.updated_at.slice(0, 10)}
      </p>

      {!editing ? (
        <>
          {/* 只读呈现完整当前正文；修改必须显式进入编辑状态（规格）。 */}
          <pre className="focus-body">{prompt.body}</pre>
          <div className="button-row">
            <button
              type="button"
              className="primary-button"
              onClick={() => {
                setDrafts(draftsOf(prompt));
                setStatus({ kind: "idle" });
                setEditing(true);
              }}
            >
              编辑主字段
            </button>
          </div>
        </>
      ) : (
        <div className="prompt-edit-grid">
          <label className="prompt-edit-field">
            <span>标题</span>
            <input
              type="text"
              name="prompt-title"
              autoComplete="off"
              value={drafts.title}
              onChange={(event) => updateField("title", event.target.value)}
            />
          </label>
          <div className="prompt-edit-pair">
            <label className="prompt-edit-field">
              <span>模型 / 平台</span>
              <input
                type="text"
                name="prompt-model"
                autoComplete="off"
                value={drafts.model}
                onChange={(event) => updateField("model", event.target.value)}
              />
            </label>
            <label className="prompt-edit-field">
              <span>参数说明</span>
              <input
                type="text"
                name="prompt-parameters"
                autoComplete="off"
                value={drafts.parameters}
                onChange={(event) => updateField("parameters", event.target.value)}
              />
            </label>
          </div>
          <label className="prompt-edit-field">
            <span>正文</span>
            <textarea
              name="prompt-body"
              rows={14}
              value={drafts.body}
              onChange={(event) => updateField("body", event.target.value)}
            />
          </label>
          <div className="button-row">
            {/* 无修改或保存中禁用；Ctrl+S 与按钮共用同一条写入路径。 */}
            <button
              type="button"
              className="primary-button"
              disabled={!dirty || status.kind === "saving"}
              onClick={() => void attemptSave()}
            >
              保存
            </button>
            <button
              type="button"
              disabled={status.kind === "saving"}
              onClick={() => {
                // 取消 = 放弃修改并回到只读呈现。
                setDrafts(draftsOf(prompt));
                setStatus({ kind: "idle" });
                setEditing(false);
              }}
            >
              取消
            </button>
            <p role="status" aria-live="polite" className="note-status">
              {status.kind === "saving" && "正在保存…"}
              {status.kind === "saved" && "已保存"}
              {status.kind !== "saving" && status.kind !== "saved" && dirty && "有未保存的修改"}
            </p>
          </div>
          {status.kind === "failed" && (
            <>
              <ErrorLine error={status.error} />
              <p className="muted">保存失败；全部修改仍保留在上方编辑框中，可重试或取消。</p>
            </>
          )}
        </div>
      )}

      {confirmClose && (
        <DraftGuardDialog
          saving={status.kind === "saving"}
          onStay={() => {
            pendingContinuationRef.current = null;
            setConfirmClose(false);
          }}
          onDiscard={discardAndClose}
          onSaveAndLeave={() => {
            void (async () => {
              const saved = await attemptSave();
              if (saved) {
                leaveAfterResolution();
                return;
              }
              setConfirmClose(false);
            })();
          }}
        />
      )}
    </section>
  );
}

/**
 * 脏草稿三选一对话框（任务 11.3 抽出为独立挂载单元）。
 *
 * 焦点陷阱/Esc/触发器归还由 useDialogFocusTrap 在本组件挂载期统一落实：
 * Esc 是安全侧的"留在当前页"，Tab 圈在三个动作之间，关闭后焦点回到外层触发点。
 */
function DraftGuardDialog({
  saving,
  onStay,
  onDiscard,
  onSaveAndLeave,
}: {
  saving: boolean;
  onStay: () => void;
  onDiscard: () => void;
  onSaveAndLeave: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocusTrap(dialogRef, onStay);

  useEffect(() => {
    const button = cancelRef.current;
    if (button === null) throw new Error("草稿对话框取消按钮不存在");
    button.focus();
  }, []);

  return (
    <div className="dialog-backdrop">
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="prompt-draft-dialog-title"
        className="confirm-dialog"
      >
        <p className="eyebrow">UNSAVED</p>
        <h2 id="prompt-draft-dialog-title">有未保存的修改</h2>
        <p>主字段存在未保存的修改。保存后离开、放弃修改，还是留在当前页面？</p>
        <div className="dialog-actions">
          <button ref={cancelRef} type="button" onClick={onStay}>
            留在当前页
          </button>
          <button type="button" className="danger-ghost" onClick={onDiscard}>
            放弃修改
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={saving}
            onClick={onSaveAndLeave}
          >
            保存并离开
          </button>
        </div>
      </section>
    </div>
  );
}
