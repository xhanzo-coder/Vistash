import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useIsMutating, useMutation, useMutationState, useQuery, useQueryClient } from "@tanstack/react-query";
import { parseAssetId, type AssetId } from "../../../app/common";
import { catalogSnapshot, readLayout, writeLayout } from "../../../shared/ipc";
import { IpcError } from "../../../shared/errors";
import { Button } from "../../../ui/button/Button";
import { SearchField } from "../../../ui/search-field/SearchField";
import { Dialog } from "../../../ui/dialog/Dialog";
import type { AssetLibraryWorkspaceProps } from "../index";
import { assetKeys } from "./queryKeys";
import { defaultAssetPreferences, parseLibraryPreferences, queryFromPreferences, type AssetPreferences, type LibraryPreferences } from "./preferences";
import styles from "./AssetLibraryWorkspace.module.css";
import { AssetCollection } from "./AssetCollection";
import { AssetNavigator, type NavigatorScope } from "./AssetNavigator";
import { sortAssets } from "./collectionSort";
import { initialSelection, selectionReducer } from "./selection";
import type { CollectionSort } from "./preferences";
import { ActionResults, useAssetActions } from "./useAssetActions";
import { DeleteFolderDialog, FolderEditor, type FolderChange } from "./FolderEditor";
import { MoveAssetsDialog } from "./MoveAssetsDialog";
import { useFolderDrag } from "./useFolderDrag";
import { RenameAssetDialog, filenameTarget, type FilenameTarget } from "./AssetFilename";
import { AssetInspector } from "./AssetInspector";
import { useAssetNotes } from "./assetNotes";

/** 集合滚动偏移在布局偏好 scrollOffsets 表中的固定键。 */
const COLLECTION_SCROLL_KEY = "assets-collection";
// 与冻结的 780px 覆盖式检查器断点一致；隐藏的桌面检查器不持有媒体或表单实例。
const inlineInspectorSnapshot = (): boolean => window.innerWidth > 780;
const subscribeViewport = (listener: () => void): (() => void) => {
  window.addEventListener("resize", listener, { passive: true });
  return () => window.removeEventListener("resize", listener);
};
/** 密度三档的界面文案；值本身是持久化枚举。 */
const DENSITY_LABELS = [
  { value: "small", label: "小" },
  { value: "medium", label: "中" },
  { value: "large", label: "大" },
] as const;
/** 排序选项：值是持久化枚举，文案面向使用者。 */
const SORT_OPTIONS = [
  { value: "imported-desc", label: "最新导入在前" },
  { value: "name-asc", label: "名称（拼音）" },
  { value: "size-desc", label: "尺寸从大到小" },
] as const satisfies readonly { value: CollectionSort; label: string }[];

/** IPC 错误可就地呈现；编程错误和协议不变量错误继续抛出，不伪装成业务失败。 */
function Problem({ error }: { error: Error }): ReactNode {
  if (!(error instanceof IpcError)) throw error;
  return <p className={styles.error} role="alert">{error.message}</p>;
}

function LoadedWorkspace({ session, active, entry, saved }: AssetLibraryWorkspaceProps & { saved: LibraryPreferences }): ReactNode {
  const client = useQueryClient();
  const notes = useAssetNotes(session.id, active);
  const inlineInspector = useSyncExternalStore(subscribeViewport, inlineInspectorSnapshot);
  const organizationBusy = useIsMutating({ predicate: (mutation) => mutation.options.scope?.id === `asset-organization:${session.id}` }) > 0;
  const [layout, setLayout] = useState<AssetPreferences>(() => {
    if (active && entry?.kind === "locate") {
      return { ...saved.assets, ...queryFromPreferences(defaultAssetPreferences()), location: entry.location };
    }
    return saved.assets;
  });
  const [selection, dispatchSelection] = useReducer(selectionReducer, [], () => initialSelection([]));
  const selectedIds = selection.selectedIds;
  const activeId = selection.activeId;
  const [seenRequests, setSeenRequests] = useState<ReadonlySet<string>>(() => new Set());
  const [navigatorOpen, setNavigatorOpen] = useState(false);
  const [informationOpen, setInformationOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<FilenameTarget | null>(null);
  const renameOrigin = useRef<HTMLElement | null>(null);
  const savedRequestCount = useRef(0);
  const query = queryFromPreferences(layout);
  const collection = useQuery({
    queryKey: assetKeys.collection(session.id, query),
    queryFn: async ({ signal }) => {
      signal.throwIfAborted();
      const snapshot = await catalogSnapshot(query);
      signal.throwIfAborted();
      return snapshot;
    },
    enabled: active,
    staleTime: Infinity,
    // 筛选切换期间保留上一份快照：左栏树与标签面板不随加载闪空，卡片保持可交互。
    placeholderData: (previous) => previous,
  });

  const save = useMutation({
    mutationKey: assetKeys.savePreferences(session.id),
    scope: { id: `asset-preferences:${session.id}` },
    mutationFn: async (next: AssetPreferences) => {
      // 写前读取最新根对象，只替换本模块拥有的分区，不覆盖提示词或其他布局数据。
      const latest = parseLibraryPreferences(await readLayout(session.id));
      await writeLayout(session.id, { ...latest, assets: { ...latest.assets, ...next } });
    },
  });
  const { mutate: savePreferences } = save;
  // mutation 的结果归 QueryClient 保存；同库重开不能把未保存草稿显示成已落盘。
  const latestSave = useMutationState({
    filters: { mutationKey: assetKeys.savePreferences(session.id), exact: true },
    select: (mutation) => ({ status: mutation.state.status, error: mutation.state.error }),
  }).at(-1);
  const saveError = latestSave?.status === "error" ? latestSave.error : null;
  const actions = useAssetActions(session.id);
  // 排序是呈现语义：同一份缓存快照在两种视图与排序选项间共享，不触发新拉取。
  const orderedAssets = useMemo(
    () => sortAssets(collection.data?.assets ?? [], layout.sort),
    [collection.data, layout.sort],
  );
  // 查询域变化收敛进选择模型：越界选中被裁剪，同域下发不打扰现场。
  useEffect(() => {
    dispatchSelection({ kind: "idsReplaced", ids: orderedAssets.map((asset) => asset.hash) });
  }, [orderedAssets]);
  const selectedAsset = collection.data?.assets.find((asset) => asset.hash === activeId);
  // 选择模型以字符串保存 ID；离开模型边界时恢复素材品牌身份。
  const activeAssetId: AssetId | null = activeId === null ? null : parseAssetId(activeId);

  const onItemSelect = useCallback((id: AssetId, modifiers: { ctrl: boolean; shift: boolean }): void => {
    if (modifiers.shift) {
      dispatchSelection({ kind: "rangeTo", id });
      return;
    }
    dispatchSelection({ kind: modifiers.ctrl ? "toggleOne" : "selectOne", id });
  }, []);
  const onBoxSelect = useCallback((ids: readonly string[], additive: boolean): void => {
    dispatchSelection({ kind: "boxSelect", ids, additive });
  }, []);

  // 批量动作作用于当前选中集合；成功后精确失效当前库的集合族。
  const selectedHashList = useMemo(() => [...selectedIds], [selectedIds]);
  const writesDisabled = organizationBusy || collection.isPlaceholderData || collection.isError || !active;
  const singleAsset = selectedIds.size === 1 && selectedAsset !== undefined ? selectedAsset : null;
  const canRename = !writesDisabled && !collection.isError && layout.location === "active" && singleAsset !== null && singleAsset.deleted_at === null;
  const openRename = useCallback((): void => {
    if (!canRename || singleAsset === null || renameTarget !== null) return;
    renameOrigin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setRenameTarget(filenameTarget(singleAsset));
  }, [canRename, singleAsset, renameTarget]);
  const folderDrag = useFolderDrag({
    selectedIds, disabled: writesDisabled || layout.location !== "active",
    selectSource: (id) => dispatchSelection({ kind: "selectOne", id }),
    restore: (ids) => dispatchSelection({ kind: "boxSelect", ids }),
    move: (hashes, folder) => actions.run({ kind: "move", hashes, folder }),
  });

  // Esc/Ctrl+A 属于本工作区的批量语法：仅激活时认领，文本控件内保持原生行为。
  // 用冒泡阶段监听：框选手势的 Esc 在捕获阶段 stopPropagation，不会到 Window。
  useEffect(() => {
    if (!active) return undefined;
    const isEditable = (target: EventTarget | null): boolean =>
      target instanceof Element &&
      target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [role="alertdialog"], [role="menu"]') !== null;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || isEditable(event.target)) return;
      if (event.key === "Escape") {
        if (selectedIds.size > 0) {
          event.preventDefault();
          dispatchSelection({ kind: "clear" });
        }
        return;
      }
      if (!event.ctrlKey || event.altKey || event.metaKey || event.key.toLowerCase() !== "a") return;
      event.preventDefault();
      dispatchSelection({ kind: "selectAll" });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, selectedIds.size]);
  const changeLayout = useCallback((next: AssetPreferences): void => {
    const current = client.getQueryData<LibraryPreferences>(assetKeys.preferences(session.id));
    if (current === undefined) throw new Error("已加载工作区缺少布局会话");
    // 滚动写入刻意不触发本地 layout state；其他控件必须合并缓存中的最新偏移。
    const merged = { ...next, scrollOffsets: current.assets.scrollOffsets };
    setLayout(merged);
    client.setQueryData<LibraryPreferences>(assetKeys.preferences(session.id), { ...current, assets: merged });
    savePreferences(merged);
  }, [client, session.id, savePreferences]);

  const folderCommitted = async (change: FolderChange): Promise<void> => {
    if (change.kind === "create") changeLayout({ ...layout, folder: { kind: "path", path: change.path }, location: "active" });
    else if (change.kind === "rename" && layout.folder.kind === "path" && (layout.folder.path === change.previousPath || layout.folder.path.startsWith(`${change.previousPath}/`))) {
      changeLayout({ ...layout, folder: { kind: "path", path: change.path + layout.folder.path.slice(change.previousPath.length) } });
    }
    else if (change.kind === "delete" && layout.folder.kind === "path" && (layout.folder.path === change.path || layout.folder.path.startsWith(`${change.path}/`))) {
      changeLayout({ ...layout, folder: { kind: "root" }, location: "active" });
    }
    await Promise.all([
      client.invalidateQueries({ queryKey: assetKeys.collections(session.id) }),
      client.invalidateQueries({ queryKey: assetKeys.details(session.id) }),
    ]);
  };
  const navigatorProps = {
    folders: collection.data?.folders ?? [],
    tagUsage: collection.data?.tags ?? [],
    trashCount: collection.data?.trash_count ?? 0,
    scope: layout,
    dropTarget: folderDrag.preview?.target,
    onChange: (patch: Partial<NavigatorScope>): void => {
      changeLayout({ ...layout, ...patch, tags: patch.tags === undefined ? [...layout.tags] : [...patch.tags] });
      setNavigatorOpen(false);
    },
  };

  // 滚动偏移回写绕过本地 layout state：直读缓存里最新的整份偏好做合并，
  // 避免滚动期间反复重建查询对象与派生序列，也无需渲染期写 ref。
  const persistScrollOffset = useCallback((offset: number): void => {
    const current = client.getQueryData<LibraryPreferences>(assetKeys.preferences(session.id));
    if (current === undefined) return;
    const assets = {
      ...current.assets,
      scrollOffsets: { ...current.assets.scrollOffsets, [COLLECTION_SCROLL_KEY]: offset },
    };
    client.setQueryData<LibraryPreferences>(assetKeys.preferences(session.id), { ...current, assets });
    savePreferences(assets);
  }, [client, savePreferences, session.id]);

  // 本地查找快捷键只在本工作区激活时认领：Ctrl+F 聚焦搜索框并全选内容；
  // Ctrl+K 属于应用外壳的全局搜索，这里刻意不认领，分层由结构保证。
  const sectionRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!canRename || renameTarget !== null) return undefined;
    const onRenameKey = (event: KeyboardEvent): void => {
      if (event.key !== "F2" || event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [role="alertdialog"], [role="menu"]') !== null) return;
      event.preventDefault();
      openRename();
    };
    window.addEventListener("keydown", onRenameKey);
    return () => window.removeEventListener("keydown", onRenameKey);
  }, [canRename, renameTarget, openRename]);

  const restoreRenameFocus = (): void => {
    const origin = renameOrigin.current;
    if (origin !== null && origin !== document.body && origin.isConnected) {
      origin.focus({ preventScroll: true });
      if (document.activeElement === origin) return;
    }
    // 改名后素材可能退出查询或被虚拟化卸载；回到当前集合搜索，而不是失效卡片。
    sectionRef.current?.querySelector<HTMLInputElement>('input[name="asset-filename"]')?.focus();
  };
  useEffect(() => {
    if (!active) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || (event.target instanceof Element && event.target.closest('[role="dialog"], [role="alertdialog"], [role="menu"]') !== null)) return;
      if (!event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.key.toLowerCase() !== "f") return;
      const input = sectionRef.current?.querySelector<HTMLInputElement>(
        'input[aria-label="按文件名搜索"]',
      );
      if (input === null || input === undefined) return;
      event.preventDefault();
      input.focus();
      input.select();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active]);

  // 导航是有身份的外部输入。只调整本实例状态，不在渲染中调用 IPC 或修改共享缓存。
  if (active && entry?.kind === "locate" && !seenRequests.has(entry.requestId)) {
    setSeenRequests(new Set([...seenRequests, entry.requestId]));
    dispatchSelection({ kind: "selectOne", id: entry.hash });
    const alreadyVisible = layout.location === entry.location && collection.data?.assets.some((asset) => asset.hash === entry.hash);
    if (!alreadyVisible) {
      setLayout({ ...layout, ...queryFromPreferences(defaultAssetPreferences()), location: entry.location });
    }
  }
  useEffect(() => {
    if (savedRequestCount.current === seenRequests.size) return;
    savedRequestCount.current = seenRequests.size;
    client.setQueryData<LibraryPreferences>(assetKeys.preferences(session.id), { ...saved, assets: layout });
    savePreferences(layout);
  }, [client, layout, saved, session.id, seenRequests.size, savePreferences]);

  return (
    <section ref={sectionRef} className={styles.workspace} aria-label="图片工作区" hidden={!active} {...folderDrag.handlers} data-dragging={folderDrag.preview !== null ? "true" : undefined}>
      {folderDrag.preview === null ? null : <div className={styles.dragPreview} role="status" style={{ left: folderDrag.preview.x + 12, top: folderDrag.preview.y + 12 }}>
        移动 {folderDrag.preview.count} 张图片{folderDrag.preview.target === undefined ? "：拖到文件夹" : folderDrag.preview.target === null ? "到未分类" : `到 ${folderDrag.preview.target}`}
      </div>}
      <header className={styles.heading}>
        <div><p className={styles.eyebrow}>IMAGE ARCHIVE</p><h1>{session.displayName}</h1></div>
        <span>{layout.location === "trash" ? "回收站" : layout.folder.kind === "path" ? layout.folder.path : layout.folder.kind === "root" ? "未分类" : "全部图片"}</span>
      </header>
      <div className={styles.columns}>
        <AssetNavigator {...navigatorProps} presentation="sidebar" />
        <div className={styles.content}>
          <div className={styles.toolbar} role="toolbar" aria-label="图片查询与视图">
            <div className={styles.mobileNavigation}>
              <Dialog title="图片导航" description="选择图片范围、文件夹或标签。" open={navigatorOpen} onOpenChange={setNavigatorOpen} trigger={<Button size="compact">图片导航</Button>}>
                <AssetNavigator {...navigatorProps} presentation="dialog" />
              </Dialog>
            </div>
            <FolderEditor mode="create" libraryId={session.id} currentFolder={layout.folder.kind === "path" ? layout.folder.path : null}
              folders={collection.data?.folders ?? []} disabled={writesDisabled || collection.isPending || collection.isError} onCommitted={folderCommitted} />
            <FolderEditor mode="rename" libraryId={session.id} currentFolder={layout.folder.kind === "path" ? layout.folder.path : null}
              folders={collection.data?.folders ?? []} disabled={writesDisabled || collection.isPending || collection.isError} onCommitted={folderCommitted} />
            <DeleteFolderDialog libraryId={session.id} currentFolder={layout.folder.kind === "path" ? layout.folder.path : null}
              folders={collection.data?.folders ?? []} disabled={writesDisabled || collection.isPending || collection.isError} onCommitted={folderCommitted} />
            <SearchField label="按文件名搜索" aria-label="按文件名搜索" name="asset-filename" placeholder="显示名或来源文件名…" value={layout.text} onValueChange={(text) => changeLayout({ ...layout, text })} />
            <RenameAssetDialog libraryId={session.id} target={renameTarget} disabled={!canRename} onOpen={openRename} onClose={() => setRenameTarget(null)} restoreFocus={restoreRenameFocus} />
            <div className={styles.mobileFileInformation}>
              <Dialog title="图片信息" description="查看摘要、色卡、组织、备注、关联与来源记录。" open={active && informationOpen} onOpenChange={setInformationOpen} trigger={<Button size="compact">图片信息</Button>}
                onCloseAutoFocus={(event) => {
                  if (inlineInspector) { event.preventDefault(); sectionRef.current?.querySelector<HTMLButtonElement>('[data-inspector-section] h2 button')?.focus(); }
                }}>
                <AssetInspector libraryId={session.id} asset={singleAsset} count={selectedIds.size} active={active} editable={canRename} onEdit={openRename} sections={layout.inspectorSections} onSectionsChange={(inspectorSections) => changeLayout({ ...layout, inspectorSections })} notes={notes} folders={collection.data?.folders ?? []} />
              </Dialog>
            </div>
            <div className={styles.density} role="group" aria-label="缩略图大小">
              {DENSITY_LABELS.map(({ value, label }) => (
                <Button key={value} size="compact" aria-pressed={layout.tileSize === value}
                  onClick={() => changeLayout({ ...layout, tileSize: value })}>
                  {label}
                </Button>
              ))}
            </div>
            <select aria-label="排序方式" className={styles.sortSelect} value={layout.sort}
              onChange={(event) => {
                const chosen = SORT_OPTIONS.find((option) => option.value === event.target.value);
                if (chosen === undefined) return;
                changeLayout({ ...layout, sort: chosen.value });
              }}>
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <div className={styles.views} role="group" aria-label="集合视图">
              <Button size="compact" aria-pressed={layout.view === "waterfall"} onClick={() => changeLayout({ ...layout, view: "waterfall" })}>瀑布流</Button>
              <Button size="compact" aria-pressed={layout.view === "list"} onClick={() => changeLayout({ ...layout, view: "list" })}>详情列表</Button>
            </div>
            {activeAssetId !== null && selectedAsset !== undefined && layout.location === "active" ? (
              <Button size="compact" aria-label={selectedAsset.favorite ? "取消收藏" : "收藏图片"} disabled={writesDisabled}
                onClick={() => actions.run({ kind: "favorite-one", hash: activeAssetId, value: !selectedAsset.favorite })}>
                {selectedAsset.favorite ? "取消收藏" : "收藏图片"}
              </Button>
            ) : null}
          </div>
          {saveError !== null ? <div><Problem error={saveError} /><Button onClick={() => savePreferences(layout)}>重试保存布局</Button></div> : null}
          {collection.isError ? <Problem error={collection.error} /> : collection.isPending ? <p role="status">正在读取图片…</p> : (
            orderedAssets.length === 0 ? <p className={styles.empty}>没有符合条件的图片</p> :
              <AssetCollection
                assets={orderedAssets}
                view={layout.view}
                activeId={activeAssetId}
                focusedId={selection.focusedId}
                onNavigate={(step, extend) => dispatchSelection({ kind: "moveActive", step, extend })}
                selectedIds={selectedIds}
                onItemSelect={onItemSelect}
                onBoxSelect={onBoxSelect}
                tileSize={layout.tileSize}
                initialScrollTop={layout.scrollOffsets[COLLECTION_SCROLL_KEY]}
                onScrollOffset={persistScrollOffset}
                contextMenu={layout.location === "active" && !writesDisabled
                  ? {
                      onFavorite: (id, value) => actions.run({ kind: "favorite-one", hash: id, value }),
                      onTrash: (id) => actions.run({ kind: "trash", hashes: [id] }),
                    }
                  : undefined}
              />
          )}
          {selectedIds.size > 0 ? (
            <footer className={styles.selectionBar} role="toolbar" aria-label="批量操作">
              <span className={styles.selectionCount}>已选中 {selectedIds.size} 项</span>
              {layout.location === "active" ? (
                <>
                  <MoveAssetsDialog hashes={selectedHashList} folders={collection.data?.folders ?? []} disabled={writesDisabled} busy={actions.busy} run={actions.run} />
                  <Button size="compact" disabled={writesDisabled}
                    onClick={() => actions.run({ kind: "favorite", hashes: selectedHashList, value: true })}>收藏</Button>
                  <Button size="compact" disabled={writesDisabled}
                    onClick={() => actions.run({ kind: "favorite", hashes: selectedHashList, value: false })}>取消收藏</Button>
                  <Button size="compact" disabled={writesDisabled}
                    onClick={() => actions.run({ kind: "trash", hashes: selectedHashList })}>移入回收站</Button>
                </>
              ) : null}
            </footer>
          ) : null}
          <ActionResults results={actions.results} dismiss={actions.dismiss} />
        </div>
        {inlineInspector && !informationOpen ? <aside className={styles.filenameInspector} aria-label="图片检查器">
          <AssetInspector libraryId={session.id} asset={singleAsset} count={selectedIds.size} active={active} editable={canRename} onEdit={openRename} sections={layout.inspectorSections} onSectionsChange={(inspectorSections) => changeLayout({ ...layout, inspectorSections })} notes={notes} folders={collection.data?.folders ?? []} />
        </aside> : null}
      </div>
    </section>
  );
}

function WorkspaceSession(props: AssetLibraryWorkspaceProps): ReactNode {
  const preferences = useQuery({
    queryKey: assetKeys.preferences(props.session.id),
    queryFn: async () => parseLibraryPreferences(await readLayout(props.session.id)),
    staleTime: Infinity,
    enabled: props.active,
  });
  if (preferences.isError) return <section hidden={!props.active}><Problem error={preferences.error} /><Button onClick={() => void preferences.refetch()}>重试恢复布局</Button></section>;
  if (preferences.isPending) return <p role="status" hidden={!props.active}>正在恢复图片工作现场…</p>;
  return <LoadedWorkspace {...props} saved={preferences.data} />;
}

/** 库身份变化是会话重建边界；一级入口切换仅改变 active，保留查询和选择。 */
export function AssetLibraryWorkspace(props: AssetLibraryWorkspaceProps): ReactNode {
  return <WorkspaceSession key={props.session.id} {...props} />;
}
