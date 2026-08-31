import {
  useCallback,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";

import { asAppError } from "../../shared/errors";
import type { AppError, FolderFilter } from "../../shared/types";
import type { GlobalLocateRequest } from "./locate";
import {
  useWorkspacePreferences,
  type LibraryWorkspaceLayout,
} from "./libraryLayout";

export type WorkspaceCollectionQuery = {
  text: string;
  tags: string[];
  folder: FolderFilter;
  favorite: boolean | null;
  location: "active" | "trash";
};

/**
 * 图片与提示词集合共享的查询控制器。
 *
 * 这里统一持有可持久化查询、全局定位重置、Ctrl+F 和可移除条件；两个工作台只
 * 注入各自的 section，快照 DTO 与呈现保持领域独立。
 */
export function useWorkspaceQueryController(
  libraryId: string | null,
  section: keyof LibraryWorkspaceLayout,
  locate: (GlobalLocateRequest & { nonce: number }) | null,
) {
  const preferences = useWorkspacePreferences(libraryId, section);
  const {
    update,
    text,
    selectedTags,
    folder,
    favoriteOnly,
    location,
    ready,
  } = preferences;
  const deferredText = useDeferredValue(text);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const handledLocateNonce = useRef<number>(-1);
  const activation =
    locate !== null && (libraryId === null || ready)
      ? { id: locate.id, nonce: locate.nonce }
      : null;

  const query = useMemo<WorkspaceCollectionQuery>(
    () => ({
      text: deferredText,
      tags: selectedTags,
      folder,
      favorite: favoriteOnly ? true : null,
      location,
    }),
    [deferredText, favoriteOnly, folder, location, selectedTags],
  );

  useEffect(() => {
    if (locate === null || handledLocateNonce.current === locate.nonce) return;
    if (libraryId !== null && !ready) return;
    handledLocateNonce.current = locate.nonce;
    update({
      location: locate.inTrash ? "trash" : "active",
      folder: { kind: "all" },
      tags: [],
      favorite: null,
      text: "",
    });
  }, [libraryId, locate, ready, update]);

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

  return { ...preferences, query, activation, searchInputRef };
}

/** 共享的异步快照加载接缝；领域差异只体现在传入的 load 函数与 DTO 类型。 */
export function useWorkspaceSnapshot<TQuery, TSnapshot>(
  query: TQuery,
  load: (query: TQuery) => Promise<TSnapshot>,
  enabled = true,
): {
  snapshot: TSnapshot | null;
  loading: boolean;
  error: AppError | null;
  setError: (error: AppError | null) => void;
  /** 返回可处理的读取错误；调用方可忽略，也可把它提升为协调失败。 */
  refresh: () => Promise<AppError | null>;
} {
  const [snapshot, setSnapshot] = useState<TSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AppError | null>(null);
  const requestKey = useMemo(() => JSON.stringify(query), [query]);
  const currentRequestKeyRef = useRef(requestKey);
  const loadCurrentRequest = useEffectEvent((_requestKey: string) => load(query));

  useEffect(() => {
    currentRequestKeyRef.current = requestKey;
  }, [requestKey]);

  const refresh = useCallback(async () => {
    const startedFor = requestKey;
    try {
      const next = await load(query);
      if (currentRequestKeyRef.current !== startedFor) return null;
      setSnapshot(next);
      setError(null);
      return null;
    } catch (raw) {
      const nextError = asAppError(raw);
      if (currentRequestKeyRef.current === startedFor) setError(nextError);
      return nextError;
    } finally {
      if (currentRequestKeyRef.current === startedFor) setLoading(false);
    }
  }, [load, query, requestKey]);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const next = await loadCurrentRequest(requestKey);
        if (cancelled || currentRequestKeyRef.current !== requestKey) return;
        setSnapshot(next);
        setError(null);
      } catch (raw) {
        if (!cancelled && currentRequestKeyRef.current === requestKey) {
          setError(asAppError(raw));
        }
      } finally {
        if (!cancelled && currentRequestKeyRef.current === requestKey) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, requestKey]);

  return { snapshot, loading, error, setError, refresh };
}
