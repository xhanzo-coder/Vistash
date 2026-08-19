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
use crate::sidecar::{AssetSidecar, SIDECAR_FORMAT_VERSION};
use chrono::Utc;
use serde::Serialize;
use std::path::{Path, PathBuf};

/// 导入时施加在每个素材上的归属信息。
#[derive(Debug, Clone, Default)]
pub struct ImportOptions {
    pub folders: Vec<String>,
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

    fn on_progress(&mut self, done: usize, total: usize, source: &Path) {
        let _ = (done, total, source);
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

    let decoded = media::decode(source)?;
    let ext = decoded.media_type.library_ext();

    let body = lib.body_path(&hash, ext);
    created.claim(&body);
    copy_into(source, &body)?;
    observer.after_stage(ImportStage::BodyWritten)?;

    // 缩略图失败按素材失败处理并回滚。它虽是可重算的派生数据，但编码失败几乎总是
    // 真问题（空间不足或图本身异常），静默放过只会得到一批在网格里看不见的素材。
    let thumb_bytes = media::encode_thumbnail(&decoded.image)?;
    let thumb = lib.thumbnail_path(&hash);
    created.claim(&thumb);
    write_bytes(&thumb, &thumb_bytes, Code::LibraryThumbnailFailed)?;
    observer.after_stage(ImportStage::ThumbnailWritten)?;

    // 色卡失败不影响入库：失败原因记录在色卡自身里。
    let color_card = colorcard::analyze(&decoded.image);

    let sidecar = AssetSidecar {
        format_version: SIDECAR_FORMAT_VERSION,
        hash: hash.clone(),
        hash_algo: lib.meta().hash_algo.clone(),
        media_type: decoded.media_type,
        ext: ext.to_owned(),
        byte_size,
        width: decoded.width(),
        height: decoded.height(),
        imported_at: Utc::now(),
        original_filename: source
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        source_path: Some(source.to_string_lossy().into_owned()),
        folders: opts.folders.clone(),
        tags: opts.tags.clone(),
        color_card,
        deleted_at: None,
        deleted_from_folders: None,
    };

    let side = lib.sidecar_path(&hash);
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
        observer.on_progress(i, total, source);
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
    observer.on_progress(total, total, Path::new(""));
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
        fn on_progress(&mut self, _done: usize, _total: usize, _source: &Path) {
            self.started += 1;
        }
    }

    /// 记录进度回调的观察者。
    #[derive(Default)]
    struct Recorder {
        calls: Vec<(usize, usize)>,
    }
    impl ImportObserver for Recorder {
        fn on_progress(&mut self, done: usize, total: usize, _source: &Path) {
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
            folders: vec!["参考/构图".to_owned()],
            tags: vec!["草稿".to_owned()],
        };
        let s = import_one(&f.lib, &p, &opts, &mut NoopObserver).expect("导入应成功");
        assert_eq!(s.hash, ContentHash::of_file(&p).expect("计算摘要"));
        assert_eq!((s.width, s.height), (40, 20));
        assert_eq!(s.media_type, MediaType::Png);
        assert_eq!(s.ext, "png");
        assert_eq!(s.original_filename, "封面图.png");
        assert_eq!(s.byte_size, std::fs::metadata(&p).expect("读取大小").len());
        assert_eq!(s.folders, opts.folders);
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
        assert_eq!(s.original_filename, "照片.jpeg");
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
