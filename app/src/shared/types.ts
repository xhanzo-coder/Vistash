/**
 * 后端 DTO 的镜像类型。
 *
 * 字段名与 Rust 侧一致（snake_case），刻意不改写成 camelCase：核心类型与命令层的 DTO
 * 若混用两种命名，前端就得记住哪个类型走哪种规则。
 *
 * Rust 的 `Option<T>` 序列化为 `T | null`，因此这里一律写成联合 `null` 而不是可选字段——
 * 可选字段的含义是"这个键可能不存在"，与"这个键存在且为 null"不是一回事。
 */

/** `vistash_core::error::AppError` */
export type AppError = {
  code: string;
  detail: string | null;
};

/** `vistash_core::colorcard::ColorRole` 的字符串形式 */
export type ColorRole = "dominant" | "secondary" | "accent" | "neutral";

/** `vistash_core::index::ColorRow` */
export type ColorRow = {
  hex: string;
  oklab_l: number;
  oklab_a: number;
  oklab_b: number;
  share: number;
  role: string;
};

/** `vistash_core::index::AssetRow` */
export type AssetRow = {
  hash: string;
  hash_algo: string;
  media_type: string;
  ext: string;
  byte_size: number;
  width: number;
  height: number;
  imported_at: string;
  original_filename: string;
  source_path: string | null;
  deleted_at: string | null;
  color_card_status: string;
  color_card_algo_version: number;
  color_card_failure_reason: string | null;
  color_card_sampled_pixel_count: number;
  /** 多行纯文本备注，逐字保留。详情列表的备注摘要列从这里回答。 */
  note: string;
  /** 二值收藏状态。收藏筛选从这里回答。 */
  favorite: boolean;
  tags: string[];
  folders: string[];
  colors: ColorRow[];
};

/** `commands::LibraryStatus` */
export type LibraryStatus = {
  /** 已打开的库根路径。null 表示需要使用者选择。 */
  path: string | null;
  /** 设置里记录的库路径。path 为 null 而它有值时，可以直接对它发起迁移。 */
  recorded_path: string | null;
  /** 恢复上次的库失败时的原因。 */
  problem: AppError | null;
};

/** `vistash_core::import::ImportFailure` */
export type ImportFailure = {
  source_path: string;
  original_filename: string;
  error: AppError;
};

/** `commands::ImportOutcome` */
export type ImportOutcome = {
  imported: number;
  skipped_non_images: number;
  failures: ImportFailure[];
};

/** `commands::ImportProgress` */
export type ImportProgress = {
  /** 已结束处理的素材数。 */
  done: number;
  /** 本批次展开后的素材总数。 */
  total: number;
  /** 当前即将处理的文件；全部结束时为 null。 */
  current_filename: string | null;
};

export type FolderFilter =
  | { kind: "all" }
  | { kind: "root" }
  | { kind: "path"; path: string };

export type AssetQuery = {
  text: string;
  tags: string[];
  folder: FolderFilter;
  /** 收藏筛选；null 表示不限。 */
  favorite: boolean | null;
  location: "active" | "trash";
};

export type TagUsage = {
  tag: string;
  count: number;
};

export type CatalogSnapshot = {
  assets: AssetRow[];
  folders: string[];
  tags: TagUsage[];
  trash_count: number;
};

export type FolderMutationProgress = {
  done: number;
  total: number;
  current_filename: string;
};

/** `commands::MigrationProgress`：v1→v2 一次性迁移的进度。 */
export type MigrationProgress = {
  /** 正在进行的阶段，取后端 `MigrationStage::as_str` 的稳定字面量。 */
  stage: string;
  /** 已处理的侧车数。 */
  done: number;
  /** 待处理的侧车总数。 */
  total: number;
  /** 当前处理的侧车文件名，不含路径。 */
  current_filename: string;
};

export type RestoreOutcome = {
  missing_folders: string[];
};

export type PurgeFailure = {
  hash: string;
  original_filename: string;
  error: AppError;
};

export type PurgeReport = {
  purged: number;
  failures: PurgeFailure[];
};

/** `vistash_core::prompt::PromptAsset`：提示词的唯一权威文件内容。 */
export type PromptAsset = {
  format_version: number;
  id: string;
  /** 当前正文。去除首尾空白后必须非空。 */
  body: string;
  title: string | null;
  model: string | null;
  parameters: string | null;
  /** 多行纯文本备注，逐字保留。 */
  note: string;
  favorite: boolean;
  folders: string[];
  tags: string[];
  /** 有序关联图片哈希；默认封面取第一张。 */
  linked_image_hashes: string[];
  /** 显式封面；null 表示回落缺省（第一张关联）或纯文本卡片。 */
  cover_image_hash: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  deleted_from_folders: string[] | null;
};

/** `vistash_core::catalog::NewPrompt`：创建提示词的草稿。正文是唯一必填项。 */
export type NewPromptInput = {
  body: string;
  title: string | null;
  model: string | null;
  parameters: string | null;
  folders: string[];
  tags: string[];
};

/** `vistash_core::catalog::PromptEdit`：显式保存的主字段编辑。 */
export type PromptEditInput = {
  body: string;
  title: string | null;
  model: string | null;
  parameters: string | null;
};

/** `vistash_core::index::PromptRow`：提示词轻量行，列表与搜索共用。 */
export type PromptRow = {
  id: string;
  body: string;
  title: string | null;
  model: string | null;
  parameters: string | null;
  note: string;
  favorite: boolean;
  folders: string[];
  tags: string[];
  linked_image_hashes: string[];
  cover_image_hash: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type PromptQuery = {
  text: string;
  tags: string[];
  folder: FolderFilter;
  /** 收藏筛选；null 表示不限。 */
  favorite: boolean | null;
  location: "active" | "trash";
};

/** `vistash_core::catalog::PromptSnapshot`：提示词工作区一次刷新所需的一致快照。 */
export type PromptSnapshot = {
  prompts: PromptRow[];
  folders: string[];
  tags: TagUsage[];
  trash_count: number;
};

/** `vistash_core::catalog::PromptRestoreOutcome` */
export type PromptRestoreOutcome = {
  missing_folders: string[];
};

/** `vistash_core::catalog::PromptPurgeFailure` */
export type PromptPurgeFailure = {
  id: string;
  title: string | null;
  error: AppError;
};

/** `vistash_core::catalog::PromptPurgeReport` */
export type PromptPurgeReport = {
  purged: number;
  failures: PromptPurgeFailure[];
};

/** `vistash_core::catalog::GlobalSearchResult`：按素材类型分组的全局搜索结果。 */
export type GlobalSearchResult = {
  assets: AssetRow[];
  prompts: PromptRow[];
};

/** `vistash_core::catalog::ImageDetail`：图片检查器的按需详情。 */
export type ImageDetail = {
  asset: AssetRow;
  /** 关联这张图的全部提示词（含回收站提示词）。 */
  linked_prompts: PromptRow[];
};

/** `vistash_core::catalog::BatchFailure`：单个目标的批量失败。 */
export type BatchFailure = {
  id: string;
  display_name: string;
  error: AppError;
};

/** `vistash_core::catalog::BatchReport`：部分成功是常态，因此这不是 Result。 */
export type BatchReport = {
  succeeded: number;
  failures: BatchFailure[];
};

/** 批量进度观察点：每处理完一项调用一次。 */
export type BatchProgress = {
  done: number;
  total: number;
};

/** `vistash_core::catalog::ImportAndLinkOutcome`：逐项说明走到了哪一步。 */
export type ImportAndLinkOutcome =
  | { kind: "linked_existing"; hash: string }
  | { kind: "linked_imported"; hash: string }
  | { kind: "imported_but_not_linked"; hash: string; error: AppError }
  | { kind: "import_failed"; error: AppError };

/** `vistash_core::catalog::ImportAndLinkItem` */
export type ImportAndLinkItem = {
  source_path: string;
  original_filename: string;
  outcome: ImportAndLinkOutcome;
};

/** `vistash_core::catalog::ImportAndLinkReport` */
export type ImportAndLinkReport = {
  items: ImportAndLinkItem[];
};
