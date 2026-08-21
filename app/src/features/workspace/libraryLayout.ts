/**
 * 分库布局偏好模型（任务 8.3，设计第一条）。
 *
 * 偏好的键是库 ID（`LibraryStatus.library_id`）而不是库路径：使用者把库目录改名
 * 或搬到另一个盘之后，路径键会静默丢掉全部偏好，而使用者看到的现象是"设置自己
 * 复位了"。持久化经 `read_layout`/`write_layout` 原样透传 JSON——后端不解释形状，
 * 因此校验与演进都属于前端领域：`normalizeLayout` 把任意保存值安全合并到默认值上，
 * 旧版本缺字段或手改损坏都不会让工作台崩溃。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { asAppError } from "../../shared/errors";
import { readLayout, writeLayout } from "../../shared/ipc";
import type { AppError, FolderFilter } from "../../shared/types";

/** 中央集合视图：瀑布流或详情列表。图片与提示词各自消费同一组取值。 */
export type WorkspaceView = "waterfall" | "list";

/** 分库布局偏好的持久化形状。只存可序列化的纯数据。 */
export type WorkspaceLayout = {
  view: WorkspaceView;
  folder: FolderFilter;
  tags: string[];
  /** 收藏筛选；null 表示不限。 */
  favorite: boolean | null;
  /** 各滚动容器的偏移，键由消费方命名（如 "assets-waterfall"）。 */
  scrollOffsets: Record<string, number>;
};

const defaultLayout: WorkspaceLayout = {
  view: "waterfall",
  folder: { kind: "all" },
  tags: [],
  favorite: null,
  scrollOffsets: {},
};

/** 默认布局：全部素材、不限标签、瀑布流、无滚动记忆。冻结防止意外共享突变。 */
export const DEFAULT_LAYOUT: Readonly<WorkspaceLayout> = Object.freeze(defaultLayout);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isView(value: unknown): value is WorkspaceView {
  return value === "waterfall" || value === "list";
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
    folder: folderOf(saved.folder),
    tags: Array.isArray(saved.tags)
      ? [...new Set(saved.tags.filter((tag): tag is string => typeof tag === "string"))]
      : [],
    favorite: typeof saved.favorite === "boolean" ? saved.favorite : null,
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

const SAVE_DEBOUNCE_MS = 300;

/** 单一状态快照：连同它属于哪个库一起保存，切换库时在渲染期派生回默认值。 */
type Snapshot = {
  id: string | null;
  layout: WorkspaceLayout;
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
export function useLibraryLayout(libraryId: string | null): {
  layout: WorkspaceLayout;
  /** 是否已完成当前库的首次读取；未选择库时为 false。 */
  ready: boolean;
  problem: AppError | null;
  update: (patch: Partial<WorkspaceLayout>) => void;
} {
  const [snapshot, setSnapshot] = useState<Snapshot>(() => ({
    id: null,
    layout: normalizeLayout(null),
    ready: false,
    problem: null,
  }));

  // 快照不属于当前库（刚切库、读取未返回）时，呈现默认布局而不是上一个库的残留。
  const visible =
    snapshot.id === libraryId
      ? snapshot
      : {
          id: libraryId,
          layout: normalizeLayout(null),
          ready: false,
          problem: null as AppError | null,
        };

  // update 的合并基底。只在 effect 与事件里维护，渲染期不读：布局内容只会经
  // 这两条路径变化，ref 因此与生效值保持一致。
  const effectiveRef = useRef<WorkspaceLayout>(normalizeLayout(null));

  const pendingRef = useRef<{ id: string; value: WorkspaceLayout } | null>(null);
  const timerRef = useRef<number | null>(null);

  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending === null) return;
    writeLayout(pending.id, pending.value).catch((raw: unknown) => {
      // 写失败不静默：偏好保存不了必须可见。挂到当前快照上呈现。
      setSnapshot((prev) => ({ ...prev, problem: asAppError(raw) }));
    });
  }, []);

  useEffect(() => {
    // 切库：生效布局先回到默认值，等待该库自己的读取结果。
    effectiveRef.current = normalizeLayout(null);
    if (libraryId === null) {
      // 选择界面没有可恢复的布局。
      return undefined;
    }
    let active = true;
    void (async () => {
      try {
        const saved = await readLayout(libraryId);
        if (!active) return;
        // 读取期间使用者已经调整过（有待写内容）时，本地的意图比磁盘新，
        // 不再覆盖：它马上就会作为最新值写回。
        if (pendingRef.current !== null && pendingRef.current.id === libraryId) return;
        const layout = normalizeLayout(saved);
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
          layout: normalizeLayout(null),
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
      const next = { ...effectiveRef.current, ...patch };
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
    [libraryId, flush],
  );

  return { layout: visible.layout, ready: visible.ready, problem: visible.problem, update };
}
