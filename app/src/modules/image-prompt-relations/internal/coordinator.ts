import { createRequestId, type AssetId, type LibraryId } from "../../../app/common";
import type { WorkspaceNavigation } from "../../../app/navigation";
import { asAppError, IpcError } from "../../../shared/errors";
import type {
  ImagePromptRelationAdapter,
  ImagePromptRelations,
  RelationChange,
  RelationCommand,
  RelationCommit,
  RelationFailure,
  RelationRefresh,
  RelationTarget,
} from "../index";

const MISSING_CODES = new Set(["library.not_found", "prompt.not_found", "prompt.linked_image_not_found"]);

/** 关联写入、revision 和跨页定位集中在一个深 Module 内。 */
export function createRelationCoordinator(adapter: ImagePromptRelationAdapter, navigation: WorkspaceNavigation): ImagePromptRelations {
  const refreshers = new Map<LibraryId, Set<RelationRefresh>>();
  const tails = new Map<LibraryId, Promise<void>>();

  /** 同一库的权威写入与读取刷新严格排队；不同库保持独立并发。 */
  const enqueue = <T>(libraryId: LibraryId, operation: () => Promise<T>): Promise<T> => {
    const previous = tails.get(libraryId) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(() => undefined, () => undefined);
    tails.set(libraryId, tail);
    void tail.then(() => {
      if (tails.get(libraryId) === tail) tails.delete(libraryId);
      return undefined;
    });
    return result;
  };

  const refresh = async (libraryId: LibraryId, change: RelationChange): Promise<ReturnType<typeof asAppError> | null> => {
    const settled = await Promise.allSettled(
      [...(refreshers.get(libraryId) ?? [])].map((listener) => listener(change)),
    );
    const rejected = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
    return rejected === undefined ? null : asAppError(rejected.reason);
  };

  const commit = async (libraryId: LibraryId, change: RelationChange, succeeded: number, failures: readonly RelationFailure[]): Promise<RelationCommit> => {
    const targetWasDeleted = failures.some((failure) => MISSING_CODES.has(failure.error.code));
    if (succeeded === 0 && !targetWasDeleted) return { succeeded, failures, refreshError: null };
    return { succeeded, failures, refreshError: await refresh(libraryId, change) };
  };

  const executeLink = async (command: Extract<RelationCommand, { kind: "link" }>): Promise<RelationCommit> => {
    const failures: RelationFailure[] = [];
    let succeeded = 0;
    for (const promptId of command.prompts) {
      try {
        await adapter.link(promptId, command.images);
        succeeded += 1;
      } catch (raw) {
        failures.push({ promptId, error: asAppError(raw) });
      }
    }
    return await commit(command.libraryId, { imageIds: command.images, promptIds: command.prompts }, succeeded, failures);
  };

  const executeSingle = async (command: Exclude<RelationCommand, { kind: "link" }>): Promise<RelationCommit> => {
    const imageIds: readonly AssetId[] = command.kind === "unlink"
      ? [command.image]
      : command.image === null
        ? []
        : [command.image];
    try {
      if (command.kind === "unlink") await adapter.unlink(command.prompt, command.image);
      else await adapter.setCover(command.prompt, command.image);
    } catch (raw) {
      return await commit(command.libraryId, { imageIds, promptIds: [command.prompt] }, 0, [{ promptId: command.prompt, error: asAppError(raw) }]);
    }
    return await commit(command.libraryId, { imageIds, promptIds: [command.prompt] }, 1, []);
  };

  const open = async (target: RelationTarget): Promise<void> => {
    await (tails.get(target.libraryId) ?? Promise.resolve());
    let resolved: RelationTarget;
    try {
      resolved = await adapter.resolve(target);
    } catch (raw) {
      const error = asAppError(raw);
      if (MISSING_CODES.has(error.code)) {
        const change = target.kind === "image"
          ? { imageIds: [target.id], promptIds: [] }
          : { imageIds: [], promptIds: [target.id] };
        await refresh(target.libraryId, change);
      }
      throw new IpcError(error);
    }
    if (resolved.kind === "image") {
      navigation.requestLocate({ kind: "locate_asset", requestId: createRequestId(), hash: resolved.id, location: resolved.location });
      return;
    }
    navigation.requestLocate({ kind: "locate_prompt", requestId: createRequestId(), promptId: resolved.id, location: resolved.location });
  };

  return {
    registerRefresh(libraryId, listener) {
      const scoped = refreshers.get(libraryId) ?? new Set<RelationRefresh>();
      scoped.add(listener);
      refreshers.set(libraryId, scoped);
      return () => {
        scoped.delete(listener);
        if (scoped.size === 0) refreshers.delete(libraryId);
      };
    },
    execute(command) {
      return enqueue(command.libraryId, () => command.kind === "link" ? executeLink(command) : executeSingle(command));
    },
    synchronize(libraryId, change) {
      return enqueue(libraryId, () => refresh(libraryId, change));
    },
    open,
  };
}
