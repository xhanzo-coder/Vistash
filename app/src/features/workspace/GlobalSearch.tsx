import { useDeferredValue, useEffect, useRef, useState } from "react";

import { asAppError } from "../../shared/errors";
import { globalSearch } from "../../shared/ipc";
import type { AppError, AssetRow, GlobalSearchResult, PromptRow } from "../../shared/types";
import { ErrorLine } from "../library/ErrorLine";
import { promptDisplayTitle } from "../prompts/promptDisplay";

/** 从全局结果发起的一次定位：目标库、目标项与它是否在回收站里。 */
export type GlobalLocateRequest = {
  section: "assets" | "prompts";
  id: string;
  inTrash: boolean;
};

/**
 * 顶栏全局搜索（任务 11.1）。
 *
 * 规格钉死三件事：结果按素材类型分组并显示各组数量，绝不混入一个无类型瀑布流；
 * `Ctrl+K` 聚焦这里；从结果进入某项后切换到对应素材库并定位该项——定位语义
 * （含回收站归属）由 App 与两个工作区落实，这里只报告使用者的选择。
 */
export function GlobalSearchPanel({ onLocate }: { onLocate: (request: GlobalLocateRequest) => void }) {
  const [text, setText] = useState("");
  const deferredText = useDeferredValue(text);
  const [result, setResult] = useState<GlobalSearchResult | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Ctrl+K 聚焦全局搜索（规格）。监听挂在本组件：库未打开时它不存在，快捷键自然失效。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 点击面板外关闭结果；聚焦移动是唯一可靠的"离开"信号之外的手段。
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      if (!(event.target instanceof Node)) return;
      if (containerRef.current !== null && !containerRef.current.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  useEffect(() => {
    let cancelled = false;

    async function loadResults() {
      const query = deferredText.trim();
      if (query === "") {
        // 清空与真实搜索同构地走一次异步边界，不在 effect 里同步 setState。
        await Promise.resolve();
        if (!cancelled) {
          setResult(null);
          setError(null);
        }
        return;
      }
      try {
        const next = await globalSearch(query);
        if (!cancelled) {
          setResult(next);
          setError(null);
        }
      } catch (raw) {
        if (!cancelled) setError(asAppError(raw));
      }
    }

    void loadResults();
    return () => {
      cancelled = true;
    };
  }, [deferredText]);

  function choose(request: GlobalLocateRequest) {
    setOpen(false);
    onLocate(request);
  }

  const hasQuery = deferredText.trim() !== "";

  return (
    <div className="global-search" ref={containerRef}>
      <input
        ref={inputRef}
        type="search"
        name="global-search"
        autoComplete="off"
        aria-label="全局搜索（图片与提示词）"
        aria-expanded={open && hasQuery}
        aria-controls="global-search-results"
        placeholder="全局搜索…（Ctrl+K）"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
      />
      {open && hasQuery && (
        <div className="global-search-panel" id="global-search-results" aria-label="全局搜索结果">
          {error !== null && <ErrorLine error={error} />}
          {result === null && error === null && <p role="status">正在搜索…</p>}
          {result !== null && (
            <>
              <SearchGroup
                title="图片素材"
                rows={result.assets}
                emptyCopy="没有匹配的图片"
                keyOf={(asset) => asset.hash}
                label={(asset) => asset.original_filename}
                inTrash={(asset) => asset.deleted_at !== null}
                onChoose={(asset) =>
                  choose({ section: "assets", id: asset.hash, inTrash: asset.deleted_at !== null })
                }
              />
              <SearchGroup
                title="提示词"
                rows={result.prompts}
                emptyCopy="没有匹配的提示词"
                keyOf={(prompt) => prompt.id}
                label={promptDisplayTitle}
                inTrash={(prompt) => prompt.deleted_at !== null}
                onChoose={(prompt) =>
                  choose({ section: "prompts", id: prompt.id, inTrash: prompt.deleted_at !== null })
                }
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** 单一素材类型的结果组：组标题带数量，行是可进入的按钮。 */
function SearchGroup<T extends AssetRow | PromptRow>({
  title,
  rows,
  emptyCopy,
  keyOf,
  label,
  inTrash,
  onChoose,
}: {
  title: string;
  rows: T[];
  emptyCopy: string;
  keyOf: (row: T) => string;
  label: (row: T) => string;
  inTrash: (row: T) => boolean;
  onChoose: (row: T) => void;
}) {
  return (
    <section className="search-group" aria-label={`${title}（${rows.length}）`}>
      <p className="search-group-title">
        {title} <span>{rows.length}</span>
      </p>
      {rows.length === 0 ? (
        <p className="muted">{emptyCopy}</p>
      ) : (
        <ul>
          {rows.map((row) => (
            <li key={keyOf(row)}>
              <button type="button" onClick={() => onChoose(row)}>
                <span>{label(row)}</span>
                {inTrash(row) && <span className="deleted-badge">已删除</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
