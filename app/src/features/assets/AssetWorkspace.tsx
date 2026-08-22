import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  catalogSnapshot,
  createFolder,
  deleteAsset,
  deleteFolder,
  purgeTrash,
  renameFolder,
  restoreAsset,
  setAssetFavorite,
  setAssetFolders,
  setAssetTags,
} from "../../shared/ipc";
import { asAppError } from "../../shared/errors";
import type {
  AppError,
  AssetQuery,
  AssetRow,
  CatalogSnapshot,
  FolderFilter,
  FolderMutationProgress,
  PurgeReport,
} from "../../shared/types";
import { ErrorLine } from "../library/ErrorLine";
import { useWindowTier } from "../workspace/breakpoints";
import { useLibraryLayout, type WorkspaceView } from "../workspace/libraryLayout";
import { SelectionProvider } from "../workspace/selectionContext";
import { WorkspaceDrawer } from "../workspace/workspaceDrawer";
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
}: {
  refreshVersion: number;
  libraryId: string | null;
}) {
  const { layout, update } = useLibraryLayout(libraryId);
  const [text, setText] = useState("");
  const deferredText = useDeferredValue(text);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [folder, setFolder] = useState<FolderFilter>({ kind: "all" });
  // 收藏筛选（任务 9.4）：null=不限，true=只看收藏；规格里收藏是二值状态。
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [location, setLocation] = useState<"active" | "trash">("active");
  const [snapshot, setSnapshot] = useState<CatalogSnapshot | null>(null);
  // 聚焦原图模式（任务 9.3）：只由双击或 Enter 显式进入；单击仅更新右检查器。
  const [focusedHash, setFocusedHash] = useState<string | null>(null);
  // 右检查器抽屉（中等/窄窗口）的开关；宽屏原位展开时忽略。
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [notice, setNotice] = useState<AppError | null>(null);
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [purgeReport, setPurgeReport] = useState<PurgeReport | null>(null);
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

  const query = useMemo<AssetQuery>(
    () => ({
      text: deferredText,
      tags: selectedTags,
      folder,
      favorite: favoriteOnly ? true : null,
      location,
    }),
    [deferredText, favoriteOnly, folder, location, selectedTags],
  );
  const snapshotRequest = useMemo(
    () => ({ query, refreshVersion }),
    [query, refreshVersion],
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

  function switchView(view: WorkspaceView) {
    if (view !== layout.view) update({ view });
  }

  const refresh = useCallback(async () => {
    try {
      const next = await catalogSnapshot(query);
      setSnapshot(next);
      setError(null);
    } catch (raw) {
      setError(asAppError(raw));
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    let cancelled = false;

    async function loadSnapshot() {
      try {
        const next = await catalogSnapshot(snapshotRequest.query);
        if (cancelled) return;
        setSnapshot(next);
        setError(null);
      } catch (raw) {
        if (!cancelled) setError(asAppError(raw));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadSnapshot();
    return () => {
      cancelled = true;
    };
  }, [snapshotRequest]);

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

  async function confirmOperation() {
    if (confirm === null) return;
    const operation = confirm.onConfirm;
    const refreshCurrentQuery = confirm.refreshCurrentQuery;
    setConfirm(null);
    await runMutation(operation, refreshCurrentQuery);
  }

  return (
    <section
      className={`asset-workspace${drawerMode === "drawer" ? " rail-drawer" : ""}${
        drawerMode === "inline" ? " with-inspector" : ""
      }`}
      aria-label="素材工作区"
    >
      <WorkspaceDrawer
        mode={drawerMode}
        side="start"
        label="素材分类"
        open={railOpen}
        onClose={() => setRailOpen(false)}
        panelId="catalog-rail-panel"
      >
        <aside className="catalog-rail">
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
        </aside>
      </WorkspaceDrawer>

      {/*
        统一选择模型（任务 9.3）：Provider 上移到中央区与右检查器之外，
        单击图片只更新检查器，瀑布流/详情列表不被详情页替换。
      */}
      <SelectionProvider ids={sortedAssets.map((asset) => asset.hash)}>
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
          <div className="view-switch" role="group" aria-label="集合视图">
            <button
              type="button"
              aria-pressed={layout.view === "waterfall"}
              onClick={() => switchView("waterfall")}
            >
              瀑布流
            </button>
            <button
              type="button"
              aria-pressed={layout.view === "list"}
              onClick={() => switchView("list")}
            >
              详情列表
            </button>
          </div>
          <label className="search-field">
            <span>文件名</span>
            <input
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
          ) : layout.view === "list" ? (
            <AssetDetailList
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
      </div>

      <WorkspaceDrawer
        mode={drawerMode}
        side="end"
        label="图片检查器"
        open={inspectorOpen}
        onClose={() => setInspectorOpen(false)}
        panelId="asset-inspector-panel"
      >
        <aside className="inspector-rail" aria-label="图片检查器">
          <AssetInspector
            assets={sortedAssets}
            folders={snapshot?.folders ?? []}
            mutating={mutating}
            trashLocation={location === "trash"}
            onSetFolders={(hash, nextFolders) =>
              void runMutation(() => setAssetFolders(hash, nextFolders), true)
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
          />
        </aside>
      </WorkspaceDrawer>
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

function ConfirmDialog({
  title,
  body,
  confirmLabel,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const button = cancelRef.current;
    if (button === null) throw new Error("确认对话框取消按钮不存在");
    button.focus();
  }, []);

  return (
    <div className="dialog-backdrop">
      <section role="dialog" aria-modal="true" aria-labelledby="confirm-title" className="confirm-dialog">
        <p className="eyebrow">CONFIRM</p>
        <h2 id="confirm-title">{title}</h2>
        <p>{body}</p>
        <div className="dialog-actions">
          <button ref={cancelRef} type="button" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button type="button" className="danger-button" onClick={onConfirm} disabled={busy}>
            {confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

function titleForFolder(folder: FolderFilter): string {
  if (folder.kind === "root") return "根文件夹";
  if (folder.kind === "path") return folder.path;
  return "全部素材";
}

function finalFolderSegment(path: string): string {
  const segment = path.split("/").at(-1);
  if (segment === undefined || segment.length === 0) {
    throw new Error(`文件夹路径缺少名称段：${path}`);
  }
  return segment;
}
