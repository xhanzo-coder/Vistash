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
import { AssetGrid } from "./AssetGrid";
import { AssetPreview } from "./AssetPreview";

type ConfirmState = {
  title: string;
  body: string;
  confirmLabel: string;
  refreshCurrentQuery: boolean;
  onConfirm: () => Promise<void>;
};

export function AssetWorkspace({ refreshVersion }: { refreshVersion: number }) {
  const [text, setText] = useState("");
  const deferredText = useDeferredValue(text);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [folder, setFolder] = useState<FolderFilter>({ kind: "all" });
  const [location, setLocation] = useState<"active" | "trash">("active");
  const [snapshot, setSnapshot] = useState<CatalogSnapshot | null>(null);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [notice, setNotice] = useState<AppError | null>(null);
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [purgeReport, setPurgeReport] = useState<PurgeReport | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  const [renameValue, setRenameValue] = useState("");
  const [folderProgress, setFolderProgress] = useState<FolderMutationProgress | null>(null);

  const query = useMemo<AssetQuery>(
    // 收藏筛选属于第 9 章的检查器与筛选条；在它落地前恒为"不限"。
    () => ({ text: deferredText, tags: selectedTags, folder, favorite: null, location }),
    [deferredText, folder, location, selectedTags],
  );
  const snapshotRequest = useMemo(
    () => ({ query, refreshVersion }),
    [query, refreshVersion],
  );

  const refresh = useCallback(async () => {
    try {
      const next = await catalogSnapshot(query);
      setSnapshot(next);
      setError(null);
      setSelectedHash((current) =>
        current !== null && next.assets.some((asset) => asset.hash === current)
          ? current
          : null,
      );
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
        setSelectedHash((current) =>
          current !== null && next.assets.some((asset) => asset.hash === current)
            ? current
            : null,
        );
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

  const selected =
    selectedHash === null
      ? null
      : (snapshot?.assets.find((asset) => asset.hash === selectedHash) ?? null);

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
    setSelectedHash(null);
    setRenameValue(next.kind === "path" ? finalFolderSegment(next.path) : "");
  }

  function toggleTag(tag: string) {
    setSelectedTags((current) =>
      current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag],
    );
    setSelectedHash(null);
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
        setSelectedHash(null);
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
        setSelectedHash(null);
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
    <section className="asset-workspace" aria-label="素材工作区">
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
              setSelectedHash(null);
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
        ) : selected !== null ? (
          <AssetDetails
            asset={selected}
            folders={snapshot?.folders ?? []}
            isTrash={location === "trash"}
            mutating={mutating}
            onBack={() => setSelectedHash(null)}
            onSetFolders={(folders) =>
              runMutation(() => setAssetFolders(selected.hash, folders), true)
            }
            onSetTags={(tags) => runMutation(() => setAssetTags(selected.hash, tags), true)}
            onDelete={() => requestAssetDelete(selected)}
            onRestore={() =>
              runMutation(async () => {
                const outcome = await restoreAsset(selected.hash);
                setSelectedHash(null);
                if (outcome.missing_folders.length > 0) {
                  setNotice({
                    code: "trash.restore_target_folder_missing",
                    detail: `缺失文件夹：${outcome.missing_folders.join("、")}`,
                  });
                }
              }, true)
            }
          />
        ) : (
          <AssetGrid assets={snapshot?.assets ?? []} onSelect={(asset) => setSelectedHash(asset.hash)} />
        )}
      </div>

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

function AssetDetails({
  asset,
  folders,
  isTrash,
  mutating,
  onBack,
  onSetFolders,
  onSetTags,
  onDelete,
  onRestore,
}: {
  asset: AssetRow;
  folders: string[];
  isTrash: boolean;
  mutating: boolean;
  onBack: () => void;
  onSetFolders: (folders: string[]) => Promise<void>;
  onSetTags: (tags: string[]) => Promise<void>;
  onDelete: () => void;
  onRestore: () => Promise<void>;
}) {
  const [tagDraft, setTagDraft] = useState("");

  return (
    <div className="asset-details">
      <AssetPreview asset={asset} onClose={onBack} />
      <aside className="metadata-panel" aria-label="素材组织">
        <p className="eyebrow">ORGANIZE</p>
        <h3>归档信息</h3>
        {!isTrash && (
          <>
            <fieldset>
              <legend>逻辑文件夹</legend>
              {folders.length === 0 ? (
                <p className="muted">尚未创建文件夹。</p>
              ) : (
                folders.map((folder) => (
                  <label key={folder} className="check-row">
                    <input
                      type="checkbox"
                      checked={asset.folders.includes(folder)}
                      disabled={mutating}
                      onChange={() => {
                        const next = asset.folders.includes(folder)
                          ? asset.folders.filter((item) => item !== folder)
                          : [...asset.folders, folder];
                        void onSetFolders(next);
                      }}
                    />
                    <span>{folder}</span>
                  </label>
                ))
              )}
            </fieldset>
            <div className="tag-editor">
              <h4>标签</h4>
              <div className="tag-list">
                {asset.tags.map((tag) => (
                  <button
                    type="button"
                    key={tag}
                    aria-label={`移除标签 ${tag}`}
                    onClick={() => void onSetTags(asset.tags.filter((item) => item !== tag))}
                  >
                    {tag} ×
                  </button>
                ))}
              </div>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const next = [...asset.tags, tagDraft];
                  setTagDraft("");
                  void onSetTags(next);
                }}
              >
                <label htmlFor="new-tag">添加标签</label>
                <div className="compact-form">
                  <input
                    id="new-tag"
                    name="new-tag"
                    autoComplete="off"
                    value={tagDraft}
                    onChange={(event) => setTagDraft(event.target.value)}
                    required
                  />
                  <button type="submit" disabled={mutating}>添加</button>
                </div>
              </form>
            </div>
            <button type="button" className="danger-button" onClick={onDelete}>
              移入回收站
            </button>
          </>
        )}
        {isTrash && (
          <button type="button" className="primary-button" onClick={() => void onRestore()}>
            还原素材
          </button>
        )}
      </aside>
    </div>
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
