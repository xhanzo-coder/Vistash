import type { ReactNode } from "react";

import type { LibraryStatus, MigrationProgress, V3MigrationPlan } from "../../shared/types";
import {
  LibraryLifecycle,
  type LibraryLifecyclePort,
} from "../../modules/library-lifecycle";
import styles from "./LibraryLifecycleShowcase.module.css";

type ShowcaseState = "welcome" | "failure" | "migration" | "migration-many" | "ready";

const READY: LibraryStatus = {
  path: "E:\\视觉档案",
  library_id: "018f3c9e-6c00-7000-8000-0000000000aa",
  recorded_path: "E:\\视觉档案",
  problem: null,
};

const OLD: LibraryStatus = {
  path: null,
  library_id: null,
  recorded_path: "E:\\旧视觉档案",
  problem: { code: "library.format_too_old", detail: "需要完成文件夹单归属迁移" },
};

const PLAN: V3MigrationPlan = {
  entries: [
    {
      hash: "a".repeat(64),
      original_filename: "建筑参考.png",
      kind: "automatic",
      folder: "建筑",
    },
    {
      hash: "b".repeat(64),
      original_filename: "雨夜街道.png",
      kind: "conflict",
      candidates: ["构图参考", "配色参考"],
    },
    {
      hash: "c".repeat(64),
      original_filename: "人物逆光.jpg",
      kind: "conflict",
      candidates: ["人物", "光影"],
    },
  ],
};

/** 真实组件长列表验收 fixture；只由开发入口使用，不调用磁盘或原生迁移。 */
const MANY_CONFLICTS_PLAN: V3MigrationPlan = {
  entries: Array.from({ length: 60 }, (_value, index) => ({
    hash: index.toString(16).padStart(64, "0"),
    original_filename: `迁移参考-${index + 1}.png`,
    kind: "conflict",
    candidates: ["构图参考", "配色参考"],
  })),
};

function currentShowcaseState(): ShowcaseState {
  const value = new URLSearchParams(window.location.search).get("state") ?? "welcome";
  if (value === "welcome" || value === "failure" || value === "migration" || value === "migration-many" || value === "ready") {
    return value;
  }
  throw new TypeError(`未知 library-lifecycle 展台状态：${value}`);
}

function initialStatus(state: ShowcaseState): LibraryStatus {
  switch (state) {
    case "welcome":
      return { path: null, library_id: null, recorded_path: null, problem: null };
    case "failure":
      return {
        path: null,
        library_id: null,
        recorded_path: "E:\\已移动的视觉档案",
        problem: { code: "library.path_unreadable", detail: "目录不存在" },
      };
    case "migration":
    case "migration-many":
      return OLD;
    case "ready":
      return READY;
  }
  throw new Error(`未穷尽展台状态：${String(state)}`);
}

function progress(stage: string): MigrationProgress {
  return { stage, done: 3, total: 3, current_filename: "雨夜街道.png" };
}

function createShowcasePort(state: ShowcaseState): LibraryLifecyclePort {
  return {
    status: async () => initialStatus(state),
    pickLibraryDirectory: async (purpose) =>
      purpose === "relocate" ? "F:\\视觉档案" : "E:\\新视觉档案",
    open: async (path) => ({ ...READY, path, recorded_path: path }),
    migrateLegacy: async (_path, onProgress) => {
      onProgress(progress("sidecars_rewritten"));
      return OLD;
    },
    planV3: async () => state === "migration-many" ? MANY_CONFLICTS_PLAN : PLAN,
    commitV3: async (path, _resolutions, onProgress) => {
      onProgress(progress("replaced"));
      return { ...READY, path, recorded_path: path };
    },
  };
}

const showcaseState = currentShowcaseState();
const showcasePort = createShowcasePort(showcaseState);

export function LibraryLifecycleShowcase(): ReactNode {
  return (
    <LibraryLifecycle port={showcasePort}>
      {(context) => (
        <main className={styles.ready} data-testid="ready-workspace">
          <p>兼容库已直接恢复</p>
          <h1>{context.session.displayName}</h1>
          <span>{context.path}</span>
        </main>
      )}
    </LibraryLifecycle>
  );
}
