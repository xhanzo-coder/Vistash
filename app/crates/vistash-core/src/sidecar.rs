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
            AppError::detailed(Code::ImportMetadataWriteFailed, format!("序列化侧车失败: {e}"))
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
}

/// 生产路径使用的侧车格式。
///
/// 用别名而不是把 v2 直接命名为 `AssetSidecar`：库格式版本会继续往前走，而"生产用哪一版"
/// 这件事应当只在一处改写。索引、导入与编目全部引用这个名字，因此下一次格式升级只需要
/// 改这一行，而不是再一次全仓库改名。
pub type AssetSidecar = AssetSidecarV2;

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
