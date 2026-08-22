import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { asAppError } from "../../shared/errors";
import {
  deletePrompt,
  promptSnapshot,
  purgePromptTrash,
  restorePrompt,
  setPromptFavorite,
  setPromptFolders,
  setPromptTags,
} from "../../shared/ipc";
import type {
  AppError,
  FolderFilter,
  PromptPurgeReport,
  PromptQuery,
  PromptRow,
  PromptSnapshot,
} from "../../shared/types";
import { ErrorLine } from "../library/ErrorLine";
import { useWindowTier } from "../workspace/breakpoints";
import { AppliedFilterChips, type AppliedFilterChip } from "../workspace/AppliedFilterChips";
import { ConfirmDialog } from "../workspace/ConfirmDialog";
import { useLibraryLayout, type WorkspaceView } from "../workspace/libraryLayout";
import { SelectionProvider, useSelection } from "../workspace/selectionContext";
import type { GlobalLocateRequest } from "../workspace/GlobalSearch";
import { WorkspaceDrawer } from "../workspace/workspaceDrawer";
import { PromptBodyFocus } from "./PromptBodyFocus";
import { promptDisplayTitle } from "./promptDisplay";
import { PromptCardWaterfall } from "./PromptCardWaterfall";
import { PromptDetailList } from "./PromptDetailList";
import { PromptInspector } from "./PromptInspector";
import {
  DEFAULT_PROMPT_SORT,
  sortPrompts,
  type PromptSort,
  type PromptSortColumn,
} from "./promptSort";

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
 * 与图片侧 AssetWorkspace 同构：左分类、中央集合、右检查器三栏；查询状态、
 * 快照刷新与变更协调都在这里，中央视图与检查器只是呈现端。
 *
 * 布局偏好只消费滚动偏移（"prompts-waterfall"/"prompts-list" 键），视图、筛选
 * 与排序用组件内状态：useLibraryLayout 的顶层 view/folder/tags/favorite 字段
 * 归图片侧所有，提示词侧写它们会互相覆盖；滚动键由消费方命名，天然隔离。
 */
export function PromptWorkspace({
  refreshVersion,
  libraryId,
  locate = null,
}: {
  refreshVersion: number;
  libraryId: string | null;
  /** 全局搜索发来的定位请求（任务 11.1）；由 App 保证只发给本库。 */
  locate?: (GlobalLocateRequest & { nonce: number }) | null;
}) {
  const { layout, update } = useLibraryLayout(libraryId);
  const [text, setText] = useState("");
  const deferredText = useDeferredValue(text);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [folder, setFolder] = useState<FolderFilter>({ kind: "all" });
  // 收藏筛选：null=不限，true=只看收藏；规格里收藏是二值状态。
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [location, setLocation] = useState<"active" | "trash">("active");
  const [snapshot, setSnapshot] = useState<PromptSnapshot | null>(null);
  // 聚焦阅读：只由检查器的显式按钮进入；单击仅更新右检查器。
  // bodyFocusEdit 区分"聚焦阅读"与"编辑主字段"两种进入方式（任务 10.4）。
  const [bodyFocusId, setBodyFocusId] = useState<string | null>(null);
  const [bodyFocusEdit, setBodyFocusEdit] = useState(false);
  // 右检查器抽屉（中等/窄窗口）的开关；宽屏原位展开时忽略。
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  // 回收站（任务 10.6）：还原缺失文件夹的非阻断警告、清空回收站二次确认与逐项结果。
  const [notice, setNotice] = useState<AppError | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [purgeReport, setPurgeReport] = useState<PromptPurgeReport | null>(null);
  // 视图与排序不进布局偏好（见组件头注释）；两视图共用同一顺序。
  const [view, setView] = useState<WorkspaceView>("waterfall");
  const [sort, setSort] = useState<PromptSort>({ ...DEFAULT_PROMPT_SORT });
  // 全局搜索定位（任务 11.1）：请求先重置查询到能看见目标项的位置，再由
  // SelectionProvider 内的桥组件触发选中。nonce 保证同一次请求只消费一次。
  const [activation, setActivation] = useState<{ id: string; nonce: number } | null>(null);
  const handledLocateNonce = useRef(-1);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // 中等/窄窗口左栏收起为抽屉：宽屏原位展开，其余层级默认收起、经边缘入口打开。
  const tier = useWindowTier();
  const drawerMode = tier === "wide" ? "inline" : "drawer";
  const [railOpen, setRailOpen] = useState(false);

  const query = useMemo<PromptQuery>(
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

  const refresh = useCallback(async () => {
    try {
      const next = await promptSnapshot(query);
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
        const next = await promptSnapshot(snapshotRequest.query);
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

  // 全局搜索定位（任务 11.1）：回收站归属驱动位置切换（global_search 跨两个
  // 位置），其余条件全部回到默认，保证目标项一定出现在结果里。快照刷新是异步
  // 的，选中先落进选择模型，条目到达后检查器随即显示它。
  useEffect(() => {
    if (locate === null) return;
    if (handledLocateNonce.current === locate.nonce) return;
    handledLocateNonce.current = locate.nonce;
    setLocation(locate.inTrash ? "trash" : "active");
    setFolder({ kind: "all" });
    setSelectedTags([]);
    setFavoriteOnly(false);
    setText("");
    setActivation({ id: locate.id, nonce: locate.nonce });
  }, [locate]);

  // Ctrl+F 聚焦本库搜索（规格）。监听挂在工作区内：同一时刻只挂载一个库，
  // 快捷键天然只作用于当前库，不会泄漏进另一库。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 已应用条件（任务 11.1）：每条都可单独移除，移除即回到该维度的默认查询。
  const chips = useMemo<AppliedFilterChip[]>(() => {
    const list: AppliedFilterChip[] = [];
    if (text.trim() !== "") {
      list.push({
        key: "text",
        label: `搜索：${text.trim()}`,
        removeLabel: `移除搜索条件 ${text.trim()}`,
        onRemove: () => setText(""),
      });
    }
    for (const tag of selectedTags) {
      list.push({
        key: `tag:${tag}`,
        label: `标签：${tag}`,
        removeLabel: `移除标签条件 ${tag}`,
        onRemove: () => setSelectedTags((current) => current.filter((item) => item !== tag)),
      });
    }
    if (favoriteOnly) {
      list.push({
        key: "favorite",
        label: "只看收藏",
        removeLabel: "移除收藏条件",
        onRemove: () => setFavoriteOnly(false),
      });
    }
    if (folder.kind === "path") {
      list.push({
        key: "folder",
        label: `文件夹：${folder.path}`,
        removeLabel: `移除文件夹条件 ${folder.path}`,
        onRemove: () => setFolder({ kind: "all" }),
      });
    }
    if (location === "trash") {
      list.push({
        key: "location",
        label: "位置：回收站",
        removeLabel: "移除回收站位置条件",
        onRemove: () => {
          setLocation("active");
          setFolder({ kind: "all" });
        },
      });
    }
    return list;
  }, [text, selectedTags, favoriteOnly, folder, location]);

  // 聚焦阅读的目标从当前查询解析；权威刷新把它移除后自动退回集合视图。
  const bodyFocus =
    bodyFocusId === null
      ? null
      : (sortedPrompts.find((prompt) => prompt.id === bodyFocusId) ?? null);

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
    }
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
    setLocation("active");
    setFolder(next);
  }

  function toggleTag(tag: string) {
    setSelectedTags((current) =>
      current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag],
    );
  }

  return (
    <section
      className={`prompt-workspace${drawerMode === "drawer" ? " rail-drawer" : ""}${
        drawerMode === "inline" ? " with-inspector" : ""
      }`}
      aria-label="提示词工作区"
    >
      <WorkspaceDrawer
        mode={drawerMode}
        side="start"
        label="提示词分类"
        open={railOpen}
        onClose={() => setRailOpen(false)}
        panelId="prompt-rail-panel"
      >
        <aside className="catalog-rail">
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
        </aside>
      </WorkspaceDrawer>

      {/* 统一选择模型：Provider 上移到中央区与右检查器之外，视图等价切换共享选择。 */}
      <SelectionProvider ids={sortedPrompts.map((prompt) => prompt.id)}>
      {/* 定位桥（任务 11.1）：点击入口在 Provider 内部，定位请求由外壳驱动，
          这里用普通单击语义把目标项落进统一选择模型。 */}
      <ExternalActivation request={activation} />
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
              onChange={(event) => setText(event.target.value)}
            />
          </label>
          {/* 收藏筛选入口：中央视图只返回 favorite=true 的正常提示词。 */}
          <button
            type="button"
            className={`favorite-filter${favoriteOnly ? " is-on" : ""}`}
            aria-pressed={favoriteOnly}
            onClick={() => setFavoriteOnly((current) => !current)}
          >
            ★ 只看收藏
          </button>
          <span className="result-count">{snapshot?.prompts.length ?? 0} 条</span>
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
            />
          ) : (
            <PromptCardWaterfall
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
            />
          )
        )}
      </div>

      <WorkspaceDrawer
        mode={drawerMode}
        side="end"
        label="提示词检查器"
        open={inspectorOpen}
        onClose={() => setInspectorOpen(false)}
        panelId="prompt-inspector-panel"
      >
        <aside className="inspector-rail" aria-label="提示词检查器">
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

/**
 * 全局搜索定位的选中桥（任务 11.1）：点击入口只在 SelectionProvider 内部可得，
 * 而定位请求由外壳状态驱动，这里以普通单击语义分派目标项。
 *
 * nonce 记账保证同一次请求只分派一次——分派会推进选择状态并换出新的
 * onItemClick 引用，不记账的话 effect 会因依赖变化重跑而自我无限分派。
 * 目标项尚未进入当前查询域（回收站快照还在刷新）时先等它到达再选中，
 * 否则 selectOne 的域守卫会把这次分派静默丢弃。
 */
function ExternalActivation({ request }: { request: { id: string; nonce: number } | null }) {
  const { state, onItemClick } = useSelection();
  const firedNonce = useRef(-1);
  useEffect(() => {
    if (request === null || firedNonce.current === request.nonce) return;
    if (!state.orderedIds.includes(request.id)) return;
    firedNonce.current = request.nonce;
    onItemClick(request.id, new MouseEvent("click"));
  }, [request, state, onItemClick]);
  return null;
}
