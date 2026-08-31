import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { parseLibraryId } from "../../app/common";
import { createWorkspaceNavigation } from "../../app/navigation";
import { createImagePromptRelations, createTauriImagePromptRelationAdapter } from "../../modules/image-prompt-relations";
import { PromptLibraryWorkspace } from "../../modules/prompt-library";
import type { PromptQuery, PromptRow } from "../../shared/types";
import testImageUrl from "../../../src-tauri/icons/128x128.png?url";
import styles from "./PromptLibraryShowcase.module.css";

const LIBRARY = { id: parseLibraryId("018f3c9e-6c00-7000-8000-0000000000ee"), displayName: "提示词展台" };
const IMAGE_HASHES = ["a".repeat(64), "b".repeat(64), "c".repeat(64)] as const;
const imageResponse = await fetch(testImageUrl);
if (!imageResponse.ok) throw new Error("无法读取提示词展台封面图");
const imageBytes = await imageResponse.arrayBuffer();
mockWindows("main");
const prompts: PromptRow[] = Array.from({ length: 10_000 }, (_, index) => ({
  id: `showcase-prompt-${index}`,
  title: index % 4 === 0 ? `电影光影构图 ${index}` : null,
  body: `主体处于画面${index % 2 === 0 ? "左侧" : "右侧"}，低饱和电影色彩，柔和侧光与细腻材质。\n保留可复用的构图和光色控制。`,
  model: index % 3 === 0 ? "SDXL" : null,
  parameters: index % 5 === 0 ? "steps 30 · cfg 6" : null,
  note: "",
  favorite: index % 11 === 0,
  folders: index % 2 === 0 ? ["构图"] : [],
  tags: index % 3 === 0 ? ["电影感"] : [],
  linked_image_hashes: index % 7 === 0 ? [...IMAGE_HASHES] : [],
  cover_image_hash: null,
  resolved_cover_hash: index % 7 === 0 ? IMAGE_HASHES[0] : null,
  created_at: "2026-08-30T08:00:00Z",
  updated_at: `2026-08-${String((index % 28) + 1).padStart(2, "0")}T08:00:00Z`,
  deleted_at: null,
}));

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError("提示词展台 IPC 载荷必须为对象");
  return value;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function promptQuery(value: unknown): PromptQuery {
  if (!isRecord(value) || typeof value.text !== "string" || !Array.isArray(value.tags) || !value.tags.every((tag) => typeof tag === "string") || typeof value.favorite !== "boolean" && value.favorite !== null || value.location !== "active" && value.location !== "trash" || !isRecord(value.folder) || value.folder.kind !== "all" && value.folder.kind !== "root" && value.folder.kind !== "path") throw new TypeError("提示词展台收到非法查询");
  if (value.folder.kind === "path") {
    const path = value.folder.path;
    if (typeof path !== "string") throw new TypeError("提示词展台路径查询缺少路径");
    return { text: value.text, tags: value.tags, favorite: value.favorite, location: value.location, folder: { kind: "path", path } };
  }
  return { text: value.text, tags: value.tags, favorite: value.favorite, location: value.location, folder: { kind: value.folder.kind } };
}

mockIPC((command, payload) => {
  const request = record(payload);
  if (command === "read_layout") {
    const saved = localStorage.getItem("vistash.dev.prompt-layout");
    return saved === null ? null : JSON.parse(saved);
  }
  if (command === "write_layout") {
    localStorage.setItem("vistash.dev.prompt-layout", JSON.stringify(request.layout));
    return undefined;
  }
  if (command === "prompt_snapshot") {
    const query = promptQuery(request.query);
    const text = query.text.toLowerCase();
    return {
      prompts: prompts.filter((prompt) => {
        if (query.location !== "active") return false;
        if (query.favorite === true && !prompt.favorite) return false;
        if (text.length > 0 && !`${prompt.title ?? ""} ${prompt.body}`.toLowerCase().includes(text)) return false;
        if (query.folder.kind === "root" && prompt.folders.length > 0) return false;
        if (query.folder.kind === "path" && !prompt.folders.includes(query.folder.path)) return false;
        return query.tags.every((tag) => prompt.tags.includes(tag));
      }),
      folders: ["构图", "色彩"], tags: [{ tag: "电影感", count: 3334 }], trash_count: 0,
    };
  }
  if (command === "linked_image_states") return [
    { hash: IMAGE_HASHES[0], deleted: false, display_filename: "电影光影参考.png", folder: "构图", width: 1024, height: 1024 },
    { hash: IMAGE_HASHES[1], deleted: false, display_filename: "柔光人像.png", folder: "光线", width: 1200, height: 1600 },
    { hash: IMAGE_HASHES[2], deleted: true, display_filename: "暗部配色.png", folder: null, width: 1440, height: 900 },
  ];
  if (command === "asset_thumbnail") return imageBytes.slice(0);
  if (command === "catalog_snapshot") return { assets: [], folders: [], tags: [], trash_count: 0 };
  if (command === "plugin:event|listen" || command === "plugin:event|unlisten") return undefined;
  if (command === "set_prompt_favorite" || command === "set_prompt_folders" || command === "set_prompt_tags" || command === "set_prompt_note" || command === "link_images" || command === "unlink_image" || command === "set_prompt_cover") return undefined;
  throw new Error(`提示词展台未预期 IPC：${command}`);
});

const relations = createImagePromptRelations({ adapter: createTauriImagePromptRelationAdapter(), navigation: createWorkspaceNavigation("prompts") });

export function PromptLibraryShowcase() {
  return <div className={styles.workspace}><PromptLibraryWorkspace session={LIBRARY} relations={relations} active entry={{ kind: "resume" }} /></div>;
}
