import { useCallback, useDeferredValue, useEffect, useState } from "react";

import { asAppError } from "../../shared/errors";
import { imageDetail, linkImages, promptSnapshot, unlinkImage } from "../../shared/ipc";
import type { AppError, PromptRow } from "../../shared/types";
import { ErrorLine } from "../library/ErrorLine";

/** 标题缺失时回退到正文首个非空行，截断到 40 字符。 */
function promptLabel(prompt: PromptRow): string {
  const source = prompt.title ?? prompt.body.split("\n").find((line) => line.trim() !== "") ?? "";
  return source.length > 40 ? `${source.slice(0, 40)}…` : source;
}

/**
 * 检查器的关联提示词分区（任务 9.3 第二循环）。
 *
 * 关联数据经 image_detail 自取自刷：解除/建立不改变图片查询结果集，因此不需要
 * 把整份快照刷新传导进来。调用方以 hash 作 key 渲染本组件——换活动项即重新挂载，
 * 加载状态自然干净。回收站里的关联提示词显式标记"已删除"，绝不静默隐藏。
 */
export function AssetPromptLinks({ hash }: { hash: string }) {
  const [linked, setLinked] = useState<PromptRow[] | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [actionError, setActionError] = useState<AppError | null>(null);
  const [busy, setBusy] = useState(false);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [searchDraft, setSearchDraft] = useState("");
  const deferredSearch = useDeferredValue(searchDraft);
  const [candidates, setCandidates] = useState<PromptRow[] | null>(null);
  const [checkedIds, setCheckedIds] = useState<string[]>([]);

  // 事件路径（解除/建立后）复用的刷新；挂载加载在下面的 effect 里自带取消守卫。
  const reload = useCallback(async () => {
    try {
      const detail = await imageDetail(hash);
      setLinked(detail.linked_prompts);
      setError(null);
    } catch (raw) {
      setError(asAppError(raw));
    }
  }, [hash]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const detail = await imageDetail(hash);
        if (!cancelled) {
          setLinked(detail.linked_prompts);
          setError(null);
        }
      } catch (raw) {
        if (!cancelled) setError(asAppError(raw));
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [hash]);

  // 选择器打开期间按文本查询候选；候选只来自正常区（回收站提示词不出现在建立入口）。
  useEffect(() => {
    if (!pickerOpen) return undefined;
    let cancelled = false;
    const load = async () => {
      try {
        const snapshot = await promptSnapshot({
          text: deferredSearch,
          tags: [],
          folder: { kind: "all" },
          favorite: null,
          location: "active",
        });
        if (!cancelled) setCandidates(snapshot.prompts);
      } catch (raw) {
        if (!cancelled) setActionError(asAppError(raw));
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [pickerOpen, deferredSearch]);

  function openPicker() {
    setPickerOpen(true);
    setSearchDraft("");
    setCheckedIds([]);
    setCandidates(null);
    setActionError(null);
  }

  function closePicker() {
    setPickerOpen(false);
    setSearchDraft("");
    setCheckedIds([]);
  }

  async function removeLinked(promptId: string) {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await unlinkImage(promptId, hash);
      await reload();
    } catch (raw) {
      setActionError(asAppError(raw));
      await reload();
    } finally {
      setBusy(false);
    }
  }

  async function confirmLink() {
    if (busy || checkedIds.length === 0) return;
    setBusy(true);
    setActionError(null);
    try {
      // 逐条建立：后端对重复关联幂等成功，这里不需要去重防御。
      for (const promptId of checkedIds) {
        await linkImages(promptId, [hash]);
      }
      closePicker();
    } catch (raw) {
      setActionError(asAppError(raw));
    } finally {
      await reload();
      setBusy(false);
    }
  }

  return (
    <div className="asset-prompt-links">
      {error !== null && <ErrorLine error={error} />}
      {actionError !== null && <ErrorLine error={actionError} />}

      <div className="links-actions">
        <button type="button" aria-expanded={pickerOpen} onClick={pickerOpen ? closePicker : openPicker}>
          建立关联
        </button>
      </div>

      {pickerOpen && (
        <div className="link-picker">
          <label htmlFor="link-prompt-search">搜索提示词</label>
          <input
            id="link-prompt-search"
            name="link-prompt-search"
            type="search"
            autoComplete="off"
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
          />
          {candidates === null ? (
            <p role="status">正在读取提示词…</p>
          ) : candidates.length === 0 ? (
            <p className="muted">没有匹配的提示词</p>
          ) : (
            <ul className="link-candidates">
              {/* 已关联的候选不再重复出现：建立语义是新增关联。 */}
              {candidates
                .filter((prompt) => !linked?.some((item) => item.id === prompt.id))
                .map((prompt) => (
                  <li key={prompt.id}>
                    <label className="check-row">
                      <input
                        type="checkbox"
                        value={prompt.id}
                        checked={checkedIds.includes(prompt.id)}
                        onChange={() => {
                          setCheckedIds((current) =>
                            current.includes(prompt.id)
                              ? current.filter((id) => id !== prompt.id)
                              : [...current, prompt.id],
                          );
                        }}
                      />
                      <span>{promptLabel(prompt)}</span>
                    </label>
                  </li>
                ))}
            </ul>
          )}
          <div className="button-row">
            <button
              type="button"
              disabled={busy || checkedIds.length === 0}
              onClick={() => void confirmLink()}
            >
              确认关联
            </button>
            <button type="button" onClick={closePicker}>
              取消
            </button>
          </div>
        </div>
      )}

      {linked === null ? (
        <p role="status">正在读取关联…</p>
      ) : linked.length === 0 ? (
        <p className="muted">尚未关联任何提示词。</p>
      ) : (
        <ul className="links-list">
          {linked.map((prompt) => {
            const label = promptLabel(prompt);
            return (
              <li key={prompt.id} data-linked-prompt="" data-prompt-id={prompt.id}>
                {prompt.deleted_at !== null && <span className="deleted-badge">已删除</span>}
                <span className="link-title">{label}</span>
                <button
                  type="button"
                  aria-label={`解除关联 ${label}`}
                  disabled={busy}
                  onClick={() => void removeLinked(prompt.id)}
                >
                  解除
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
