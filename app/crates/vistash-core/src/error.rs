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
    Prompt,
    Migration,
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
            Domain::Prompt => "prompt",
            Domain::Migration => "migration",
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
    /// 库格式比当前数据模型旧。它不是损坏：开库入口应把它转成一次明确的迁移，
    /// 而不是让使用者面对"元数据损坏"误以为素材丢了。
    LibraryFormatTooOld,
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
    // prompt 域：提示词素材及其权威文件
    PromptMetadataCorrupt,
    PromptFormatTooNew,
    PromptWriteFailed,
    PromptBodyEmpty,
    PromptIdInvalid,
    PromptCoverNotLinked,
    PromptLinkedImageDuplicated,
    /// 正常库中不存在该提示词。它与瞬时 IO 失败不同：多半意味着素材已被删除或
    /// ID 有误，界面应引导重新查看列表而不是提示重试。
    PromptNotFound,
    /// 提示词文件夹清单中不存在该文件夹。提示词文件夹与图片文件夹是两棵树，
    /// 归属必须指向自己那棵树里真实存在的路径。
    PromptFolderNotFound,
    /// 提示词文件夹清单中已有同名路径。与图片文件夹无关：两棵树允许同路径字面值
    /// 各自存在，重复只发生在提示词树内部。
    PromptFolderExists,
    /// 把提示词移入库内提示词回收站失败。与图片侧的 `trash.delete_failed` 分开：
    /// 两棵树的同名路径可以各自存在，失败也必须能归因到各自那一侧。
    PromptTrashDeleteFailed,
    /// 从库内提示词回收站还原提示词失败。分开的理由同上。
    PromptTrashRestoreFailed,
    /// 彻底删除一条回收站提示词失败。逐项隔离：一条失败不阻止其余条目继续清理。
    PromptTrashPurgeFailed,
    /// 关联目标图片不在库中。关联只能指向真实入库的图片，否则界面会把一个
    /// 永远无法解析的引用呈现成"已删除"。
    PromptLinkedImageNotFound,
    // migration 域：库格式 v1 到 v2 的一次性迁移
    MigrationJournalCorrupt,
    MigrationJournalFormatTooNew,
    MigrationJournalWriteFailed,
    MigrationLockHeld,
    MigrationInterrupted,
    MigrationBackupFailed,
    MigrationSidecarRewriteFailed,
    MigrationCommitFailed,
    MigrationRollbackFailed,
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
    Code::LibraryFormatTooOld,
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
    Code::PromptMetadataCorrupt,
    Code::PromptFormatTooNew,
    Code::PromptWriteFailed,
    Code::PromptBodyEmpty,
    Code::PromptIdInvalid,
    Code::PromptCoverNotLinked,
    Code::PromptLinkedImageDuplicated,
    Code::PromptNotFound,
    Code::PromptFolderNotFound,
    Code::PromptFolderExists,
    Code::PromptTrashDeleteFailed,
    Code::PromptTrashRestoreFailed,
    Code::PromptTrashPurgeFailed,
    Code::PromptLinkedImageNotFound,
    Code::MigrationJournalCorrupt,
    Code::MigrationJournalFormatTooNew,
    Code::MigrationJournalWriteFailed,
    Code::MigrationLockHeld,
    Code::MigrationInterrupted,
    Code::MigrationBackupFailed,
    Code::MigrationSidecarRewriteFailed,
    Code::MigrationCommitFailed,
    Code::MigrationRollbackFailed,
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
            | LibraryFormatTooOld
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
            PromptMetadataCorrupt
            | PromptFormatTooNew
            | PromptWriteFailed
            | PromptBodyEmpty
            | PromptIdInvalid
            | PromptCoverNotLinked
            | PromptLinkedImageDuplicated
            | PromptNotFound
            | PromptFolderNotFound
            | PromptFolderExists
            | PromptTrashDeleteFailed
            | PromptTrashRestoreFailed
            | PromptTrashPurgeFailed
            | PromptLinkedImageNotFound => Domain::Prompt,
            MigrationJournalCorrupt
            | MigrationJournalFormatTooNew
            | MigrationJournalWriteFailed
            | MigrationLockHeld
            | MigrationInterrupted
            | MigrationBackupFailed
            | MigrationSidecarRewriteFailed
            | MigrationCommitFailed
            | MigrationRollbackFailed
            => Domain::Migration,
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
            LibraryFormatTooOld => "library.format_too_old",
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
            PromptMetadataCorrupt => "prompt.metadata_corrupt",
            PromptFormatTooNew => "prompt.format_too_new",
            PromptWriteFailed => "prompt.write_failed",
            PromptBodyEmpty => "prompt.body_empty",
            PromptIdInvalid => "prompt.id_invalid",
            PromptCoverNotLinked => "prompt.cover_not_linked",
            PromptLinkedImageDuplicated => "prompt.linked_image_duplicated",
            PromptNotFound => "prompt.not_found",
            PromptFolderNotFound => "prompt.folder_not_found",
            PromptFolderExists => "prompt.folder_exists",
            PromptTrashDeleteFailed => "prompt.trash_delete_failed",
            PromptTrashRestoreFailed => "prompt.trash_restore_failed",
            PromptTrashPurgeFailed => "prompt.trash_purge_failed",
            PromptLinkedImageNotFound => "prompt.linked_image_not_found",
            MigrationJournalCorrupt => "migration.journal_corrupt",
            MigrationJournalFormatTooNew => "migration.journal_format_too_new",
            MigrationJournalWriteFailed => "migration.journal_write_failed",
            MigrationLockHeld => "migration.lock_held",
            MigrationInterrupted => "migration.interrupted",
            MigrationBackupFailed => "migration.backup_failed",
            MigrationSidecarRewriteFailed => "migration.sidecar_rewrite_failed",
            MigrationCommitFailed => "migration.commit_failed",
            MigrationRollbackFailed => "migration.rollback_failed",
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
