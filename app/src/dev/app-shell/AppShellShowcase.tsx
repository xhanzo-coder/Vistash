import type { ReactNode } from "react";

import { parseLibraryId } from "../../app/common";
import type { GlobalSearch } from "../../app/globalSearch";
import { createWorkspaceNavigation } from "../../app/navigation";
import { AppShell } from "../../app/shell/AppShell";
import { createTaskCenterStore } from "../../app/taskCenterStore";
import type { AssetRow, PromptRow } from "../../shared/types";
import { Button } from "../../ui/button/Button";
import { EmptyState, Panel } from "../../ui/surface/Surface";
import { useToast } from "../../ui/toast/Toast";
import styles from "./AppShellShowcase.module.css";

const navigation = createWorkspaceNavigation();
const taskCenter = createTaskCenterStore();
const registered = taskCenter.register({
  kind: "import",
  title: "导入灵感参考",
  libraryId: "018f3c9e-6c00-7000-8000-0000000000aa",
  stoppable: true,
  concurrencyKey: "library:018f3c9e-6c00-7000-8000-0000000000aa:transfer",
});
if (registered.kind !== "registered") throw new Error("组件展台无法注册示例任务");
taskCenter.reportProgress(registered.record.id, {
  kind: "transfer",
  done: 42,
  total: 100,
  currentFilename: "雨夜街道.png",
});

const ASSET_RESULT: AssetRow = {
  hash: "a".repeat(64),
  hash_algo: "blake3",
  media_type: "image/png",
  ext: "png",
  byte_size: 2048,
  width: 1600,
  height: 1200,
  imported_at: "2026-08-27T00:00:00Z",
  original_filename: "IMG_0042.PNG",
  display_filename: "雨夜街道.png",
  source_path: "E:\\参考\\IMG_0042.PNG",
  folder: "构图参考",
  deleted_at: null,
  color_card_status: "ok",
  color_card_algo_version: 1,
  color_card_failure_reason: null,
  color_card_sampled_pixel_count: 1024,
  note: "",
  favorite: false,
  tags: ["电影感"],
  colors: [],
};

const PROMPT_RESULT: PromptRow = {
  id: "018f3c9e-6c00-7000-8000-000000000001",
  body: "电影感逆光，低饱和冷色调",
  title: "雨夜构图提示词",
  model: null,
  parameters: null,
  note: "",
  favorite: false,
  folders: [],
  tags: ["电影感"],
  linked_image_hashes: [],
  cover_image_hash: null,
  resolved_cover_hash: null,
  created_at: "2026-08-27T00:00:00Z",
  updated_at: "2026-08-27T00:00:00Z",
  deleted_at: null,
};

const search: GlobalSearch = {
  run: async (text) =>
    text.includes("雨夜")
      ? { assets: [ASSET_RESULT], prompts: [PROMPT_RESULT] }
      : { assets: [], prompts: [] },
};

function WorkspacePlaceholder({ kind }: { kind: "assets" | "prompts" }): ReactNode {
  return (
    <div className={styles.workspace}>
      <Panel label={kind === "assets" ? "图片工作区预留" : "提示词工作区预留"}>
        <EmptyState
          title={kind === "assets" ? "图片工作区" : "提示词工作区"}
          description={kind === "assets" ? "集合、导航和检查器将在图片模块阶段接入。" : "现有提示词行为将在最终切换阶段接入。"}
          primaryAction={<Button>保持工作现场</Button>}
        />
      </Panel>
    </div>
  );
}

export function AppShellShowcase(): ReactNode {
  const toast = useToast();
  return (
    <AppShell
      navigation={navigation}
      globalSearch={search}
      taskCenter={taskCenter}
      library={{
        id: parseLibraryId("018f3c9e-6c00-7000-8000-0000000000aa"),
        displayName: "视觉档案",
        path: "E:\\视觉档案",
        formatVersion: 3,
      }}
      appVersion="0.1.0"
      onImportImages={() => toast.publish({ tone: "info", title: "已提交导入图片意图" })}
      onImportFolder={() => toast.publish({ tone: "info", title: "已提交导入文件夹意图" })}
      onOpenOtherLibrary={() => toast.publish({ tone: "info", title: "已提交打开其他库意图" })}
      assets={<WorkspacePlaceholder kind="assets" />}
      prompts={<WorkspacePlaceholder kind="prompts" />}
    />
  );
}
