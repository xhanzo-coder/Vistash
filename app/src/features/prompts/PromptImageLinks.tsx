import { useCallback, useDeferredValue, useEffect, useRef, useState } from "react";

import { asAppError } from "../../shared/errors";
import {
  catalogSnapshot,
  importAndLink,
  linkImages,
  linkedImageStates,
  onFileDragEvent,
  pickImageFiles,
  setPromptCover,
  unlinkImage,
} from "../../shared/ipc";
import type {
  AppError,
  AssetRow,
  ImportAndLinkReport,
  LinkedImageState,
  PromptRow,
} from "../../shared/types";
import { ErrorLine } from "../library/ErrorLine";
import { useLazyThumbnailUrl } from "../workspace/thumbnailUrl";
import {
  handleFileDragEvent,
  setPromptDropZone,
  subscribePromptDropHover,
} from "./promptDropZone";

/**
 * 关联图片的一格缩略图。
 *
 * 与检查器其他缩略图同一套懒加载生命周期；格位固定方形，超出部分裁剪。加载失败
 * 必须显式呈现原因，不留一个与"空关联"无法区分的空白。
 */
function LinkedThumb({ hash }: { hash: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { started, url, error } = useLazyThumbnailUrl(containerRef, hash);

  return (
    <div
      ref={containerRef}
      className="linked-thumb"
      aria-busy={started && url === null && error === null}
    >
      {error !== null ? (
        <ErrorLine error={error} />
      ) : url !== null ? (
        <img src={url} alt="" width={1} height={1} loading="lazy" />
      ) : started ? (
        <p>正在载入…</p>
      ) : (
        <p>等待载入…</p>
      )}
    </div>
  );
}

/** 单条导入结果的稳定文案；失败项另附稳定错误码。 */
function outcomeLabel(outcome: ImportAndLinkReport["items"][number]["outcome"]): string | null {
  if (outcome.kind === "linked_imported") return "已导入并关联";
  if (outcome.kind === "linked_existing") return "库内已有，已关联";
  if (outcome.kind === "imported_but_not_linked") return "已入库但未关联";
  return null;
}

/**
 * 提示词检查器的关联图片分区主体（任务 10.5）。
 *
 * 关联数据经 linked_image_states 自取自刷：解除/建立只改变这条提示词自己的关联，
 * 调用方以活动提示词作 key 渲染本组件——换活动项即重新挂载，加载状态自然干净。
 * 回收站里的关联图片保留并显式标记"已删除"，绝不静默隐藏（规格）。
 *
 * 建立关联的两个入口共用同一条后端编排语义：库内多选直接复用单份本体；
 * 本地文件先走已批准的导入不变量再关联，逐项报告"已入库但未关联"。拖入与
 * 选择是同一入口的两条触发路径，都汇入 import_and_link。
 *
 * 封面是关联的引用：检查器按"显式值优先、缺省取第一张正常关联图片"呈现徽标，
 * 设置/取消走独立的二值 IPC；解除显式封面或永久删除后的回落由权威层保证，
 * 这里只在刷新后的快照上如实呈现结果。
 */
export function PromptImageLinks({
  active,
  onChanged,
}: {
  active: PromptRow;
  /** 任何关联变更后通知工作区刷新权威快照：卡片封面与计数随之更新。 */
  onChanged: () => void;
}) {
  const [states, setStates] = useState<LinkedImageState[] | null>(null);
  const [loadError, setLoadError] = useState<AppError | null>(null);
  const [actionError, setActionError] = useState<AppError | null>(null);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ImportAndLinkReport | null>(null);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [searchDraft, setSearchDraft] = useState("");
  const deferredSearch = useDeferredValue(searchDraft);
  const [candidates, setCandidates] = useState<AssetRow[] | null>(null);
  const [checkedHashes, setCheckedHashes] = useState<string[]>([]);

  const [hovering, setHovering] = useState(false);
  const dropZoneRef = useRef<HTMLDivElement>(null);

  // 事件路径（解除/建立/导入后）复用的刷新；挂载加载在下面的 effect 里自带取消守卫。
  const reload = useCallback(async () => {
    try {
      const next = await linkedImageStates(active.id);
      setStates(next);
      setLoadError(null);
    } catch (raw) {
      setLoadError(asAppError(raw));
    }
  }, [active.id]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await linkedImageStates(active.id);
        if (!cancelled) {
          setStates(next);
          setLoadError(null);
        }
      } catch (raw) {
        if (!cancelled) setLoadError(asAppError(raw));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active.id]);

  // 选择器打开期间按文本查询库内候选；候选只来自正常区（回收站图片不出现在建立入口）。
  useEffect(() => {
    if (!pickerOpen) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const snapshot = await catalogSnapshot({
          text: deferredSearch,
          tags: [],
          folder: { kind: "all" },
          favorite: null,
          location: "active",
        });
        if (!cancelled) setCandidates(snapshot.assets);
      } catch (raw) {
        if (!cancelled) setActionError(asAppError(raw));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pickerOpen, deferredSearch]);

  // 落点处理器经 ref 取到最新的导入实现，挂载 effect 因此可以保持空依赖。
  const importDroppedRef = useRef<(paths: string[]) => Promise<void>>(async () => {});

  // 拖放认领：登记本分区几何范围并接住窗口级拖动事件。纯浏览器/测试环境没有
  // Tauri 拖放事件可接，注册失败退化为只有"从本地导入"按钮可用。
  useEffect(() => {
    setPromptDropZone({
      rect: () => dropZoneRef.current?.getBoundingClientRect() ?? null,
      drop: (paths) => void importDroppedRef.current(paths),
    });
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const fn = await onFileDragEvent(handleFileDragEvent);
        if (cancelled) {
          fn();
          return;
        }
        unlisten = fn;
      } catch {
        // 无 Tauri 运行时：没有拖放事件流，按钮入口仍然完整。
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten !== null) unlisten();
      setPromptDropZone(null);
    };
  }, []);

  // 高亮状态由模块广播：拖动事件发生在组件树之外，只能这样回流。
  useEffect(() => subscribePromptDropHover(setHovering), []);

  async function runImportAndLink(paths: string[]) {
    if (busy || paths.length === 0) return;
    setBusy(true);
    setActionError(null);
    setReport(null);
    try {
      const nextReport = await importAndLink(active.id, paths);
      setReport(nextReport);
      await reload();
      onChanged();
    } catch (raw) {
      setActionError(asAppError(raw));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    importDroppedRef.current = runImportAndLink;
  });

  async function pickLocalFiles() {
    if (busy) return;
    try {
      const paths = await pickImageFiles();
      await runImportAndLink(paths);
    } catch (raw) {
      setActionError(asAppError(raw));
    }
  }

  function openPicker() {
    setPickerOpen(true);
    setSearchDraft("");
    setCheckedHashes([]);
    setCandidates(null);
    setActionError(null);
  }

  function closePicker() {
    setPickerOpen(false);
    setSearchDraft("");
    setCheckedHashes([]);
  }

  async function confirmLink() {
    if (busy || checkedHashes.length === 0) return;
    setBusy(true);
    setActionError(null);
    try {
      // 单次批量建立；后端对重复关联幂等成功，这里不需要去重防御。
      await linkImages(active.id, checkedHashes);
      closePicker();
      await reload();
      onChanged();
    } catch (raw) {
      setActionError(asAppError(raw));
    } finally {
      setBusy(false);
    }
  }

  async function removeLinked(hash: string) {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await unlinkImage(active.id, hash);
      await reload();
      onChanged();
    } catch (raw) {
      setActionError(asAppError(raw));
      await reload();
    } finally {
      setBusy(false);
    }
  }

  async function changeCover(hash: string | null) {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await setPromptCover(active.id, hash);
      await reload();
      onChanged();
    } catch (raw) {
      setActionError(asAppError(raw));
    } finally {
      setBusy(false);
    }
  }

  // 检查器与卡片使用同一有效封面语义：显式值只有仍为正常图片时才优先，
  // 否则回落到第一张正常关联图。已删除项保留关联与取消显式值的入口，但不冒充封面。
  const explicitCover = active.cover_image_hash;
  const explicitState = states?.find((state) => state.hash === explicitCover);
  const effectiveCover =
    explicitState !== undefined && !explicitState.deleted
      ? explicitState.hash
      : states?.find((state) => !state.deleted)?.hash ?? null;

  return (
    <div className="prompt-image-links">
      {loadError !== null && <ErrorLine error={loadError} />}
      {actionError !== null && <ErrorLine error={actionError} />}

      <div className="links-actions">
        <button type="button" aria-expanded={pickerOpen} onClick={pickerOpen ? closePicker : openPicker}>
          从图片库选择
        </button>
        <button type="button" disabled={busy} onClick={() => void pickLocalFiles()}>
          从本地导入
        </button>
      </div>

      {/* 拖入目标：悬停高亮由窗口级拖动事件驱动，落点命中才接管这次拖放。 */}
      <div
        ref={dropZoneRef}
        className={`link-drop-zone${hovering ? " is-hover" : ""}`}
        data-drop-zone="prompt-images"
        aria-label="拖入本地图片以导入并关联"
      >
        <p className="muted">把本地图片拖到这里，导入并关联到这条提示词</p>
      </div>

      {pickerOpen && (
        <div className="link-picker">
          <label htmlFor="link-image-search">搜索图片</label>
          <input
            id="link-image-search"
            name="link-image-search"
            type="search"
            autoComplete="off"
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
          />
          {candidates === null ? (
            <p role="status">正在读取图片…</p>
          ) : candidates.length === 0 ? (
            <p className="muted">没有匹配的图片</p>
          ) : (
            <ul className="link-candidates">
              {/* 已关联的候选不再重复出现：建立语义是新增关联。 */}
              {candidates
                .filter((asset) => !states?.some((state) => state.hash === asset.hash))
                .map((asset) => (
                  <li key={asset.hash}>
                    <label className="check-row">
                      <input
                        type="checkbox"
                        value={asset.hash}
                        checked={checkedHashes.includes(asset.hash)}
                        onChange={() => {
                          setCheckedHashes((current) =>
                            current.includes(asset.hash)
                              ? current.filter((item) => item !== asset.hash)
                              : [...current, asset.hash],
                          );
                        }}
                      />
                      <span>{asset.original_filename}</span>
                    </label>
                  </li>
                ))}
            </ul>
          )}
          <div className="button-row">
            <button
              type="button"
              disabled={busy || checkedHashes.length === 0}
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

      {report !== null && report.items.length > 0 && (
        <ul className="import-report" aria-label="导入并关联结果">
          {report.items.map((item) => {
            const label = outcomeLabel(item.outcome);
            return (
              <li key={item.source_path}>
                <span>{item.original_filename}</span>
                {item.outcome.kind === "imported_but_not_linked" && (
                  <ErrorLine error={item.outcome.error} />
                )}
                {item.outcome.kind === "import_failed" && (
                  <ErrorLine error={item.outcome.error} />
                )}
                {label !== null && <span className="muted">{label}</span>}
              </li>
            );
          })}
        </ul>
      )}

      {states === null ? (
        loadError === null && <p role="status">正在读取关联…</p>
      ) : states.length === 0 ? (
        <p className="muted">还没有关联图片。可从图片库选择，或拖入本地文件导入。</p>
      ) : (
        <ul className="linked-thumbs" aria-label={`关联 ${states.length} 张图片`}>
          {states.map((state, index) => {
            const isExplicitCover = state.hash === explicitCover;
            const isEffectiveCover = state.hash === effectiveCover;
            return (
              <li
                key={state.hash}
                data-linked-hash={state.hash}
                className={state.deleted ? "is-deleted" : undefined}
              >
                {(isEffectiveCover || state.deleted) && (
                  <div className="thumb-badges">
                    {isEffectiveCover && <span className="cover-badge">封面</span>}
                    {state.deleted && <span className="deleted-badge">已删除</span>}
                  </div>
                )}
                <LinkedThumb hash={state.hash} />
                <div className="button-row">
                  {/* 已是当前封面（显式或缺省）的格子不再提供设为封面。 */}
                  {!state.deleted && !isEffectiveCover && (
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`把第 ${index + 1} 张图片设为封面`}
                      onClick={() => void changeCover(state.hash)}
                    >
                      设为封面
                    </button>
                  )}
                  {isExplicitCover && (
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`取消第 ${index + 1} 张图片的封面`}
                      onClick={() => void changeCover(null)}
                    >
                      取消封面
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`解除关联第 ${index + 1} 张图片`}
                    onClick={() => void removeLinked(state.hash)}
                  >
                    解除
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
