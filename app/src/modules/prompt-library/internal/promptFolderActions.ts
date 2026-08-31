import type { FolderFilter } from "../../../shared/types";
import { createPromptFolder, deletePromptFolder, movePromptFolder, renamePromptFolder } from "../../../shared/ipc";

export type PromptConfirmRequest = {
  title: string;
  body: string;
  confirmLabel: string;
  refreshCurrentQuery: boolean;
  onConfirm: () => Promise<void>;
};

type MutationRunner = (operation: () => Promise<void>, refreshCurrentQuery: boolean) => Promise<boolean>;

function rebaseFolderPath(path: string, source: string, target: string): string {
  return path === source || path.startsWith(`${source}/`) ? target + path.slice(source.length) : path;
}

/** 提示词文件夹权威写入知识簇；工作区只提供统一 mutation 纪律与范围导航。 */
export function createPromptFolderActions({ currentFolder, run, navigate, confirm }: {
  currentFolder: FolderFilter;
  run: MutationRunner;
  navigate: (folder: FolderFilter) => void;
  confirm: (request: PromptConfirmRequest) => void;
}) {
  return {
    create: async (parent: string | null, name: string): Promise<boolean> => await run(async () => {
      const created = await createPromptFolder(parent, name);
      navigate({ kind: "path", path: created });
    }, true),
    rename: async (path: string, name: string): Promise<boolean> => await run(async () => {
      const renamed = await renamePromptFolder(path, name);
      navigate({ kind: "path", path: renamed });
    }, true),
    move: async (path: string, destinationParent: string | null): Promise<boolean> => await run(async () => {
      const moved = await movePromptFolder(path, destinationParent);
      if (currentFolder.kind === "path" && (currentFolder.path === path || currentFolder.path.startsWith(`${path}/`))) {
        navigate({ kind: "path", path: rebaseFolderPath(currentFolder.path, path, moved) });
      }
    }, true),
    delete: (path: string): void => confirm({
      title: "删除提示词文件夹？",
      body: `“${path}”及其子文件夹会被删除，但提示词素材不会删除；没有其他归属的提示词将回到提示词根位置。`,
      confirmLabel: "删除文件夹",
      refreshCurrentQuery: true,
      onConfirm: async () => {
        await deletePromptFolder(path);
        if (currentFolder.kind === "path" && (currentFolder.path === path || currentFolder.path.startsWith(`${path}/`))) navigate({ kind: "all" });
      },
    }),
  };
}
