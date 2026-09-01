//! 素材侧车：与本体同目录的 JSON 元数据。
//!
//! 侧车与本体同目录，使"复制一个叶目录等于复制一个完整素材"。侧车是库内素材的
//! 权威元数据来源，SQLite 索引是它的派生物——因此索引可以随时删除重建，侧车不可。

use crate::colorcard::ColorCard;
use crate::error::{AppError, Code, Result};
use crate::hashing::ContentHash;
use crate::media::MediaType;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// v1 侧车格式版本。与库级元数据的格式版本分开，因为侧车结构的演进节奏与库骨架不同。
///
/// 生产路径已切到 v2（任务 3.3），这个值此后只用于迁移：它标记的是"迁移的输入长什么样"。
pub const SIDECAR_FORMAT_VERSION: u32 = 1;

/// 图片侧车格式 v2 的版本号。
///
/// v2 强制写入纯文本 `note` 与布尔 `favorite`（设计第四条）。两个字段刻意没有 serde
/// 默认值：缺少它们的文件就是 v1 文件，必须走迁移，而不是被当成"备注为空、未收藏"的
/// 正常 v2 文件——后者会让一次误判永久顶替掉使用者真实写过的备注。
pub const SIDECAR_FORMAT_VERSION_V2: u32 = 2;

/// 图片侧车格式 v3 的版本号。
///
/// v3 把来源改成显式判别联合，增加必填显示文件名，并把图片文件夹归属收窄为
/// 零个或一个。生产别名在完整迁移门禁实现前仍指向 v2。
pub const SIDECAR_FORMAT_VERSION_V3: u32 = 3;

/// v1 侧车：一个素材在库格式 v1 下的全部权威元数据。
///
/// 形状已冻结，只服务迁移（设计第四条）。生产读写走 [`AssetSidecarV2`]，即类型别名
/// [`AssetSidecar`]。冻结的理由是迁移的正确性完全依赖"读一个 v1 文件"的含义固定：
/// 这个结构若继续跟随新字段演进，迁移的输入含义就会随之漂移。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AssetSidecarV1 {
    pub format_version: u32,
    pub hash: ContentHash,
    /// 哈希算法标识符。冗余记录一份，使单个叶目录脱离库目录后仍可自证寻址方式。
    pub hash_algo: String,
    pub media_type: MediaType,
    /// 库内本体的扩展名。与 `media_type` 一致，单独记录以免路径拼接时反查。
    pub ext: String,
    pub byte_size: u64,
    pub width: u32,
    pub height: u32,
    pub imported_at: DateTime<Utc>,
    pub original_filename: String,
    /// 导入时的来源路径，仅用于溯源展示。
    ///
    /// 系统不得据此检查源文件是否仍然存在：采用复制入库模型后，库内副本即唯一
    /// 权威副本，源文件消失没有任何后果，检查只会引入一整套无意义的断链修复流程。
    pub source_path: Option<String>,
    pub folders: Vec<String>,
    pub tags: Vec<String>,
    pub color_card: ColorCard,
    /// 进入库内回收站的时刻。`None` 表示素材在正常库中。
    pub deleted_at: Option<DateTime<Utc>>,
    /// 删除前所属的文件夹。还原时据此回到原位置而不是落到根目录。
    pub deleted_from_folders: Option<Vec<String>>,
}

impl AssetSidecarV1 {
    /// 是否处于回收站中。以 `deleted_at` 为准而不是以所在目录树为准，
    /// 使单个侧车文件脱离上下文后仍能自证状态。
    pub fn is_deleted(&self) -> bool {
        self.deleted_at.is_some()
    }

    pub fn read(path: &Path) -> Result<Self> {
        let bytes = std::fs::read(path).map_err(|e| {
            AppError::detailed(
                Code::LibraryIoFailed,
                format!("读取侧车失败 {}: {e}", path.display()),
            )
        })?;
        let sidecar: Self = serde_json::from_slice(&bytes).map_err(|e| {
            AppError::detailed(
                Code::LibraryMetadataCorrupt,
                format!("侧车无法解析 {}: {e}", path.display()),
            )
        })?;
        if sidecar.format_version > SIDECAR_FORMAT_VERSION {
            return Err(AppError::detailed(
                Code::LibraryFormatTooNew,
                format!(
                    "侧车格式版本 {} 高于程序支持的 {}：{}",
                    sidecar.format_version,
                    SIDECAR_FORMAT_VERSION,
                    path.display()
                ),
            ));
        }
        Ok(sidecar)
    }

    /// 写入侧车。先写临时文件再改名，使进程在写入中途终止时不会留下半个 JSON。
    ///
    /// 半个 JSON 比没有文件更糟：索引重建以扫描 `objects/**/*.json` 为入口，
    /// 会把它当成损坏的素材而不是不存在的素材。
    pub fn write_atomic(&self, path: &Path) -> Result<()> {
        let io_err = |e: std::io::Error, what: &str| {
            AppError::detailed(
                Code::ImportMetadataWriteFailed,
                format!("{what} {}: {e}", path.display()),
            )
        };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| io_err(e, "建立侧车目录失败"))?;
        }
        let json = serde_json::to_vec_pretty(self).map_err(|e| {
            AppError::detailed(
                Code::ImportMetadataWriteFailed,
                format!("序列化侧车失败: {e}"),
            )
        })?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, &json).map_err(|e| io_err(e, "写入临时侧车失败"))?;
        std::fs::rename(&tmp, path).map_err(|e| {
            // 改名失败时清理临时文件，避免叶目录里留下无人引用的 .json.tmp。
            let _ = std::fs::remove_file(&tmp);
            io_err(e, "提交侧车失败")
        })?;
        Ok(())
    }
}

/// 图片侧车格式 v2：v1 的全部字段，加上纯文本备注与收藏。
///
/// 刻意复制字段而不是内嵌 v1：内嵌会让 v2 的任何字段改动都从 v1 结构里穿过去，于是
/// "读一个 v1 文件"的含义会随 v2 的演进而漂移，而迁移的正确性完全依赖这个含义固定。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AssetSidecarV2 {
    pub format_version: u32,
    pub hash: ContentHash,
    pub hash_algo: String,
    pub media_type: MediaType,
    pub ext: String,
    pub byte_size: u64,
    pub width: u32,
    pub height: u32,
    pub imported_at: DateTime<Utc>,
    pub original_filename: String,
    pub source_path: Option<String>,
    pub folders: Vec<String>,
    pub tags: Vec<String>,
    pub color_card: ColorCard,
    /// 多行纯文本备注。不解析 Markdown 或富文本；"没有备注"就是空字符串，
    /// 不再额外引入 `Option`——两种表示同时存在只会让写入端需要挑一种。
    pub note: String,
    pub favorite: bool,
    pub deleted_at: Option<DateTime<Utc>>,
    pub deleted_from_folders: Option<Vec<String>>,
}

impl AssetSidecarV2 {
    /// 是否处于回收站中。与 v1 一致，以 `deleted_at` 为准而不是以所在目录树为准。
    pub fn is_deleted(&self) -> bool {
        self.deleted_at.is_some()
    }

    pub fn read(path: &Path) -> Result<Self> {
        let bytes = std::fs::read(path).map_err(|e| {
            AppError::detailed(
                Code::LibraryIoFailed,
                format!("读取侧车失败 {}: {e}", path.display()),
            )
        })?;
        let sidecar: Self = serde_json::from_slice(&bytes).map_err(|e| {
            AppError::detailed(
                Code::LibraryMetadataCorrupt,
                format!("侧车无法按 v2 解析 {}: {e}", path.display()),
            )
        })?;
        if sidecar.format_version > SIDECAR_FORMAT_VERSION_V2 {
            return Err(AppError::detailed(
                Code::LibraryFormatTooNew,
                format!(
                    "侧车格式版本 {} 高于程序支持的 {}：{}",
                    sidecar.format_version,
                    SIDECAR_FORMAT_VERSION_V2,
                    path.display()
                ),
            ));
        }
        if sidecar.format_version < SIDECAR_FORMAT_VERSION_V2 {
            // 字段齐全但版本号声称自己是 v1 的文件不接受为 v2：版本号是迁移判断的
            // 唯一依据，允许它与内容不一致就等于允许迁移状态说谎。
            return Err(AppError::detailed(
                Code::LibraryMetadataCorrupt,
                format!(
                    "侧车格式版本 {} 低于 v2，应由迁移处理：{}",
                    sidecar.format_version,
                    path.display()
                ),
            ));
        }
        Ok(sidecar)
    }

    /// 写入侧车。语义与 v1 相同：先写临时文件再改名，失败时清理临时文件。
    pub fn write_atomic(&self, path: &Path) -> Result<()> {
        let io_err = |e: std::io::Error, what: &str| {
            AppError::detailed(
                Code::ImportMetadataWriteFailed,
                format!("{what} {}: {e}", path.display()),
            )
        };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| io_err(e, "建立侧车目录失败"))?;
        }
        let json = serde_json::to_vec_pretty(self).map_err(|e| {
            AppError::detailed(
                Code::ImportMetadataWriteFailed,
                format!("序列化侧车失败: {e}"),
            )
        })?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, &json).map_err(|e| io_err(e, "写入临时侧车失败"))?;
        std::fs::rename(&tmp, path).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            io_err(e, "提交侧车失败")
        })?;
        Ok(())
    }

    /// 在 v1→v2 迁移的索引重建阶段提供一个只读 v3 视图。
    ///
    /// 此时权威侧车已经是 v2，但库尚未提交到 v2/v3 生产格式；索引是派生数据，
    /// 只需能完成一致重建，最终 v3 提交会再次从权威侧车重建。多归属在这个过渡
    /// 快照中取稳定的第一个路径，绝不写回侧车或改变迁移计划。
    pub(crate) fn as_v3_index_view(&self) -> Result<AssetSidecarV3> {
        let stem = Path::new(&self.original_filename)
            .file_stem()
            .and_then(|value| value.to_str())
            .ok_or_else(|| {
                AppError::detailed(
                    Code::LibraryMetadataCorrupt,
                    format!("来源文件名无法转换为显示名：{}", self.original_filename),
                )
            })?;
        Ok(AssetSidecarV3 {
            format_version: SIDECAR_FORMAT_VERSION_V3,
            hash: self.hash.clone(),
            hash_algo: self.hash_algo.clone(),
            media_type: self.media_type,
            ext: self.ext.clone(),
            byte_size: self.byte_size,
            width: self.width,
            height: self.height,
            imported_at: self.imported_at,
            source: AssetSource::Filesystem {
                path: self.source_path.clone(),
                filename: self.original_filename.clone(),
            },
            display_filename: DisplayFilename::new(stem, self.media_type)?,
            folder: if self.is_deleted() {
                None
            } else {
                match self.folders.as_slice() {
                    [] => None,
                    [folder] => Some(folder.clone()),
                    // v1/v2 libraries are blocked from opening until the v3 conflict
                    // plan resolves every multi-folder asset; the temporary derived
                    // index must not invent an arbitrary ownership here.
                    _ => None,
                }
            },
            tags: self.tags.clone(),
            color_card: self.color_card.clone(),
            note: self.note.clone(),
            favorite: self.favorite,
            deleted_at: self.deleted_at,
            deleted_from_folder: self.deleted_from_folders.as_ref().and_then(|folders| match folders.as_slice() {
                [folder] => Some(folder.clone()),
                _ => None,
            }),
        })
    }
}

/// 图片进入库时的不可变来源。
///
/// 文件系统来源保留当时的完整路径与文件名；剪贴板来源没有伪造路径，而是记录捕获
/// 时间和生成的来源文件名。显示名称由 [`DisplayFilename`] 独立承担。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AssetSource {
    Filesystem {
        /// v2 允许来源路径缺失；迁移必须以显式 `null` 保留缺失，不能伪造路径。
        #[serde(deserialize_with = "deserialize_explicit_option")]
        path: Option<String>,
        filename: String,
    },
    Clipboard {
        captured_at: DateTime<Utc>,
        filename: String,
    },
}

impl AssetSource {
    /// 导入时的不可变来源文件名。
    pub fn filename(&self) -> &str {
        match self {
            Self::Filesystem { filename, .. } | Self::Clipboard { filename, .. } => filename,
        }
    }

    fn validate(&self) -> Result<()> {
        let filename = self.filename();
        if invalid_filename_text(filename) {
            return Err(AppError::detailed(
                Code::LibraryMetadataCorrupt,
                "素材来源文件名为空或包含非法路径字符",
            ));
        }
        if let Self::Filesystem {
            path: Some(path), ..
        } = self
        {
            if path.trim().is_empty() {
                return Err(AppError::detailed(
                    Code::LibraryMetadataCorrupt,
                    "文件系统来源路径为空",
                ));
            }
        }
        Ok(())
    }
}

/// 带真实媒体扩展名的显示文件名。
///
/// 使用者只提交名称主体，构造函数依据 [`MediaType`] 附加规范扩展名。内部字符串保持
/// 私有，使生产代码不能绕过校验直接制造伪造格式的显示名。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(transparent)]
pub struct DisplayFilename(String);

impl DisplayFilename {
    /// 从使用者提交的名称主体创建显示文件名。
    ///
    /// # Errors
    ///
    /// 名称为空、含控制字符或 Windows 路径字符，或者已经带有受支持图片扩展名时，
    /// 返回 `library.filename_invalid`。
    pub fn new(stem: &str, media_type: MediaType) -> Result<Self> {
        let normalized = stem.trim();
        if invalid_filename_text(normalized)
            || std::path::Path::new(normalized)
                .extension()
                .and_then(|extension| extension.to_str())
                .and_then(MediaType::from_extension)
                .is_some()
        {
            return Err(AppError::detailed(
                Code::LibraryFilenameInvalid,
                "显示名称主体为空、含非法路径字符或自带图片扩展名",
            ));
        }
        Ok(Self(format!("{normalized}.{}", media_type.library_ext())))
    }

    /// 完整显示文件名，包含由真实媒体类型决定的扩展名。
    pub fn as_str(&self) -> &str {
        &self.0
    }

    fn validate_for_media(&self, media_type: MediaType) -> Result<()> {
        let path = std::path::Path::new(&self.0);
        let stem_is_valid = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .is_some_and(|stem| !invalid_filename_text(stem));
        let extension_matches = path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension == media_type.library_ext());
        if !stem_is_valid || !extension_matches {
            return Err(AppError::detailed(
                Code::LibraryMetadataCorrupt,
                format!(
                    "显示文件名必须使用真实扩展名 .{}：{}",
                    media_type.library_ext(),
                    self.0
                ),
            ));
        }
        Ok(())
    }
}

impl std::fmt::Display for DisplayFilename {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// 图片侧车格式 v3：显式来源、显示文件名与单一图片文件夹归属。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AssetSidecarV3 {
    pub format_version: u32,
    pub hash: ContentHash,
    pub hash_algo: String,
    pub media_type: MediaType,
    pub ext: String,
    pub byte_size: u64,
    pub width: u32,
    pub height: u32,
    pub imported_at: DateTime<Utc>,
    pub source: AssetSource,
    pub display_filename: DisplayFilename,
    /// `None` 表示图片位于界面所称的“未分类”。字段必须显式写为 `null`，不能缺失。
    #[serde(deserialize_with = "deserialize_explicit_option")]
    pub folder: Option<String>,
    pub tags: Vec<String>,
    pub color_card: ColorCard,
    pub note: String,
    pub favorite: bool,
    #[serde(deserialize_with = "deserialize_explicit_option")]
    pub deleted_at: Option<DateTime<Utc>>,
    #[serde(deserialize_with = "deserialize_explicit_option")]
    pub deleted_from_folder: Option<String>,
}

impl AssetSidecarV3 {
    /// 是否处于图片回收站中。
    pub fn is_deleted(&self) -> bool {
        self.deleted_at.is_some()
    }

    /// 修改显示文件名，但不改变来源身份、内容哈希对象或真实媒体类型。
    ///
    /// # Errors
    ///
    /// 名称主体非法时返回 `library.filename_invalid`，原显示文件名保持不变。
    pub fn rename_display_filename(&mut self, stem: &str) -> Result<()> {
        let display_filename = DisplayFilename::new(stem, self.media_type)?;
        self.display_filename = display_filename;
        Ok(())
    }

    /// 把图片移动到唯一逻辑文件夹；`None` 表示移动到“未分类”。
    ///
    /// 这里只验证逻辑路径字面值。目标节点是否存在属于迁移后的 Catalog 事务，不由侧车
    /// 猜测。路径非法时返回 `library.folder_invalid`，原归属保持不变。
    pub fn move_to_folder(&mut self, folder: Option<&str>) -> Result<()> {
        let folder = folder.map(normalize_folder_path).transpose()?;
        self.folder = folder;
        Ok(())
    }

    /// 读取并完整校验 v3 侧车。
    ///
    /// # Errors
    ///
    /// IO 失败返回 `library.io_failed`；JSON、版本或字段不变量失败返回稳定的库错误码。
    pub fn read(path: &Path) -> Result<Self> {
        let bytes = std::fs::read(path).map_err(|error| {
            AppError::detailed(
                Code::LibraryIoFailed,
                format!("读取侧车失败 {}: {error}", path.display()),
            )
        })?;
        let sidecar: Self = serde_json::from_slice(&bytes).map_err(|error| {
            AppError::detailed(
                Code::LibraryMetadataCorrupt,
                format!("侧车无法按 v3 解析 {}: {error}", path.display()),
            )
        })?;
        if sidecar.format_version > SIDECAR_FORMAT_VERSION_V3 {
            return Err(AppError::detailed(
                Code::LibraryFormatTooNew,
                format!(
                    "侧车格式版本 {} 高于程序支持的 {}：{}",
                    sidecar.format_version,
                    SIDECAR_FORMAT_VERSION_V3,
                    path.display()
                ),
            ));
        }
        if sidecar.format_version < SIDECAR_FORMAT_VERSION_V3 {
            return Err(AppError::detailed(
                Code::LibraryMetadataCorrupt,
                format!(
                    "侧车格式版本 {} 低于 v3，应由迁移处理：{}",
                    sidecar.format_version,
                    path.display()
                ),
            ));
        }
        sidecar.validate()?;
        Ok(sidecar)
    }

    /// 原子写入经过验证的 v3 侧车。
    ///
    /// # Errors
    ///
    /// 字段不变量或文件系统写入失败时返回明确错误，且不提交半个 JSON。
    pub fn write_atomic(&self, path: &Path) -> Result<()> {
        self.validate()?;
        let io_error = |error: std::io::Error, action: &str| {
            AppError::detailed(
                Code::ImportMetadataWriteFailed,
                format!("{action} {}: {error}", path.display()),
            )
        };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| io_error(error, "建立侧车目录失败"))?;
        }
        let json = serde_json::to_vec_pretty(self).map_err(|error| {
            AppError::detailed(
                Code::ImportMetadataWriteFailed,
                format!("序列化侧车失败: {error}"),
            )
        })?;
        let temporary = path.with_extension("json.tmp");
        std::fs::write(&temporary, &json).map_err(|error| io_error(error, "写入临时侧车失败"))?;
        std::fs::rename(&temporary, path).map_err(|error| {
            let _ = std::fs::remove_file(&temporary);
            io_error(error, "提交侧车失败")
        })?;
        Ok(())
    }

    fn validate(&self) -> Result<()> {
        if self.ext != self.media_type.library_ext() {
            return Err(AppError::detailed(
                Code::LibraryMetadataCorrupt,
                format!(
                    "侧车扩展名 {} 与媒体类型 {} 不一致",
                    self.ext,
                    self.media_type.as_str()
                ),
            ));
        }
        self.source.validate()?;
        self.display_filename.validate_for_media(self.media_type)?;
        if self
            .folder
            .as_deref()
            .is_some_and(|folder| normalize_folder_path(folder).is_err())
            || self
                .deleted_from_folder
                .as_deref()
                .is_some_and(|folder| normalize_folder_path(folder).is_err())
        {
            return Err(AppError::detailed(
                Code::LibraryMetadataCorrupt,
                "单一图片文件夹路径为空或包含控制字符",
            ));
        }
        Ok(())
    }
}

fn deserialize_explicit_option<'de, D, T>(
    deserializer: D,
) -> std::result::Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

fn invalid_filename_text(value: &str) -> bool {
    value.trim().is_empty()
        || value == "."
        || value == ".."
        || value
            .chars()
            .any(|character| character.is_control() || "\\/:*?\"<>|".contains(character))
}

pub(crate) fn normalize_folder_path(raw: &str) -> Result<String> {
    if raw.is_empty() {
        return Err(invalid_folder_path(raw));
    }
    let mut normalized = Vec::new();
    for segment in raw.split('/') {
        let segment = segment.trim();
        if segment.is_empty()
            || segment == "."
            || segment == ".."
            || segment.chars().any(char::is_control)
        {
            return Err(invalid_folder_path(raw));
        }
        normalized.push(segment);
    }
    Ok(normalized.join("/"))
}

fn invalid_folder_path(raw: &str) -> AppError {
    AppError::detailed(
        Code::LibraryFolderInvalid,
        format!("非法文件夹路径：{raw:?}"),
    )
}

/// 生产路径使用的侧车格式。
///
/// 用别名而不是把当前版直接命名为 `AssetSidecar`：库格式版本会继续往前走，而"生产用哪一版"
/// 这件事应当只在一处改写。索引、导入与编目全部引用这个名字，因此下一次格式升级只需要
/// 改这一行，而不是再一次全仓库改名。
///
/// 任务 3.7 起（迁移提交门禁与恢复入口均已就位）生产切换为 v3：显式来源、必填显示
/// 文件名与单一可选文件夹归属。
pub type AssetSidecar = AssetSidecarV3;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::colorcard::{ColorCard, ColorCardStatus};

    fn sample() -> AssetSidecarV1 {
        AssetSidecarV1 {
            format_version: SIDECAR_FORMAT_VERSION,
            hash: ContentHash::of_bytes(b"abc"),
            hash_algo: crate::hashing::HASH_ALGO_ID.to_owned(),
            media_type: MediaType::Png,
            ext: "png".to_owned(),
            byte_size: 3,
            width: 4,
            height: 2,
            imported_at: DateTime::from_timestamp(0, 0).expect("固定时间戳"),
            original_filename: "样例.png".to_owned(),
            source_path: Some("D:/素材/样例.png".to_owned()),
            folders: vec![],
            tags: vec![],
            color_card: ColorCard::failed(Code::ColorCardInsufficientOpaquePixels),
            deleted_at: None,
            deleted_from_folders: None,
        }
    }

    fn sample_v2() -> AssetSidecarV2 {
        let v1 = sample();
        AssetSidecarV2 {
            format_version: SIDECAR_FORMAT_VERSION_V2,
            hash: v1.hash,
            hash_algo: v1.hash_algo,
            media_type: v1.media_type,
            ext: v1.ext,
            byte_size: v1.byte_size,
            width: v1.width,
            height: v1.height,
            imported_at: v1.imported_at,
            original_filename: v1.original_filename,
            source_path: v1.source_path,
            folders: v1.folders,
            tags: v1.tags,
            color_card: v1.color_card,
            note: "第一行备注".to_owned(),
            favorite: true,
            deleted_at: None,
            deleted_from_folders: None,
        }
    }

    #[test]
    fn v2_round_trips_with_note_and_favorite() {
        let dir = tempfile::tempdir().expect("建立临时目录");
        let p = dir.path().join("a.json");
        let s = sample_v2();
        s.write_atomic(&p).expect("写入 v2 侧车");
        assert_eq!(AssetSidecarV2::read(&p).expect("读回 v2 侧车"), s);
    }

    #[test]
    fn a_v2_note_keeps_its_line_breaks_verbatim() {
        // 备注是纯文本：换行必须逐字保留，不得被规范化或解析成富文本。
        let dir = tempfile::tempdir().expect("建立临时目录");
        let p = dir.path().join("a.json");
        let mut s = sample_v2();
        s.note = "第一行

第三行  末尾两个空格  "
            .to_owned();
        s.write_atomic(&p).expect("写入 v2 侧车");
        assert_eq!(AssetSidecarV2::read(&p).expect("读回").note, s.note);
    }

    #[test]
    fn a_v1_sidecar_is_refused_by_the_v2_reader_instead_of_defaulted() {
        // 设计第四条：不以 serde 默认值猜测 note/favorite。少了这两个字段的文件是
        // v1 文件，必须交给迁移，而不是当成"备注为空、未收藏"的 v2 文件。
        let dir = tempfile::tempdir().expect("建立临时目录");
        let p = dir.path().join("a.json");
        sample().write_atomic(&p).expect("写入 v1 侧车");
        let err = AssetSidecarV2::read(&p).expect_err("本应拒绝 v1 侧车");
        assert_eq!(err.code, Code::LibraryMetadataCorrupt);
    }

    #[test]
    fn a_v2_sidecar_is_refused_by_the_v1_reader_as_too_new() {
        // 回滚应用二进制后旧版本不得打开 v2 数据（迁移计划第六条）。
        let dir = tempfile::tempdir().expect("建立临时目录");
        let p = dir.path().join("a.json");
        sample_v2().write_atomic(&p).expect("写入 v2 侧车");
        let err = AssetSidecarV1::read(&p).expect_err("v1 阅读器本应拒绝 v2 侧车");
        assert_eq!(err.code, Code::LibraryFormatTooNew);
    }

    #[test]
    fn a_v2_sidecar_claiming_to_be_v1_is_refused() {
        let dir = tempfile::tempdir().expect("建立临时目录");
        let p = dir.path().join("a.json");
        let mut s = sample_v2();
        s.format_version = SIDECAR_FORMAT_VERSION;
        s.write_atomic(&p).expect("写入版本号不一致的侧车");
        let err = AssetSidecarV2::read(&p).expect_err("本应拒绝声称自己是 v1 的文件");
        assert_eq!(err.code, Code::LibraryMetadataCorrupt);
    }

    #[test]
    fn a_newer_v2_sidecar_format_version_is_refused() {
        let dir = tempfile::tempdir().expect("建立临时目录");
        let p = dir.path().join("a.json");
        let mut s = sample_v2();
        s.format_version = SIDECAR_FORMAT_VERSION_V2 + 1;
        s.write_atomic(&p).expect("写入更高版本侧车");
        let err = AssetSidecarV2::read(&p).expect_err("本应拒绝更高的格式版本");
        assert_eq!(err.code, Code::LibraryFormatTooNew);
    }

    #[test]
    fn v2_atomic_write_leaves_no_temp_file_behind() {
        let dir = tempfile::tempdir().expect("建立临时目录");
        sample_v2()
            .write_atomic(&dir.path().join("a.json"))
            .expect("写入 v2 侧车");
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .expect("读取目录")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "残留临时文件：{leftovers:?}");
    }

    #[test]
    fn v2_deleted_state_is_derived_from_the_sidecar_itself() {
        let mut s = sample_v2();
        assert!(!s.is_deleted());
        s.deleted_at = Some(DateTime::from_timestamp(1, 0).expect("固定时间戳"));
        s.deleted_from_folders = Some(vec!["参考/构图".to_owned()]);
        assert!(s.is_deleted());
    }

    #[test]
    fn round_trips_through_json() {
        let dir = tempfile::tempdir().expect("建立临时目录");
        let p = dir.path().join("a.json");
        let s = sample();
        s.write_atomic(&p).expect("写入侧车");
        assert_eq!(AssetSidecarV1::read(&p).expect("读回侧车"), s);
    }

    #[test]
    fn atomic_write_leaves_no_temp_file_behind() {
        let dir = tempfile::tempdir().expect("建立临时目录");
        let p = dir.path().join("a.json");
        sample().write_atomic(&p).expect("写入侧车");
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .expect("读取目录")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "残留临时文件：{leftovers:?}");
    }

    #[test]
    fn overwriting_an_existing_sidecar_succeeds() {
        // Windows 上改名覆盖既有文件容易踩坑，而重算色卡等操作会覆盖侧车。
        let dir = tempfile::tempdir().expect("建立临时目录");
        let p = dir.path().join("a.json");
        let mut s = sample();
        s.write_atomic(&p).expect("首次写入");
        s.tags.push("已改".to_owned());
        s.write_atomic(&p).expect("覆盖写入");
        assert_eq!(AssetSidecarV1::read(&p).expect("读回").tags, vec!["已改"]);
    }

    #[test]
    fn sidecar_from_a_newer_format_version_is_refused() {
        let dir = tempfile::tempdir().expect("建立临时目录");
        let p = dir.path().join("a.json");
        let mut s = sample();
        s.format_version = SIDECAR_FORMAT_VERSION + 1;
        s.write_atomic(&p).expect("写入更高版本侧车");
        let err = AssetSidecarV1::read(&p).expect_err("本应拒绝更高的格式版本");
        assert_eq!(err.code, Code::LibraryFormatTooNew);
    }

    #[test]
    fn unparseable_sidecar_reports_corruption_not_io_failure() {
        let dir = tempfile::tempdir().expect("建立临时目录");
        let p = dir.path().join("a.json");
        std::fs::write(&p, "{ 这不是合法 JSON".as_bytes()).expect("写入损坏内容");
        let err = AssetSidecar::read(&p).expect_err("本应报告损坏");
        assert_eq!(err.code, Code::LibraryMetadataCorrupt);
    }

    #[test]
    fn deleted_state_is_derived_from_the_sidecar_itself() {
        let mut s = sample();
        assert!(!s.is_deleted());
        s.deleted_at = Some(DateTime::from_timestamp(1, 0).expect("固定时间戳"));
        s.deleted_from_folders = Some(vec!["参考/构图".to_owned()]);
        assert!(s.is_deleted());
    }

    #[test]
    fn color_card_failure_carries_no_colors() {
        // 规格要求失败时 colors 为空数组，而不是静默返回一个看起来正常的空色卡。
        let s = sample();
        assert_eq!(s.color_card.status, ColorCardStatus::Failed);
        assert!(s.color_card.colors.is_empty());
        assert!(s.color_card.failure_reason.is_some());
    }
}
