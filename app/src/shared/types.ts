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
  tags: string[];
  folders: string[];
  colors: ColorRow[];
};

/** `commands::LibraryStatus` */
export type LibraryStatus = {
  /** 已打开的库根路径。null 表示需要使用者选择。 */
  path: string | null;
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
