//! 导入管线。
//!
//! 导入的核心不变式：**单个素材要么完整入库，要么在库内不留任何痕迹**。因此写入
//! 顺序固定为 本体 → 缩略图 → 侧车，且每一步都记录"这个路径在我动手之前是否已
//! 存在"，回滚时只删除自己创建的东西。
//!
//! 侧车最后写入不是随意排的：索引重建以扫描 `objects/**/*.json` 为入口，所以侧车
//! 的存在即等于"这个素材已入库"。中途崩溃留下的孤儿本体对索引不可见，也因此库内
//! 查重必须以侧车为准而不是以本体为准。
//!
//! 本次全部串行执行（设计第五条）。并行化只会替换执行器，不改变本文件的任何契约。

use crate::colorcard;
use crate::error::{AppError, Code, Result};
use crate::hashing::ContentHash;
use crate::library::Library;
use crate::media;
use crate::sidecar::{
    normalize_folder_path, AssetSidecar, AssetSource, DisplayFilename, SIDECAR_FORMAT_VERSION_V3,
};
use chrono::{DateTime, Utc};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex};

/// 导入时施加在每个素材上的归属信息。
///
/// 库格式 v3 起素材只属于零个或一个文件夹：`folder` 为 `None` 即导入到"未分类"。
#[derive(Debug, Clone, Default)]
pub struct ImportOptions {
    pub folder: Option<String>,
    pub tags: Vec<String>,
}

/// 导入的阶段。仅用于故障注入点的标识。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportStage {
    Hashed,
    BodyWritten,
    ThumbnailWritten,
    SidecarWritten,
}

/// 导入过程的可观察点。
///
/// `after_stage` 是刻意留出的故障注入接缝。回滚不变式无法用真实故障复现——磁盘不会
/// 按需在第三步失败——所以要么留一个注入点并真的测它，要么这条不变式永远只是注释。
/// 生产环境由 Tauri 命令层实现进度 Channel，核心 crate 的无界面调用可使用
/// [`NoopObserver`]，测试实现在本文件的测试模块里；接缝存在多个真实实现。
pub trait ImportObserver {
    fn should_cancel(&self) -> bool {
        false
    }

    /// 报告进度。`current_filename` 是当前即将处理的素材名（内存来源没有路径，
    /// 只有名字），全部结束时为空串。
    fn on_progress(&mut self, done: usize, total: usize, current_filename: &str) {
        let _ = (done, total, current_filename);
    }

    fn after_stage(&mut self, stage: ImportStage) -> Result<()> {
        let _ = stage;
        Ok(())
    }
}

/// 什么都不做的观察者。
pub struct NoopObserver;
impl ImportObserver for NoopObserver {}

/// 一个素材的导入失败。
#[derive(Debug, Clone, Serialize)]
pub struct ImportFailure {
    pub source_path: String,
    pub original_filename: String,
    pub error: AppError,
}

/// 一次导入的结果。部分成功是常态，因此这不是 `Result`。
#[derive(Debug, Clone, Serialize)]
pub struct ImportReport {
    pub imported: Vec<AssetSidecar>,
    pub failed: Vec<ImportFailure>,
}

impl ImportReport {
    pub fn total(&self) -> usize {
        self.imported.len() + self.failed.len()
    }
}

/// 把写入失败的底层错误分类。
///
/// 刻意不做写入前的剩余空间预检：预检与写入之间空间仍可能被占满，所以权威信号只能是
/// 写入本身的失败。
fn classify_write_error(e: &std::io::Error) -> Code {
    match e.raw_os_error() {
        // Windows: ERROR_HANDLE_DISK_FULL 与 ERROR_DISK_FULL。
        Some(39) | Some(112) => Code::ImportInsufficientSpace,
        // POSIX 的 ENOSPC。必须限定平台：Windows 上 28 是 ERROR_OUT_OF_PAPER。
        Some(28) if cfg!(unix) => Code::ImportInsufficientSpace,
        _ => Code::ImportCopyFailed,
    }
}

/// 记录导入过程中创建了哪些文件，供失败时精确回滚。
struct Created {
    paths: Vec<PathBuf>,
}

impl Created {
    fn new() -> Self {
        Self { paths: Vec::new() }
    }

    /// 登记一个即将写入的路径。已存在的路径不登记——回滚不应删除不是自己创建的东西。
    fn claim(&mut self, path: &Path) {
        if !path.exists() {
            self.paths.push(path.to_path_buf());
        }
    }

    /// 回滚。只删文件不删目录：空的 fanout 叶目录不携带任何素材状态，而删除它会与
    /// 落在同一叶目录的其他导入相互干扰。
    fn rollback(&self) {
        for p in self.paths.iter().rev() {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// 把源文件复制到目标路径。先写同目录临时文件再改名，避免留下被截断的本体。
fn copy_into(source: &Path, target: &Path) -> Result<()> {
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            AppError::detailed(
                classify_write_error(&e),
                format!("建立目标目录失败 {}: {e}", parent.display()),
            )
        })?;
    }
    let tmp = target.with_extension("part");
    std::fs::copy(source, &tmp).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        AppError::detailed(
            classify_write_error(&e),
            format!("复制到 {} 失败: {e}", tmp.display()),
        )
    })?;
    std::fs::rename(&tmp, target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        AppError::detailed(
            classify_write_error(&e),
            format!("提交本体失败 {}: {e}", target.display()),
        )
    })
}

fn write_bytes(target: &Path, bytes: &[u8], on_fail: Code) -> Result<()> {
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            AppError::detailed(on_fail, format!("建立目录失败 {}: {e}", parent.display()))
        })?;
    }
    let tmp = target.with_extension("part");
    std::fs::write(&tmp, bytes).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        AppError::detailed(on_fail, format!("写入失败 {}: {e}", tmp.display()))
    })?;
    std::fs::rename(&tmp, target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        AppError::detailed(on_fail, format!("提交失败 {}: {e}", target.display()))
    })
}

/// 导入单个文件。失败时库内状态与调用前完全一致。
pub fn import_one(
    lib: &Library,
    source: &Path,
    opts: &ImportOptions,
    observer: &mut dyn ImportObserver,
) -> Result<AssetSidecar> {
    let mut created = Created::new();
    match import_one_inner(lib, source, opts, observer, &mut created) {
        Ok(s) => Ok(s),
        Err(e) => {
            created.rollback();
            Err(e)
        }
    }
}

fn import_one_inner(
    lib: &Library,
    source: &Path,
    opts: &ImportOptions,
    observer: &mut dyn ImportObserver,
    created: &mut Created,
) -> Result<AssetSidecar> {
    if observer.should_cancel() {
        return Err(AppError::new(Code::ImportCancelled));
    }

    let (byte_size, hash) = probe_source(source, observer)?;

    // 查重以侧车为准而不是以本体为准：孤儿本体是中途失败的残留，不代表素材已入库。
    if lib.sidecar_path(&hash).is_file() {
        return Err(AppError::detailed(
            Code::ImportDuplicateInLibrary,
            format!("库内已有相同内容：{hash}"),
        ));
    }
    if lib.trash_sidecar_path(&hash).is_file() {
        return Err(AppError::detailed(
            Code::ImportDuplicateInTrash,
            format!("回收站中已有相同内容：{hash}"),
        ));
    }

    let folder = opts
        .folder
        .as_deref()
        .map(normalize_folder_path)
        .transpose()?;
    materialize_import(
        lib,
        SourceData::Disk(source),
        byte_size,
        &hash,
        folder,
        &opts.tags,
        observer,
        created,
    )
}

/// 读取源文件元数据并计算内容哈希。这是每条导入管线的公共前半程。
fn probe_source(source: &Path, observer: &mut dyn ImportObserver) -> Result<(u64, ContentHash)> {
    let meta = std::fs::metadata(source).map_err(|e| {
        AppError::detailed(
            Code::ImportSourceUnreadable,
            format!("{}: {e}", source.display()),
        )
    })?;
    if !meta.is_file() {
        return Err(AppError::detailed(
            Code::ImportSourceUnreadable,
            format!("不是文件：{}", source.display()),
        ));
    }
    let byte_size = meta.len();
    let hash = ContentHash::of_file(source)?;
    observer.after_stage(ImportStage::Hashed)?;
    Ok((byte_size, hash))
}

/// 把已确认非重复的源文件写入库：本体 → 缩略图 → 侧车。
///
/// 从 [`import_one_inner`] 中拆出，使统一协调器（[`import_sources`]）能复用同一条写入
/// 管线，只把"查重命中"的处理从报错换成记录——两种入口的落盘步骤与回滚不变式必须
/// 完全一致，否则两条路径会慢慢分叉。
/// 物化阶段的载荷来源：磁盘文件或内存 PNG 字节（剪贴板位图，设计第十一条）。
///
/// 落盘步骤与回滚不变式对两者完全一致；分派点只有"读什么来解码"与"本体怎么写"。
/// 这正是设计第十条"四个入口不得各自维护导入语义"在实现层的落点。
#[derive(Debug, Clone, Copy)]
enum SourceData<'a> {
    Disk(&'a Path),
    MemoryPng {
        bytes: &'a [u8],
        filename: &'a str,
        captured_at: DateTime<Utc>,
    },
}

/// 把已确认非重复的素材写入库：本体 → 缩略图 → 侧车。
///
/// 从 [`import_one_inner`] 中拆出，使统一协调器（[`import_sources`]）能复用同一条写入
/// 管线，只把"查重命中"的处理从报错换成记录——两种入口的落盘步骤与回滚不变式必须
/// 完全一致，否则两条路径会慢慢分叉。
#[allow(clippy::too_many_arguments)]
fn materialize_import(
    lib: &Library,
    source: SourceData<'_>,
    byte_size: u64,
    hash: &ContentHash,
    folder: Option<String>,
    tags: &[String],
    observer: &mut dyn ImportObserver,
    created: &mut Created,
) -> Result<AssetSidecar> {
    // 来源身份与解码按载荷类型分派；从这里开始两种载荷走完全相同的写入序列。
    let (decoded, display_stem, asset_source) = match source {
        SourceData::Disk(path) => {
            let decoded = media::decode(path)?;
            let filename = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let display_stem = std::path::Path::new(&filename)
                .file_stem()
                .map(|stem| stem.to_string_lossy().into_owned())
                .unwrap_or_else(|| filename.clone());
            (
                decoded,
                display_stem,
                AssetSource::Filesystem {
                    path: Some(path.to_string_lossy().into_owned()),
                    filename,
                },
            )
        }
        SourceData::MemoryPng {
            bytes,
            filename,
            captured_at,
        } => {
            // 位图已在 Rust 侧编码为 PNG：解码只走文件头判定，没有扩展名可查。
            let decoded = media::decode_bytes(bytes)?;
            let display_stem = std::path::Path::new(filename)
                .file_stem()
                .map(|stem| stem.to_string_lossy().into_owned())
                .unwrap_or_else(|| filename.to_owned());
            (
                decoded,
                display_stem,
                AssetSource::Clipboard {
                    captured_at,
                    filename: filename.to_owned(),
                },
            )
        }
    };
    let ext = decoded.media_type.library_ext();

    let body = lib.body_path(hash, ext);
    created.claim(&body);
    // 写本体是唯一区分读写方式的步骤：磁盘文件流式复制，内存字节整块落盘。
    match source {
        SourceData::Disk(path) => copy_into(path, &body)?,
        SourceData::MemoryPng { bytes, .. } => write_bytes(&body, bytes, Code::ImportCopyFailed)?,
    }
    observer.after_stage(ImportStage::BodyWritten)?;

    // 缩略图失败按素材失败处理并回滚。它虽是可重算的派生数据，但编码失败几乎总是
    // 真问题（空间不足或图本身异常），静默放过只会得到一批在网格里看不见的素材。
    let thumb_bytes = media::encode_thumbnail(&decoded.image)?;
    let thumb = lib.thumbnail_path(hash);
    created.claim(&thumb);
    write_bytes(&thumb, &thumb_bytes, Code::LibraryThumbnailFailed)?;
    observer.after_stage(ImportStage::ThumbnailWritten)?;

    // 色卡失败不影响入库：失败原因记录在色卡自身里。
    let color_card = colorcard::analyze(&decoded.image);

    // v3 侧车：来源身份不可变，显示名初始化为来源名主体，归属是唯一文件夹或未分类。
    // 名称主体非法时导入失败——真实扩展名与合法名称属于入库条件，而不是事后修复项。
    let display_filename = DisplayFilename::new(&display_stem, decoded.media_type)?;

    let sidecar = AssetSidecar {
        format_version: SIDECAR_FORMAT_VERSION_V3,
        hash: hash.clone(),
        hash_algo: lib.meta().hash_algo.clone(),
        media_type: decoded.media_type,
        ext: ext.to_owned(),
        byte_size,
        width: decoded.width(),
        height: decoded.height(),
        imported_at: Utc::now(),
        source: asset_source,
        display_filename,
        folder,
        tags: tags.to_vec(),
        color_card,
        // 新入库的素材既没有备注也未被收藏。这两个字段刻意没有 serde 默认值（见
        // `sidecar.rs`），因此必须在这里显式写出，不能靠反序列化时补齐。
        note: String::new(),
        favorite: false,
        deleted_at: None,
        deleted_from_folder: None,
    };

    let side = lib.sidecar_path(hash);
    created.claim(&side);
    sidecar.write_atomic(&side)?;
    observer.after_stage(ImportStage::SidecarWritten)?;

    Ok(sidecar)
}

/// 缩略图编码格式的版本。
///
/// 编码器、质量参数与长边任一改动都必须提升它。1 是最初的无损 WebP，2 起为有损。
///
/// 没有这个版本号会怎样：换了编码参数之后，既有缩略图文件仍然存在，于是
/// [`ensure_thumbnail`] 认为它们没缺失而直接读回旧格式的字节。同一个库里混着两代
/// 缩略图，且这件事不会有任何报错——这正是设计第四条"调整该值的代价是一次全库重建"
/// 那句话得以成立的机制。
pub const THUMBNAIL_FORMAT_VERSION: u32 = 2;

/// 缩略图树内记录格式版本的标记文件名。
const THUMBNAIL_FORMAT_MARKER: &str = ".format";

/// 校验缩略图树的格式版本，不匹配即清空整棵树。
///
/// 打开库时调用一次。清空是安全的：缩略图是派生数据，清空只会触发按需重算，
/// 而规格明确写了"缩略图全部缺失必须触发重新生成，禁止被报告为库损坏"。
///
/// 标记文件缺失视为版本未知，同样清空——旧版本的库没有这个文件。
pub fn ensure_thumbnail_format(lib: &Library) -> Result<()> {
    let tree = lib.thumbnails_dir();
    let marker = tree.join(THUMBNAIL_FORMAT_MARKER);
    let recorded: Option<u32> = std::fs::read_to_string(&marker)
        .ok()
        .and_then(|s| s.trim().parse().ok());
    if recorded == Some(THUMBNAIL_FORMAT_VERSION) {
        return Ok(());
    }

    let io_fail = |what: &str, path: &Path, e: std::io::Error| {
        AppError::detailed(
            Code::LibraryThumbnailFailed,
            format!("{what} {}: {e}", path.display()),
        )
    };
    if tree.exists() {
        std::fs::remove_dir_all(&tree).map_err(|e| io_fail("清空缩略图树失败", &tree, e))?;
    }
    std::fs::create_dir_all(&tree).map_err(|e| io_fail("重建缩略图目录失败", &tree, e))?;
    std::fs::write(&marker, THUMBNAIL_FORMAT_VERSION.to_string())
        .map_err(|e| io_fail("写入缩略图格式标记失败", &marker, e))?;
    Ok(())
}

/// 展开拖入的路径的结果。
#[derive(Debug, Clone, Serialize)]
pub struct Expanded {
    /// 待导入的源文件，按路径排序，已去重。
    pub sources: Vec<PathBuf>,
    /// 目录中被跳过的非图片文件数。
    ///
    /// 计数而不是逐条报错：拖入一个目录时，使用者选择的是"这个目录里的图片"，目录里的
    /// 说明文档与工程文件从来不是候选素材，逐条报错只会把真正的失败埋掉。但也不能一声
    /// 不出，否则"这个目录里还有 3 个文件没进来"就无从得知。
    pub skipped_non_images: usize,
}

/// 展开拖入或选中的路径。
///
/// **目录与文件的处理刻意不同。**目录递归展开为其中扩展名受支持的图片；直接给出的文件
/// 原样保留，即便扩展名不受支持——那是使用者明确指定的一个素材，必须让它走到
/// `import.unsupported_media_type` 而不是被悄悄丢掉。
pub fn expand_sources(paths: &[PathBuf]) -> Result<Expanded> {
    let mut sources: Vec<PathBuf> = Vec::new();
    let mut skipped = 0usize;
    for p in paths {
        let meta = std::fs::metadata(p).map_err(|e| {
            AppError::detailed(
                Code::ImportSourceUnreadable,
                format!("{}: {e}", p.display()),
            )
        })?;
        if meta.is_dir() {
            collect_images(p, &mut sources, &mut skipped)?;
        } else {
            sources.push(p.clone());
        }
    }
    sources.sort();
    sources.dedup();
    Ok(Expanded {
        sources,
        skipped_non_images: skipped,
    })
}

fn collect_images(dir: &Path, out: &mut Vec<PathBuf>, skipped: &mut usize) -> Result<()> {
    let entries = std::fs::read_dir(dir).map_err(|e| {
        AppError::detailed(
            Code::ImportSourceUnreadable,
            format!("读取目录失败 {}: {e}", dir.display()),
        )
    })?;
    for entry in entries {
        let entry = entry.map_err(|e| {
            AppError::detailed(
                Code::ImportSourceUnreadable,
                format!("读取目录项失败 {}: {e}", dir.display()),
            )
        })?;
        let path = entry.path();
        let file_type = entry.file_type().map_err(|e| {
            AppError::detailed(
                Code::ImportSourceUnreadable,
                format!("读取目录项类型失败 {}: {e}", path.display()),
            )
        })?;
        if file_type.is_dir() {
            collect_images(&path, out, skipped)?;
        } else {
            let supported = path
                .extension()
                .and_then(|e| e.to_str())
                .and_then(media::MediaType::from_extension)
                .is_some();
            if supported {
                out.push(path);
            } else {
                *skipped += 1;
            }
        }
    }
    Ok(())
}

/// 读取缩略图，缺失时按需重新生成。
///
/// 放在 `import` 而不是 `media`：生成缩略图既要知道库布局又要解码，而 `media` 刻意不接触
/// 文件系统。放这里还有一个好处——缩略图的生成口径只有一处，导入路径与重生成路径不会
/// 各写一份而慢慢分叉。
///
/// 缺失即重算，不用占位图代替：规格明确禁止"以占位图代替而不重建"。缩略图全部被删掉
/// 也只是触发重算，不构成库损坏。
pub fn ensure_thumbnail(lib: &Library, hash: &ContentHash, ext: &str) -> Result<Vec<u8>> {
    let thumb = lib.thumbnail_path(hash);
    if thumb.is_file() {
        return std::fs::read(&thumb).map_err(|e| {
            AppError::detailed(
                Code::LibraryThumbnailFailed,
                format!("读取缩略图失败 {}: {e}", thumb.display()),
            )
        });
    }
    let body = lib.body_path(hash, ext);
    // 解码与编码失败统一归到 library.thumbnail_failed：底层给出的是 import.* 码，
    // 而这里并不是一次导入，原样透出会让使用者以为导入出了问题。原始码进 detail，
    // 诊断信息不丢。
    let wrap = |e: AppError| {
        AppError::detailed(
            Code::LibraryThumbnailFailed,
            format!("重新生成缩略图失败 {}: {e}", body.display()),
        )
    };
    let decoded = media::decode(&body).map_err(wrap)?;
    let bytes = media::encode_thumbnail(&decoded.image).map_err(wrap)?;
    write_bytes(&thumb, &bytes, Code::LibraryThumbnailFailed)?;
    Ok(bytes)
}

/// 批量导入。逐个处理，一个失败不影响其余。
///
/// 取消后剩余的源仍会各自记为一条 `import.cancelled` 失败：报告必须覆盖全部输入，
/// 否则界面无法说明"这次选了 20 个，结果只提到 7 个"。
pub fn import_many(
    lib: &Library,
    sources: &[PathBuf],
    opts: &ImportOptions,
    observer: &mut dyn ImportObserver,
) -> ImportReport {
    let total = sources.len();
    let mut report = ImportReport {
        imported: Vec::new(),
        failed: Vec::new(),
    };
    let mut cancelled = false;

    for (i, source) in sources.iter().enumerate() {
        if cancelled || observer.should_cancel() {
            cancelled = true;
            report.failed.push(failure(source, AppError::new(Code::ImportCancelled)));
            continue;
        }
        let name = source
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        observer.on_progress(i, total, &name);
        match import_one(lib, source, opts, observer) {
            Ok(s) => report.imported.push(s),
            Err(e) => {
                if e.code == Code::ImportCancelled {
                    cancelled = true;
                }
                report.failed.push(failure(source, e));
            }
        }
    }
    observer.on_progress(total, total, "");
    report
}

fn failure(source: &Path, error: AppError) -> ImportFailure {
    ImportFailure {
        source_path: source.to_string_lossy().into_owned(),
        original_filename: source
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        error,
    }
}

/// 统一导入的入站来源（设计第十条）。
///
/// 文件选择、目录选择、拖放与剪贴板只负责产生来源；查重、目标解析、层级映射与
/// 逐项报告全部由 [`import_sources`] 一处裁决——四个入口不允许各自维护一套导入语义。
#[derive(Debug, Clone)]
pub enum ImportSource {
    /// 使用者明确指定的单个文件。即便扩展名不受支持也原样送达，让它以
    /// `import.unsupported_media_type` 失败而不是被悄悄丢掉。
    File(PathBuf),
    /// 使用者指定的目录：以目录名为逻辑根，内部相对层级映射为嵌套逻辑文件夹。
    Directory(PathBuf),
    /// 剪贴板位图经 Rust 侧编码的 PNG 字节（设计第十一条）。没有文件系统来源：
    /// 来源身份记为 [`crate::sidecar::AssetSource::Clipboard`]，显示名由调用方
    /// 按 [`crate::clipboard::clipboard_image_display_name`] 生成本地时间名，
    /// 在当前导入内天然唯一。
    PngBytes {
        bytes: Vec<u8>,
        filename: String,
        captured_at: DateTime<Utc>,
    },
}

/// 把资源管理器粘贴得到的路径分类为导入来源（设计第十一条）。
///
/// 剪贴板里的文件与目录不另起一套粘贴语义：按磁盘事实分类成 [`ImportSource`]，
/// 与文件/目录选择入口产生完全相同的来源集合。目录保持为 Directory 来源，让
/// 协调器保留所选目录名与相对层级；分类只做存在性判断，消失的路径按 File 来源
/// 原样送达，由导入阶段以 `import.source_unreadable` 失败呈现。
pub fn classify_paths(paths: Vec<PathBuf>) -> Vec<ImportSource> {
    paths
        .into_iter()
        .map(|p| {
            if p.is_dir() {
                ImportSource::Directory(p)
            } else {
                ImportSource::File(p)
            }
        })
        .collect()
}

/// 统一导入协调器的请求。
#[derive(Debug, Clone)]
pub struct ImportRequest {
    pub sources: Vec<ImportSource>,
    /// 工作区当前所在的具体逻辑文件夹；当前在全部、未分类或回收站时为 `None`，
    /// 此时导入目标一律是未分类。
    pub current_folder: Option<String>,
}

/// 内容重复的来源：库内（或回收站）已有相同内容。
///
/// 重复既不是失败也不是新导入：既有素材保持原归属、不被静默移动（asset-transfer
/// 规格），但也不能一声不吭——报告单独列出，界面才有"这几张已经在库里了"可说。
#[derive(Debug, Clone, Serialize)]
pub struct ImportDuplicate {
    pub source_path: String,
    pub original_filename: String,
    pub hash: String,
    /// 重复对象位于回收站而不是库内。
    pub in_trash: bool,
}

/// 单个计划文件的处置结果。
enum PlannedOutcome {
    /// 装箱侧车：两个变体尺寸悬殊，重复记录远小于完整侧车。
    Imported(Box<AssetSidecar>),
    Duplicate(ImportDuplicate),
}

/// 统一协调器的完成报告。
///
/// 四个桶互相独立、数量齐全（asset-transfer 停止规格）：已成功看
/// [`Self::imported`]，重复或跳过看 [`Self::duplicates`] 加 [`Self::skipped_non_images`]，
/// 失败看 [`Self::failed`]，尚未处理看 [`Self::pending_count`]——未处理的项既不算
/// 失败也不算重复，界面才能如实说明"停在这里，还剩多少没动"。
#[derive(Debug, Clone, Serialize)]
pub struct SourceImportReport {
    pub imported: Vec<AssetSidecar>,
    pub duplicates: Vec<ImportDuplicate>,
    pub failed: Vec<ImportFailure>,
    /// 目录来源中因不是图片而被跳过的文件数。
    pub skipped_non_images: usize,
    /// 观察到停止后尚未处理（或被完整回滚）的计划内文件数。
    pub pending_count: usize,
}

/// 长任务的唯一标识（设计第十条）。
///
/// UUIDv7 字面值：任务中心按创建时间展示，时间可排序让"按 ID 排"与"按开始时间排"
/// 是同一个顺序。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ImportTaskId(String);

impl ImportTaskId {
    fn generate() -> Self {
        Self(crate::ids::generate_canonical_uuid_v7())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for ImportTaskId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// 导入运行的可见状态。
///
/// `stopped` 只能由协调器确认返回时进入：前端仅停止等待 MUST NOT 冒充任务已停止
/// （asset-transfer 规格），调用方提前宣布同样算冒充。`stopping` 表示停止命令已被
/// 接受但协调器还没在安全边界退出。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportRunState {
    Running,
    Stopping,
    Stopped,
}

impl ImportRunState {
    fn from_u8(value: u8) -> Self {
        match value {
            1 => Self::Stopping,
            2 => Self::Stopped,
            _ => Self::Running,
        }
    }
}

/// 一次统一导入的运行句柄：任务身份、库级槽位与停止信号的载体（设计第十条）。
///
/// 停止是协作式的：[`ImportRun::request_stop`] 只把状态推进到 stopping，真正的
/// 退出由 [`import_sources`] 在扫描循环与单素材事务边界轮询观察；协调器确认返回时
/// 才进入 stopped。
#[derive(Debug)]
pub struct ImportRun {
    id: ImportTaskId,
    concurrency_key: String,
    state: AtomicU8,
}

impl ImportRun {
    pub fn id(&self) -> &ImportTaskId {
        &self.id
    }

    pub fn concurrency_key(&self) -> &str {
        &self.concurrency_key
    }

    pub fn state(&self) -> ImportRunState {
        ImportRunState::from_u8(self.state.load(Ordering::SeqCst))
    }

    /// 提交停止请求。幂等；对已经确认结束的任务无效果。
    pub fn request_stop(&self) {
        // 只从 Running 推进：已确认结束的任务不得被拉回 stopping。
        let _ = self.state.compare_exchange(
            ImportRunState::Running as u8,
            ImportRunState::Stopping as u8,
            Ordering::SeqCst,
            Ordering::SeqCst,
        );
    }

    /// 停止信号是否已提交。crate 内的协调器（导入与导出）在单文件边界观察。
    pub(crate) fn should_cancel(&self) -> bool {
        self.state() != ImportRunState::Running
    }

    pub(crate) fn confirm_stopped(&self) {
        self.state.store(ImportRunState::Stopped as u8, Ordering::SeqCst);
    }
}

/// 库级导入运行注册表：同一时刻一座库最多一个进行中的导入（设计第十条）。
///
/// 生产环境由 Tauri 应用状态持有一份；停止命令经 [`ImportRuns::lookup`] 按并发键
/// 定位运行中的任务提交停止。已确认结束的残留条目在下一次 begin 时被替换，
/// 不需要显式清理。
#[derive(Default)]
pub struct ImportRuns {
    active: Mutex<HashMap<String, Arc<ImportRun>>>,
}

impl ImportRuns {
    pub fn new() -> Self {
        Self {
            active: Mutex::new(HashMap::new()),
        }
    }

    /// 占用该库的导入槽位。已有未结束的任务时报 `import.already_running`。
    pub fn begin(&self, library: &Library) -> Result<Arc<ImportRun>> {
        let key = import_concurrency_key(library);
        let mut active = lock_runs(&self.active);
        if let Some(existing) = active.get(&key) {
            if existing.state() != ImportRunState::Stopped {
                return Err(AppError::detailed(
                    Code::ImportAlreadyRunning,
                    format!("库已有进行中的导入或导出任务：{key}"),
                ));
            }
        }
        let run = Arc::new(ImportRun {
            id: ImportTaskId::generate(),
            concurrency_key: key.clone(),
            state: AtomicU8::new(ImportRunState::Running as u8),
        });
        active.insert(key, run.clone());
        Ok(run)
    }

    /// 按并发键查找任务，供停止命令定位。已确认结束的任务也会被找到；
    /// 是否还能停止由其状态决定。
    pub fn lookup(&self, concurrency_key: &str) -> Option<Arc<ImportRun>> {
        lock_runs(&self.active).get(concurrency_key).cloned()
    }
}

/// 库级导入并发键的字面值（设计第十条）。
///
/// 命令层的停止入口用它从注册表定位运行中的任务——键的字面规则只有这一处，
/// begin 与停止两端才不会各拼各的字符串。
pub fn import_concurrency_key(library: &Library) -> String {
    format!("import@{}", library.root().display())
}

/// 锁中毒只可能来自持锁线程 panic；注册表操作本身不 panic，直接取回内层数据，
/// 不让一次历史 panic 永久堵死导入入口。
fn lock_runs(active: &Mutex<HashMap<String, Arc<ImportRun>>>) -> std::sync::MutexGuard<'_, HashMap<String, Arc<ImportRun>>> {
    active.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// 计划阶段产出的单个待导条目及其已规范化的逻辑归属。
struct PlannedFile {
    item: PlannedItem,
    folder: Option<String>,
}

/// 计划内条目的载荷：磁盘文件或剪贴板位图编码出的内存 PNG。
#[derive(Debug)]
enum PlannedItem {
    Disk(PathBuf),
    MemoryPng {
        bytes: Vec<u8>,
        filename: String,
        captured_at: DateTime<Utc>,
    },
}

impl PlannedItem {
    /// 确定性排序与去重键：磁盘文件按路径，内存载荷按来源名。
    ///
    /// 与旧展开一致的动机：同一批次里同一条目绝不会被处理两次；内存 PNG 的
    /// 内容重复由哈希查重兜底，第二次出现会落入"重复"桶而不是再写一份。
    fn sort_key(&self) -> (u8, String) {
        match self {
            PlannedItem::Disk(path) => (0, path.to_string_lossy().into_owned()),
            PlannedItem::MemoryPng { filename, .. } => (1, filename.clone()),
        }
    }

    /// 进度报告用的素材名（内存来源没有路径，只有名字）。
    fn display_name(&self) -> String {
        match self {
            PlannedItem::Disk(path) => path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            PlannedItem::MemoryPng { filename, .. } => filename.clone(),
        }
    }

    /// 报告里的定位串：磁盘载荷用完整路径，内存载荷用来源名。
    fn locator(&self) -> String {
        match self {
            PlannedItem::Disk(path) => path.to_string_lossy().into_owned(),
            PlannedItem::MemoryPng { filename, .. } => filename.clone(),
        }
    }

    /// 失败报告：内存载荷没有路径可引，来源名同时充当定位信息。
    fn failure(&self, error: AppError) -> ImportFailure {
        ImportFailure {
            source_path: self.locator(),
            original_filename: self.display_name(),
            error,
        }
    }

    /// 物化阶段的载荷视图。
    fn source_data(&self) -> SourceData<'_> {
        match self {
            PlannedItem::Disk(path) => SourceData::Disk(path),
            PlannedItem::MemoryPng {
                bytes,
                filename,
                captured_at,
            } => SourceData::MemoryPng {
                bytes,
                filename,
                captured_at: *captured_at,
            },
        }
    }
}

/// 统一导入入口：文件选择、目录选择、拖放与剪贴板共用的协调器（设计第十条）。
///
/// 目标规则：文件落在当前具体逻辑文件夹；当前是全部、未分类或回收站（`None`）
/// 时落入未分类。目录以所选目录名为逻辑根保留相对层级，并整体挂在当前文件夹
/// 之下（若有）。路径规范化发生在任何写入之前；规范化后相同的逻辑路径合并进
/// 同一文件夹，不创建编号副本也不拒绝整批。内容重复既不复制也不移动既有素材，
/// 作为独立结果呈现在 [`SourceImportReport::duplicates`] 里。
///
/// 停止语义：`run` 是生产通路的停止信号——扫描阶段逐目录项尽快观察，处理阶段
/// 只在单素材事务边界观察；已成功素材保留，当前素材完整成功或完整回滚，后续项
/// 计入 [`SourceImportReport::pending_count`] 而不是失败。协调器返回（无论成败）
/// 即后端确认，任务进入 stopped。
///
/// 部分成功是常态：单个素材失败只影响自己，报告覆盖全部输入。
pub fn import_sources(
    lib: &Library,
    request: &ImportRequest,
    tags: &[String],
    run: &ImportRun,
    observer: &mut dyn ImportObserver,
) -> Result<SourceImportReport> {
    let result = import_sources_inner(lib, request, tags, run, observer);
    // 无论正常结束还是整体出错（例如目标文件夹非法），协调器返回即后端确认：
    // 槽位必须释放，状态不得永远悬在 running/stopping。
    run.confirm_stopped();
    result
}

fn import_sources_inner(
    lib: &Library,
    request: &ImportRequest,
    tags: &[String],
    run: &ImportRun,
    observer: &mut dyn ImportObserver,
) -> Result<SourceImportReport> {
    let base = request
        .current_folder
        .as_deref()
        .map(normalize_folder_path)
        .transpose()?;

    let (planned, skipped_non_images, failed) = plan_sources(&request.sources, &base, run)?;

    // 扫描阶段观察到停止：不建文件夹、不写任何素材。已发现的计划内文件全部计为
    // 未处理——它们确实一个都没被碰过。
    if run.should_cancel() {
        return Ok(SourceImportReport {
            imported: Vec::new(),
            duplicates: Vec::new(),
            failed,
            skipped_non_images,
            pending_count: planned.len(),
        });
    }

    ensure_folders(lib, planned.iter().filter_map(|p| p.folder.as_deref()))?;

    let total = planned.len();
    let mut report = SourceImportReport {
        imported: Vec::new(),
        duplicates: Vec::new(),
        failed,
        skipped_non_images,
        pending_count: 0,
    };
    let mut stopping = false;

    for (i, file) in planned.iter().enumerate() {
        if stopping || run.should_cancel() || observer.should_cancel() {
            stopping = true;
            report.pending_count += 1;
            continue;
        }
        observer.on_progress(i, total, &file.item.display_name());
        match import_planned(lib, file, tags, run, observer) {
            Ok(PlannedOutcome::Imported(sidecar)) => report.imported.push(*sidecar),
            Ok(PlannedOutcome::Duplicate(duplicate)) => report.duplicates.push(duplicate),
            // 素材处理途中观察到取消：materialize 已把本项完整回滚，计未处理
            // 而不是失败——它既没有入库也没有留下痕迹。
            Err(e) if e.code == Code::ImportCancelled => {
                stopping = true;
                report.pending_count += 1;
            }
            Err(e) => report.failed.push(file.item.failure(e)),
        }
    }
    observer.on_progress(total, total, "");
    Ok(report)
}

/// 把来源集合展开为带逻辑归属的计划。目录不可读等计划期问题记入失败列表，
/// 不拖垮其余来源。每个来源之间观察停止请求——扫描必须尽快停下。
fn plan_sources(
    sources: &[ImportSource],
    base: &Option<String>,
    run: &ImportRun,
) -> Result<(Vec<PlannedFile>, usize, Vec<ImportFailure>)> {
    let mut planned = Vec::new();
    let mut skipped = 0usize;
    let mut failed = Vec::new();
    for source in sources {
        if run.should_cancel() {
            break;
        }
        match source {
            ImportSource::File(path) => planned.push(PlannedFile {
                item: PlannedItem::Disk(path.clone()),
                folder: base.clone(),
            }),
            ImportSource::Directory(root) => {
                collect_directory(root, base, run, &mut planned, &mut skipped, &mut failed);
            }
            // 内存 PNG 与磁盘文件同批时排在磁盘之后（真实来源优先）；位图的内容
            // 重复由哈希查重兜底，再次粘贴落入重复桶而不是再写一份。
            ImportSource::PngBytes {
                bytes,
                filename,
                captured_at,
            } => planned.push(PlannedFile {
                item: PlannedItem::MemoryPng {
                    bytes: bytes.clone(),
                    filename: filename.clone(),
                    captured_at: *captured_at,
                },
                folder: base.clone(),
            }),
        }
    }
    // 与旧展开一致的确定性顺序：按排序键排序去重，同一条目不会被处理两次。
    planned.sort_by_key(|file| file.item.sort_key());
    planned.dedup_by(|a, b| a.item.sort_key() == b.item.sort_key());
    Ok((planned, skipped, failed))
}

/// 把一个目录来源展开为带逻辑归属的待导文件。
///
/// 目录名本身是逻辑根的第一段；子目录逐级拼进逻辑路径并在写入前统一规范化。
/// 非图片计入跳过而不是失败（与旧展开同一口径）；目录树中途读不到的部分记为
/// 该处的失败，已看到的文件照常导入。
fn collect_directory(
    root: &Path,
    base: &Option<String>,
    run: &ImportRun,
    planned: &mut Vec<PlannedFile>,
    skipped: &mut usize,
    failed: &mut Vec<ImportFailure>,
) {
    let Some(name) = root.file_name().map(|n| n.to_string_lossy().into_owned()) else {
        failed.push(failure(
            root,
            AppError::detailed(
                Code::ImportSourceUnreadable,
                format!("目录缺少名称：{}", root.display()),
            ),
        ));
        return;
    };
    let prefix = match base {
        Some(base) => format!("{base}/{name}"),
        None => name,
    };
    walk_directory(root, &prefix, run, planned, skipped, failed);
}

fn walk_directory(
    dir: &Path,
    logical_prefix: &str,
    run: &ImportRun,
    planned: &mut Vec<PlannedFile>,
    skipped: &mut usize,
    failed: &mut Vec<ImportFailure>,
) {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) => {
            failed.push(failure(
                dir,
                AppError::detailed(
                    Code::ImportSourceUnreadable,
                    format!("读取目录失败 {}: {e}", dir.display()),
                ),
            ));
            return;
        }
    };
    for entry in entries {
        // 扫描阶段在每个目录项之间观察停止请求（设计第十条"扫描阶段尽快观察"）：
        // 停止即整棵剩余子树都不再展开。
        if run.should_cancel() {
            return;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(e) => {
                failed.push(failure(
                    dir,
                    AppError::detailed(
                        Code::ImportSourceUnreadable,
                        format!("读取目录项失败 {}: {e}", dir.display()),
                    ),
                ));
                continue;
            }
        };
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(e) => {
                failed.push(failure(
                    &path,
                    AppError::detailed(
                        Code::ImportSourceUnreadable,
                        format!("读取目录项类型失败 {}: {e}", path.display()),
                    ),
                ));
                continue;
            }
        };
        if file_type.is_dir() {
            let name = entry.file_name().to_string_lossy().into_owned();
            walk_directory(
                &path,
                &format!("{logical_prefix}/{name}"),
                run,
                planned,
                skipped,
                failed,
            );
            continue;
        }
        let supported = path
            .extension()
            .and_then(|e| e.to_str())
            .and_then(media::MediaType::from_extension)
            .is_some();
        if !supported {
            *skipped += 1;
            continue;
        }
        match normalize_folder_path(logical_prefix) {
            Ok(folder) => planned.push(PlannedFile {
                item: PlannedItem::Disk(path),
                folder: Some(folder),
            }),
            Err(e) => failed.push(failure(&path, e)),
        }
    }
}

/// 确保计划涉及的逻辑文件夹都已存在于清单里。
///
/// 在任何素材写入之前一次性补齐：侧车指向的逻辑路径必须在索引重建读到它之前
/// 已经合法。只追加缺失项且彼此排序，既有清单的顺序保持不动——重排使用者的
/// 文件夹不在导入的职权范围内。
fn ensure_folders<'a>(lib: &Library, wanted: impl Iterator<Item = &'a str>) -> Result<()> {
    let wanted: std::collections::BTreeSet<&str> = wanted.collect();
    let known = lib.read_folders()?;
    let additions: Vec<String> = wanted
        .into_iter()
        .filter(|folder| !known.folders.iter().any(|f| f == folder))
        .map(str::to_owned)
        .collect();
    if additions.is_empty() {
        return Ok(());
    }
    let mut list = known;
    list.folders.extend(additions);
    lib.write_folders(&list)?;
    Ok(())
}

/// 处理单个计划文件。
///
/// 与旧入口唯一的语义差异在两处：查重命中返回 [`PlannedOutcome::Duplicate`] 而不是
/// 报错；停止信号以 `run` 为生产通路、观察者通道保留为测试与注入接缝——落盘步骤、
/// 回滚不变式与取消边界完全一致。
fn import_planned(
    lib: &Library,
    file: &PlannedFile,
    tags: &[String],
    run: &ImportRun,
    observer: &mut dyn ImportObserver,
) -> Result<PlannedOutcome> {
    if run.should_cancel() || observer.should_cancel() {
        return Err(AppError::new(Code::ImportCancelled));
    }
    let mut created = Created::new();
    let (byte_size, hash) = match &file.item {
        PlannedItem::Disk(path) => probe_source(path, observer)?,
        PlannedItem::MemoryPng { bytes, .. } => {
            // 内存载荷没有文件系统元数据：大小即字节数，哈希直接对内容计算。
            let hash = ContentHash::of_bytes(bytes);
            observer.after_stage(ImportStage::Hashed)?;
            (bytes.len() as u64, hash)
        }
    };

    // 查重以侧车为准而不是以本体为准（与 import_one 同一口径）。命中的来源什么
    // 都不写，自然也没有需要回滚的东西。
    let in_library = lib.sidecar_path(&hash).is_file();
    let in_trash = lib.trash_sidecar_path(&hash).is_file();
    if in_library || in_trash {
        return Ok(PlannedOutcome::Duplicate(ImportDuplicate {
            source_path: file.item.locator(),
            original_filename: file.item.display_name(),
            hash: hash.as_str().to_owned(),
            in_trash,
        }));
    }

    match materialize_import(
        lib,
        file.item.source_data(),
        byte_size,
        &hash,
        file.folder.clone(),
        tags,
        observer,
        &mut created,
    ) {
        Ok(sidecar) => Ok(PlannedOutcome::Imported(Box::new(sidecar))),
        Err(e) => {
            created.rollback();
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::MediaType;
    use image::{DynamicImage, ImageFormat, Rgba, RgbaImage};

    /// 在指定阶段之后注入失败的观察者。
    struct FailAt(ImportStage);
    impl ImportObserver for FailAt {
        fn after_stage(&mut self, stage: ImportStage) -> Result<()> {
            if stage == self.0 {
                Err(AppError::detailed(Code::ImportCopyFailed, "注入的故障"))
            } else {
                Ok(())
            }
        }
    }

    /// 处理到第 n 个素材时开始取消。
    struct CancelAfter {
        limit: usize,
        started: usize,
    }
    impl ImportObserver for CancelAfter {
        fn should_cancel(&self) -> bool {
            self.started > self.limit
        }
        fn on_progress(&mut self, _done: usize, _total: usize, _current: &str) {
            self.started += 1;
        }
    }

    /// 记录进度回调的观察者。
    #[derive(Default)]
    struct Recorder {
        calls: Vec<(usize, usize)>,
    }
    impl ImportObserver for Recorder {
        fn on_progress(&mut self, done: usize, total: usize, _current: &str) {
            self.calls.push((done, total));
        }
    }

    fn write_png(dir: &Path, name: &str, w: u32, h: u32, px: [u8; 4]) -> PathBuf {
        let p = dir.join(name);
        DynamicImage::ImageRgba8(RgbaImage::from_pixel(w, h, Rgba(px)))
            .save_with_format(&p, ImageFormat::Png)
            .expect("写入 PNG");
        p
    }

    fn count_files(root: &Path) -> usize {
        let mut n = 0;
        if let Ok(rd) = std::fs::read_dir(root) {
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    n += count_files(&p);
                } else {
                    n += 1;
                }
            }
        }
        n
    }

    struct Fixture {
        _dir: tempfile::TempDir,
        lib: Library,
        src: PathBuf,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().expect("建立临时目录");
        let lib = Library::create(&dir.path().join("库")).expect("建库");
        let src = dir.path().join("来源");
        std::fs::create_dir_all(&src).expect("建立来源目录");
        Fixture {
            _dir: dir,
            lib,
            src,
        }
    }

    #[test]
    fn expanding_a_folder_collects_images_and_counts_the_rest() {
        let f = fixture();
        write_png(&f.src, "一.png", 8, 8, [1, 2, 3, 255]);
        write_png(&f.src, "二.png", 8, 8, [4, 5, 6, 255]);
        let nested = f.src.join("子目录");
        std::fs::create_dir_all(&nested).expect("建立子目录");
        write_png(&nested, "三.png", 8, 8, [7, 8, 9, 255]);
        std::fs::write(f.src.join("说明.txt"), b"x").expect("写入说明文件");
        std::fs::write(nested.join("工程.psd"), b"x").expect("写入工程文件");

        let e = expand_sources(std::slice::from_ref(&f.src)).expect("展开目录");
        assert_eq!(e.sources.len(), 3, "应收集三张图片：{:?}", e.sources);
        assert_eq!(e.skipped_non_images, 2, "应计出两个被跳过的非图片文件");
    }

    #[test]
    fn an_explicitly_given_unsupported_file_is_kept_for_the_error_path() {
        // 直接指定的文件即便扩展名不受支持也必须保留，让它走到
        // import.unsupported_media_type，而不是被悄悄丢掉。
        let f = fixture();
        let odd = f.src.join("工程.psd");
        std::fs::write(&odd, b"x").expect("写入工程文件");
        let e = expand_sources(std::slice::from_ref(&odd)).expect("展开单个文件");
        assert_eq!(e.sources, vec![odd.clone()]);
        assert_eq!(e.skipped_non_images, 0);

        let report = import_many(&f.lib, &e.sources, &ImportOptions::default(), &mut NoopObserver);
        assert_eq!(report.failed.len(), 1);
        assert_eq!(report.failed[0].error.code, Code::ImportUnsupportedMediaType);
    }

    #[test]
    fn expanding_deduplicates_overlapping_selections() {
        // 同时拖入一个目录和它里面的某个文件时，那个文件不应被导入两次——
        // 第二次会撞上 import.duplicate_in_library，呈现为一条莫名的失败。
        let f = fixture();
        let one = write_png(&f.src, "一.png", 8, 8, [1, 2, 3, 255]);
        let e = expand_sources(&[f.src.clone(), one.clone()]).expect("展开");
        assert_eq!(e.sources, vec![one]);
    }

    #[test]
    fn expanding_a_missing_path_reports_source_unreadable() {
        let f = fixture();
        let err = expand_sources(&[f.src.join("不存在")]).expect_err("本应报错");
        assert_eq!(err.code, Code::ImportSourceUnreadable);
    }

    #[test]
    fn a_fresh_library_gets_the_current_thumbnail_format_marker() {
        let f = fixture();
        ensure_thumbnail_format(&f.lib).expect("写入格式标记");
        let marker = f.lib.thumbnails_dir().join(THUMBNAIL_FORMAT_MARKER);
        assert_eq!(
            std::fs::read_to_string(&marker).expect("读取标记").trim(),
            THUMBNAIL_FORMAT_VERSION.to_string()
        );
    }

    #[test]
    fn an_outdated_thumbnail_format_wipes_the_tree() {
        // 换编码参数后旧缩略图必须消失，否则 ensure_thumbnail 会认为它们没缺失而
        // 直接读回旧格式的字节，库里混着两代缩略图却不报任何错。
        let f = fixture();
        let p = write_png(&f.src, "样例.png", 40, 20, [10, 120, 200, 255]);
        let s = import_one(&f.lib, &p, &ImportOptions::default(), &mut NoopObserver)
            .expect("导入");
        let thumb = f.lib.thumbnail_path(&s.hash);
        assert!(thumb.is_file());

        let marker = f.lib.thumbnails_dir().join(THUMBNAIL_FORMAT_MARKER);
        std::fs::write(&marker, "1").expect("写入过期版本");

        ensure_thumbnail_format(&f.lib).expect("清空并重建");
        assert!(!thumb.exists(), "过期格式的缩略图应被清除");
        assert!(f.lib.thumbnails_dir().is_dir(), "目录本身应保留");

        // 清空不影响素材本体与侧车，重算即可恢复。
        assert!(f.lib.body_path(&s.hash, &s.ext).is_file());
        ensure_thumbnail(&f.lib, &s.hash, &s.ext).expect("重算缩略图");
        assert!(thumb.is_file());
    }

    #[test]
    fn a_matching_thumbnail_format_leaves_the_tree_alone() {
        // 顺序照真实流程：打开库时先校验格式，之后才导入。反过来写会让首次校验把刚
        // 生成的缩略图一起清掉——那是正确行为，但测不到"版本一致时不动"这件事。
        let f = fixture();
        ensure_thumbnail_format(&f.lib).expect("首次写入标记");
        let p = write_png(&f.src, "样例.png", 40, 20, [10, 120, 200, 255]);
        let s = import_one(&f.lib, &p, &ImportOptions::default(), &mut NoopObserver)
            .expect("导入");
        let before = std::fs::read(f.lib.thumbnail_path(&s.hash)).expect("读取缩略图");
        ensure_thumbnail_format(&f.lib).expect("再次校验");
        assert_eq!(
            std::fs::read(f.lib.thumbnail_path(&s.hash)).expect("再读缩略图"),
            before,
            "版本一致时不应动缩略图"
        );
    }

    #[test]
    fn a_deleted_thumbnail_is_regenerated_on_demand() {
        // 规格：缩略图缺失时必须按需重新生成，不得以占位图代替；全部缺失也不算库损坏。
        let f = fixture();
        let p = write_png(&f.src, "样例.png", 40, 20, [10, 120, 200, 255]);
        let s = import_one(&f.lib, &p, &ImportOptions::default(), &mut NoopObserver)
            .expect("导入");
        let thumb = f.lib.thumbnail_path(&s.hash);
        let original = std::fs::read(&thumb).expect("读取缩略图");
        std::fs::remove_file(&thumb).expect("删除缩略图");

        let regenerated = ensure_thumbnail(&f.lib, &s.hash, &s.ext).expect("按需重新生成");
        assert_eq!(regenerated, original, "重新生成的缩略图应与导入时一致");
        assert!(thumb.is_file(), "重新生成后应落盘，而不是只返回内存中的字节");
    }

    #[test]
    fn an_existing_thumbnail_is_read_not_regenerated() {
        let f = fixture();
        let p = write_png(&f.src, "样例.png", 40, 20, [10, 120, 200, 255]);
        let s = import_one(&f.lib, &p, &ImportOptions::default(), &mut NoopObserver)
            .expect("导入");
        // 往缩略图里写入一段可辨认的内容。若实现擅自重算，读回的就不是这段内容。
        let marker = "这不是真的 WebP".as_bytes().to_vec();
        std::fs::write(f.lib.thumbnail_path(&s.hash), &marker).expect("覆盖缩略图");
        assert_eq!(
            ensure_thumbnail(&f.lib, &s.hash, &s.ext).expect("读取缩略图"),
            marker,
            "既有缩略图应被直接读取而不是重算"
        );
    }

    #[test]
    fn regenerating_a_thumbnail_without_a_body_reports_the_thumbnail_code() {
        let f = fixture();
        let p = write_png(&f.src, "样例.png", 40, 20, [10, 120, 200, 255]);
        let s = import_one(&f.lib, &p, &ImportOptions::default(), &mut NoopObserver)
            .expect("导入");
        std::fs::remove_file(f.lib.thumbnail_path(&s.hash)).expect("删除缩略图");
        std::fs::remove_file(f.lib.body_path(&s.hash, &s.ext)).expect("删除本体");
        let err = ensure_thumbnail(&f.lib, &s.hash, &s.ext).expect_err("本体缺失时本应失败");
        assert_eq!(err.code, Code::LibraryThumbnailFailed);
    }

    #[test]
    fn a_successful_import_writes_body_thumbnail_and_sidecar() {
        let f = fixture();
        let p = write_png(&f.src, "样例.png", 40, 20, [200, 30, 30, 255]);
        let s = import_one(&f.lib, &p, &ImportOptions::default(), &mut NoopObserver)
            .expect("导入应成功");
        assert!(f.lib.body_path(&s.hash, "png").is_file(), "缺少本体");
        assert!(f.lib.sidecar_path(&s.hash).is_file(), "缺少侧车");
        assert!(f.lib.thumbnail_path(&s.hash).is_file(), "缺少缩略图");
    }

    #[test]
    fn the_sidecar_records_what_the_browse_view_needs() {
        let f = fixture();
        let p = write_png(&f.src, "封面图.png", 40, 20, [10, 200, 90, 255]);
        let opts = ImportOptions {
            folder: Some("参考/构图".to_owned()),
            tags: vec!["草稿".to_owned()],
        };
        let s = import_one(&f.lib, &p, &opts, &mut NoopObserver).expect("导入应成功");
        assert_eq!(s.hash, ContentHash::of_file(&p).expect("计算摘要"));
        assert_eq!((s.width, s.height), (40, 20));
        assert_eq!(s.media_type, MediaType::Png);
        assert_eq!(s.ext, "png");
        // 来源文件名来自不可变的 source 字段；显示名初始化为来源名主体。
        assert_eq!(s.source.filename(), "封面图.png");
        assert_eq!(s.display_filename.as_str(), "封面图.png");
        assert_eq!(
            s.source,
            AssetSource::Filesystem {
                path: Some(p.to_string_lossy().into_owned()),
                filename: "封面图.png".to_owned(),
            }
        );
        assert_eq!(s.byte_size, std::fs::metadata(&p).expect("读取大小").len());
        assert_eq!(s.folder.as_deref(), Some("参考/构图"));
        assert_eq!(s.tags, opts.tags);
        assert!(!s.is_deleted());
        assert!(s.color_card.is_ok(), "色卡应成功：{:?}", s.color_card);
        // 侧车落盘后读回应完全一致。
        assert_eq!(
            AssetSidecar::read(&f.lib.sidecar_path(&s.hash)).expect("读回侧车"),
            s
        );
    }

    #[test]
    fn a_jpeg_is_stored_with_the_normalised_extension() {
        let f = fixture();
        let p = f.src.join("照片.jpeg");
        DynamicImage::ImageRgba8(RgbaImage::from_pixel(30, 30, Rgba([90, 90, 200, 255])))
            .save_with_format(&p, ImageFormat::Jpeg)
            .expect("写入 JPEG");
        let s = import_one(&f.lib, &p, &ImportOptions::default(), &mut NoopObserver)
            .expect("导入应成功");
        assert_eq!(s.media_type, MediaType::Jpeg);
        assert_eq!(s.ext, "jpg");
        assert_eq!(s.source.filename(), "照片.jpeg");
        assert!(f.lib.body_path(&s.hash, "jpg").is_file());
    }

    #[test]
    fn re_importing_the_same_content_reports_a_library_duplicate() {
        let f = fixture();
        let p = write_png(&f.src, "一.png", 40, 20, [1, 2, 3, 255]);
        import_one(&f.lib, &p, &ImportOptions::default(), &mut NoopObserver).expect("首次导入");
        // 换个文件名，内容相同：查重按内容而不是按文件名。
        let q = f.src.join("二.png");
        std::fs::copy(&p, &q).expect("复制来源");
        let err = import_one(&f.lib, &q, &ImportOptions::default(), &mut NoopObserver)
            .expect_err("本应报告库内重复");
        assert_eq!(err.code, Code::ImportDuplicateInLibrary);
    }

    #[test]
    fn content_sitting_in_the_trash_reports_a_trash_duplicate() {
        // 回收站里的重复必须与库内重复区分开：使用者需要知道"去回收站还原"，
        // 而不是以为自己弄错了文件。
        let f = fixture();
        let p = write_png(&f.src, "已删.png", 40, 20, [7, 7, 7, 255]);
        let s = import_one(&f.lib, &p, &ImportOptions::default(), &mut NoopObserver)
            .expect("首次导入");
        // 手工把素材搬进回收站树，模拟删除后的状态。
        let (tb, ts) = (
            f.lib.trash_body_path(&s.hash, "png"),
            f.lib.trash_sidecar_path(&s.hash),
        );
        std::fs::create_dir_all(ts.parent().unwrap()).expect("建立回收站叶目录");
        std::fs::rename(f.lib.body_path(&s.hash, "png"), &tb).expect("移动本体");
        std::fs::rename(f.lib.sidecar_path(&s.hash), &ts).expect("移动侧车");

        let err = import_one(&f.lib, &p, &ImportOptions::default(), &mut NoopObserver)
            .expect_err("本应报告回收站重复");
        assert_eq!(err.code, Code::ImportDuplicateInTrash);
    }

    #[test]
    fn an_unsupported_format_leaves_the_library_untouched() {
        let f = fixture();
        let p = f.src.join("图层.psd");
        std::fs::write(&p, b"8BPS").expect("写入样本");
        let err = import_one(&f.lib, &p, &ImportOptions::default(), &mut NoopObserver)
            .expect_err("本应拒绝");
        assert_eq!(err.code, Code::ImportUnsupportedMediaType);
        assert_eq!(count_files(&f.lib.objects_dir()), 0);
        assert_eq!(count_files(&f.lib.thumbnails_dir()), 0);
    }

    #[test]
    fn a_missing_source_reports_source_unreadable() {
        let f = fixture();
        let err = import_one(
            &f.lib,
            &f.src.join("不存在.png"),
            &ImportOptions::default(),
            &mut NoopObserver,
        )
        .expect_err("本应失败");
        assert_eq!(err.code, Code::ImportSourceUnreadable);
    }

    #[test]
    fn a_failure_at_any_stage_leaves_no_trace_in_the_library() {
        // 这是导入最重要的不变式，也只能靠注入触发：磁盘不会按需在第三步失败。
        for stage in [
            ImportStage::Hashed,
            ImportStage::BodyWritten,
            ImportStage::ThumbnailWritten,
            ImportStage::SidecarWritten,
        ] {
            let f = fixture();
            let p = write_png(&f.src, "样例.png", 40, 20, [5, 100, 200, 255]);
            let err = import_one(&f.lib, &p, &ImportOptions::default(), &mut FailAt(stage))
                .expect_err("注入故障后本应失败");
            assert_eq!(err.code, Code::ImportCopyFailed, "阶段 {stage:?}");
            assert_eq!(
                count_files(&f.lib.objects_dir()),
                0,
                "阶段 {stage:?} 之后 objects/ 有残留"
            );
            assert_eq!(
                count_files(&f.lib.thumbnails_dir()),
                0,
                "阶段 {stage:?} 之后 thumbnails/ 有残留"
            );
        }
    }

    #[test]
    fn a_rolled_back_import_can_be_retried_successfully() {
        // 回滚只有在"重试能成功"时才算真的回滚干净了。
        let f = fixture();
        let p = write_png(&f.src, "样例.png", 40, 20, [5, 100, 200, 255]);
        import_one(
            &f.lib,
            &p,
            &ImportOptions::default(),
            &mut FailAt(ImportStage::SidecarWritten),
        )
        .expect_err("首次应因注入失败");
        let s = import_one(&f.lib, &p, &ImportOptions::default(), &mut NoopObserver)
            .expect("重试应成功");
        assert!(f.lib.sidecar_path(&s.hash).is_file());
    }

    #[test]
    fn rollback_never_deletes_a_file_it_did_not_create() {
        // 场景：上一次导入崩在写侧车之前，留下一个孤儿本体。这次再失败时，
        // 不应把不属于本次的文件一并删掉。
        let f = fixture();
        let p = write_png(&f.src, "样例.png", 40, 20, [9, 9, 200, 255]);
        let hash = ContentHash::of_file(&p).expect("计算摘要");
        let body = f.lib.body_path(&hash, "png");
        std::fs::create_dir_all(body.parent().unwrap()).expect("建立叶目录");
        std::fs::write(&body, "上一次留下的孤儿本体".as_bytes()).expect("写入孤儿本体");

        import_one(
            &f.lib,
            &p,
            &ImportOptions::default(),
            &mut FailAt(ImportStage::ThumbnailWritten),
        )
        .expect_err("本应因注入失败");
        assert!(body.is_file(), "回滚删掉了不属于本次导入的文件");
        assert_eq!(count_files(&f.lib.thumbnails_dir()), 0);
        assert!(!f.lib.sidecar_path(&hash).exists());
    }

    #[test]
    fn a_mixed_batch_accounts_for_every_source_exactly_once() {
        let f = fixture();
        let good = write_png(&f.src, "好.png", 40, 20, [1, 1, 1, 255]);
        let bad = f.src.join("坏.psd");
        std::fs::write(&bad, b"8BPS").expect("写入样本");
        let dup = f.src.join("好的副本.png");
        std::fs::copy(&good, &dup).expect("复制");
        let sources = vec![good, bad, dup];

        let report = import_many(
            &f.lib,
            &sources,
            &ImportOptions::default(),
            &mut NoopObserver,
        );
        assert_eq!(report.total(), sources.len(), "报告未覆盖全部输入");
        assert_eq!(report.imported.len(), 1);
        assert_eq!(report.failed.len(), 2);
        let codes: Vec<_> = report.failed.iter().map(|f| f.error.code).collect();
        assert!(codes.contains(&Code::ImportUnsupportedMediaType));
        assert!(codes.contains(&Code::ImportDuplicateInLibrary));
    }

    #[test]
    fn cancellation_still_accounts_for_the_remaining_sources() {
        let f = fixture();
        let sources: Vec<PathBuf> = (0..5)
            .map(|i| write_png(&f.src, &format!("第{i}张.png"), 40, 20, [i as u8, 60, 90, 255]))
            .collect();
        let mut obs = CancelAfter {
            limit: 2,
            started: 0,
        };
        let report = import_many(&f.lib, &sources, &ImportOptions::default(), &mut obs);
        assert_eq!(report.total(), 5, "取消后报告未覆盖全部输入");
        assert!(!report.imported.is_empty(), "取消前已完成的应保留");
        assert!(report
            .failed
            .iter()
            .any(|f| f.error.code == Code::ImportCancelled));
    }

    #[test]
    fn progress_is_reported_from_zero_up_to_the_total() {
        let f = fixture();
        let sources: Vec<PathBuf> = (0..3)
            .map(|i| write_png(&f.src, &format!("p{i}.png"), 40, 20, [i as u8, 7, 7, 255]))
            .collect();
        let mut rec = Recorder::default();
        import_many(&f.lib, &sources, &ImportOptions::default(), &mut rec);
        assert_eq!(rec.calls.first(), Some(&(0, 3)));
        assert_eq!(rec.calls.last(), Some(&(3, 3)), "结束时应回报完成");
    }

    #[test]
    fn disk_full_os_errors_map_to_the_insufficient_space_code() {
        // 真的把磁盘写满不可行，但错误码映射本身必须锁住，否则空间不足会被
        // 报成"复制失败"，使用者按提示做不出任何有用的处置。
        use std::io::{Error, ErrorKind};
        assert_eq!(
            classify_write_error(&Error::from_raw_os_error(112)),
            Code::ImportInsufficientSpace
        );
        assert_eq!(
            classify_write_error(&Error::from_raw_os_error(39)),
            Code::ImportInsufficientSpace
        );
        assert_eq!(
            classify_write_error(&Error::new(ErrorKind::PermissionDenied, "拒绝访问")),
            Code::ImportCopyFailed
        );
    }

    #[test]
    fn the_library_copy_is_byte_identical_to_the_source() {
        // 复制入库模型的前提：库内副本就是权威副本。
        let f = fixture();
        let p = write_png(&f.src, "样例.png", 64, 48, [123, 45, 67, 255]);
        let s = import_one(&f.lib, &p, &ImportOptions::default(), &mut NoopObserver)
            .expect("导入应成功");
        let body = f.lib.body_path(&s.hash, "png");
        assert_eq!(
            std::fs::read(&body).expect("读本体"),
            std::fs::read(&p).expect("读来源")
        );
        assert_eq!(ContentHash::of_file(&body).expect("重算摘要"), s.hash);
    }

    #[test]
    fn no_part_files_survive_a_successful_import() {
        let f = fixture();
        let p = write_png(&f.src, "样例.png", 40, 20, [3, 3, 3, 255]);
        import_one(&f.lib, &p, &ImportOptions::default(), &mut NoopObserver).expect("导入应成功");
        for dir in [f.lib.objects_dir(), f.lib.thumbnails_dir()] {
            let mut stack = vec![dir];
            while let Some(d) = stack.pop() {
                for e in std::fs::read_dir(&d).expect("读目录").flatten() {
                    let p = e.path();
                    if p.is_dir() {
                        stack.push(p);
                    } else {
                        let n = p.file_name().unwrap().to_string_lossy().into_owned();
                        assert!(!n.ends_with(".part") && !n.ends_with(".tmp"), "残留 {n}");
                    }
                }
            }
        }
    }
}
