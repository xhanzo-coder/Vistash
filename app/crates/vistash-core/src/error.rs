//! 错误码。
//!
//! 命名规则为 `<域>.<具体失败>`。错误码是本项目唯一稳定的诊断标识符，因此界面
//! 必须原样呈现它，而不是只给一句通用失败文案。

use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// 错误码所属的域。`Observe` 与 `Compile` 属于反推能力，本变更不产生这两域的
/// 错误，但保留枚举项以免后续变更改动这里的判别逻辑。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Domain {
    Import,
    Trash,
    ColorCard,
    Library,
    Observe,
    Compile,
}

impl Domain {
    pub fn as_str(self) -> &'static str {
        match self {
            Domain::Import => "import",
            Domain::Trash => "trash",
            Domain::ColorCard => "color_card",
            Domain::Library => "library",
            Domain::Observe => "observe",
            Domain::Compile => "compile",
        }
    }
}

/// 全部错误码。序列化时用 `as_str` 给出的字符串，因此前端、日志与规格文档看到的
/// 是同一个标识符。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Code {
    // import 域：九个，与 asset-library 规格一致
    ImportSourceUnreadable,
    ImportUnsupportedMediaType,
    ImportDecodeFailed,
    ImportInsufficientSpace,
    ImportCopyFailed,
    ImportMetadataWriteFailed,
    ImportDuplicateInLibrary,
    ImportDuplicateInTrash,
    ImportCancelled,
    // trash 域
    TrashDeleteFailed,
    TrashRestoreFailed,
    TrashRestoreTargetFolderMissing,
    TrashPurgeFailed,
    // color_card 域
    ColorCardDecodeFailed,
    ColorCardInsufficientOpaquePixels,
    ColorCardClusterFailed,
    // library 域：本变更新增，填充既有设计已保留的域
    LibraryNotFound,
    LibraryPathUnreadable,
    LibraryFormatTooNew,
    LibraryMetadataCorrupt,
    LibraryDirectoryNotEmpty,
    LibraryCreateFailed,
    LibraryIoFailed,
    LibraryIndexRebuildFailed,
    LibraryThumbnailFailed,
    LibrarySettingsCorrupt,
    LibraryFolderInvalid,
    LibraryFolderExists,
    LibraryFolderNotFound,
    LibraryTagInvalid,
    LibraryAssetMetadataWriteFailed,
}

/// 全部错误码的清单。测试与前端文案表都以它为准，避免新增错误码后漏掉映射。
pub const ALL_CODES: &[Code] = &[
    Code::ImportSourceUnreadable,
    Code::ImportUnsupportedMediaType,
    Code::ImportDecodeFailed,
    Code::ImportInsufficientSpace,
    Code::ImportCopyFailed,
    Code::ImportMetadataWriteFailed,
    Code::ImportDuplicateInLibrary,
    Code::ImportDuplicateInTrash,
    Code::ImportCancelled,
    Code::TrashDeleteFailed,
    Code::TrashRestoreFailed,
    Code::TrashRestoreTargetFolderMissing,
    Code::TrashPurgeFailed,
    Code::ColorCardDecodeFailed,
    Code::ColorCardInsufficientOpaquePixels,
    Code::ColorCardClusterFailed,
    Code::LibraryNotFound,
    Code::LibraryPathUnreadable,
    Code::LibraryFormatTooNew,
    Code::LibraryMetadataCorrupt,
    Code::LibraryDirectoryNotEmpty,
    Code::LibraryCreateFailed,
    Code::LibraryIoFailed,
    Code::LibraryIndexRebuildFailed,
    Code::LibraryThumbnailFailed,
    Code::LibrarySettingsCorrupt,
    Code::LibraryFolderInvalid,
    Code::LibraryFolderExists,
    Code::LibraryFolderNotFound,
    Code::LibraryTagInvalid,
    Code::LibraryAssetMetadataWriteFailed,
];

impl Code {
    pub fn domain(self) -> Domain {
        use Code::*;
        match self {
            ImportSourceUnreadable
            | ImportUnsupportedMediaType
            | ImportDecodeFailed
            | ImportInsufficientSpace
            | ImportCopyFailed
            | ImportMetadataWriteFailed
            | ImportDuplicateInLibrary
            | ImportDuplicateInTrash
            | ImportCancelled => Domain::Import,
            TrashDeleteFailed
            | TrashRestoreFailed
            | TrashRestoreTargetFolderMissing
            | TrashPurgeFailed => Domain::Trash,
            ColorCardDecodeFailed | ColorCardInsufficientOpaquePixels | ColorCardClusterFailed => {
                Domain::ColorCard
            }
            LibraryNotFound
            | LibraryPathUnreadable
            | LibraryFormatTooNew
            | LibraryMetadataCorrupt
            | LibraryDirectoryNotEmpty
            | LibraryCreateFailed
            | LibraryIoFailed
            | LibraryIndexRebuildFailed
            | LibraryThumbnailFailed
            | LibrarySettingsCorrupt
            | LibraryFolderInvalid
            | LibraryFolderExists
            | LibraryFolderNotFound
            | LibraryTagInvalid
            | LibraryAssetMetadataWriteFailed => Domain::Library,
        }
    }

    pub fn as_str(self) -> &'static str {
        use Code::*;
        match self {
            ImportSourceUnreadable => "import.source_unreadable",
            ImportUnsupportedMediaType => "import.unsupported_media_type",
            ImportDecodeFailed => "import.decode_failed",
            ImportInsufficientSpace => "import.insufficient_space",
            ImportCopyFailed => "import.copy_failed",
            ImportMetadataWriteFailed => "import.metadata_write_failed",
            ImportDuplicateInLibrary => "import.duplicate_in_library",
            ImportDuplicateInTrash => "import.duplicate_in_trash",
            ImportCancelled => "import.cancelled",
            TrashDeleteFailed => "trash.delete_failed",
            TrashRestoreFailed => "trash.restore_failed",
            TrashRestoreTargetFolderMissing => "trash.restore_target_folder_missing",
            TrashPurgeFailed => "trash.purge_failed",
            ColorCardDecodeFailed => "color_card.decode_failed",
            ColorCardInsufficientOpaquePixels => "color_card.insufficient_opaque_pixels",
            ColorCardClusterFailed => "color_card.cluster_failed",
            LibraryNotFound => "library.not_found",
            LibraryPathUnreadable => "library.path_unreadable",
            LibraryFormatTooNew => "library.format_too_new",
            LibraryMetadataCorrupt => "library.metadata_corrupt",
            LibraryDirectoryNotEmpty => "library.directory_not_empty",
            LibraryCreateFailed => "library.create_failed",
            LibraryIoFailed => "library.io_failed",
            LibraryIndexRebuildFailed => "library.index_rebuild_failed",
            LibraryThumbnailFailed => "library.thumbnail_failed",
            LibrarySettingsCorrupt => "library.settings_corrupt",
            LibraryFolderInvalid => "library.folder_invalid",
            LibraryFolderExists => "library.folder_exists",
            LibraryFolderNotFound => "library.folder_not_found",
            LibraryTagInvalid => "library.tag_invalid",
            LibraryAssetMetadataWriteFailed => "library.asset_metadata_write_failed",
        }
    }

    /// 由字符串反查错误码。以 `ALL_CODES` 为唯一数据源，新增错误码时无需改动这里。
    pub fn parse(s: &str) -> Option<Self> {
        ALL_CODES.iter().copied().find(|c| c.as_str() == s)
    }
}

impl Serialize for Code {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for Code {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        Self::parse(&s).ok_or_else(|| serde::de::Error::custom(format!("未知错误码：{s}")))
    }
}

impl std::fmt::Display for Code {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 携带错误码的失败。`detail` 保留底层原因用于诊断，界面呈现以 `code` 为主。
#[derive(Debug, Clone, Serialize)]
pub struct AppError {
    pub code: Code,
    pub detail: Option<String>,
}

impl AppError {
    pub fn new(code: Code) -> Self {
        Self { code, detail: None }
    }

    pub fn detailed(code: Code, detail: impl std::fmt::Display) -> Self {
        Self {
            code,
            detail: Some(detail.to_string()),
        }
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.detail {
            Some(d) => write!(f, "{}: {}", self.code, d),
            None => write!(f, "{}", self.code),
        }
    }
}

impl std::error::Error for AppError {}

pub type Result<T> = std::result::Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_string_is_prefixed_by_its_domain() {
        for &c in ALL_CODES {
            let expected = format!("{}.", c.domain().as_str());
            assert!(
                c.as_str().starts_with(&expected),
                "错误码 {} 的前缀与其域 {} 不一致",
                c.as_str(),
                c.domain().as_str()
            );
        }
    }

    #[test]
    fn all_code_strings_are_unique() {
        let mut seen: Vec<&str> = ALL_CODES.iter().map(|c| c.as_str()).collect();
        let total = seen.len();
        seen.sort_unstable();
        seen.dedup();
        assert_eq!(seen.len(), total, "存在重复的错误码字符串");
    }

    #[test]
    fn import_domain_has_exactly_nine_codes() {
        // asset-library 规格明确列出九个导入错误码。数量变化必须是有意的，
        // 因此在这里锁死，防止随手增删。
        let n = ALL_CODES
            .iter()
            .filter(|c| c.domain() == Domain::Import)
            .count();
        assert_eq!(n, 9, "导入错误码数量与规格不符");
    }

    #[test]
    fn every_code_survives_a_json_round_trip() {
        // 侧车把色卡失败原因写成错误码字符串，读不回就等于侧车损坏。
        for &c in ALL_CODES {
            let json = serde_json::to_string(&c).expect("序列化错误码");
            let back: Code = serde_json::from_str(&json).expect("反序列化错误码");
            assert_eq!(back, c);
        }
    }

    #[test]
    fn unknown_code_string_is_refused() {
        assert!(serde_json::from_str::<Code>("\"import.不存在的码\"").is_err());
        assert_eq!(
            Code::parse("library.not_found"),
            Some(Code::LibraryNotFound)
        );
        assert_eq!(Code::parse("library.NOT_FOUND"), None);
    }

    #[test]
    fn color_card_domain_has_exactly_three_codes() {
        let n = ALL_CODES
            .iter()
            .filter(|c| c.domain() == Domain::ColorCard)
            .count();
        assert_eq!(n, 3, "色卡错误码数量与规格不符");
    }
}
