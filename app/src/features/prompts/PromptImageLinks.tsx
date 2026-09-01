import { useCallback, useDeferredValue, useEffect, useRef, useState } from "react";
import { parseAssetId, type LibraryId } from "../../app/common";
import { DotsThreeIcon } from "@phosphor-icons/react/dist/csr/DotsThree";
import { LinkBreakIcon } from "@phosphor-icons/react/dist/csr/LinkBreak";
import { IpcError } from "../../shared/errors";
import type { ImagePromptRelations } from "../../modules/image-prompt-relations";
import { Button, IconButton } from "../../ui/button/Button";
import { Dialog } from "../../ui/dialog/Dialog";
import { Menu, MenuItem, MenuSeparator } from "../../ui/overlays/Menu";
import styles from "./PromptImageLinks.module.css";

import { asAppError } from "../../shared/errors";
import {
  catalogSnapshot,
  importAndLink,
  linkedImageStates,
  onFileDragEvent,
  pickImageFiles,
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
function LinkedThumb({ hash, width, height, alt = "", presentation = "grid" }: { hash: string; width: number; height: number; alt?: string; presentation?: "grid" | "preview" }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { started, url, error } = useLazyThumbnailUrl(containerRef, hash);

  return (
    <div
      ref={containerRef}
      className={`${styles.linkedMedia} ${presentation === "preview" ? styles.previewThumb : styles.gridThumb}`}
      data-linked-thumb=""
      aria-busy={started && url === null && error === null}
    >
      {error !== null ? (
        <ErrorLine error={error} />
      ) : url !== null ? (
        <img src={url} alt={alt} width={width} height={height} loading="lazy" />
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
 * 提示词检查器的关联图片分区主体。
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
  libraryId,
  relations,
}: {
  active: PromptRow;
  libraryId: LibraryId;
  relations: ImagePromptRelations;
}) {
  const [states, setStates] = useState<LinkedImageState[] | null>(null);
  const [loadError, setLoadError] = useState<AppError | null>(null);
  const [actionError, setActionError] = useState<AppError | null>(null);
  const [refreshCommitted, setRefreshCommitted] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ImportAndLinkReport | null>(null);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [searchDraft, setSearchDraft] = useState("");
  const deferredSearch = useDeferredValue(searchDraft);
  const [candidates, setCandidates] = useState<AssetRow[] | null>(null);
  const [checkedHashes, setCheckedHashes] = useState<string[]>([]);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);

  const [hovering, setHovering] = useState(false);
  const dropZoneRef = useRef<HTMLDivElement>(null);

  // 事件路径（解除/建立/导入后）复用的刷新；挂载加载在下面的 effect 里自带取消守卫。
  const reload = useCallback(async () => {
    try {
      const next = await linkedImageStates(active.id);
      setStates(next);
      setLoadError(null);
    } catch (raw) {
      const error = asAppError(raw);
      setLoadError(error);
      throw new IpcError(error);
    }
  }, [active.id]);

  useEffect(
    () => relations.registerRefresh(libraryId, async (change) => {
      if (change.promptIds.includes(active.id) || change.imageIds.length > 0) await reload();
    }),
    [active.id, libraryId, relations, reload],
  );

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

  // 拖放认领：订阅失败明确提示，不把真实平台错误当作测试环境缺失吞掉。
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
      } catch (raw) {
        if (!cancelled) {
          setPromptDropZone(null);
          setDropError(String(raw));
        }
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
    setRefreshCommitted(false);
    setReport(null);
    try {
      const nextReport = await importAndLink(active.id, paths);
      setReport(nextReport);
      const changedImages = nextReport.items.flatMap((item) =>
        item.outcome.kind === "import_failed" ? [] : [parseAssetId(item.outcome.hash)],
      );
      const linked = nextReport.items.flatMap((item) =>
        item.outcome.kind === "linked_imported" || item.outcome.kind === "linked_existing"
          ? [parseAssetId(item.outcome.hash)]
          : [],
      );
      if (changedImages.length > 0) {
        const refreshError = await relations.synchronize(libraryId, { imageIds: changedImages, promptIds: linked.length > 0 ? [active.id] : [] });
        if (refreshError !== null) {
          setRefreshCommitted(true);
          setActionError(refreshError);
        }
      } else {
        await reload();
      }
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
      const result = await relations.execute({ kind: "link", libraryId, images: checkedHashes.map(parseAssetId), prompts: [active.id] });
      const failure = result.failures[0];
      if (failure !== undefined) throw new IpcError(failure.error);
      if (result.refreshError !== null) {
        setRefreshCommitted(true);
        setActionError(result.refreshError);
        return;
      }
      closePicker();
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
      const commit = await relations.execute({ kind: "unlink", libraryId, prompt: active.id, image: parseAssetId(hash) });
      const failure = commit.failures[0];
      if (failure !== undefined) throw new IpcError(failure.error);
      if (commit.refreshError !== null) {
        setRefreshCommitted(true);
        setActionError(commit.refreshError);
      }
    } catch (raw) {
      setActionError(asAppError(raw));
    } finally {
      setBusy(false);
    }
  }

  async function changeCover(hash: string | null) {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const commit = await relations.execute({ kind: "set_cover", libraryId, prompt: active.id, image: hash === null ? null : parseAssetId(hash) });
      const failure = commit.failures[0];
      if (failure !== undefined) throw new IpcError(failure.error);
      if (commit.refreshError !== null) {
        setRefreshCommitted(true);
        setActionError(commit.refreshError);
      }
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
  const current = states?.find((state) => state.hash === selectedHash)
    ?? states?.find((state) => state.hash === effectiveCover)
    ?? states?.[0]
    ?? null;
  const currentIndex = current === null || states === null ? -1 : states.findIndex((state) => state.hash === current.hash);

  return (
    <div className={styles.root}>
      {loadError !== null && <ErrorLine error={loadError} />}
      {refreshCommitted && <p role="alert">关系已写入、刷新失败。重试只重新读取，不会重复或撤销关联。</p>}
      {actionError !== null && <ErrorLine error={actionError} />}

      <div className={styles.actions}>
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
        className={styles.dropZone}
        data-hover={hovering ? "true" : undefined}
        data-drop-zone="prompt-images"
        aria-label={dropError === null ? "拖入本地图片以导入并关联" : "图片拖放不可用"}
      >
        {dropError === null ? (
          <p className="muted">把本地图片拖到这里，导入并关联到这条提示词</p>
        ) : (
          <p role="alert">拖放不可用，请使用“从本地导入”。原因：{dropError}</p>
        )}
      </div>

      <Dialog title="添加关联图片" description="从图片库搜索并选择要与当前提示词建立普通关联的图片。" open={pickerOpen} onOpenChange={(open) => { if (!busy) { if (open) openPicker(); else closePicker(); } }} footer={<><Button onClick={closePicker}>取消</Button><Button variant="primary" disabled={busy || checkedHashes.length === 0} onClick={() => void confirmLink()}>确认关联 {checkedHashes.length} 张</Button></>}>
        <div className={styles.picker}>
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
            <ul className={styles.candidateList} data-link-candidates="">
              {candidates.map((asset) => {
                  const alreadyLinked = states?.some((state) => state.hash === asset.hash) === true;
                  return (
                  <li key={asset.hash}>
                    <label className={styles.candidateRow}>
                      <input
                        type="checkbox"
                        value={asset.hash}
                        checked={alreadyLinked || checkedHashes.includes(asset.hash)}
                        disabled={alreadyLinked || busy}
                        onChange={() => {
                          setCheckedHashes((existing) =>
                            existing.includes(asset.hash)
                              ? existing.filter((item) => item !== asset.hash)
                              : [...existing, asset.hash],
                          );
                        }}
                      />
                      <span>{asset.display_filename} · {asset.folder ?? "未分类"} · {asset.width} × {asset.height}{alreadyLinked ? " · 已关联" : ""}</span>
                    </label>
                  </li>
                  );
                })}
            </ul>
          )}
        </div>
      </Dialog>

      {report !== null && report.items.length > 0 && (
        <ul className={styles.importReport} data-import-report="" aria-label="导入并关联结果">
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
        <p className="muted">还没有关联图片。可从图片库选择，或使用“从本地导入”。</p>
      ) : current === null ? (
        <p className="muted">关联图片状态异常：存在数量但没有可预览对象。</p>
      ) : (
        <div className={styles.gallery} data-preview-hash={current.hash}>
          <div className={styles.previewFrame}>
            {(current.hash === effectiveCover || current.deleted) ? <div className={styles.previewBadges}>
              {current.hash === effectiveCover ? <span className={styles.coverBadge} data-relation-badge="cover">封面</span> : null}
              {current.deleted ? <span className={styles.deletedBadge} data-relation-badge="deleted">已删除</span> : null}
            </div> : null}
            <LinkedThumb hash={current.hash} width={current.width} height={current.height} alt={current.display_filename} presentation="preview" />
          </div>
          <div className={styles.currentMeta}>
            <strong>{current.display_filename}</strong>
            <span>{current.display_filename} · {current.width} × {current.height} · 第 {currentIndex + 1} / {states.length} 张{current.deleted ? " · 已删除" : ""}</span>
          </div>
          <div className={styles.currentActions}>
            <span className="muted">{current.folder ?? "未分类"}</span>
            <Button size="compact" disabled={busy} onClick={() => void relations.open({ kind: "image", libraryId, id: parseAssetId(current.hash), location: current.deleted ? "trash" : "active" }).catch((raw) => setActionError(asAppError(raw)))}>打开当前图片</Button>
          </div>
          <ul className={styles.thumbnailGrid} aria-label={`关联 ${states.length} 张图片`}>
            {states.map((state) => {
              const isExplicitCover = state.hash === explicitCover;
              const isEffectiveCover = state.hash === effectiveCover;
              return <li key={state.hash} data-linked-hash={state.hash} data-current={state.hash === current.hash ? "true" : undefined} className={styles.thumbnailItem}>
                <button type="button" className={styles.thumbButton} aria-label={`预览关联图片 ${state.display_filename}`} aria-pressed={state.hash === current.hash} data-deleted={state.deleted ? "true" : undefined} onClick={() => setSelectedHash(state.hash)}>
                  {(isEffectiveCover || state.deleted) ? <span className={styles.thumbBadges}>
                    {isEffectiveCover ? <span className={styles.coverBadge} data-relation-badge="cover">封面</span> : null}
                    {state.deleted ? <span className={styles.deletedBadge} data-relation-badge="deleted">已删除</span> : null}
                  </span> : null}
                  <LinkedThumb hash={state.hash} width={state.width} height={state.height} />
                  <span className={styles.thumbName}><strong>{state.display_filename}</strong><small>{state.width} × {state.height}</small></span>
                </button>
                <span className={styles.thumbActions}>
                  <IconButton className={styles.thumbDirectAction} size="compact" title="解除关联" label={`解除与图片 ${state.display_filename} 的关联`} icon={<LinkBreakIcon />} disabled={busy} onClick={() => void removeLinked(state.hash)} />
                  <span className={styles.thumbMenu}><Menu trigger={<IconButton size="compact" label={`关联图片操作 ${state.display_filename}`} icon={<DotsThreeIcon />} disabled={busy} />}>
                    {!state.deleted && !isEffectiveCover ? <MenuItem onSelect={() => void changeCover(state.hash)}>设为封面</MenuItem> : null}
                    {isExplicitCover ? <MenuItem onSelect={() => void changeCover(null)}>取消封面</MenuItem> : null}
                    {(!state.deleted && !isEffectiveCover) || isExplicitCover ? <MenuSeparator /> : null}
                    <MenuItem destructive onSelect={() => void removeLinked(state.hash)}>解除关联</MenuItem>
                  </Menu></span>
                </span>
              </li>;
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
