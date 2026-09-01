/**
 * 图片—提示词普通关联 Module 的唯一公共出口与 seam。
 *
 * 两个素材模块只依赖本 interface，不互相导入内部 query key、store 或组件。
 */
import type { AssetId, LibraryId, Unsubscribe } from "../../app/common";
import type { WorkspaceNavigation } from "../../app/navigation";
import type { AppError } from "../../shared/types";
import { imageDetail, linkImages, promptDetail, promptSnapshot, setPromptCover, unlinkImage } from "../../shared/ipc";
import { asAppError } from "../../shared/errors";
import { createRelationCoordinator } from "./internal/coordinator";

export type RelationLocation = "active" | "trash";
export type RelationTarget =
  | { kind: "image"; libraryId: LibraryId; id: AssetId; location: RelationLocation }
  | { kind: "prompt"; libraryId: LibraryId; id: string; location: RelationLocation };

export type RelationChange = {
  imageIds: readonly AssetId[];
  promptIds: readonly string[];
  /** 永久删除的对象必须移除精确缓存，禁止用必然失败的读取冒充刷新失败。 */
  removedImageIds?: readonly AssetId[];
  removedPromptIds?: readonly string[];
};

export type RelationCommand =
  | { kind: "link"; libraryId: LibraryId; images: readonly AssetId[]; prompts: readonly string[] }
  | { kind: "unlink"; libraryId: LibraryId; image: AssetId; prompt: string }
  | { kind: "set_cover"; libraryId: LibraryId; prompt: string; image: AssetId | null };

export type RelationFailure = { promptId: string; error: AppError };
export type RelationCommit = {
  succeeded: number;
  failures: readonly RelationFailure[];
  /** 权威写入已经成功、但至少一个前端读取端未刷新完成。 */
  refreshError: AppError | null;
};

export type RelationRefresh = (change: RelationChange) => Promise<void>;

export interface ImagePromptRelationAdapter {
  link(promptId: string, images: readonly AssetId[]): Promise<void>;
  unlink(promptId: string, image: AssetId): Promise<void>;
  setCover(promptId: string, image: AssetId | null): Promise<void>;
  /** 重新读取权威状态并返回目标当前所在区域；永久删除必须抛出稳定缺失错误。 */
  resolve(target: RelationTarget): Promise<RelationTarget>;
}

export interface ImagePromptRelations {
  /** 工作区只注册自己的读取刷新 Adapter；revision 与执行顺序留在 Module 内部。 */
  registerRefresh(libraryId: LibraryId, refresh: RelationRefresh): Unsubscribe;
  execute(command: RelationCommand): Promise<RelationCommit>;
  /** 导入/永久删除等其他权威事务改变了关系投影后，进入同一按库刷新屏障。 */
  synchronize(libraryId: LibraryId, change: RelationChange): Promise<AppError | null>;
  open(target: RelationTarget): Promise<void>;
}

export function createImagePromptRelations({ adapter, navigation }: { adapter: ImagePromptRelationAdapter; navigation: WorkspaceNavigation }): ImagePromptRelations {
  return createRelationCoordinator(adapter, navigation);
}

export function createTauriImagePromptRelationAdapter(): ImagePromptRelationAdapter {
  return {
    link: (promptId, images) => linkImages(promptId, [...images]),
    unlink: (promptId, image) => unlinkImage(promptId, image),
    setCover: (promptId, image) => setPromptCover(promptId, image),
    resolve: async (target) => {
      if (target.kind === "image") {
        const detail = await imageDetail(target.id);
        return { ...target, location: detail.asset.deleted_at === null ? "active" : "trash" };
      }
      try {
        const detail = await promptDetail(target.id);
        return { ...target, location: detail.deleted_at === null ? "active" : "trash" };
      } catch (raw) {
        const error = asAppError(raw);
        if (error.code !== "prompt.not_found") throw raw;
        const trash = await promptSnapshot({ text: "", tags: [], folder: { kind: "all" }, favorite: null, location: "trash" });
        if (trash.prompts.some((prompt) => prompt.id === target.id)) return { ...target, location: "trash" };
        throw raw;
      }
    },
  };
}
