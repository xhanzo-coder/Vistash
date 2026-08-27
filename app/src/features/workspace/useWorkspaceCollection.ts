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
import type { GlobalLocateRequest } from "./GlobalSearch";
import type { AppliedFilterChip } from "./AppliedFilterChips";
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
    setText,
    selectedTags,
    setSelectedTags,
    folder,
    setFolder,
    favoriteOnly,
    setFavoriteOnly,
    location,
    setLocation,
    ready,
  } = preferences;
  const deferredText = useDeferredValue(text);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const handledLocateNonce = useRef(-1);
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

  const chips = useMemo<AppliedFilterChip[]>(() => {
    const list: AppliedFilterChip[] = [];
    const trimmedText = text.trim();
    if (trimmedText !== "") {
      list.push({
        key: "text",
        label: `搜索：${trimmedText}`,
        removeLabel: `移除搜索条件 ${trimmedText}`,
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
  }, [favoriteOnly, folder, location, selectedTags, setFavoriteOnly, setFolder, setLocation, setSelectedTags, setText, text]);

  return { ...preferences, query, activation, searchInputRef, chips };
}

/** 共享的异步快照加载接缝；领域差异只体现在传入的 load 函数与 DTO 类型。 */
export function useWorkspaceSnapshot<TQuery, TSnapshot>(
  query: TQuery,
  refreshVersion: number,
  load: (query: TQuery) => Promise<TSnapshot>,
): {
  snapshot: TSnapshot | null;
  loading: boolean;
  error: AppError | null;
  setError: (error: AppError | null) => void;
  refresh: () => Promise<void>;
} {
  const [snapshot, setSnapshot] = useState<TSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AppError | null>(null);
  const requestKey = useMemo(() => JSON.stringify(query), [query]);
  const currentRequestKeyRef = useRef(requestKey);
  const loadCurrentRequest = useEffectEvent(
    (_requestKey: string, _refreshVersion: number) => load(query),
  );

  useEffect(() => {
    currentRequestKeyRef.current = requestKey;
  }, [requestKey]);

  const refresh = useCallback(async () => {
    const startedFor = requestKey;
    try {
      const next = await load(query);
      if (currentRequestKeyRef.current !== startedFor) return;
      setSnapshot(next);
      setError(null);
    } catch (raw) {
      if (currentRequestKeyRef.current === startedFor) setError(asAppError(raw));
    } finally {
      if (currentRequestKeyRef.current === startedFor) setLoading(false);
    }
  }, [load, query, requestKey]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await loadCurrentRequest(requestKey, refreshVersion);
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
  }, [refreshVersion, requestKey]);

  return { snapshot, loading, error, setError, refresh };
}
