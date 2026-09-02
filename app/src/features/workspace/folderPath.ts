/** 逻辑文件夹路径的呈现计算；不读取或写入任何领域状态。 */
export function folderParent(path: string): string | null {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? null : path.slice(0, separator);
}

export function folderLeaf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function folderMoveResult(path: string, destinationParent: string | null): string {
  const leaf = folderLeaf(path);
  return destinationParent === null ? leaf : `${destinationParent}/${leaf}`;
}

export function folderMoveCandidates(path: string, folders: readonly string[]): string[] {
  return folders.filter((candidate) => candidate !== path && !candidate.startsWith(`${path}/`));
}

export function sortFolderPaths(folders: readonly string[]): string[] {
  const result = [...folders];
  result.sort((left, right) => left.localeCompare(right, "zh-Hans-CN"));
  return result;
}

export type FolderTreeRow = { path: string; depth: number; hasChildren: boolean };

/**
 * 把扁平路径清单展开为深度优先树行；同级顺序即清单中的出现顺序（权威存储序），
 * 不做字母排序。父路径缺失的孤儿条目按根节点兜底呈现，不丢弃任何存储条目。
 */
export function buildFolderTreeRows(folders: readonly string[]): {
  rows: FolderTreeRow[];
  childrenOf: ReadonlyMap<string | null, readonly string[]>;
} {
  const known = new Set(folders);
  const children = new Map<string | null, string[]>();
  for (const path of folders) {
    const parent = folderParent(path);
    const key = parent !== null && known.has(parent) ? parent : null;
    const list = children.get(key);
    if (list === undefined) children.set(key, [path]);
    else list.push(path);
  }
  const rows: FolderTreeRow[] = [];
  const emit = (path: string, depth: number): void => {
    const offspring = children.get(path) ?? [];
    rows.push({ path, depth, hasChildren: offspring.length > 0 });
    for (const child of offspring) emit(child, depth + 1);
  };
  for (const root of children.get(null) ?? []) emit(root, 0);
  return { rows, childrenOf: children };
}
