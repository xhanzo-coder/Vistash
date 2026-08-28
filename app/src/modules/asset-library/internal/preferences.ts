import type { AssetQuery, FolderFilter } from "../../../shared/types";

/** 集合排序轴；后端基线顺序就是 imported-desc，其余选项在界面内重排。 */
export type CollectionSort = "imported-desc" | "name-asc" | "size-desc";
/** 瀑布流缩略图档位；映射到卡片基准宽度的小/中/大三档。 */
export type ThumbnailSize = "small" | "medium" | "large";

const COLLECTION_SORTS: readonly CollectionSort[] = ["imported-desc", "name-asc", "size-desc"];
const THUMBNAIL_SIZES: readonly ThumbnailSize[] = ["small", "medium", "large"];

export const INSPECTOR_SECTIONS = ["summary", "colors", "organization", "note", "links", "files"] as const;
export type InspectorSection = typeof INSPECTOR_SECTIONS[number];
/** 只记录使用者的展开状态覆盖；未设置的分区按产品规则展开。 */
export type InspectorSections = Partial<Record<InspectorSection, boolean>>;

/** 本阶段消费查询与视图；其他已有布局字段保留，后续控件接入时再严格解释。 */
export type AssetPreferences = Record<string, unknown> & AssetQuery & {
  view: "waterfall" | "list";
  sort: CollectionSort;
  tileSize: ThumbnailSize;
  /** 滚动容器偏移表；键由消费方命名（如 "assets-collection"）。 */
  scrollOffsets: Record<string, number>;
  inspectorSections?: InspectorSections;
};

export type LibraryPreferences = Record<string, unknown> & {
  assets: AssetPreferences;
  prompts: unknown;
};

export function defaultAssetPreferences(): AssetPreferences {
  return {
    view: "waterfall",
    text: "",
    tags: [],
    folder: { kind: "all" },
    favorite: null,
    location: "active",
    sort: "imported-desc",
    tileSize: "medium",
    scrollOffsets: {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFolder(value: unknown): FolderFilter {
  if (!isRecord(value)) throw new TypeError("图片布局的 folder 必须是对象");
  if (value.kind === "all" || value.kind === "root") return { kind: value.kind };
  if (value.kind === "path" && typeof value.path === "string" && value.path.length > 0) {
    return { kind: "path", path: value.path };
  }
  throw new TypeError("图片布局包含非法文件夹条件");
}

/** null 是尚未保存的正常状态；缺字段或损坏值不能被默认值掩盖。 */
export function parseLibraryPreferences(value: unknown): LibraryPreferences {
  if (value === null) return { assets: defaultAssetPreferences(), prompts: {} };
  if (!isRecord(value) || !isRecord(value.assets) || !("prompts" in value)) {
    throw new TypeError("布局必须包含 assets 与 prompts 分区");
  }
  const assets = value.assets;
  if ("inspectorSections" in assets) {
    if (!isRecord(assets.inspectorSections)) throw new TypeError("检查器分区偏好必须是对象");
    for (const [section, expanded] of Object.entries(assets.inspectorSections)) {
      if (!INSPECTOR_SECTIONS.some((name) => name === section) || typeof expanded !== "boolean") {
        throw new TypeError("检查器分区偏好包含非法键或展开状态");
      }
    }
  }
  if (assets.view !== "waterfall" && assets.view !== "list") throw new TypeError("图片布局包含非法视图");
  if (typeof assets.text !== "string") throw new TypeError("图片布局缺少 text");
  if (!Array.isArray(assets.tags) || !assets.tags.every((tag): tag is string => typeof tag === "string")) {
    throw new TypeError("图片布局的 tags 必须是字符串数组");
  }
  if (assets.favorite !== null && typeof assets.favorite !== "boolean") throw new TypeError("图片布局包含非法收藏条件");
  if (assets.location !== "active" && assets.location !== "trash") throw new TypeError("图片布局包含非法素材位置");
  // 新增轴对旧持久化值保持开放：缺省注入默认值，出现但损坏才视为错误。
  const sort = parseEnumChoice(COLLECTION_SORTS, assets.sort, "imported-desc", "排序");
  const tileSize = parseEnumChoice(THUMBNAIL_SIZES, assets.tileSize, "medium", "缩略图档位");
  let scrollOffsets: Record<string, number> = {};
  if (assets.scrollOffsets !== undefined) {
    if (!isRecord(assets.scrollOffsets)) throw new TypeError("图片布局的滚动偏移必须是对象");
    for (const [key, offset] of Object.entries(assets.scrollOffsets)) {
      if (typeof offset !== "number" || !Number.isFinite(offset) || offset < 0) {
        throw new TypeError(`滚动偏移包含非法数值：${key}`);
      }
      scrollOffsets[key] = offset;
    }
  }
  return {
    ...value,
    assets: {
      ...assets,
      view: assets.view,
      text: assets.text,
      tags: [...assets.tags],
      folder: parseFolder(assets.folder),
      favorite: assets.favorite,
      location: assets.location,
      sort,
      tileSize,
      scrollOffsets,
    },
    prompts: value.prompts,
  };
}

/** 解析一个受限字符串枚举轴；缺省回默认值，出现但非法才报错。 */
function parseEnumChoice<T extends string>(
  allowed: readonly T[],
  value: unknown,
  fallback: T,
  label: string,
): T {
  if (value === undefined) return fallback;
  const found = typeof value === "string" ? allowed.find((candidate) => candidate === value) : undefined;
  if (found !== undefined) return found;
  throw new TypeError(`图片布局包含非法${label}`);
}

export function queryFromPreferences(layout: AssetPreferences): AssetQuery {
  return { text: layout.text, tags: layout.tags, folder: layout.folder, favorite: layout.favorite, location: layout.location };
}
