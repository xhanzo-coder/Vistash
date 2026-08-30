import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { asAppError } from "../../../shared/errors";
import { createPrompt } from "../../../shared/ipc";
import type { AppError, PromptAsset } from "../../../shared/types";
import { ErrorLine } from "../../../features/library/ErrorLine";
import { Button } from "../../../ui/button/Button";
import { setPromptDraftGuard } from "../../../features/prompts/draftGuard";
import { PromptDraftGuardDialog } from "../../../features/prompts/PromptDraftGuardDialog";
import styles from "./PromptWorkspace.module.css";

type CreateStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "failed"; error: AppError };

function nullable(value: string): string | null {
  return value.trim() === "" ? null : value;
}

/**
 * 手写提示词的聚焦创作面板。正文是唯一必填项；组织与图片关联在创建后的
 * 检查器继续完成，避免第一次写入被次要字段淹没。
 */
export function PromptCreateFocus({ initialFolder, onCancel, onCreated }: {
  initialFolder: string | null;
  onCancel: () => void;
  onCreated: (prompt: PromptAsset) => Promise<void> | void;
}): ReactNode {
  const [title, setTitle] = useState("");
  const [model, setModel] = useState("");
  const [parameters, setParameters] = useState("");
  const [body, setBody] = useState("");
  const [targetFolder] = useState(initialFolder);
  const [status, setStatus] = useState<CreateStatus>({ kind: "idle" });
  const [confirmCancel, setConfirmCancel] = useState(false);
  const regionRef = useRef<HTMLElement>(null);
  const dirtyRef = useRef(false);
  const pendingContinuationRef = useRef<(() => void) | null>(null);
  const dirty = title !== "" || model !== "" || parameters !== "" || body !== "";

  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  useEffect(() => {
    setPromptDraftGuard({
      isDirty: () => dirtyRef.current,
      requestResolve: (continueAction) => {
        pendingContinuationRef.current = continueAction;
        setConfirmCancel(true);
      },
    });
    return () => setPromptDraftGuard(null);
  }, []);

  async function save(): Promise<boolean> {
    if (body.trim() === "" || status.kind === "saving") return false;
    setStatus({ kind: "saving" });
    try {
      const created = await createPrompt({
        body,
        title: nullable(title),
        model: nullable(model),
        parameters: nullable(parameters),
        folders: targetFolder === null ? [] : [targetFolder],
        tags: [],
      });
      dirtyRef.current = false;
      await onCreated(created);
      return true;
    } catch (raw) {
      setStatus({ kind: "failed", error: asAppError(raw) });
      return false;
    }
  }

  function requestCancel(): void {
    if (dirty) {
      pendingContinuationRef.current = null;
      setConfirmCancel(true);
      return;
    }
    onCancel();
  }

  function handleShortcut(event: KeyboardEvent<HTMLElement>): void {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void save();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      requestCancel();
    }
  }

  return (
    <section ref={regionRef} tabIndex={-1} className={styles.createFocus} aria-label="新建提示词编辑器" onKeyDown={handleShortcut}>
      <header className={styles.createHeader}>
        <div>
          <h2>写下新的提示词</h2>
          <p>{targetFolder === null ? "保存到提示词根位置" : `保存到 ${targetFolder}`}</p>
        </div>
        <Button variant="ghost" onClick={requestCancel} disabled={status.kind === "saving"}>返回列表</Button>
      </header>
      <div className={styles.createFields}>
        <label className={styles.createField}>
          <span>标题 <small>可选</small></span>
          <input name="prompt-create-title" autoComplete="off" value={title} onChange={(event) => setTitle(event.currentTarget.value)} placeholder="给这条提示词一个便于查找的名字" />
        </label>
        <div className={styles.createPair}>
          <label className={styles.createField}>
            <span>模型 / 平台 <small>可选</small></span>
            <input name="prompt-create-model" autoComplete="off" value={model} onChange={(event) => setModel(event.currentTarget.value)} placeholder="例如 Midjourney、SDXL" />
          </label>
          <label className={styles.createField}>
            <span>参数 <small>可选</small></span>
            <input name="prompt-create-parameters" autoComplete="off" value={parameters} onChange={(event) => setParameters(event.currentTarget.value)} placeholder="尺寸、采样器或其他说明" />
          </label>
        </div>
        <label className={`${styles.createField} ${styles.createBody}`}>
          <span>提示词正文</span>
          <textarea autoFocus name="prompt-create-body" value={body} onChange={(event) => setBody(event.currentTarget.value)} placeholder="输入希望保存和复用的完整提示词…" />
        </label>
      </div>
      <footer className={styles.createFooter}>
        <span>Ctrl+S 保存</span>
        <Button variant="primary" onClick={() => void save()} disabled={body.trim() === "" || status.kind === "saving"}>
          {status.kind === "saving" ? "正在保存…" : "保存提示词"}
        </Button>
      </footer>
      {status.kind === "failed" ? <div className={styles.createError}><ErrorLine error={status.error} /><p>保存失败，草稿仍完整保留在编辑器中。</p></div> : null}
      {confirmCancel ? (
        <PromptDraftGuardDialog
          saving={status.kind === "saving"}
          description="保存后继续、放弃草稿，还是留在当前页面？"
          discardLabel="放弃草稿"
          saveLabel="保存并继续"
          onStay={() => { pendingContinuationRef.current = null; setConfirmCancel(false); }}
          onDiscard={() => {
            dirtyRef.current = false;
            const continuation = pendingContinuationRef.current;
            pendingContinuationRef.current = null;
            setConfirmCancel(false);
            onCancel();
            continuation?.();
          }}
          onSaveAndLeave={() => {
            void (async () => {
              const saved = await save();
              if (!saved) { setConfirmCancel(false); return; }
              const continuation = pendingContinuationRef.current;
              pendingContinuationRef.current = null;
              setConfirmCancel(false);
              continuation?.();
            })();
          }}
        />
      ) : null}
    </section>
  );
}
