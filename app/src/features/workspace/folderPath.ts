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
