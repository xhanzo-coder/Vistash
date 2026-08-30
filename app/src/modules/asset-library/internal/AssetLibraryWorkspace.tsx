import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useIsMutating, useMutation, useMutationState, useQuery, useQueryClient } from "@tanstack/react-query";
import { PencilSimpleIcon } from "@phosphor-icons/react/dist/csr/PencilSimple";
import { ArrowsOutLineHorizontalIcon } from "@phosphor-icons/react/dist/csr/ArrowsOutLineHorizontal";
import { ListBulletsIcon } from "@phosphor-icons/react/dist/csr/ListBullets";
import { SquaresFourIcon } from "@phosphor-icons/react/dist/csr/SquaresFour";
import { DotsThreeIcon } from "@phosphor-icons/react/dist/csr/DotsThree";
import { LinkSimpleIcon } from "@phosphor-icons/react/dist/csr/LinkSimple";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
import { InfoIcon } from "@phosphor-icons/react/dist/csr/Info";
import { SidebarSimpleIcon } from "@phosphor-icons/react/dist/csr/SidebarSimple";
import { StarIcon } from "@phosphor-icons/react/dist/csr/Star";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { parseAssetId, type AssetId } from "../../../app/common";
import { catalogSnapshot, readLayout, writeLayout } from "../../../shared/ipc";
import { IpcError } from "../../../shared/errors";
import { Button, IconButton } from "../../../ui/button/Button";
import { SearchField } from "../../../ui/search-field/SearchField";
import { ConfirmDialog, Dialog } from "../../../ui/dialog/Dialog";
import { Tooltip } from "../../../ui/overlays/Tooltip";
import { Menu, MenuItem } from "../../../ui/overlays/Menu";
import type { AssetLibraryWorkspaceProps } from "../index";
import { assetKeys } from "./queryKeys";
import { assetScrollScopeKey, defaultAssetPreferences, INSPECTOR_WIDTH, NAVIGATION_WIDTH, parseLibraryPreferences, queryFromPreferences, type AssetPreferences, type LibraryPreferences } from "./preferences";
import styles from "./AssetLibraryWorkspace.module.css";
import { AssetCollection } from "./AssetCollection";
import { AssetNavigator, type FolderNodeAction, type NavigatorScope } from "./AssetNavigator";
import { sortAssets } from "./collectionSort";
import { initialSelection, selectionReducer } from "./selection";
import type { CollectionSort } from "./preferences";
import { ActionResults, useAssetActions } from "./useAssetActions";
import { DeleteFolderDialog, FolderEditor, InlineFolderCreator, type FolderChange } from "./FolderEditor";
import { MoveAssetsDialog } from "./MoveAssetsDialog";
import { useFolderDrag } from "./useFolderDrag";
import { RenameAssetDialog, filenameTarget, type FilenameTarget } from "./AssetFilename";
import { AssetInspector } from "./AssetInspector";
import { AssetMultiInspector } from "./AssetMultiInspector";
import { BatchEditDialog, type BatchEdit } from "./BatchEditDialog";
import { useAssetNotes } from "./assetNotes";
import { TrashResults, useTrashActions } from "./TrashActions";
import { AssetLightbox, type LightboxSession } from "./AssetLightbox";
import { AssetTransferFeedback, ImportGuide, useAssetTransfer } from "./AssetTransfer";
import { AssetOutboundControls, AssetOutboundFeedback } from "./AssetOutbound";
import { PanelResizeHandle } from "./PanelResizeHandle";
import { MoveFolderDialog, useMoveFolder } from "./MoveFolderDialog";

// 与冻结的 780px 覆盖式检查器断点一致；隐藏的桌面检查器不持有媒体或表单实例。
const inlineInspectorSnapshot = (): boolean => window.innerWidth > 780;
const subscribeViewport = (listener: () => void): (() => void) => {
  window.addEventListener("resize", listener, { passive: true });
  return () => window.removeEventListener("resize", listener);
};
const DENSITY_VALUES = ["small", "medium", "large"] as const;
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

function LoadedWorkspace({ session, active, entry, importRequest, onImportRequestHandled, saved }: AssetLibraryWorkspaceProps & { saved: LibraryPreferences }): ReactNode {
  const client = useQueryClient();
  useEffect(() => {
    if (!active) client.removeQueries({ queryKey: assetKeys.collections(session.id) });
  }, [active, client, session.id]);
  const notes = useAssetNotes(session.id, active);
  const inlineInspector = useSyncExternalStore(subscribeViewport, inlineInspectorSnapshot);
  const organizationBusy = useIsMutating({ predicate: (mutation) => mutation.options.scope?.id === `asset-organization:${session.id}` }) > 0;
  const [layout, setLayout] = useState<AssetPreferences>(() => {
    if (active && entry?.kind === "locate") {
      return { ...saved.assets, ...queryFromPreferences(defaultAssetPreferences()), location: entry.location };
    }
    return saved.assets;
  });
  const save = useMutation({
    mutationKey: assetKeys.savePreferences(session.id),
    scope: { id: `asset-preferences:${session.id}` },
    mutationFn: async (next: AssetPreferences) => {
      const latest = parseLibraryPreferences(await readLayout(session.id));
      await writeLayout(session.id, { ...latest, assets: { ...latest.assets, ...next } });
    },
  });
  const { mutate: savePreferences } = save;
  const latestSave = useMutationState({
    filters: { mutationKey: assetKeys.savePreferences(session.id), exact: true },
    select: (mutation) => ({ status: mutation.state.status, error: mutation.state.error }),
  }).at(-1);
  const saveError = latestSave?.status === "error" ? latestSave.error : null;
  const changeLayout = useCallback((next: AssetPreferences): void => {
    const current = client.getQueryData<LibraryPreferences>(assetKeys.preferences(session.id));
    if (current === undefined) throw new Error("已加载工作区缺少布局会话");
    const merged = { ...next, scrollOffsets: current.assets.scrollOffsets };
    setLayout(merged);
    client.setQueryData<LibraryPreferences>(assetKeys.preferences(session.id), { ...current, assets: merged });
    savePreferences(merged);
  }, [client, session.id, savePreferences]);
  const currentImportFolder = layout.folder.kind === "path" && layout.location === "active" ? layout.folder.path : null;
  const revealImported = useCallback((): void => {
    const folder = currentImportFolder !== null
      ? { kind: "path" as const, path: currentImportFolder }
      : layout.location === "active" && layout.folder.kind === "all" && layout.favorite !== true
        ? { kind: "all" as const }
        : { kind: "root" as const };
    changeLayout({ ...layout, text: "", tags: [], favorite: null, folder, location: "active" });
  }, [changeLayout, currentImportFolder, layout]);
  const transfer = useAssetTransfer(session.id, active, currentImportFolder, revealImported);
  const { chooseFolder, chooseImages } = transfer;
  const handledImportRequest = useRef<string | null>(null);
  useEffect(() => {
    if (!active || importRequest === undefined || handledImportRequest.current === importRequest.requestId) return;
    handledImportRequest.current = importRequest.requestId;
    onImportRequestHandled?.(importRequest.requestId);
    if (importRequest.kind === "images") void chooseImages();
    else void chooseFolder();
  }, [active, chooseFolder, chooseImages, importRequest, onImportRequestHandled]);
  const [selection, dispatchSelection] = useReducer(selectionReducer, [], () => initialSelection([]));
  const selectedIds = selection.selectedIds;
  const activeId = selection.activeId;
  const [seenRequests, setSeenRequests] = useState<ReadonlySet<string>>(() => new Set());
  const [navigatorOpen, setNavigatorOpen] = useState(false);
  const [informationOpen, setInformationOpen] = useState(false);
  const [folderNodeAction, setFolderNodeAction] = useState<{ kind: FolderNodeAction; path: string } | null>(null);
  const [createFolderParent, setCreateFolderParent] = useState<string | null | undefined>(undefined);
  const [renameTarget, setRenameTarget] = useState<FilenameTarget | null>(null);
  const renameOrigin = useRef<HTMLElement | null>(null);
  const [batchEdit, setBatchEdit] = useState<BatchEdit | null>(null);
  const batchOrigin = useRef<HTMLElement | null>(null);
  const [lightbox, setLightbox] = useState<LightboxSession | null>(null);
  const [previewReturn, setPreviewReturn] = useState<{ id: number; hash: string | null; scrollTop: number } | null>(null);
  const nextPreviewReturn = useRef(0);
  const savedRequestCount = useRef(0);
  const query = queryFromPreferences(layout);
  const scrollScopeKey = assetScrollScopeKey(query);
  const scopeKey = JSON.stringify({ folder: query.folder, favorite: query.favorite, location: query.location });
  const collection = useQuery({
    queryKey: assetKeys.collection(session.id, query),
    queryFn: async ({ signal }) => {
      signal.throwIfAborted();
      const snapshot = await catalogSnapshot(query);
      signal.throwIfAborted();
      return { scopeKey, snapshot };
    },
    enabled: active,
    staleTime: Infinity,
    // 查询切换期间保留上一份快照，使左栏树与标签面板不会随加载闪空。
    placeholderData: (previous) => previous,
  });
  const snapshot = collection.data?.snapshot;
  const changingBrowseScope = collection.isPlaceholderData && collection.data?.scopeKey !== scopeKey;

  const actions = useAssetActions(session.id);
  const trash = useTrashActions(session.id);
  // 排序是呈现语义：同一份缓存快照在两种视图与排序选项间共享，不触发新拉取。
  const orderedAssets = useMemo(
    () => sortAssets(snapshot?.assets ?? [], layout.sort),
    [snapshot, layout.sort],
  );
  const renderedAssets = useMemo(
    () => changingBrowseScope ? [] : orderedAssets,
    [changingBrowseScope, orderedAssets],
  );
  // 查询域变化收敛进选择模型：越界选中被裁剪，同域下发不打扰现场。
  useEffect(() => {
    dispatchSelection({ kind: "idsReplaced", ids: orderedAssets.map((asset) => asset.hash) });
  }, [orderedAssets]);
  const selectedAsset = orderedAssets.find((asset) => asset.hash === activeId);
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
  const selectedAssets = useMemo(() => orderedAssets.filter((asset) => selectedIds.has(asset.hash)), [orderedAssets, selectedIds]);
  const allSelectedFavorite = selectedAssets.length > 0 && selectedAssets.every((asset) => asset.favorite);
  const writesDisabled = organizationBusy || collection.isPlaceholderData || collection.isError || !active;
  const singleAsset = selectedIds.size === 1 && selectedAsset !== undefined ? selectedAsset : null;
  const restoreSelected = (): void => {
    if (writesDisabled || layout.location !== "trash" || selectedAssets.length === 0) return;
    trash.restore(selectedAssets.map((asset) => ({ hash: parseAssetId(asset.hash), displayName: asset.display_filename })));
  };
  const canRename = !writesDisabled && !collection.isError && layout.location === "active" && singleAsset !== null && singleAsset.deleted_at === null;
  const openRename = useCallback((): void => {
    if (!canRename || singleAsset === null || renameTarget !== null) return;
    renameOrigin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setRenameTarget(filenameTarget(singleAsset));
  }, [canRename, singleAsset, renameTarget]);
  const inspectorActions = singleAsset === null || activeAssetId === null || layout.location !== "active" ? undefined : <div className={styles.inspectorActions} aria-label="当前图片操作">
    <AssetOutboundControls libraryId={session.id} assets={[singleAsset]} active={active} disabled={writesDisabled} />
    <Tooltip content="修改显示文件名"><IconButton size="compact" label="修改显示文件名" icon={<PencilSimpleIcon />} disabled={!canRename} onClick={openRename} /></Tooltip>
    <Tooltip content={singleAsset.favorite ? "取消收藏" : "收藏"}><IconButton size="compact" label={singleAsset.favorite ? "取消收藏" : "收藏图片"} icon={<StarIcon weight={singleAsset.favorite ? "fill" : "regular"} />} disabled={writesDisabled} aria-pressed={singleAsset.favorite} onClick={() => actions.run({ kind: "favorite-one", hash: activeAssetId, value: !singleAsset.favorite })} /></Tooltip>
  </div>;
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
  const folderCommitted = async (change: FolderChange): Promise<void> => {
    if (change.kind === "create") changeLayout({ ...layout, text: "", tags: [], favorite: null, folder: { kind: "path", path: change.path }, location: "active" });
    else if ((change.kind === "rename" || change.kind === "move") && layout.folder.kind === "path" && (layout.folder.path === change.previousPath || layout.folder.path.startsWith(`${change.previousPath}/`))) {
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
  const draggedFolderMove = useMoveFolder(session.id, folderCommitted);
  if (draggedFolderMove.error !== null && !(draggedFolderMove.error instanceof IpcError)) {
    throw draggedFolderMove.error;
  }
  const navigatorProps = {
    width: layout.navigationWidth,
    collapsed: layout.navigationCollapsed,
    onToggleCollapsed: (): void => changeLayout({ ...layout, navigationCollapsed: !layout.navigationCollapsed }),
    folderActions: <Tooltip content={layout.folder.kind === "path" ? "新建子文件夹" : "新建文件夹"}><IconButton size="compact" label="新建文件夹" icon={<PlusIcon />} disabled={writesDisabled || collection.isPending || collection.isError || organizationBusy} onClick={() => setCreateFolderParent(layout.folder.kind === "path" ? layout.folder.path : null)} /></Tooltip>,
    folders: snapshot?.folders ?? [],
    tagUsage: snapshot?.tags ?? [],
    trashCount: snapshot?.trash_count ?? 0,
    scope: layout,
    dropTarget: folderDrag.preview?.target,
    onFolderAction: (kind: FolderNodeAction, path: string): void => {
      if (kind === "create-child") setCreateFolderParent(path);
      else setFolderNodeAction({ kind, path });
    },
    folderInteractionDisabled: writesDisabled || collection.isPending || collection.isError || organizationBusy || draggedFolderMove.isPending,
    onFolderMove: (path: string, destinationParent: string | null): void => {
      draggedFolderMove.mutate({ path, destinationParent });
    },
    folderCreator: createFolderParent === undefined ? null : {
      parent: createFolderParent,
      node: <InlineFolderCreator libraryId={session.id} parent={createFolderParent} disabled={writesDisabled || collection.isPending || collection.isError || organizationBusy}
        onCommitted={folderCommitted} onCancel={() => setCreateFolderParent(undefined)} />,
    },
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
      scrollOffsets: { ...current.assets.scrollOffsets, [scrollScopeKey]: offset },
    };
    client.setQueryData<LibraryPreferences>(assetKeys.preferences(session.id), { ...current, assets });
    savePreferences(assets);
  }, [client, savePreferences, scrollScopeKey, session.id]);

  // 本地查找快捷键只在本工作区激活时认领：Ctrl+F 聚焦搜索框并全选内容；
  // Ctrl+K 属于应用外壳的全局搜索，这里刻意不认领，分层由结构保证。
  const sectionRef = useRef<HTMLElement | null>(null);
  const openLightbox = (hash: AssetId): void => {
    if (!active || collection.isPending || collection.isError || collection.isPlaceholderData || lightbox !== null) return;
    const gallery = sectionRef.current?.querySelector<HTMLElement>('[role="listbox"][aria-label="图片集合"]');
    if (gallery === null || gallery === undefined || !orderedAssets.some((asset) => asset.hash === hash)) return;
    dispatchSelection({ kind: "selectOne", id: hash });
    setLightbox({ assets: orderedAssets, initialId: hash, scrollTop: gallery.scrollTop });
  };
  const closeLightbox = (hash: AssetId): void => {
    if (lightbox === null) return;
    const present = orderedAssets.some((asset) => asset.hash === hash);
    dispatchSelection(present ? { kind: "selectOne", id: hash } : { kind: "clear" });
    setPreviewReturn({ id: ++nextPreviewReturn.current, hash: present ? hash : null, scrollTop: lightbox.scrollTop });
    setLightbox(null);
  };
  const openBatchEdit = (kind: BatchEdit["kind"], origin?: HTMLElement | null): void => {
    if (writesDisabled || layout.location !== "active" || selectedHashList.length === 0) return;
    batchOrigin.current = origin ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setBatchEdit({ kind, hashes: [...selectedHashList] });
  };
  const restoreBatchFocus = (): void => {
    const origin = batchOrigin.current;
    if (origin !== null && origin !== document.body && origin.isConnected) {
      origin.focus({ preventScroll: true });
      if (document.activeElement === origin) return;
    }
    // 写入可能让原触发器退出查询；仍有覆盖检查器时在其中恢复，否则回到集合搜索。
    const target = informationOpen ? document.querySelector<HTMLButtonElement>('[role="dialog"] button') : sectionRef.current?.querySelector<HTMLInputElement>('input[name="asset-filename"]');
    target?.focus();
  };
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
    // WebView2/系统级组合键在不同宿主上可能从 document 捕获阶段进入；
    // 同一处理器保留 window 冒泡接缝以兼容浏览器与现有测试事件。首次处理会
    // preventDefault，window 阶段只会看到 defaultPrevented，不会重复聚焦。
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [active]);

  // 导航是有身份的外部输入。只调整本实例状态，不在渲染中调用 IPC 或修改共享缓存。
  useEffect(() => {
    if (active || lightbox === null) return;
    // 失活是应用壳层的外部生命周期输入；清除灯箱会话，避免重新激活时恢复过期原图。
    // oxlint-disable-next-line react/set-state-in-effect
    setLightbox(null);
  }, [active, lightbox]);

  useEffect(() => {
    if (!active || entry?.kind !== "locate" || seenRequests.has(entry.requestId)) return;
    // 定位请求是应用层外部输入；消费后记录 requestId，保证一次性语义。
    // oxlint-disable-next-line react/set-state-in-effect
    setSeenRequests((current) => {
      if (current.has(entry.requestId)) return current;
      return new Set([...current, entry.requestId]);
    });
    if (lightbox !== null) {
      // 定位请求离开当前原图上下文时必须先关闭灯箱。
      // oxlint-disable-next-line react/set-state-in-effect
      setLightbox(null);
    }
    dispatchSelection({ kind: "selectOne", id: entry.hash });
    const alreadyVisible = layout.location === entry.location && snapshot?.assets.some((asset) => asset.hash === entry.hash);
    if (!alreadyVisible) {
      // 定位到另一查询域需要原子地切换本模块查询偏好。
      // oxlint-disable-next-line react/set-state-in-effect
      setLayout((current) => ({ ...current, ...queryFromPreferences(defaultAssetPreferences()), location: entry.location }));
    }
  }, [active, dispatchSelection, entry, layout.location, lightbox, seenRequests, snapshot]);
  useEffect(() => {
    if (savedRequestCount.current === seenRequests.size) return;
    savedRequestCount.current = seenRequests.size;
    client.setQueryData<LibraryPreferences>(assetKeys.preferences(session.id), { ...saved, assets: layout });
    savePreferences(layout);
  }, [client, layout, saved, session.id, seenRequests.size, savePreferences]);

  const collectionTitle = layout.location === "trash"
    ? "回收站"
    : layout.favorite === true
      ? "收藏"
      : layout.folder.kind === "path"
        ? layout.folder.path
        : layout.folder.kind === "root"
          ? "未分类"
          : "全部图片";
  const hasCentralFilter = layout.text.trim().length > 0 || layout.tags.length > 0;
  const emptyMessage = hasCentralFilter
    ? "没有符合条件的图片"
    : layout.location === "trash"
      ? "图片回收站为空"
      : layout.favorite === true
        ? "还没有收藏图片"
        : layout.folder.kind === "root"
          ? "未分类中没有图片"
          : layout.folder.kind === "path"
            ? "此文件夹中没有图片"
            : "图片库还是空的";
  const showImportGuide = layout.location === "active"
    && layout.favorite !== true
    && layout.folder.kind === "all"
    && !hasCentralFilter;

  return (
    <section ref={sectionRef} className={styles.workspace} aria-label="图片工作区" hidden={!active} {...folderDrag.handlers} data-dragging={folderDrag.preview !== null ? "true" : undefined}>
      {folderDrag.preview === null ? null : <div className={styles.dragPreview} role="status" style={{ left: folderDrag.preview.x + 12, top: folderDrag.preview.y + 12 }}>
        移动 {folderDrag.preview.count} 张图片{folderDrag.preview.target === undefined ? "：拖到文件夹" : folderDrag.preview.target === null ? "到未分类" : `到 ${folderDrag.preview.target}`}
      </div>}
      <div className={styles.columns}>
        <AssetNavigator {...navigatorProps} presentation="sidebar" />
        {layout.navigationCollapsed ? null : <PanelResizeHandle panel="navigation" label="调整图片导航宽度" value={layout.navigationWidth} min={NAVIGATION_WIDTH.min} max={NAVIGATION_WIDTH.max} defaultValue={NAVIGATION_WIDTH.default} pointerDirection={1}
          onPreview={(navigationWidth) => setLayout((current) => ({ ...current, navigationWidth }))}
          onCommit={(navigationWidth) => changeLayout({ ...layout, navigationWidth })} />}
        <div className={styles.content}>
          <header className={styles.heading}>
            <h1>{collectionTitle}</h1>
            <span aria-live="polite">{collection.isPending || changingBrowseScope ? "正在读取…" : collection.isError ? "读取失败" : `${renderedAssets.length.toLocaleString("zh-CN")} 张图片`}</span>
          </header>
          <div className={styles.toolbar} role="toolbar" aria-label="图片查询与视图">
            <div className={styles.mobileNavigation}>
              <Dialog title="图片导航" description="选择图片范围、文件夹或标签。" open={navigatorOpen} onOpenChange={setNavigatorOpen} trigger={<IconButton size="compact" label="图片导航" title="图片导航" icon={<SidebarSimpleIcon />} />}>
                <AssetNavigator {...navigatorProps} presentation="dialog" />
              </Dialog>
            </div>
            <div className={styles.localSearch}><SearchField label="按文件名搜索" aria-label="按文件名搜索" name="asset-filename" placeholder="搜索文件名…" value={layout.text} onValueChange={(text) => changeLayout({ ...layout, text })} /></div>
            {layout.location === "trash" && snapshot !== undefined ? <ConfirmDialog title="永久清空图片回收站？" description={`将永久删除回收站内全部 ${snapshot.trash_count} 张图片，包括当前筛选未显示的图片。此操作无法还原，不会删除库外源文件。`} confirmLabel="永久清空"
              trigger={<Button size="compact" variant="danger" disabled={writesDisabled || collection.isPending || snapshot.trash_count === 0}>清空图片回收站</Button>}
              onConfirm={() => { if (!writesDisabled && !collection.isPending && snapshot.trash_count > 0) trash.purge(); }}
              onCloseAutoFocus={(event) => { event.preventDefault(); sectionRef.current?.querySelector<HTMLInputElement>('input[name="asset-filename"]')?.focus(); }} /> : null}
            <div className={styles.mobileFileInformation}>
              <Dialog title="图片信息" description="查看摘要、色卡、组织、备注、关联与来源记录。" open={active && informationOpen} onOpenChange={setInformationOpen} trigger={<IconButton size="compact" label="图片信息" title="图片信息" icon={<InfoIcon />} />}
                onCloseAutoFocus={(event) => {
                  if (inlineInspector) { event.preventDefault(); sectionRef.current?.querySelector<HTMLElement>('[data-inspector-heading], [data-inspector-section] h2 button')?.focus(); }
                }}>
                {selectedAssets.length > 1 ? <AssetMultiInspector assets={selectedAssets} /> : <AssetInspector libraryId={session.id} asset={singleAsset} count={selectedIds.size} active={active} editable={canRename} sections={layout.inspectorSections} onSectionsChange={(inspectorSections) => changeLayout({ ...layout, inspectorSections })} notes={notes} folders={snapshot?.folders ?? []} onRestore={restoreSelected} restorable={!writesDisabled && layout.location === "trash"} actions={inspectorActions} />}
              </Dialog>
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
            <label className={styles.density} title="缩略图大小">
              <ArrowsOutLineHorizontalIcon aria-hidden="true" />
              <span className={styles.visuallyHidden}>缩略图大小</span>
              <input type="range" name="asset-thumbnail-density" aria-label="缩略图大小" min="0" max="2" step="1" value={DENSITY_VALUES.indexOf(layout.tileSize)}
                onChange={(event) => {
                  const value = DENSITY_VALUES[Number(event.currentTarget.value)];
                  if (value === undefined) throw new RangeError("缩略图密度档位越界");
                  changeLayout({ ...layout, tileSize: value });
                }} />
            </label>
            <div className={styles.views} role="group" aria-label="集合视图">
              <Tooltip content="瀑布流"><Button size="compact" variant="ghost" aria-label="瀑布流" startIcon={<SquaresFourIcon />} aria-pressed={layout.view === "waterfall"} onClick={() => changeLayout({ ...layout, view: "waterfall" })}><span className={styles.visuallyHidden}>瀑布流</span></Button></Tooltip>
              <Tooltip content="详情列表"><Button size="compact" variant="ghost" aria-label="详情列表" startIcon={<ListBulletsIcon />} aria-pressed={layout.view === "list"} onClick={() => changeLayout({ ...layout, view: "list" })}><span className={styles.visuallyHidden}>详情列表</span></Button></Tooltip>
            </div>
          </div>
          <AssetTransferFeedback transfer={transfer} />
          <AssetOutboundFeedback libraryId={session.id} />
          <RenameAssetDialog libraryId={session.id} target={renameTarget} onClose={() => setRenameTarget(null)} restoreFocus={restoreRenameFocus} />
          {saveError !== null ? <div><Problem error={saveError} /><Button onClick={() => savePreferences(layout)}>重试保存布局</Button></div> : null}
          {collection.isError ? <div><Problem error={collection.error} /><Button onClick={() => void collection.refetch()}>重试读取图片</Button></div> : collection.isPending || changingBrowseScope ? <p role="status">正在读取图片…</p> : (
            renderedAssets.length === 0 ? <><p className={styles.empty}>{emptyMessage}</p>{showImportGuide ? <ImportGuide onImportImages={() => void transfer.chooseImages()} onImportFolder={() => void transfer.chooseFolder()} /> : null}</> :
              <AssetCollection
                onOpen={openLightbox}
                previewOpen={lightbox !== null}
                previewReturn={previewReturn}
                assets={renderedAssets}
                view={layout.view}
                activeId={activeAssetId}
                focusedId={selection.focusedId}
                onNavigate={(step, extend) => dispatchSelection({ kind: "moveActive", step, extend })}
                selectedIds={selectedIds}
                onItemSelect={onItemSelect}
                onBoxSelect={onBoxSelect}
                tileSize={layout.tileSize}
                scrollScopeKey={scrollScopeKey}
                initialScrollTop={layout.scrollOffsets[scrollScopeKey]}
                onScrollOffset={persistScrollOffset}
                contextMenu={layout.location === "active" && !writesDisabled
                  ? {
                      onFavorite: (id, value) => actions.run({ kind: "favorite-one", hash: id, value }),
                      onTrash: (id) => actions.run({ kind: "trash", hashes: [id] }),
                    }
                  : undefined}
              />
          )}
          {selectedIds.size > 1 ? (
            <footer className={styles.selectionBar} role="toolbar" aria-label="批量操作">
              <span className={styles.selectionCount}>已选中 {selectedIds.size} 项</span>
              {layout.location === "active" ? (
                <>
                  <AssetOutboundControls libraryId={session.id} assets={selectedAssets} active={active} disabled={writesDisabled} />
                  <MoveAssetsDialog hashes={selectedHashList} folders={snapshot?.folders ?? []} disabled={writesDisabled} busy={actions.busy} run={actions.run} />
                  <Button size="compact" disabled={writesDisabled} onClick={() => openBatchEdit("tags")}>标签</Button>
                  <Button size="compact" disabled={writesDisabled}
                    onClick={() => actions.run({ kind: "favorite", hashes: selectedHashList, value: !allSelectedFavorite })}>{allSelectedFavorite ? "取消收藏" : "收藏"}</Button>
                  <Menu align="end" label="更多批量操作" trigger={<IconButton size="compact" label="更多批量操作" title="更多批量操作" icon={<DotsThreeIcon />} disabled={writesDisabled} />}>
                    <MenuItem icon={<LinkSimpleIcon />} onSelect={() => openBatchEdit("link", sectionRef.current?.querySelector<HTMLButtonElement>('button[aria-label="更多批量操作"]'))}>关联提示词</MenuItem>
                    <MenuItem icon={<TrashIcon />} destructive onSelect={() => actions.run({ kind: "trash", hashes: selectedHashList })}>移入回收站</MenuItem>
                  </Menu>
                </>
              ) : <Button size="compact" disabled={writesDisabled} onClick={restoreSelected}>还原所选图片</Button>}
            </footer>
          ) : null}
          <ActionResults results={actions.results} dismiss={actions.dismiss} />
          <TrashResults actions={trash} />
          {lightbox === null || !active ? null : <AssetLightbox session={lightbox} onClose={closeLightbox} />}
          <BatchEditDialog edit={batchEdit} libraryId={session.id} active={active} busy={organizationBusy} run={actions.run} onClose={() => setBatchEdit(null)} restoreFocus={restoreBatchFocus} />
        </div>
        {inlineInspector && !informationOpen ? <>
          {layout.inspectorCollapsed ? null : <PanelResizeHandle panel="inspector" label="调整图片检查器宽度" value={layout.inspectorWidth} min={INSPECTOR_WIDTH.min} max={INSPECTOR_WIDTH.max} defaultValue={INSPECTOR_WIDTH.default} pointerDirection={-1}
            onPreview={(inspectorWidth) => setLayout((current) => ({ ...current, inspectorWidth }))}
            onCommit={(inspectorWidth) => changeLayout({ ...layout, inspectorWidth })} />}
          <aside className={styles.filenameInspector} aria-label="图片检查器" data-collapsed={layout.inspectorCollapsed ? "true" : undefined} style={{ flexBasis: layout.inspectorCollapsed ? "3.5rem" : `${layout.inspectorWidth}px` }}>
            <div className={styles.inspectorPanelHeader}><Tooltip content={layout.inspectorCollapsed ? "展开图片检查器" : "收起图片检查器"}><IconButton size="compact" label={layout.inspectorCollapsed ? "展开图片检查器" : "收起图片检查器"} icon={<SidebarSimpleIcon />} onClick={() => changeLayout({ ...layout, inspectorCollapsed: !layout.inspectorCollapsed })} /></Tooltip></div>
            {layout.inspectorCollapsed ? null : <div className={styles.inspectorScroll}>{selectedAssets.length > 1 ? <AssetMultiInspector assets={selectedAssets} /> : <AssetInspector libraryId={session.id} asset={singleAsset} count={selectedIds.size} active={active} editable={canRename} sections={layout.inspectorSections} onSectionsChange={(inspectorSections) => changeLayout({ ...layout, inspectorSections })} notes={notes} folders={snapshot?.folders ?? []} onRestore={restoreSelected} restorable={!writesDisabled && layout.location === "trash"} actions={inspectorActions} />}</div>}
          </aside>
        </> : null}
      </div>
      {folderNodeAction?.kind === "rename" ? <FolderEditor key={`rename:${folderNodeAction.path}`} mode="rename" initiallyOpen libraryId={session.id} currentFolder={folderNodeAction.path}
        folders={snapshot?.folders ?? []} disabled={writesDisabled || collection.isPending || collection.isError} onCommitted={folderCommitted} onClosed={() => setFolderNodeAction(null)} /> : null}
      {folderNodeAction?.kind === "move" ? <MoveFolderDialog key={`move:${folderNodeAction.path}`} libraryId={session.id} path={folderNodeAction.path}
        folders={snapshot?.folders ?? []} disabled={writesDisabled || collection.isPending || collection.isError} onCommitted={folderCommitted} onClosed={() => setFolderNodeAction(null)} /> : null}
      {folderNodeAction?.kind === "delete" ? <DeleteFolderDialog key={`delete:${folderNodeAction.path}`} initiallyOpen libraryId={session.id} currentFolder={folderNodeAction.path}
        folders={snapshot?.folders ?? []} disabled={writesDisabled || collection.isPending || collection.isError} onCommitted={folderCommitted} onClosed={() => setFolderNodeAction(null)} /> : null}
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
