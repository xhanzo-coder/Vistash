import type { AssetId, LibraryId } from "../../../app/common";
import type { AssetQuery } from "../../../shared/types";

/** key 与失效范围不离开图片模块；视图、选择和草稿不会改变集合身份。 */
export const assetKeys = {
  preferences: (id: LibraryId) => ["asset-library", id, "preferences"] as const,
  collections: (id: LibraryId) => ["asset-library", id, "collection"] as const,
  collection: (id: LibraryId, query: AssetQuery) => ["asset-library", id, "collection", query] as const,
  detail: (id: LibraryId, hash: AssetId) => ["asset-library", id, "detail", hash] as const,
  details: (id: LibraryId) => ["asset-library", id, "detail"] as const,
  savePreferences: (id: LibraryId) => ["asset-library", id, "save-preferences"] as const,
  renameFilename: (id: LibraryId) => ["asset-library", id, "rename-filename"] as const,
  promptCandidatesRoot: (id: LibraryId) => ["asset-library", id, "prompt-candidates"] as const,
  promptCandidates: (id: LibraryId, text: string) => ["asset-library", id, "prompt-candidates", text] as const,
};
