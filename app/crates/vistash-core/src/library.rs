//! 库骨架：目录布局、库级元数据与路径推导。
//!
//! 库是一个自包含的目录：把它整体复制到另一台机器上应当能直接打开。因此凡是无法
//! 从库内文件重建的信息（哈希算法、格式版本）都必须写进 `library.json`，而凡是能
//! 重建的（SQLite 索引、缩略图）都不进入元数据。

use crate::error::{AppError, Code, Result};
use crate::hashing::{ContentHash, HASH_ALGO_ID};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// 库格式版本。寻址方式（fanout 层数与切片位置）属于库格式，改动必须提升此值。
pub const LIBRARY_FORMAT_VERSION: u32 = 1;

pub const META_FILE: &str = "library.json";
pub const FOLDERS_FILE: &str = "folders.json";
pub const INDEX_FILE: &str = "index.sqlite";
pub const OBJECTS_DIR: &str = "objects";
pub const TRASH_DIR: &str = "trash";
pub const THUMBNAILS_DIR: &str = "thumbnails";
pub const PROMPTS_DIR: &str = "prompts";

/// 库创建时会建立的全部子目录。
const SUBDIRS: &[&str] = &[OBJECTS_DIR, TRASH_DIR, THUMBNAILS_DIR, PROMPTS_DIR];

/// 库级元数据。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LibraryMeta {
    pub format_version: u32,
    /// 哈希算法标识符。它决定了库内既有素材的全部路径，无法从本体反推，
    /// 因此这个文件损坏后库不能自愈重建。
    pub hash_algo: String,
    pub created_at: DateTime<Utc>,
    /// 建库时的程序版本。仅用于诊断，不参与任何判断。
    pub created_by_app_version: String,
}

/// 文件夹清单。
///
/// 本变更只负责建立并读写这个文件，文件夹的增删改与界面属于后续变更。用斜杠分隔的
/// 路径字符串而不是带 id 的树结构，是为了与 `AssetSidecar::folders` 保持同一种表示——
/// 两处若用不同表示，同步逻辑就会成为一个必须存在的模块。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FolderList {
    pub format_version: u32,
    pub folders: Vec<String>,
}

impl Default for FolderList {
    fn default() -> Self {
        Self {
            format_version: LIBRARY_FORMAT_VERSION,
            folders: Vec::new(),
        }
    }
}

/// 一个已打开的库。
///
/// 持有它即代表"根目录存在且 `library.json` 已校验通过"，因此下游模块不需要重复
/// 检查库是否有效——这是把校验集中在一处的目的。
#[derive(Debug, Clone)]
pub struct Library {
    root: PathBuf,
    meta: LibraryMeta,
}

fn io_failed(what: &str, path: &Path, e: std::io::Error) -> AppError {
    AppError::detailed(Code::LibraryIoFailed, format!("{what} {}: {e}", path.display()))
}

fn write_json_atomic(path: &Path, value: &impl Serialize, code: Code) -> Result<()> {
    let json = serde_json::to_vec_pretty(value)
        .map_err(|e| AppError::detailed(code, format!("序列化失败 {}: {e}", path.display())))?;
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, &json)
        .map_err(|e| AppError::detailed(code, format!("写入临时文件失败 {}: {e}", tmp.display())))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        AppError::detailed(code, format!("提交失败 {}: {e}", path.display()))
    })
}

impl Library {
    /// 在指定目录建立新库。目录必须不存在，或者存在且为空。
    ///
    /// 拒绝非空目录不是保守，而是因为建库会在其中写入 `library.json` 并声称整个
    /// 目录是一个库；若目录里原有别的文件，之后的索引重建会去扫描它们。
    pub fn create(root: &Path) -> Result<Self> {
        if root.exists() {
            if !root.is_dir() {
                return Err(AppError::detailed(
                    Code::LibraryCreateFailed,
                    format!("目标不是目录：{}", root.display()),
                ));
            }
            let mut entries = std::fs::read_dir(root)
                .map_err(|e| io_failed("读取目标目录失败", root, e))?;
            if entries.next().is_some() {
                return Err(AppError::detailed(
                    Code::LibraryDirectoryNotEmpty,
                    format!("目录非空：{}", root.display()),
                ));
            }
        } else {
            std::fs::create_dir_all(root).map_err(|e| {
                AppError::detailed(
                    Code::LibraryCreateFailed,
                    format!("建立库目录失败 {}: {e}", root.display()),
                )
            })?;
        }

        for d in SUBDIRS {
            let p = root.join(d);
            std::fs::create_dir_all(&p).map_err(|e| {
                AppError::detailed(
                    Code::LibraryCreateFailed,
                    format!("建立子目录失败 {}: {e}", p.display()),
                )
            })?;
        }

        let meta = LibraryMeta {
            format_version: LIBRARY_FORMAT_VERSION,
            hash_algo: HASH_ALGO_ID.to_owned(),
            created_at: Utc::now(),
            created_by_app_version: env!("CARGO_PKG_VERSION").to_owned(),
        };
        write_json_atomic(&root.join(META_FILE), &meta, Code::LibraryCreateFailed)?;
        write_json_atomic(
            &root.join(FOLDERS_FILE),
            &FolderList::default(),
            Code::LibraryCreateFailed,
        )?;

        Ok(Self {
            root: root.to_path_buf(),
            meta,
        })
    }

    /// 打开既有库。
    pub fn open(root: &Path) -> Result<Self> {
        let meta_path = root.join(META_FILE);
        if !meta_path.is_file() {
            return Err(AppError::detailed(
                Code::LibraryNotFound,
                format!("目录中没有 {META_FILE}：{}", root.display()),
            ));
        }
        let bytes = std::fs::read(&meta_path).map_err(|e| {
            AppError::detailed(
                Code::LibraryPathUnreadable,
                format!("读取 {META_FILE} 失败 {}: {e}", meta_path.display()),
            )
        })?;
        let meta: LibraryMeta = serde_json::from_slice(&bytes).map_err(|e| {
            AppError::detailed(
                Code::LibraryMetadataCorrupt,
                format!("{META_FILE} 无法解析 {}: {e}", meta_path.display()),
            )
        })?;
        if meta.format_version > LIBRARY_FORMAT_VERSION {
            return Err(AppError::detailed(
                Code::LibraryFormatTooNew,
                format!(
                    "库格式版本 {} 高于程序支持的 {}",
                    meta.format_version, LIBRARY_FORMAT_VERSION
                ),
            ));
        }
        if meta.hash_algo != HASH_ALGO_ID {
            // 无法识别的哈希算法意味着本次构建不知道库内路径是怎么算出来的，
            // 与"格式过新"属于同一类失败：能读到文件，但不能安全地解释它。
            return Err(AppError::detailed(
                Code::LibraryFormatTooNew,
                format!(
                    "库使用的哈希算法 {} 不被本次构建支持（本构建为 {HASH_ALGO_ID}）",
                    meta.hash_algo
                ),
            ));
        }

        // 补齐缺失的子目录。空目录不携带任何信息，因此重建它不会掩盖数据丢失——
        // 真正的数据丢失会在索引重建时表现为素材数量下降。
        for d in SUBDIRS {
            let p = root.join(d);
            if !p.is_dir() {
                std::fs::create_dir_all(&p).map_err(|e| io_failed("补齐子目录失败", &p, e))?;
            }
        }

        Ok(Self {
            root: root.to_path_buf(),
            meta,
        })
    }

    /// 打开指定目录的库；目录还不是库时创建一个。
    ///
    /// **只用于使用者显式选择目录的流程。**启动时恢复上次的库必须直接用 [`Library::open`]：
    /// 若那条路径也走这里，一个被移走或改名的库目录就会被当成"新目录"而建出一个空库，
    /// 使用者面对空库却以为素材全丢了。规格把这条列为明令禁止。
    ///
    /// 三种情形分别由下层保证：目录已是库则 `open` 校验格式版本；目录为空则 `create`
    /// 建骨架；目录非空且不是库则 `create` 报 `library.directory_not_empty`。
    pub fn open_or_create(root: &Path) -> Result<Self> {
        if root.join(META_FILE).exists() {
            Self::open(root)
        } else {
            Self::create(root)
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn meta(&self) -> &LibraryMeta {
        &self.meta
    }

    pub fn objects_dir(&self) -> PathBuf {
        self.root.join(OBJECTS_DIR)
    }

    pub fn trash_dir(&self) -> PathBuf {
        self.root.join(TRASH_DIR)
    }

    /// 缩略图独立成树（设计第四条）：它是可重算的派生数据，与权威本体混在同一棵
    /// 树里会让"重建缩略图"这类操作写进权威目录。
    pub fn thumbnails_dir(&self) -> PathBuf {
        self.root.join(THUMBNAILS_DIR)
    }

    pub fn prompts_dir(&self) -> PathBuf {
        self.root.join(PROMPTS_DIR)
    }

    pub fn meta_path(&self) -> PathBuf {
        self.root.join(META_FILE)
    }

    pub fn folders_path(&self) -> PathBuf {
        self.root.join(FOLDERS_FILE)
    }

    pub fn index_path(&self) -> PathBuf {
        self.root.join(INDEX_FILE)
    }

    pub fn body_path(&self, hash: &ContentHash, ext: &str) -> PathBuf {
        hash.body_path_in(&self.objects_dir(), ext)
    }

    pub fn sidecar_path(&self, hash: &ContentHash) -> PathBuf {
        hash.sidecar_path_in(&self.objects_dir())
    }

    pub fn thumbnail_path(&self, hash: &ContentHash) -> PathBuf {
        hash.body_path_in(&self.thumbnails_dir(), "webp")
    }

    pub fn trash_body_path(&self, hash: &ContentHash, ext: &str) -> PathBuf {
        hash.body_path_in(&self.trash_dir(), ext)
    }

    pub fn trash_sidecar_path(&self, hash: &ContentHash) -> PathBuf {
        hash.sidecar_path_in(&self.trash_dir())
    }

    /// 读取素材本体的字节。
    ///
    /// 路径推导与库内 I/O 都是本模块的职责，因此这条读取不下放给调用方自己拼路径——
    /// 一旦调用方拼路径，fanout 的切片规则就有了第二个实现。
    pub fn read_body(&self, hash: &ContentHash, ext: &str) -> Result<Vec<u8>> {
        let p = self.body_path(hash, ext);
        std::fs::read(&p).map_err(|e| io_failed("读取素材本体失败", &p, e))
    }

    pub fn read_folders(&self) -> Result<FolderList> {
        let p = self.folders_path();
        let bytes = std::fs::read(&p).map_err(|e| io_failed("读取文件夹清单失败", &p, e))?;
        serde_json::from_slice(&bytes).map_err(|e| {
            AppError::detailed(
                Code::LibraryMetadataCorrupt,
                format!("{FOLDERS_FILE} 无法解析 {}: {e}", p.display()),
            )
        })
    }

    pub fn write_folders(&self, list: &FolderList) -> Result<()> {
        write_json_atomic(&self.folders_path(), list, Code::LibraryIoFailed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("建立临时目录");
        let root = dir.path().join("我的素材库");
        (dir, root)
    }

    #[test]
    fn a_new_library_has_every_documented_directory_and_file() {
        let (_d, root) = fresh();
        Library::create(&root).expect("建库");
        for d in SUBDIRS {
            assert!(root.join(d).is_dir(), "缺少子目录 {d}");
        }
        assert!(root.join(META_FILE).is_file());
        assert!(root.join(FOLDERS_FILE).is_file());
    }

    #[test]
    fn read_body_returns_the_exact_bytes_and_reports_a_missing_file() {
        // 单图预览的原图走这条路径。库内副本是唯一权威副本，因此必须逐字节一致。
        let (_d, root) = fresh();
        let lib = Library::create(&root).expect("建库");
        let content = "假装这是一张图的字节".as_bytes();
        let hash = ContentHash::of_bytes(content);
        let p = lib.body_path(&hash, "png");
        std::fs::create_dir_all(p.parent().expect("叶目录")).expect("建立叶目录");
        std::fs::write(&p, content).expect("写入本体");

        assert_eq!(lib.read_body(&hash, "png").expect("读取本体"), content);

        std::fs::remove_file(&p).expect("删除本体");
        let err = lib.read_body(&hash, "png").expect_err("本体缺失时本应报错");
        assert_eq!(err.code, Code::LibraryIoFailed);
    }

    #[test]
    fn open_or_create_creates_in_an_empty_directory() {
        let (_d, root) = fresh();
        let lib = Library::open_or_create(&root).expect("应创建新库");
        assert!(lib.meta_path().is_file());
    }

    #[test]
    fn open_or_create_opens_an_existing_library_without_overwriting_it() {
        let (_d, root) = fresh();
        let created = Library::create(&root).expect("建库");
        let mut list = FolderList::default();
        list.folders.push("参考".to_owned());
        created.write_folders(&list).expect("写入文件夹清单");

        let reopened = Library::open_or_create(&root).expect("应打开既有库");
        assert_eq!(reopened.meta(), created.meta(), "既有库级元数据被覆盖了");
        assert_eq!(
            reopened.read_folders().expect("读取文件夹清单").folders,
            vec!["参考".to_owned()],
            "既有文件夹清单被覆盖了"
        );
    }

    #[test]
    fn open_or_create_refuses_a_non_empty_non_library_directory() {
        let (_d, root) = fresh();
        std::fs::create_dir_all(&root).expect("建立目录");
        std::fs::write(root.join("别人的文件.txt"), b"x").expect("写入无关文件");
        let err = Library::open_or_create(&root).expect_err("本应拒绝非空的非库目录");
        assert_eq!(err.code, Code::LibraryDirectoryNotEmpty);
        assert!(!root.join(META_FILE).exists(), "拒绝后不应写入任何库骨架");
    }

    #[test]
    fn open_or_create_reports_corruption_rather_than_rebuilding() {
        let (_d, root) = fresh();
        Library::create(&root).expect("建库");
        std::fs::write(root.join(META_FILE), "{ 坏了".as_bytes()).expect("破坏库级元数据");
        let err = Library::open_or_create(&root).expect_err("本应报告损坏");
        assert_eq!(err.code, Code::LibraryMetadataCorrupt);
    }

    #[test]
    fn open_refuses_a_path_that_does_not_exist() {
        // 启动恢复走的是 open。这条锁死"记录的路径消失时不会悄悄建一个新库"。
        let (_d, root) = fresh();
        let err = Library::open(&root).expect_err("不存在的路径本应报错");
        assert_eq!(err.code, Code::LibraryNotFound);
        assert!(!root.exists(), "失败不应创建任何目录");
    }

    #[test]
    fn create_then_open_preserves_the_metadata() {
        let (_d, root) = fresh();
        let created = Library::create(&root).expect("建库");
        let opened = Library::open(&root).expect("打开库");
        assert_eq!(created.meta(), opened.meta());
        assert_eq!(opened.meta().hash_algo, HASH_ALGO_ID);
        assert_eq!(opened.meta().format_version, LIBRARY_FORMAT_VERSION);
    }

    #[test]
    fn an_existing_empty_directory_is_acceptable() {
        let (_d, root) = fresh();
        std::fs::create_dir_all(&root).expect("预建空目录");
        Library::create(&root).expect("在空目录建库");
    }

    #[test]
    fn a_non_empty_directory_is_refused() {
        // 若接受非空目录，索引重建会去扫描原本不属于库的文件。
        let (_d, root) = fresh();
        std::fs::create_dir_all(&root).expect("预建目录");
        std::fs::write(root.join("已有文件.txt"), b"x").expect("放入既有文件");
        let err = Library::create(&root).expect_err("本应拒绝非空目录");
        assert_eq!(err.code, Code::LibraryDirectoryNotEmpty);
    }

    #[test]
    fn opening_a_directory_without_metadata_reports_not_found() {
        let (_d, root) = fresh();
        std::fs::create_dir_all(&root).expect("建目录");
        let err = Library::open(&root).expect_err("本应报告不是库");
        assert_eq!(err.code, Code::LibraryNotFound);
    }

    #[test]
    fn unparseable_metadata_reports_corruption() {
        let (_d, root) = fresh();
        Library::create(&root).expect("建库");
        std::fs::write(root.join(META_FILE), "{ 坏了".as_bytes()).expect("写入损坏元数据");
        let err = Library::open(&root).expect_err("本应报告损坏");
        assert_eq!(err.code, Code::LibraryMetadataCorrupt);
    }

    #[test]
    fn a_newer_library_format_is_refused_instead_of_guessed() {
        let (_d, root) = fresh();
        let lib = Library::create(&root).expect("建库");
        let mut meta = lib.meta().clone();
        meta.format_version = LIBRARY_FORMAT_VERSION + 1;
        write_json_atomic(&root.join(META_FILE), &meta, Code::LibraryIoFailed).expect("改写元数据");
        let err = Library::open(&root).expect_err("本应拒绝更高版本");
        assert_eq!(err.code, Code::LibraryFormatTooNew);
    }

    #[test]
    fn an_unknown_hash_algorithm_is_refused() {
        // 哈希算法决定库内全部路径。猜错的后果是所有素材都找不到，
        // 而报错的后果只是打不开——后者明显更好。
        let (_d, root) = fresh();
        let lib = Library::create(&root).expect("建库");
        let mut meta = lib.meta().clone();
        meta.hash_algo = "blake3".to_owned();
        write_json_atomic(&root.join(META_FILE), &meta, Code::LibraryIoFailed).expect("改写元数据");
        let err = Library::open(&root).expect_err("本应拒绝未知算法");
        assert_eq!(err.code, Code::LibraryFormatTooNew);
    }

    #[test]
    fn opening_recreates_a_missing_subdirectory() {
        let (_d, root) = fresh();
        Library::create(&root).expect("建库");
        std::fs::remove_dir(root.join(THUMBNAILS_DIR)).expect("删掉缩略图目录");
        let lib = Library::open(&root).expect("仍应能打开");
        assert!(lib.thumbnails_dir().is_dir(), "缺失的空目录未被补齐");
    }

    #[test]
    fn body_and_sidecar_share_a_leaf_directory_under_objects() {
        let (_d, root) = fresh();
        let lib = Library::create(&root).expect("建库");
        let h = ContentHash::of_bytes(b"abc");
        let body = lib.body_path(&h, "png");
        let side = lib.sidecar_path(&h);
        assert_eq!(body.parent(), side.parent());
        assert!(body.starts_with(lib.objects_dir()));
    }

    #[test]
    fn thumbnails_live_in_their_own_tree() {
        // 设计第四条：缩略图与权威本体分树，使重建缩略图不会写进 objects/。
        let (_d, root) = fresh();
        let lib = Library::create(&root).expect("建库");
        let h = ContentHash::of_bytes(b"abc");
        let thumb = lib.thumbnail_path(&h);
        assert!(thumb.starts_with(lib.thumbnails_dir()));
        assert!(!thumb.starts_with(lib.objects_dir()));
        assert_eq!(thumb.extension().and_then(|e| e.to_str()), Some("webp"));
        // fanout 与 objects 一致，便于同一套路径推导。
        assert_eq!(
            thumb.parent().unwrap().strip_prefix(lib.thumbnails_dir()),
            lib.body_path(&h, "png")
                .parent()
                .unwrap()
                .strip_prefix(lib.objects_dir())
        );
    }

    #[test]
    fn trash_is_a_separate_tree_from_objects() {
        let (_d, root) = fresh();
        let lib = Library::create(&root).expect("建库");
        let h = ContentHash::of_bytes(b"abc");
        assert!(lib.trash_body_path(&h, "png").starts_with(lib.trash_dir()));
        assert!(!lib.trash_body_path(&h, "png").starts_with(lib.objects_dir()));
        assert_eq!(
            lib.trash_body_path(&h, "png").parent(),
            lib.trash_sidecar_path(&h).parent()
        );
    }

    #[test]
    fn the_folder_list_starts_empty_and_round_trips() {
        let (_d, root) = fresh();
        let lib = Library::create(&root).expect("建库");
        assert!(lib.read_folders().expect("读取清单").folders.is_empty());
        let list = FolderList {
            format_version: LIBRARY_FORMAT_VERSION,
            folders: vec!["参考/构图".to_owned(), "配色".to_owned()],
        };
        lib.write_folders(&list).expect("写入清单");
        assert_eq!(lib.read_folders().expect("读回清单"), list);
    }

    #[test]
    fn writing_the_folder_list_leaves_no_temp_file() {
        let (_d, root) = fresh();
        let lib = Library::create(&root).expect("建库");
        lib.write_folders(&FolderList::default()).expect("写入清单");
        let leftovers: Vec<_> = std::fs::read_dir(&root)
            .expect("读取库根")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "残留临时文件：{leftovers:?}");
    }
}
