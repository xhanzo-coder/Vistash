import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  batchAddAssetTag,
  batchDeleteAssets,
  batchLinkToPrompt,
  batchMoveAssetsToFolder,
  batchRemoveAssetTag,
  batchSetAssetFavorite,
  catalogSnapshot,
  createFolder,
  deleteAsset,
  deleteFolder,
  moveAssetToFolder,
  purgeTrash,
  renameFolder,
  restoreAsset,
  setAssetFavorite,
  setAssetTags,
} from "../../shared/ipc";
import { asAppError } from "../../shared/errors";
import type {
  AppError,
  AssetRow,
  BatchProgress,
  BatchReport,
  FolderFilter,
  FolderMutationProgress,
  PurgeReport,
} from "../../shared/types";
import { ErrorLine } from "../library/ErrorLine";
import { useWindowTier } from "../workspace/breakpoints";
import { AppliedFilterChips } from "../workspace/AppliedFilterChips";
import { BatchToolbar } from "../workspace/batchToolbar";
import { ConfirmDialog } from "../workspace/ConfirmDialog";
import {
  useWorkspaceQueryController,
  useWorkspaceSnapshot,
} from "../workspace/useWorkspaceCollection";
import { SelectionProvider, useSelection } from "../workspace/selectionContext";
import type { GlobalLocateRequest } from "../workspace/GlobalSearch";
import {
  WorkspacePaneExpandButtons,
  WorkspacePaneFrame,
  workspacePanePresentation,
} from "../workspace/workspacePaneLayout";
import { AssetInspector } from "./AssetInspector";
import { AssetPreview } from "./AssetPreview";
import { AssetWaterfall } from "./AssetWaterfall";
import { AssetDetailList } from "./AssetDetailList";
import {
  DEFAULT_SORT,
  sortAssets,
  type AssetSort,
  type AssetSortColumn,
} from "./assetSort";

type ConfirmState = {
  title: string;
  body: string;
  confirmLabel: string;
  refreshCurrentQuery: boolean;
  onConfirm: () => Promise<void>;
};

export function AssetWorkspace({
  refreshVersion,
  libraryId,
  locate = null,
  onLocateHandled,
}: {
  refreshVersion: number;
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
  } = useWorkspaceQueryController(libraryId, "assets", locate);
  // 聚焦原图模式（任务 9.3）：只由双击或 Enter 显式进入；单击仅更新右检查器。
  const [focusedHash, setFocusedHash] = useState<string | null>(null);
  // 右检查器抽屉（中等/窄窗口）的开关；宽屏原位展开时忽略。
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [notice, setNotice] = useState<AppError | null>(null);
  const [mutating, setMutating] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [purgeReport, setPurgeReport] = useState<PurgeReport | null>(null);
  // 批量组织（任务 11.2）：统一 BatchReport 逐项失败隔离，进度按项转交。
  const [batchReport, setBatchReport] = useState<BatchReport | null>(null);
  const [batchProgress, setBatchProgress] = useState<BatchProgress | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  const [renameValue, setRenameValue] = useState("");
  const [folderProgress, setFolderProgress] = useState<FolderMutationProgress | null>(null);
  // 信息列排序（任务 9.2）：瀑布流与详情列表共用同一顺序；不进布局偏好，
  // 设计定义的持久化形状只有视图/筛选/滚动。
  const [sort, setSort] = useState<AssetSort>({ ...DEFAULT_SORT });

  // 中等/窄窗口左栏收起为抽屉（任务 8.6）：宽屏原位展开，其余层级默认收起、
  // 经边缘入口打开。窄屏自动收起不写任何宽屏宽度偏好。
  const tier = useWindowTier();
  const drawerMode = tier === "wide" ? "inline" : "drawer";
  const [railOpen, setRailOpen] = useState(false);

  const { snapshot, loading, error, setError, refresh } = useWorkspaceSnapshot(
    query,
    refreshVersion,
    catalogSnapshot,
  );

  // 两种视图共用同一顺序（规格：切换视图不清空查询、排序、选择与活动项）。
  const sortedAssets = useMemo(
    () => sortAssets(snapshot?.assets ?? [], sort),
    [snapshot, sort],
  );

  function changeSort(column: AssetSortColumn) {
    setSort((current) =>
      current.column === column
        ? { column, direction: current.direction === "asc" ? "desc" : "asc" }
        : { column, direction: "asc" },
    );
  }


  // 聚焦原图的目标素材从当前查询解析；权威刷新把它移除后自动退回集合视图。
  const focusAsset =
    focusedHash === null
      ? null
      : (sortedAssets.find((asset) => asset.hash === focusedHash) ?? null);

  async function runMutation(operation: () => Promise<void>, refreshCurrentQuery: boolean) {
    if (mutating) return;
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
      setFolderProgress(null);
    }
  }

  function selectFolder(next: FolderFilter) {
    setLocation("active");
    setFolder(next);
    setRenameValue(next.kind === "path" ? finalFolderSegment(next.path) : "");
  }

  function toggleTag(tag: string) {
    setSelectedTags((current) =>
      current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag],
    );
  }

  async function submitFolder(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = newFolderName;
    const parent = folder.kind === "path" ? folder.path : null;
    await runMutation(async () => {
      const created = await createFolder(parent, name);
      setNewFolderName("");
      selectFolder({ kind: "path", path: created });
    }, false);
  }

  function requestFolderRename() {
    if (folder.kind !== "path") return;
    const path = folder.path;
    const name = renameValue;
    setFolderProgress({ done: 0, total: 0, current_filename: "正在准备侧车…" });
    void runMutation(async () => {
      const renamed = await renameFolder(path, name, setFolderProgress);
      selectFolder({ kind: "path", path: renamed });
    }, false);
  }

  function requestFolderDelete() {
    if (folder.kind !== "path") return;
    const path = folder.path;
    setConfirm({
      title: "删除逻辑文件夹？",
      body: `“${path}”及其子文件夹会被删除，但素材不会删除；没有其他归属的素材将回到根文件夹。`,
      confirmLabel: "删除文件夹",
      refreshCurrentQuery: false,
      onConfirm: async () => {
        await deleteFolder(path);
        selectFolder({ kind: "all" });
      },
    });
  }

  function requestAssetDelete(asset: AssetRow) {
    setConfirm({
      title: "移入库内回收站？",
      body: `“${asset.original_filename}”将从正常素材中移除，可从回收站还原。`,
      confirmLabel: "移入回收站",
      refreshCurrentQuery: true,
      onConfirm: async () => {
        await deleteAsset(asset.hash);
      },
    });
  }

  function requestPurge() {
    const count = snapshot?.trash_count ?? 0;
    setConfirm({
      title: "永久清空回收站？",
      body: `将永久删除 ${count} 个素材。此操作无法还原。`,
      confirmLabel: "永久删除",
      refreshCurrentQuery: true,
      onConfirm: async () => {
        const report = await purgeTrash();
        setPurgeReport(report);
      },
    });
  }

  /**
   * 批量动作（任务 11.2）：统一经 runMutation 走忙碌与错误协调；BatchReport
   * 就地呈现（设计第六条：逐项失败隔离，不以部分成功冒充全部成功）。
   */
  function runBatch(
    operation: (onProgress: (progress: BatchProgress) => void) => Promise<BatchReport>,
    refreshCurrentQuery: boolean,
  ) {
    void runMutation(async () => {
      const report = await operation((progress) => setBatchProgress(progress));
      setBatchReport(report);
    }, refreshCurrentQuery);
  }

  /** 批量移入回收站：与清空回收站同级危险动作，必须显式二次确认。 */
  function requestBatchDelete(hashes: string[]) {
    setConfirm({
      title: "批量移入回收站？",
      body: `选中的 ${hashes.length} 张图片将移入图片回收站，可随时逐项还原；它们的普通提示词关联保留。`,
      confirmLabel: "移入回收站",
      refreshCurrentQuery: true,
      onConfirm: async () => {
        const report = await batchDeleteAssets(hashes, (progress) => setBatchProgress(progress));
        setBatchReport(report);
      },
    });
  }

  async function confirmOperation() {
    if (confirm === null) return;
    const operation = confirm.onConfirm;
    const refreshCurrentQuery = confirm.refreshCurrentQuery;
    setConfirm(null);
    await runMutation(operation, refreshCurrentQuery);
  }

  if (libraryId !== null && !ready) {
    return (
      <section className="workspace-layout-loading" aria-label="素材工作区">
        <p role="status">正在恢复工作台布局…</p>
      </section>
    );
  }

  const panePresentation = workspacePanePresentation("asset-workspace", drawerMode, layout);

  return (
    <section
      className={panePresentation.className}
      style={panePresentation.style}
      aria-label="素材工作区"
    >
      <WorkspacePaneFrame
        mode={drawerMode}
        side="start"
        label="素材分类"
        open={railOpen}
        onClose={() => setRailOpen(false)}
        panelId="catalog-rail-panel"
        asideClassName="catalog-rail"
        collapsed={layout.railCollapsed}
        width={layout.railWidth}
        minWidth={180}
        maxWidth={420}
        resizeLabel="调整图片分类栏宽度"
        collapseLabel="折叠分类栏"
        onCollapse={() => update({ railCollapsed: true })}
        onResize={(railWidth) => update({ railWidth })}
      >
          <div className="rail-heading">
            <p className="eyebrow">CATALOG</p>
            <h2>素材档案</h2>
          </div>
          <nav aria-label="素材位置" className="catalog-nav">
            <button
              type="button"
              aria-current={location === "active" && folder.kind === "all" ? "page" : undefined}
              onClick={() => selectFolder({ kind: "all" })}
            >
              <span>全部素材</span>
              <span>{location === "active" && folder.kind === "all" ? snapshot?.assets.length : ""}</span>
            </button>
            <button
              type="button"
              aria-current={location === "active" && folder.kind === "root" ? "page" : undefined}
              onClick={() => selectFolder({ kind: "root" })}
            >
              根文件夹
            </button>
            <div className="folder-list" aria-label="逻辑文件夹">
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
              onClick={() => {
                setLocation("trash");
                setFolder({ kind: "all" });
                setSelectedTags([]);
              }}
            >
              <span>回收站</span>
              <span>{snapshot?.trash_count ?? 0}</span>
            </button>
          </nav>
  
          {location === "active" && (
            <div className="folder-actions">
              <form onSubmit={(event) => void submitFolder(event)}>
                <label htmlFor="new-folder">{folder.kind === "path" ? "新建子文件夹" : "新建文件夹"}</label>
                <div className="compact-form">
                  <input
                    id="new-folder"
                    name="new-folder"
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
                  <label htmlFor="rename-folder">重命名当前文件夹</label>
                  <input
                    id="rename-folder"
                    name="rename-folder"
                    autoComplete="off"
                    value={renameValue}
                    onChange={(event) => setRenameValue(event.target.value)}
                  />
                  <div className="button-row">
                    <button type="button" onClick={requestFolderRename} disabled={mutating}>
                      保存名称
                    </button>
                    <button type="button" className="danger-ghost" onClick={requestFolderDelete}>
                      删除文件夹
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
      </WorkspacePaneFrame>

      {/*
        统一选择模型（任务 9.3）：Provider 上移到中央区与右检查器之外，
        单击图片只更新检查器，瀑布流/详情列表不被详情页替换。
      */}
      <SelectionProvider ids={sortedAssets.map((asset) => asset.hash)}>
      {/* 定位桥（任务 11.1）：点击入口在 Provider 内部，定位请求由外壳驱动，
          这里用普通单击语义把目标项落进统一选择模型。 */}
      <ExternalActivation request={activation} onHandled={onLocateHandled} />
      <div className="catalog-main">
        {folderProgress !== null && (
          <p role="status" className="folder-progress">
            {folderProgress.total === 0
              ? folderProgress.current_filename
              : `正在重命名侧车 ${folderProgress.done}/${folderProgress.total}：${folderProgress.current_filename}`}
          </p>
        )}
        <header className="query-bar">
          <div>
            <p className="eyebrow">LOCAL ARCHIVE</p>
            <h2>{location === "trash" ? "回收站" : titleForFolder(folder)}</h2>
          </div>
          {drawerMode === "drawer" && (
            <button
              type="button"
              className="rail-toggle"
              aria-expanded={railOpen}
              aria-controls="catalog-rail-panel"
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
              aria-controls="asset-inspector-panel"
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
              瀑布流
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
            <span>文件名</span>
            <input
              ref={searchInputRef}
              type="search"
              name="asset-search"
              autoComplete="off"
              aria-label="按文件名搜索"
              placeholder="搜索文件名…"
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          </label>
          {/* 收藏筛选入口：中央视图只返回 favorite=true 的正常图片。 */}
          <button
            type="button"
            className={`favorite-filter${favoriteOnly ? " is-on" : ""}`}
            aria-pressed={favoriteOnly}
            onClick={() => setFavoriteOnly((current) => !current)}
          >
            ★ 只看收藏
          </button>
          <span className="result-count">{snapshot?.assets.length ?? 0} 项</span>
        </header>

        {/* 已应用条件的可移除呈现（任务 11.1）：无条件时不渲染任何东西。 */}
        <AppliedFilterChips chips={chips} />

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

        {location === "trash" && (
          <div className="trash-toolbar">
            <p>删除素材仍保存在当前库内，并继续参与内容去重。</p>
            <button
              type="button"
              className="danger-button"
              disabled={(snapshot?.trash_count ?? 0) === 0 || mutating}
              onClick={requestPurge}
            >
              清空回收站
            </button>
          </div>
        )}

        {purgeReport !== null && (
          <div role="status" className="operation-status">
            <p>
              已永久删除 {purgeReport.purged} 个
              {purgeReport.failures.length > 0 && `，失败 ${purgeReport.failures.length} 个`}
            </p>
            {purgeReport.failures.map((failure) => (
              <div key={failure.hash}>
                <strong>{failure.original_filename}</strong>
                <ErrorLine error={failure.error} />
              </div>
            ))}
          </div>
        )}
        {/* 批量报告（任务 11.2）：成功与失败并存呈现，失败逐项带稳定错误码。 */}
        {batchProgress !== null && (
          <p role="status" className="folder-progress">
            正在批量处理 {batchProgress.done}/{batchProgress.total}…
          </p>
        )}
        {batchReport !== null && (
          <div role="status" className="operation-status">
            <p>
              批量完成：成功 {batchReport.succeeded} 项
              {batchReport.failures.length > 0 && `，失败 ${batchReport.failures.length} 项`}
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
          <p role="status" className="workspace-loading">正在读取素材编目…</p>
        ) : focusAsset !== null ? (
          /* 聚焦原图（双击/Enter 显式进入）：占满中央区，退出后回到集合视图。 */
          <AssetPreview
            key={focusAsset.hash}
            asset={focusAsset}
            onClose={() => setFocusedHash(null)}
          />
        ) : (
          /*
            集合视图（任务 9.1/9.2）。选择权威在统一 SelectionModel：单击只选中并
            更新右检查器；双击或 Enter 才进入聚焦原图。瀑布流与详情列表挂在同一个
            Provider 上，切换视图时同一批 ID 经 idsReplaced 快速路径原样返回，
            查询、排序、选择与活动项全部保留。滚动偏移分别记在布局偏好的
            "assets-waterfall"/"assets-list" 键下。
          */
          (sortedAssets.length === 0) ? (
            <div className="empty-state">
              <p className="eyebrow">NO ASSETS</p>
              <h3>这里还没有匹配的素材</h3>
              <p>调整查询条件，或把图片文件与文件夹拖进窗口导入。</p>
            </div>
          ) : view === "list" ? (
            <AssetDetailList
              /* 集合视图按库重挂载（任务 11.2）：换库即全新 DOM，滚动恢复等该库
                 自己的读取返回后进行，上一库的滚动位置不会残留。 */
              key={libraryId ?? "no-library"}
              assets={sortedAssets}
              scrollKey="assets-list"
              savedOffset={layout.scrollOffsets["assets-list"] ?? 0}
              onScrollOffset={(offset) =>
                update({
                  scrollOffsets: { ...layout.scrollOffsets, "assets-list": offset },
                })
              }
              onOpenFocused={(hash) => setFocusedHash(hash)}
              sort={sort}
              onSortChange={changeSort}
            />
          ) : (
            <AssetWaterfall
              key={libraryId ?? "no-library"}
              assets={sortedAssets}
              scrollKey="assets-waterfall"
              savedOffset={layout.scrollOffsets["assets-waterfall"] ?? 0}
              onScrollOffset={(offset) =>
                update({
                  scrollOffsets: { ...layout.scrollOffsets, "assets-waterfall": offset },
                })
              }
              onOpenFocused={(hash) => setFocusedHash(hash)}
            />
          )
        )}

        {/* 批量工具条（任务 11.2）：计数/全选/清除是所有视图共有的动作；
            视图专属的批量组织操作按规格放在右检查器的多选分区。 */}
        <BatchBar total={sortedAssets.length} />
      </div>

      <WorkspacePaneFrame
        mode={drawerMode}
        side="end"
        label="图片检查器"
        open={inspectorOpen}
        onClose={() => setInspectorOpen(false)}
        panelId="asset-inspector-panel"
        asideClassName="inspector-rail"
        collapsed={layout.inspectorCollapsed}
        width={layout.inspectorWidth}
        minWidth={240}
        maxWidth={560}
        resizeLabel="调整图片检查器宽度"
        collapseLabel="折叠检查器"
        onCollapse={() => update({ inspectorCollapsed: true })}
        onResize={(inspectorWidth) => update({ inspectorWidth })}
      >
          <AssetInspector
            assets={sortedAssets}
            folders={snapshot?.folders ?? []}
            mutating={mutating}
            trashLocation={location === "trash"}
            onMoveAsset={(hash, target) =>
              void runMutation(() => moveAssetToFolder(hash, target), true)
            }
            onSetTags={(hash, nextTags) =>
              void runMutation(() => setAssetTags(hash, nextTags), true)
            }
            onDeleteAsset={(hash) => {
              const asset = sortedAssets.find((item) => item.hash === hash);
              if (asset !== undefined) requestAssetDelete(asset);
            }}
            onRestoreAsset={(hash) =>
              void runMutation(async () => {
                const outcome = await restoreAsset(hash);
                if (outcome.missing_folders.length > 0) {
                  setNotice({
                    code: "trash.restore_target_folder_missing",
                    detail: `缺失文件夹：${outcome.missing_folders.join("、")}`,
                  });
                }
              }, true)
            }
            onToggleFavorite={(hash, favorite) =>
              void runMutation(() => setAssetFavorite(hash, favorite), true)
            }
            onBatchMove={(hashes, target) =>
              runBatch((progress) => batchMoveAssetsToFolder(hashes, target, progress), true)
            }
            onBatchTags={(hashes, tag, add) =>
              runBatch(
                (progress) =>
                  add
                    ? batchAddAssetTag(hashes, tag, progress)
                    : batchRemoveAssetTag(hashes, tag, progress),
                true,
              )
            }
            onBatchFavorite={(hashes, favorite) =>
              runBatch((progress) => batchSetAssetFavorite(hashes, favorite, progress), true)
            }
            onBatchLinkToPrompt={(promptId, hashes) =>
              runBatch((progress) => batchLinkToPrompt(promptId, hashes, progress), false)
            }
            onBatchDelete={requestBatchDelete}
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

function titleForFolder(folder: FolderFilter): string {
  if (folder.kind === "root") return "根文件夹";
  if (folder.kind === "path") return folder.path;
  return "全部素材";
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

function finalFolderSegment(path: string): string {
  const segment = path.split("/").at(-1);
  if (segment === undefined || segment.length === 0) {
    throw new Error(`文件夹路径缺少名称段：${path}`);
  }
  return segment;
}
