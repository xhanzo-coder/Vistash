import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { asAppError, IpcError } from "../../../shared/errors";
import { appTaskCenter } from "../../../app/runtime";
import {
  batchAddPromptFolder,
  batchAddPromptTag,
  batchDeletePrompts,
  batchRemovePromptFolder,
  batchRemovePromptTag,
  batchSetPromptFavorite,
  createPromptFolder,
  deletePrompt,
  deletePromptFolder,
  linkImages,
  promptSnapshot,
  purgePromptTrash,
  renamePromptFolder,
  restorePrompt,
  setPromptFavorite,
  setPromptFolders,
  setPromptTags,
} from "../../../shared/ipc";
import type {
  AppError,
  BatchProgress,
  BatchReport,
  FolderFilter,
  PromptPurgeReport,
  PromptRow,
} from "../../../shared/types";
import { ErrorLine } from "../../../features/library/ErrorLine";
import { useWindowTier } from "../../../features/workspace/breakpoints";
import { BatchToolbar } from "../../../features/workspace/batchToolbar";
import { AppliedFilterChips } from "../../../features/workspace/AppliedFilterChips";
import { ConfirmDialog } from "../../../features/workspace/ConfirmDialog";
import {
  useWorkspaceQueryController,
  useWorkspaceSnapshot,
} from "../../../features/workspace/useWorkspaceCollection";
import { SelectionProvider, useSelection } from "../../../features/workspace/selectionContext";
import type { GlobalLocateRequest } from "../../../features/workspace/locate";
import {
  WorkspacePaneExpandButtons,
  WorkspacePaneFrame,
  workspacePanePresentation,
} from "../../../features/workspace/workspacePaneLayout";
import { PromptBodyFocus } from "../../../features/prompts/PromptBodyFocus";
import { blockIfPromptDraftDirty } from "../../../features/prompts/draftGuard";
import { promptDisplayTitle } from "../../../features/prompts/promptDisplay";
import { PromptCardWaterfall } from "../../../features/prompts/PromptCardWaterfall";
import { PromptDetailList } from "../../../features/prompts/PromptDetailList";
import { PromptInspector } from "../../../features/prompts/PromptInspector";
import {
  DEFAULT_PROMPT_SORT,
  sortPrompts,
  type PromptSort,
  type PromptSortColumn,
} from "../../../features/prompts/promptSort";

/** 二次确认对话框的待办：确认时执行，取消即丢弃。 */
type ConfirmRequest = {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
};

/**
 * 提示词工作区外壳（任务 10.3 首版）。
 *
 * 与图片模块同构：左分类、中央集合、右检查器三栏；查询状态、
 * 快照刷新与变更协调都在这里，中央视图与检查器只是呈现端。
 *
 * 布局偏好按 `prompts` section 独立保存视图、查询、栏位与滚动偏移，图片侧消费
 * 同一库记录中的 `assets` section；两者不会因一级入口切换而覆盖彼此。
 */
export function PromptWorkspace({
  active = true,
  libraryId,
  locate = null,
  onLocateHandled,
  }: {
  active?: boolean;
  libraryId: string | null;
  /** 全局搜索发来的定位请求（任务 11.1）；由 App 保证只发给本库。 */
  locate?: (GlobalLocateRequest & { nonce: number }) | null;
  onLocateHandled?: (nonce: number) => void;
}) {
  const {
    layout,
    ready,
    update,
    text,
    setText,
    selectedTags,
    setSelectedTags,
    folder,
    setFolder,
    favoriteOnly,
    setFavoriteOnly,
    location,
    setLocation,
    view,
    setView,
    query,
    activation,
    searchInputRef,
    chips,
  } = useWorkspaceQueryController(libraryId, "prompts", locate);
  const [newFolderName, setNewFolderName] = useState("");
  const [renameValue, setRenameValue] = useState("");
  // 聚焦阅读：由双击、Enter 或检查器的显式按钮进入；单击仅更新右检查器。
  // bodyFocusEdit 区分"聚焦阅读"与"编辑主字段"两种进入方式（任务 10.4）。
  const [bodyFocusId, setBodyFocusId] = useState<string | null>(null);
  const [bodyFocusEdit, setBodyFocusEdit] = useState(false);
  // 右检查器抽屉（中等/窄窗口）的开关；宽屏原位展开时忽略。
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [mutating, setMutating] = useState(false);
  // 回收站（任务 10.6）：还原缺失文件夹的非阻断警告、清空回收站二次确认与逐项结果。
  const [notice, setNotice] = useState<AppError | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [purgeReport, setPurgeReport] = useState<PromptPurgeReport | null>(null);
  // 批量操作（任务 11.2）：进度按项转交呈现，报告按项列出失败（设计第六条）。
  const [batchReport, setBatchReport] = useState<BatchReport | null>(null);
  const [batchProgress, setBatchProgress] = useState<BatchProgress | null>(null);
  // 两视图共用同一顺序；view 由提示词自己的持久化 section 提供。
  const [sort, setSort] = useState<PromptSort>({ ...DEFAULT_PROMPT_SORT });

  // 中等/窄窗口左栏收起为抽屉：宽屏原位展开，其余层级默认收起、经边缘入口打开。
  const tier = useWindowTier();
  const drawerMode = tier === "wide" ? "inline" : "drawer";
  const [railOpen, setRailOpen] = useState(false);

  const { snapshot, loading, error, setError, refresh } = useWorkspaceSnapshot(
    query,
    promptSnapshot,
    active,
  );

  // 两种视图共用同一顺序（规格：切换视图不清空查询、排序、选择与活动项）。
  const sortedPrompts = useMemo(
    () => sortPrompts(snapshot?.prompts ?? [], sort),
    [snapshot, sort],
  );

  function changeSort(column: PromptSortColumn) {
    setSort((current) =>
      current.column === column
        ? { column, direction: current.direction === "asc" ? "desc" : "asc" }
        : { column, direction: "asc" },
    );
  }


  // 聚焦阅读的目标从当前查询解析；权威刷新把它移除后自动退回集合视图。
  const bodyFocus =
    bodyFocusId === null
      ? null
       : (sortedPrompts.find((prompt) => prompt.id === bodyFocusId) ?? null);

  /** 查询切换必须先解决正文草稿；继续动作捕获最初意图而不是对话框关闭后的事件。 */
  function changeQuery(action: () => void) {
    const proceed = () => {
      setBodyFocusId(null);
      action();
    };
    if (!blockIfPromptDraftDirty(proceed)) proceed();
  }

  async function runMutation(operation: () => Promise<void>, refreshCurrentQuery: boolean) {
    if (mutating) return;
    const execute = async () => {
      setMutating(true);
      setNotice(null);
      try {
        await operation();
        if (refreshCurrentQuery) await refresh();
        setError(null);
      } catch (raw) {
        setError(asAppError(raw));
      } finally {
        setMutating(false);
      }
    };
    // 文件夹/标签/收藏等写入也会让当前查询排除编辑目标，必须在权威写入前守卫。
    if (blockIfPromptDraftDirty(() => {
      setBodyFocusId(null);
      void execute();
    })) return;
    await execute();
  }

  function requestPromptDelete(prompt: PromptRow) {
    setConfirm({
      title: "移入提示词回收站？",
      body: `“${promptDisplayTitle(prompt)}”将从正常提示词中移除，可从回收站还原；关联的图片不受影响。`,
      confirmLabel: "移入回收站",
      onConfirm: async () => {
        await deletePrompt(prompt.id);
      },
    });
  }

  function requestPromptPurge() {
    const count = snapshot?.trash_count ?? 0;
    setConfirm({
      title: "永久清空提示词回收站？",
      body: `将永久删除 ${count} 条提示词。此操作无法还原；它们的普通图片关联会被移除，图片素材本身不受影响。`,
      confirmLabel: "永久删除",
      onConfirm: async () => {
        const report = await purgePromptTrash();
        setPurgeReport(report);
      },
    });
  }

  // 批量动作的统一协调（任务 11.2，设计第六条）：BatchOrganizer 只翻译意图，
  // 写入经后端批量命令逐项隔离，进度按项转交呈现，报告按项列出失败。
  function runBatch(
    operation: (onProgress: (progress: BatchProgress) => void) => Promise<BatchReport>,
    refreshCurrentQuery: boolean,
  ) {
    const registration = libraryId === null ? null : appTaskCenter.register({ kind: "batch_organization", title: "提示词批量操作", libraryId, stoppable: false, concurrencyKey: null });
    if (registration !== null && registration.kind !== "registered") throw new Error("提示词批量任务意外触发并发拒绝");
    void runMutation(async () => {
      try {
        const report = await operation((progress) => {
          if (registration !== null && registration.kind === "registered") appTaskCenter.reportProgress(registration.record.id, { kind: "items", done: progress.done, total: progress.total });
          setBatchProgress(progress);
        });
        if (registration !== null && registration.kind === "registered") appTaskCenter.complete(registration.record.id, { counts: { succeeded: report.succeeded, skipped: 0, failed: report.failures.length, unprocessed: 0 }, failures: report.failures.map((failure) => ({ displayName: failure.display_name, error: failure.error })), error: null });
        setBatchReport(report);
      } catch (raw) {
        if (!(raw instanceof IpcError)) throw raw;
        if (registration !== null && registration.kind === "registered") appTaskCenter.complete(registration.record.id, { counts: { succeeded: 0, skipped: 0, failed: 0, unprocessed: 0 }, failures: [], error: raw.appError });
        throw raw;
      }
    }, refreshCurrentQuery);
  }

  function requestBatchDelete(ids: string[]) {
    setConfirm({
      title: "批量移入回收站？",
      body: `选中的 ${ids.length} 条提示词将移入提示词回收站，可随时逐项还原；它们与图片的普通关联保留。`,
      confirmLabel: "移入回收站",
      onConfirm: async () => {
        const registration = libraryId === null ? null : appTaskCenter.register({ kind: "batch_organization", title: "移入提示词回收站", libraryId, stoppable: false, concurrencyKey: null });
        if (registration !== null && registration.kind !== "registered") throw new Error("提示词批量任务意外触发并发拒绝");
        try {
          const report = await batchDeletePrompts(ids, (progress) => {
            if (registration !== null && registration.kind === "registered") appTaskCenter.reportProgress(registration.record.id, { kind: "items", done: progress.done, total: progress.total });
            setBatchProgress(progress);
          });
          if (registration !== null && registration.kind === "registered") appTaskCenter.complete(registration.record.id, { counts: { succeeded: report.succeeded, skipped: 0, failed: report.failures.length, unprocessed: 0 }, failures: report.failures.map((failure) => ({ displayName: failure.display_name, error: failure.error })), error: null });
          setBatchReport(report);
        } catch (raw) {
          if (!(raw instanceof IpcError)) throw raw;
          if (registration !== null && registration.kind === "registered") appTaskCenter.complete(registration.record.id, { counts: { succeeded: 0, skipped: 0, failed: 0, unprocessed: 0 }, failures: [], error: raw.appError });
          throw raw;
        }
      },
    });
  }

  /**
   * 批量建立图片关联（任务 11.2）：后端没有批量关联命令，这里逐条
   * link_images 并聚合出同一形状的 BatchReport——单条失败不阻断其余条目
   * （设计第六条），失败项优先用标题呈现，行已不在时回退用 id。
   */
  function batchLinkImagesTo(hash: string, ids: string[]) {
    runBatch(async (onProgress) => {
      let done = 0;
      // 内层把每条的拒绝都转成 AppError 兑现值，Promise.all 因此不会整体中断；
      // finally 保证成功与失败都推进进度。结果与 id 成对携带，免去按下标回查。
      const outcomes = await Promise.all(
        ids.map(
          async (id): Promise<{ id: string; failure: AppError | null }> => {
            try {
              await linkImages(id, [hash]);
              return { id, failure: null };
            } catch (raw) {
              return { id, failure: asAppError(raw) };
            } finally {
              done += 1;
              onProgress({ done, total: ids.length });
            }
          },
        ),
      );
      const failures: BatchReport["failures"] = [];
      for (const outcome of outcomes) {
        if (outcome.failure === null) continue;
        const row = sortedPrompts.find((item) => item.id === outcome.id);
        failures.push({
          id: outcome.id,
          display_name: row !== undefined ? promptDisplayTitle(row) : outcome.id,
          error: outcome.failure,
        });
      }
      return { succeeded: outcomes.length - failures.length, failures };
    }, true);
  }

  async function confirmOperation() {
    if (confirm === null) return;
    const operation = confirm.onConfirm;
    setConfirm(null);
    await runMutation(operation, true);
  }

  function restoreFromTrash(id: string) {
    void runMutation(async () => {
      const outcome = await restorePrompt(id);
      // 还原不被缺失文件夹阻断：恢复仍存在的路径，其余落回提示词根位置，
      // 缺失路径必须显式列出（规格）。
      if (outcome.missing_folders.length > 0) {
        setNotice({
          code: "trash.restore_target_folder_missing",
          detail: `缺失文件夹：${outcome.missing_folders.join("、")}`,
        });
      }
    }, true);
  }

  function selectFolder(next: FolderFilter) {
    changeQuery(() => {
      setLocation("active");
      setFolder(next);
      setRenameValue(next.kind === "path" ? next.path.split("/").at(-1) ?? "" : "");
    });
  }

  async function submitFolder(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parent = folder.kind === "path" ? folder.path : null;
    const name = newFolderName;
    await runMutation(async () => {
      const created = await createPromptFolder(parent, name);
      setNewFolderName("");
      selectFolder({ kind: "path", path: created });
    }, true);
  }

  function requestFolderRename() {
    if (folder.kind !== "path") return;
    const path = folder.path;
    const name = renameValue;
    void runMutation(async () => {
      const renamed = await renamePromptFolder(path, name);
      selectFolder({ kind: "path", path: renamed });
    }, true);
  }

  function requestFolderDelete() {
    if (folder.kind !== "path") return;
    const path = folder.path;
    setConfirm({
      title: "删除提示词文件夹？",
      body: `“${path}”及其子文件夹会被删除，但提示词素材不会删除；没有其他归属的提示词将回到根文件夹。`,
      confirmLabel: "删除文件夹",
      onConfirm: async () => {
        await deletePromptFolder(path);
        selectFolder({ kind: "all" });
      },
    });
  }

  function toggleTag(tag: string) {
    changeQuery(() => {
      setSelectedTags((current) =>
        current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag],
      );
    });
  }

  if (libraryId !== null && !ready) {
    return (
      <section className="workspace-layout-loading" aria-label="提示词工作区" hidden={!active}>
        <p role="status">正在恢复工作台布局…</p>
      </section>
    );
  }

  const panePresentation = workspacePanePresentation("prompt-workspace", drawerMode, layout);

  return (
    <section
      className={panePresentation.className}
      style={panePresentation.style}
      aria-label="提示词工作区"
      hidden={!active}
    >
      <WorkspacePaneFrame
        mode={drawerMode}
        side="start"
        label="提示词分类"
        open={railOpen}
        onClose={() => setRailOpen(false)}
        panelId="prompt-rail-panel"
        asideClassName="catalog-rail"
        collapsed={layout.railCollapsed}
        width={layout.railWidth}
        minWidth={180}
        maxWidth={420}
        resizeLabel="调整提示词分类栏宽度"
        collapseLabel="折叠分类栏"
        onCollapse={() => update({ railCollapsed: true })}
        onResize={(railWidth) => update({ railWidth })}
      >
          <div className="rail-heading">
            <p className="eyebrow">PROMPTS</p>
            <h2>提示词档案</h2>
          </div>
          <nav aria-label="提示词位置" className="catalog-nav">
            <button
              type="button"
              aria-current={location === "active" && folder.kind === "all" ? "page" : undefined}
              onClick={() => selectFolder({ kind: "all" })}
            >
              <span>全部提示词</span>
              <span>
                {location === "active" && folder.kind === "all" ? snapshot?.prompts.length : ""}
              </span>
            </button>
            <button
              type="button"
              aria-current={location === "active" && folder.kind === "root" ? "page" : undefined}
              onClick={() => selectFolder({ kind: "root" })}
            >
              根文件夹
            </button>
            <div className="folder-list" aria-label="提示词文件夹">
              {snapshot?.folders.map((path) => (
                <button
                  type="button"
                  key={path}
                  data-folder={path}
                  aria-current={
                    location === "active" && folder.kind === "path" && folder.path === path
                      ? "page"
                      : undefined
                  }
                  style={{ paddingInlineStart: `${1 + path.split("/").length * 0.8}rem` }}
                  onClick={() => selectFolder({ kind: "path", path })}
                >
                  {path.split("/").at(-1)}
                </button>
              ))}
            </div>
            <button
              type="button"
              aria-label="回收站"
              aria-current={location === "trash" ? "page" : undefined}
              onClick={() => changeQuery(() => {
                setLocation("trash");
                setFolder({ kind: "all" });
                setSelectedTags([]);
              })}
            >
              <span>回收站</span>
              <span>{snapshot?.trash_count ?? 0}</span>
            </button>
          </nav>

          {location === "active" && (
            <div className="folder-actions">
              <form onSubmit={(event) => void submitFolder(event)}>
                <label htmlFor="new-prompt-folder">
                  {folder.kind === "path" ? "新建提示词子文件夹" : "新建提示词文件夹"}
                </label>
                <div className="compact-form">
                  <input
                    id="new-prompt-folder"
                    name="new-prompt-folder"
                    autoComplete="off"
                    value={newFolderName}
                    onChange={(event) => setNewFolderName(event.target.value)}
                    required
                  />
                  <button type="submit" disabled={mutating}>新增</button>
                </div>
              </form>
              {folder.kind === "path" && (
                <div className="folder-edit">
                  <label htmlFor="rename-prompt-folder">重命名当前提示词文件夹</label>
                  <input
                    id="rename-prompt-folder"
                    name="rename-prompt-folder"
                    autoComplete="off"
                    value={renameValue}
                    onChange={(event) => setRenameValue(event.target.value)}
                  />
                  <div className="button-row">
                    <button type="button" onClick={requestFolderRename} disabled={mutating}>
                      保存名称
                    </button>
                    <button
                      type="button"
                      className="danger-ghost"
                      onClick={requestFolderDelete}
                      disabled={mutating}
                    >
                      删除文件夹
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
      </WorkspacePaneFrame>

      {/* 统一选择模型：Provider 上移到中央区与右检查器之外，视图等价切换共享选择。 */}
      <SelectionProvider ids={sortedPrompts.map((prompt) => prompt.id)}>
      {/* 定位桥（任务 11.1）：点击入口在 Provider 内部，定位请求由外壳驱动，
          这里用普通单击语义把目标项落进统一选择模型。 */}
      <ExternalActivation request={activation} onHandled={onLocateHandled} />
      <div className="catalog-main">
        <header className="query-bar">
          <div>
            <p className="eyebrow">PROMPT LIBRARY</p>
            <h2>
              {location === "trash"
                ? "回收站"
                : folder.kind === "root"
                  ? "根文件夹"
                  : folder.kind === "path"
                    ? folder.path
                    : "全部提示词"}
            </h2>
          </div>
          {drawerMode === "drawer" && (
            <button
              type="button"
              className="rail-toggle"
              aria-expanded={railOpen}
              aria-controls="prompt-rail-panel"
              onClick={() => setRailOpen(true)}
            >
              分类
            </button>
          )}
          {drawerMode === "drawer" && (
            <button
              type="button"
              className="rail-toggle"
              aria-expanded={inspectorOpen}
              aria-controls="prompt-inspector-panel"
              onClick={() => setInspectorOpen(true)}
            >
              检查器
            </button>
          )}
          <WorkspacePaneExpandButtons
            mode={drawerMode}
            layout={layout}
            onExpandRail={() => update({ railCollapsed: false })}
            onExpandInspector={() => update({ inspectorCollapsed: false })}
          />
          <div className="view-switch" role="group" aria-label="集合视图">
            <button
              type="button"
              aria-pressed={view === "waterfall"}
              onClick={() => setView("waterfall")}
            >
              卡片瀑布流
            </button>
            <button
              type="button"
              aria-pressed={view === "list"}
              onClick={() => setView("list")}
            >
              详情列表
            </button>
          </div>
          <label className="search-field">
            <span>搜索</span>
            <input
              ref={searchInputRef}
              type="search"
              name="prompt-search"
              autoComplete="off"
              aria-label="按标题或正文搜索"
              placeholder="搜索标题或正文…"
              value={text}
              onChange={(event) => {
                const nextText = event.target.value;
                changeQuery(() => setText(nextText));
              }}
            />
          </label>
          {/* 收藏筛选入口：中央视图只返回 favorite=true 的正常提示词。 */}
          <button
            type="button"
            className={`favorite-filter${favoriteOnly ? " is-on" : ""}`}
            aria-pressed={favoriteOnly}
            onClick={() => changeQuery(() => setFavoriteOnly(!favoriteOnly))}
          >
            ★ 只看收藏
          </button>
          <span className="result-count">{snapshot?.prompts.length ?? 0} 条</span>
        </header>

        {/* 已应用条件的可移除呈现（任务 11.1）：无条件时不渲染任何东西。 */}
        <AppliedFilterChips chips={chips.map((chip) => ({
          ...chip,
          onRemove: () => changeQuery(chip.onRemove),
        }))} />

        {location === "active" && (snapshot?.tags.length ?? 0) > 0 && (
          <div className="tag-filter" aria-label="标签筛选">
            {snapshot?.tags.map((usage) => (
              <button
                type="button"
                key={usage.tag}
                aria-pressed={selectedTags.includes(usage.tag)}
                onClick={() => toggleTag(usage.tag)}
              >
                {usage.tag} <span>{usage.count}</span>
              </button>
            ))}
          </div>
        )}

        {/* 回收站工具条（任务 10.6）：清空必须显式二次确认，取消不执行任何写入。 */}
        {location === "trash" && (
          <div className="trash-toolbar">
            <p>删除提示词仍保存在当前库内，正文、组织与图片关联原样保留。</p>
            <button
              type="button"
              className="danger-button"
              disabled={(snapshot?.trash_count ?? 0) === 0 || mutating}
              onClick={requestPromptPurge}
            >
              清空回收站
            </button>
          </div>
        )}

        {purgeReport !== null && (
          <div role="status" className="operation-status">
            <p>
              已永久删除 {purgeReport.purged} 条
              {purgeReport.failures.length > 0 && `，失败 ${purgeReport.failures.length} 条`}
            </p>
            {purgeReport.failures.map((failure) => (
              <div key={failure.id}>
                <strong>{failure.title ?? failure.id}</strong>
                <ErrorLine error={failure.error} />
              </div>
            ))}
          </div>
        )}
        {/* 批量进度与报告（任务 11.2，设计第六条）：失败按项列出，成功计数汇总。 */}
        {batchProgress !== null && (
          <p role="status" className="folder-progress">
            正在批量处理 {batchProgress.done}/{batchProgress.total}…
          </p>
        )}
        {batchReport !== null && (
          <div role="status" className="operation-status">
            <p>
              批量完成：成功 {batchReport.succeeded} 项
              {batchReport.failures.length > 0 &&
                `，失败 ${batchReport.failures.length} 项`}
            </p>
            {batchReport.failures.map((failure) => (
              <div key={failure.id}>
                <strong>{failure.display_name}</strong>
                <ErrorLine error={failure.error} />
              </div>
            ))}
          </div>
        )}
        {notice !== null && <ErrorLine error={notice} />}
        {error !== null && <ErrorLine error={error} />}
        {loading && snapshot === null ? (
          <p role="status" className="workspace-loading">正在读取提示词编目…</p>
        ) : bodyFocus !== null ? (
          /*
            聚焦阅读/编辑（显式进入）：占满中央区，退出后回原列表位置。主字段的
            显式保存在这里完成，成功后 onSaved 触发权威刷新。
          */
          <PromptBodyFocus
            key={bodyFocus.id}
            prompt={bodyFocus}
            initialEditing={bodyFocusEdit}
            onClose={() => setBodyFocusId(null)}
            onSaved={refresh}
          />
        ) : (
          /*
            集合视图（任务 10.1/10.2）。选择权威在统一 SelectionModel：单击只选中并
            更新右检查器。瀑布流与详情列表挂在同一个 Provider 上，切换视图时查询、
            排序、选择与活动项全部保留。
          */
          sortedPrompts.length === 0 ? (
            <div className="empty-state">
              <p className="eyebrow">NO PROMPTS</p>
              <h3>这里还没有匹配的提示词</h3>
              <p>调整查询条件，或从检查器新建一条手写记录。</p>
            </div>
          ) : view === "list" ? (
            <PromptDetailList
              /* 集合视图按库重挂载（任务 11.2）：换库即全新 DOM，滚动恢复等该库
                 自己的读取返回后进行，上一库的滚动位置不会残留。 */
              key={`${libraryId ?? "no-library"}:${active ? "active" : "inactive"}`}
              prompts={sortedPrompts}
              scrollKey="prompts-list"
              savedOffset={layout.scrollOffsets["prompts-list"] ?? 0}
              onScrollOffset={(offset) =>
                update({
                  scrollOffsets: { ...layout.scrollOffsets, "prompts-list": offset },
                })
              }
              sort={sort}
              onSortChange={changeSort}
              onOpenFocused={(id) => { setBodyFocusEdit(false); setBodyFocusId(id); }}
              workspaceActive={active}
            />
          ) : (
            <PromptCardWaterfall
              key={`${libraryId ?? "no-library"}:${active ? "active" : "inactive"}`}
              prompts={sortedPrompts}
              scrollKey="prompts-waterfall"
              savedOffset={layout.scrollOffsets["prompts-waterfall"] ?? 0}
              onScrollOffset={(offset) =>
                update({
                  scrollOffsets: { ...layout.scrollOffsets, "prompts-waterfall": offset },
                })
              }
              onToggleFavorite={(id, favorite) =>
                void runMutation(() => setPromptFavorite(id, favorite), true)
              }
              onOpenFocused={(id) => { setBodyFocusEdit(false); setBodyFocusId(id); }}
              workspaceActive={active}
            />
          )
        )}

        {/* 批量工具条（任务 11.2）：计数/全选/清除是所有视图共有的动作；视图
            专属的批量组织操作按规格放在右检查器的多选分区。 */}
        <BatchBar total={sortedPrompts.length} />
      </div>

      <WorkspacePaneFrame
        mode={drawerMode}
        side="end"
        label="提示词检查器"
        open={inspectorOpen}
        onClose={() => setInspectorOpen(false)}
        panelId="prompt-inspector-panel"
        asideClassName="inspector-rail"
        collapsed={layout.inspectorCollapsed}
        width={layout.inspectorWidth}
        minWidth={240}
        maxWidth={560}
        resizeLabel="调整提示词检查器宽度"
        collapseLabel="折叠检查器"
        onCollapse={() => update({ inspectorCollapsed: true })}
        onResize={(inspectorWidth) => update({ inspectorWidth })}
      >
          {/* 关联变更的忙碌与错误已由分区自管：这里只负责权威刷新。 */}
          <PromptInspector
            prompts={sortedPrompts}
            folders={snapshot?.folders ?? []}
            mutating={mutating}
            trashLocation={location === "trash"}
            onSetFolders={(id, nextFolders) =>
              void runMutation(() => setPromptFolders(id, nextFolders), true)
            }
            onSetTags={(id, nextTags) =>
              void runMutation(() => setPromptTags(id, nextTags), true)
            }
            onToggleFavorite={(id, favorite) =>
              void runMutation(() => setPromptFavorite(id, favorite), true)
            }
            onOpenBodyFocus={(id) => {
              setBodyFocusEdit(false);
              setBodyFocusId(id);
            }}
            onEditBodyFocus={(id) => {
              setBodyFocusEdit(true);
              setBodyFocusId(id);
            }}
            onImagesChanged={() => void refresh()}
            onDeletePrompt={(id) => {
              const prompt = sortedPrompts.find((item) => item.id === id);
              if (prompt !== undefined) requestPromptDelete(prompt);
            }}
            onRestorePrompt={(id) => restoreFromTrash(id)}
            onBatchFolders={(ids, path, add) =>
              runBatch(
                (progress) =>
                  add
                    ? batchAddPromptFolder(ids, path, progress)
                    : batchRemovePromptFolder(ids, path, progress),
                true,
              )
            }
            onBatchTags={(ids, tag, add) =>
              runBatch(
                (progress) =>
                  add
                    ? batchAddPromptTag(ids, tag, progress)
                    : batchRemovePromptTag(ids, tag, progress),
                true,
              )
            }
            onBatchFavorite={(ids, favorite) =>
              runBatch((progress) => batchSetPromptFavorite(ids, favorite, progress), true)
            }
            onBatchLinkImages={(hash, ids) => batchLinkImagesTo(hash, ids)}
            onBatchDelete={(ids) => requestBatchDelete(ids)}
          />
      </WorkspacePaneFrame>
      </SelectionProvider>

      {confirm !== null && (
        <ConfirmDialog
          title={confirm.title}
          body={confirm.body}
          confirmLabel={confirm.confirmLabel}
          busy={mutating}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void confirmOperation()}
        />
      )}
    </section>
  );
}

/**
 * 全局搜索定位的选中桥（任务 11.1）：点击入口只在 SelectionProvider 内部可得，
 * 而定位请求由外壳状态驱动，这里以普通单击语义分派目标项。
 *
 * nonce 记账保证同一次请求只分派一次——分派会推进选择状态并换出新的
 * onItemClick 引用，不记账的话 effect 会因依赖变化重跑而自我无限分派。
 * 目标项尚未进入当前查询域（回收站快照还在刷新）时先等它到达再选中，
 * 否则 selectOne 的域守卫会把这次分派静默丢弃。
 */
function ExternalActivation({
  request,
  onHandled,
}: {
  request: { id: string; nonce: number } | null;
  onHandled: ((nonce: number) => void) | undefined;
}) {
  const { state, onItemClick } = useSelection();
  const firedNonce = useRef(-1);
  useEffect(() => {
    if (request === null || firedNonce.current === request.nonce) return;
    if (!state.orderedIds.includes(request.id)) return;
    firedNonce.current = request.nonce;
    onItemClick(request.id, new MouseEvent("click"));
    onHandled?.(request.nonce);
  }, [request, state, onHandled, onItemClick]);
  return null;
}

/** 批量工具条桥（任务 11.2）：计数与全选/清除动作都来自统一 SelectionModel。 */
function BatchBar({ total }: { total: number }) {
  const { state, selectAll, clearSelection } = useSelection();
  return (
    <BatchToolbar
      count={state.selectedIds.size}
      totalCount={total}
      onSelectAll={selectAll}
      onClear={clearSelection}
    />
  );
}
