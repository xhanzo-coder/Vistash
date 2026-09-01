import {
  commitV3Migration,
  libraryStatus,
  migrateLibrary,
  openLibrary,
  pickLibraryDirectory,
  planV3Migration,
} from "../../../shared/ipc";
import type { LibraryLifecyclePort } from "../index";

export function createTauriLibraryLifecyclePort(): LibraryLifecyclePort {
  return {
    status: () => libraryStatus(),
    pickLibraryDirectory: () => pickLibraryDirectory(),
    open: (path) => openLibrary(path),
    migrateLegacy: (path, onProgress) => migrateLibrary(path, onProgress),
    planV3: (path) => planV3Migration(path),
    commitV3: (path, resolutions, onProgress) =>
      commitV3Migration(path, resolutions, onProgress),
  };
}
