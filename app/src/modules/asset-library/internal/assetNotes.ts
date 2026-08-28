import { useEffect, useState, useSyncExternalStore } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { parseAssetId, type LibraryId } from "../../../app/common";
import { setAssetNote } from "../../../shared/ipc";
import { IpcError } from "../../../shared/errors";
import type { AssetRow } from "../../../shared/types";
import { assetKeys } from "./queryKeys";

type NoteDraft = { text: string; revision: number; phase: "editing" | "saving" | "saved" | "failed"; error: Error | null };

/** 草稿不属于服务端缓存。以应用缓存实例为生命周期边界，库和哈希共同确定身份。 */
const sessions = new WeakMap<QueryClient, Map<LibraryId, NoteSession>>();

class NoteSession {
  private drafts: ReadonlyMap<string, NoteDraft> = new Map();
  private readonly listeners = new Set<() => void>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pending = new Set<string>();
  private active = false;
  private revision = 0;

  constructor(private readonly client: QueryClient, private readonly libraryId: LibraryId) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  snapshot = (): ReadonlyMap<string, NoteDraft> => this.drafts;

  setActive(active: boolean): void {
    this.active = active;
    if (!active) {
      for (const timer of this.timers.values()) clearTimeout(timer);
      this.timers.clear();
    }
  }

  private publish(hash: string, draft: NoteDraft): void {
    this.drafts = new Map(this.drafts).set(hash, draft);
    for (const listener of this.listeners) listener();
  }

  private schedule(hash: string): void {
    const previous = this.timers.get(hash);
    if (previous !== undefined) clearTimeout(previous);
    if (!this.active) return;
    this.timers.set(hash, setTimeout(() => { this.timers.delete(hash); this.save(hash); }, 800));
  }

  edit = (asset: AssetRow, text: string): void => {
    if (!this.active) return;
    this.publish(asset.hash, { text, revision: ++this.revision, phase: "editing", error: null });
    this.schedule(asset.hash);
  };

  save = (hash: string): void => {
    const draft = this.drafts.get(hash);
    if (!this.active || draft === undefined || draft.phase === "saved" || this.pending.has(hash)) return;
    const timer = this.timers.get(hash);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(hash);
    this.pending.add(hash);
    this.publish(hash, { ...draft, phase: "saving", error: null });
    // 立即发出当前库的命令，不使用会在切库后才执行的延迟 mutation 队列。
    void setAssetNote(hash, draft.text).then(async () => {
      await Promise.all([
        this.client.invalidateQueries({ queryKey: assetKeys.collections(this.libraryId) }),
        this.client.invalidateQueries({ queryKey: assetKeys.detail(this.libraryId, parseAssetId(hash)), exact: true }),
      ]);
      this.pending.delete(hash);
      const latest = this.drafts.get(hash);
      if (latest === undefined) throw new Error("在途备注丢失其草稿身份");
      if (latest.revision === draft.revision) this.publish(hash, { ...latest, phase: "saved", error: null });
      else this.schedule(hash);
      return undefined;
    }, (error: unknown) => {
      this.pending.delete(hash);
      if (!(error instanceof Error)) throw error;
      const latest = this.drafts.get(hash);
      if (latest === undefined) throw new Error("失败备注丢失其草稿身份");
      const failureTimer = this.timers.get(hash);
      if (failureTimer !== undefined) clearTimeout(failureTimer);
      this.timers.delete(hash);
      this.publish(hash, { ...latest, phase: "failed", error });
    });
  };
}

/** 只在工作区层连接一次；宽屏与覆盖检查器共享协调器，卸载绝不补写新当前库。 */
export function useAssetNotes(libraryId: LibraryId, active: boolean) {
  const client = useQueryClient();
  const [session] = useState(() => {
    let libraries = sessions.get(client);
    if (libraries === undefined) { libraries = new Map(); sessions.set(client, libraries); }
    let current = libraries.get(libraryId);
    if (current === undefined) { current = new NoteSession(client, libraryId); libraries.set(libraryId, current); }
    return current;
  });
  const drafts = useSyncExternalStore(session.subscribe, session.snapshot);
  useEffect(() => { session.setActive(active); return () => session.setActive(false); }, [session, active]);
  for (const draft of drafts.values()) if (draft.error !== null && !(draft.error instanceof IpcError)) throw draft.error;
  return { drafts, edit: session.edit, save: session.save };
}

export type AssetNotes = ReturnType<typeof useAssetNotes>;
