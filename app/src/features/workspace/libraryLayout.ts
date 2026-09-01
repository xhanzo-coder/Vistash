/**
 * 分库布局偏好模型。
 *
 * 偏好的键是库 ID（`LibraryStatus.library_id`）而不是库路径：使用者把库目录改名
 * 或搬到另一个盘之后，路径键会静默丢掉全部偏好，而使用者看到的现象是"设置自己
 * 复位了"。持久化经 `read_layout`/`write_layout` 原样透传 JSON——后端不解释形状，
 * 因此校验与演进都属于前端领域：`normalizeLayout` 把任意保存值安全合并到默认值上，
 * 旧版本缺字段或手改损坏都不会让工作台崩溃。
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

import { asAppError } from "../../shared/errors";
import { readLayout, writeLayout } from "../../shared/ipc";
import type { AppError, FolderFilter } from "../../shared/types";

/** 中央集合视图：瀑布流或详情列表。图片与提示词各自消费同一组取值。 */
export type WorkspaceView = "waterfall" | "list";

/** 分库布局偏好的持久化形状。只存可序列化的纯数据。 */
export type WorkspaceLayout = {
  view: WorkspaceView;
  text: string;
  folder: FolderFilter;
  tags: string[];
  /** 收藏筛选；null 表示不限。 */
  favorite: boolean | null;
  location: "active" | "trash";
  railWidth: number;
  inspectorWidth: number;
  railCollapsed: boolean;
  inspectorCollapsed: boolean;
  /** 各滚动容器的偏移，键由消费方命名（如 "assets-waterfall"）。 */
  scrollOffsets: Record<string, number>;
};

/** 一个物理库内，两类素材各自拥有独立的工作台偏好。 */
export type LibraryWorkspaceLayout = {
  assets: WorkspaceLayout;
  prompts: WorkspaceLayout;
};

const defaultLayout: WorkspaceLayout = {
  view: "waterfall",
  text: "",
  folder: { kind: "all" },
  tags: [],
  favorite: null,
  location: "active",
  railWidth: 240,
  inspectorWidth: 300,
  railCollapsed: false,
  inspectorCollapsed: false,
  scrollOffsets: {},
};

/** 默认布局：全部素材、不限标签、瀑布流、无滚动记忆。冻结防止意外共享突变。 */
export const DEFAULT_LAYOUT: Readonly<WorkspaceLayout> = Object.freeze(defaultLayout);

/** 新库的完整双工作台布局；持久化时始终整体写入这两个 section。 */
export const DEFAULT_LIBRARY_LAYOUT: Readonly<LibraryWorkspaceLayout> = Object.freeze({
  assets: DEFAULT_LAYOUT,
  prompts: DEFAULT_LAYOUT,
});

function defaultLibraryLayout(): LibraryWorkspaceLayout {
  return {
    assets: normalizeLayout(null),
    prompts: normalizeLayout(null),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isView(value: unknown): value is WorkspaceView {
  return value === "waterfall" || value === "list";
}

function finiteWidth(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

function folderOf(saved: unknown): FolderFilter {
  if (isRecord(saved)) {
    if (saved.kind === "root") return { kind: "root" };
    if (
      saved.kind === "path" &&
      typeof saved.path === "string" &&
      saved.path !== ""
    ) {
      return { kind: "path", path: saved.path };
    }
  }
  return { kind: "all" };
}

/** 把后端透传的任意保存值合并到默认值上；逐字段回退，一个坏字段不拖垮整份布局。 */
export function normalizeLayout(saved: unknown): WorkspaceLayout {
  if (!isRecord(saved)) return { ...defaultLayout, folder: { ...defaultLayout.folder } };
  return {
    view: isView(saved.view) ? saved.view : defaultLayout.view,
    text: typeof saved.text === "string" ? saved.text : defaultLayout.text,
    folder: folderOf(saved.folder),
    tags: Array.isArray(saved.tags)
      ? [...new Set(saved.tags.filter((tag): tag is string => typeof tag === "string"))]
      : [],
    favorite: typeof saved.favorite === "boolean" ? saved.favorite : null,
    location: saved.location === "trash" ? "trash" : "active",
    railWidth: finiteWidth(saved.railWidth, 180, 420, defaultLayout.railWidth),
    inspectorWidth: finiteWidth(
      saved.inspectorWidth,
      240,
      560,
      defaultLayout.inspectorWidth,
    ),
    railCollapsed:
      typeof saved.railCollapsed === "boolean" ? saved.railCollapsed : false,
    inspectorCollapsed:
      typeof saved.inspectorCollapsed === "boolean" ? saved.inspectorCollapsed : false,
    scrollOffsets: (() => {
      const offsets: Record<string, number> = {};
      if (!isRecord(saved.scrollOffsets)) return offsets;
      for (const [key, offset] of Object.entries(saved.scrollOffsets)) {
        if (typeof offset === "number" && Number.isFinite(offset) && offset >= 0) {
          offsets[key] = offset;
        }
      }
      return offsets;
    })(),
  };
}

/**
 * 解析一个库的双工作台持久化值。
 *
 * `null` 只表示从未保存；其他形状必须同时包含两个 section。这里不兼容旧的单层
 * 结构，损坏或过期数据应由调用方作为明确错误呈现。
 */
export function normalizeLibraryLayout(saved: unknown): LibraryWorkspaceLayout {
  if (saved === null) return defaultLibraryLayout();
  if (!isRecord(saved) || !("assets" in saved) || !("prompts" in saved)) {
    throw new TypeError("布局必须同时包含 assets 与 prompts section");
  }
  return {
    assets: normalizeLayout(saved.assets),
    prompts: normalizeLayout(saved.prompts),
  };
}

const SAVE_DEBOUNCE_MS = 300;

type PendingLayoutWrite = {
  value: LibraryWorkspaceLayout;
  promise: Promise<void>;
};

/** 同一 library_id 的整表写串行化；新 section 读取必须先观察前一份最新值。 */
const pendingLayoutWrites = new Map<string, PendingLayoutWrite>();

function queueLayoutWrite(id: string, value: LibraryWorkspaceLayout): Promise<void> {
  const previous = pendingLayoutWrites.get(id);
  const waitForPrevious =
    previous === undefined
      ? Promise.resolve()
      : previous.promise.then(
          () => undefined,
          () => undefined,
        );
  const operation = waitForPrevious.then(() => writeLayout(id, value));
  const pending = { value, promise: operation };
  pendingLayoutWrites.set(id, pending);
  const cleanup = () => {
    if (pendingLayoutWrites.get(id) === pending) pendingLayoutWrites.delete(id);
  };
  void operation.then(cleanup, cleanup);
  return operation;
}

async function readLatestLayout(id: string): Promise<unknown> {
  const pending = pendingLayoutWrites.get(id);
  if (pending === undefined) return readLayout(id);
  await pending.promise;
  const newer = pendingLayoutWrites.get(id);
  if (newer === undefined || newer === pending) return pending.value;
  return readLatestLayout(id);
}

function pendingLayoutValue(id: string | null): LibraryWorkspaceLayout | undefined {
  if (id === null) return undefined;
  return pendingLayoutWrites.get(id)?.value;
}

/** 单一状态快照：连同它属于哪个库一起保存，切换库时在渲染期派生回默认值。 */
type Snapshot = {
  id: string | null;
  layout: LibraryWorkspaceLayout;
  ready: boolean;
  problem: AppError | null;
};

/**
 * 按库加载、更新并防抖写回布局偏好。
 *
 * 失败语义：读失败呈现 problem 并停在默认值，写失败呈现 problem 而界面状态照常
 * 生效——偏好是便利层，绝不能阻塞工作台，但损坏也绝不静默吞掉。
 *
 * 切换库不靠 effect 里重置状态：快照记录自己的库 ID，渲染期发现对不上就按默认值
 * 呈现，读取完成后快照整体替换。因此 effect 只做一件事——同步外部存储。
 */
export function useLibraryLayout(
  libraryId: string | null,
  section: keyof LibraryWorkspaceLayout,
): {
  layout: WorkspaceLayout;
  /** 是否已完成当前库的首次读取；未选择库时为 false。 */
  ready: boolean;
  problem: AppError | null;
  update: (patch: Partial<WorkspaceLayout>) => void;
} {
  const [snapshot, setSnapshot] = useState<Snapshot>(() => ({
    id: null,
    layout: defaultLibraryLayout(),
    ready: false,
    problem: null,
  }));

  // 快照不属于当前库（刚切库、读取未返回）时，呈现默认布局而不是上一个库的残留。
  const visible =
    snapshot.id === libraryId
      ? snapshot
      : {
          id: libraryId,
          layout: pendingLayoutValue(libraryId) ?? defaultLibraryLayout(),
          ready: false,
          problem: null as AppError | null,
        };

  // update 的合并基底。只在 effect 与事件里维护，渲染期不读：布局内容只会经
  // 这两条路径变化，ref 因此与生效值保持一致。
  const effectiveRef = useRef<LibraryWorkspaceLayout>(defaultLibraryLayout());

  const pendingRef = useRef<{ id: string; value: LibraryWorkspaceLayout } | null>(null);
  const timerRef = useRef<number | null>(null);

  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending === null) return;
    queueLayoutWrite(pending.id, pending.value).catch((raw: unknown) => {
      // 写失败不静默：偏好保存不了必须可见。挂到当前快照上呈现。
      setSnapshot((prev) => ({ ...prev, problem: asAppError(raw) }));
    });
  }, []);

  useEffect(() => {
    // 快速切换 section 时，前一实例已排队的整表值是当前最新合并基底；没有待写
    // 才使用默认值等待磁盘读取，避免 ready=false 期间的操作覆盖另一 section。
    effectiveRef.current = pendingLayoutValue(libraryId) ?? defaultLibraryLayout();
    if (libraryId === null) {
      // 选择界面没有可恢复的布局。
      return undefined;
    }
    let active = true;
    void (async () => {
      try {
        const saved = await readLatestLayout(libraryId);
        if (!active) return;
        // 读取期间使用者已经调整过（有待写内容）时，本地的意图比磁盘新，
        // 不再覆盖：它马上就会作为最新值写回。
        if (pendingRef.current !== null && pendingRef.current.id === libraryId) return;
        const layout = normalizeLibraryLayout(saved);
        effectiveRef.current = layout;
        setSnapshot({
          id: libraryId,
          layout,
          ready: true,
          problem: null,
        });
      } catch (raw) {
        if (!active) return;
        setSnapshot({
          id: libraryId,
          layout: defaultLibraryLayout(),
          ready: true,
          problem: asAppError(raw),
        });
      }
    })();
    return () => {
      active = false;
      // 切库或卸载时旧库的待写立即落盘：最后一次调整不能因为防抖没到期而丢失。
      flush();
    };
  }, [libraryId, flush]);

  const update = useCallback(
    (patch: Partial<WorkspaceLayout>) => {
      const nextSection = { ...effectiveRef.current[section], ...patch };
      const next = { ...effectiveRef.current, [section]: nextSection };
      effectiveRef.current = next;
      setSnapshot((prev) => ({
        ...prev,
        id: libraryId,
        layout: next,
        ready: prev.id === libraryId ? prev.ready : false,
        problem: prev.id === libraryId ? prev.problem : null,
      }));
      if (libraryId === null) return;
      pendingRef.current = { id: libraryId, value: next };
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(flush, SAVE_DEBOUNCE_MS);
    },
    [libraryId, section, flush],
  );

  return {
    layout: visible.layout[section],
    ready: visible.ready,
    problem: visible.problem,
    update,
  };
}

function isStateUpdater<T>(action: SetStateAction<T>): action is (value: T) => T {
  return typeof action === "function";
}

function resolveAction<T>(action: SetStateAction<T>, current: T): T {
  return isStateUpdater(action) ? action(current) : action;
}

/**
 * 把持久化 section 暴露成工作台熟悉的受控状态接口。
 *
 * 图片与提示词工作台通过同一入口消费查询、视图与位置状态，避免各自再维护一套
 * `useState` 后与磁盘偏好分叉。
 */
export function useWorkspacePreferences(
  libraryId: string | null,
  section: keyof LibraryWorkspaceLayout,
): ReturnType<typeof useLibraryLayout> & {
  text: string;
  setText: Dispatch<SetStateAction<string>>;
  selectedTags: string[];
  setSelectedTags: Dispatch<SetStateAction<string[]>>;
  folder: FolderFilter;
  setFolder: Dispatch<SetStateAction<FolderFilter>>;
  favoriteOnly: boolean;
  setFavoriteOnly: Dispatch<SetStateAction<boolean>>;
  location: "active" | "trash";
  setLocation: Dispatch<SetStateAction<"active" | "trash">>;
  view: WorkspaceView;
  setView: Dispatch<SetStateAction<WorkspaceView>>;
} {
  const state = useLibraryLayout(libraryId, section);
  const { layout, update } = state;
  const text = layout.text;
  const selectedTags = layout.tags;
  const folder = layout.folder;
  const favoriteOnly = layout.favorite === true;
  const location = layout.location;
  const view = layout.view;

  const setText = useCallback<Dispatch<SetStateAction<string>>>(
    (action) => update({ text: resolveAction(action, text) }),
    [text, update],
  );
  const setSelectedTags = useCallback<Dispatch<SetStateAction<string[]>>>(
    (action) => update({ tags: resolveAction(action, selectedTags) }),
    [selectedTags, update],
  );
  const setFolder = useCallback<Dispatch<SetStateAction<FolderFilter>>>(
    (action) => update({ folder: resolveAction(action, folder) }),
    [folder, update],
  );
  const setFavoriteOnly = useCallback<Dispatch<SetStateAction<boolean>>>(
    (action) => {
      const next = resolveAction(action, favoriteOnly);
      update({ favorite: next ? true : null });
    },
    [favoriteOnly, update],
  );
  const setLocation = useCallback<Dispatch<SetStateAction<"active" | "trash">>>(
    (action) => update({ location: resolveAction(action, location) }),
    [location, update],
  );
  const setView = useCallback<Dispatch<SetStateAction<WorkspaceView>>>(
    (action) => update({ view: resolveAction(action, view) }),
    [update, view],
  );

  return {
    ...state,
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
  };
}
