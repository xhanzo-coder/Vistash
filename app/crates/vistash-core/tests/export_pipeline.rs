//! 任务 5.4 的失败测试：原图导出、显示文件名、冲突计划与安全停止的合同。
//!
//! asset-transfer 规格"原图导出与同名冲突处理"+ 设计第十二条：导出用显示文件名
//! 与真实扩展名复制原始字节，绝不修改库内本体或侧车；同名冲突先生成冲突计划，
//! 使用者明确选择跳过、覆盖或自动编号后才写入，覆盖前必须有明确确认；批量导出
//! 以单素材为失败隔离单元并逐项报告，支持在单文件边界停止。
//!
//! 本文件先于实现存在，在任务 5.5 完成前保持编译失败——这正是失败测试的交付形态。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
use vistash_core::error::AppError;
use vistash_core::export::{export_assets, plan_export, ConflictPolicy, ExportRequest};
use vistash_core::hashing::ContentHash;
use vistash_core::import::{
    ImportObserver, ImportOptions, ImportRun, ImportRunState, ImportRuns, NoopObserver,
};
use vistash_core::library::Library;

struct Fixture {
    _dir: tempfile::TempDir,
    library: Library,
    src: PathBuf,
    target: PathBuf,
    png_hash: ContentHash,
    jpeg_hash: ContentHash,
}

fn fixture() -> Fixture {
    let temp_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/vistash-test-temp");
    std::fs::create_dir_all(&temp_root).expect("建立项目测试目录");
    let dir = tempfile::tempdir_in(temp_root).expect("建立临时目录");
    let library = Library::create(&dir.path().join("library")).expect("建立库");
    let src = dir.path().join("source");
    let target = dir.path().join("export-target");
    std::fs::create_dir(&src).expect("建立来源目录");
    std::fs::create_dir(&target).expect("建立导出目标目录");

    // 经真实导入管线入库两张不同格式的图，让哈希、本体与侧车都是真的。
    write_image(&src.join("风景.png"), ImageFormat::Png, [255, 200, 0]);
    write_image(&src.join("人像.jpeg"), ImageFormat::Jpeg, [10, 20, 30]);
    let mut png_hash = None;
    let mut jpeg_hash = None;
    for name in ["风景.png", "人像.jpeg"] {
        let sidecar = vistash_core::import::import_one(
            &library,
            &src.join(name),
            &ImportOptions::default(),
            &mut NoopObserver,
        )
        .unwrap_or_else(|e| panic!("导入 {name} 失败：{e}"));
        if sidecar.ext == "png" {
            png_hash = Some(sidecar.hash.clone());
        } else {
            jpeg_hash = Some(sidecar.hash.clone());
        }
    }

    Fixture {
        _dir: dir,
        library,
        src,
        target,
        png_hash: png_hash.expect("PNG 已入库"),
        jpeg_hash: jpeg_hash.expect("JPEG 已入库"),
    }
}

fn write_image(path: &Path, format: ImageFormat, color: [u8; 3]) {
    DynamicImage::ImageRgb8(RgbImage::from_pixel(16, 16, Rgb(color)))
        .save_with_format(path, format)
        .expect("写入样本图");
}

/// 占用一次导出运行：与导入共用同一长任务注册表和库级闸（设计第十条统一语义）。
fn begin_run(runs: &ImportRuns, library: &Library) -> Arc<ImportRun> {
    runs.begin_export(library).expect("库空闲时应能开始导出")
}

fn skip_request(target: PathBuf) -> ExportRequest {
    ExportRequest {
        target_dir: target,
        policy: ConflictPolicy::Skip,
    }
}

fn body_bytes(f: &Fixture, hash: &ContentHash, ext: &str) -> Vec<u8> {
    std::fs::read(f.library.body_path(hash, ext)).expect("读取库内本体")
}

// —— 组一：导出原图与显示文件名 ——

#[test]
fn exports_copy_original_bytes_under_display_filenames() {
    let f = fixture();
    let runs = ImportRuns::new();
    let run = begin_run(&runs, &f.library);
    let request = skip_request(f.target.clone());

    let report = export_assets(
        &f.library,
        &[f.png_hash.clone(), f.jpeg_hash.clone()],
        &request,
        &run,
        &mut NoopObserver,
    )
    .expect("导出整体成功");

    assert_eq!(report.exported.len(), 2, "两张都应导出");
    assert_eq!(report.failed.len(), 0);
    assert_eq!(report.skipped_existing, 0);
    assert_eq!(report.pending_count, 0);

    // 显示文件名主体 + 真实扩展名："人像.jpeg" 入库后归一为 jpg。
    let exported_png = f.target.join("风景.png");
    let exported_jpeg = f.target.join("人像.jpg");
    assert!(exported_png.is_file(), "缺少 风景.png");
    assert!(exported_jpeg.is_file(), "导出必须使用真实扩展名 jpg");

    // 原始字节逐一相等。
    assert_eq!(
        std::fs::read(&exported_png).expect("读导出 PNG"),
        body_bytes(&f, &f.png_hash, "png"),
        "导出的 PNG 字节必须与库内本体一致"
    );
    assert_eq!(
        std::fs::read(&exported_jpeg).expect("读导出 JPEG"),
        body_bytes(&f, &f.jpeg_hash, "jpg"),
        "导出的 JPEG 字节必须与库内本体一致"
    );
}

#[test]
fn exporting_never_modifies_library_objects() {
    let f = fixture();
    let before_png = body_bytes(&f, &f.png_hash, "png");
    let before_jpeg = body_bytes(&f, &f.jpeg_hash, "jpg");
    let sidecar_before =
        std::fs::read(f.library.sidecar_path(&f.png_hash)).expect("读取 PNG 侧车");

    let runs = ImportRuns::new();
    let run = begin_run(&runs, &f.library);
    let request = ExportRequest {
        target_dir: f.target.clone(),
        policy: ConflictPolicy::Overwrite,
    };
    export_assets(
        &f.library,
        &[f.png_hash.clone(), f.jpeg_hash.clone()],
        &request,
        &run,
        &mut NoopObserver,
    )
    .expect("导出整体成功");

    assert_eq!(
        body_bytes(&f, &f.png_hash, "png"),
        before_png,
        "库内本体不得因导出而变化"
    );
    assert_eq!(
        body_bytes(&f, &f.jpeg_hash, "jpg"),
        before_jpeg,
        "库内本体不得因导出而变化"
    );
    assert_eq!(
        std::fs::read(f.library.sidecar_path(&f.png_hash)).expect("回读 PNG 侧车"),
        sidecar_before,
        "库内侧车不得因导出而变化"
    );
}

// —— 组二：冲突计划在选择前不写目标 ——

#[test]
fn conflict_plan_reports_existing_targets_before_any_write() {
    let f = fixture();
    // 预置一个同名的外部文件，字节与库内本体明显不同。
    let conflicting = f.target.join("风景.png");
    std::fs::write(&conflicting, b"external-app-stale-content").expect("预置冲突文件");
    let original = std::fs::read(&conflicting).expect("记住冲突文件字节");

    let planned =
        plan_export(&f.library, &[f.png_hash.clone()], &f.target).expect("生成冲突计划");

    assert_eq!(planned.len(), 1);
    assert!(
        planned[0].existing,
        "目标目录已有同名文件时计划必须标记冲突"
    );
    assert_eq!(
        planned[0].display_filename, "风景.png",
        "计划给出显示文件名主体加真实扩展名的完整导出名"
    );

    // 计划只是询问：在选择策略之前不得写该目标。
    assert_eq!(
        std::fs::read(&conflicting).expect("回读冲突文件"),
        original,
        "冲突选择前不得改写既有目标"
    );
}

// —— 组三：三种冲突策略 ——

#[test]
fn skip_policy_leaves_existing_files_and_reports_them() {
    let f = fixture();
    let conflicting = f.target.join("风景.png");
    std::fs::write(&conflicting, b"stale-target-bytes").expect("预置冲突文件");

    let runs = ImportRuns::new();
    let run = begin_run(&runs, &f.library);
    let report = export_assets(
        &f.library,
        &[f.png_hash.clone(), f.jpeg_hash.clone()],
        &skip_request(f.target.clone()),
        &run,
        &mut NoopObserver,
    )
    .expect("导出整体成功");

    assert_eq!(
        std::fs::read(&conflicting).expect("回读冲突文件"),
        b"stale-target-bytes".to_vec(),
        "跳过策略必须保持既有文件原样"
    );
    assert_eq!(report.skipped_existing, 1, "跳过项单独计数");
    assert_eq!(report.exported, vec!["人像.jpg".to_string()]);
    assert_eq!(report.failed.len(), 0);
}

#[test]
fn overwrite_policy_replaces_the_target_with_original_bytes() {
    let f = fixture();
    let conflicting = f.target.join("风景.png");
    std::fs::write(&conflicting, b"stale-target-bytes").expect("预置冲突文件");

    let runs = ImportRuns::new();
    let run = begin_run(&runs, &f.library);
    // 覆盖是破坏性操作；规格要求使用者在界面上明确确认后才进入本策略，
    // core 层收到的 Overwrite 即代表确认已经发生。
    let request = ExportRequest {
        target_dir: f.target.clone(),
        policy: ConflictPolicy::Overwrite,
    };
    let report = export_assets(
        &f.library,
        &[f.png_hash.clone()],
        &request,
        &run,
        &mut NoopObserver,
    )
    .expect("导出整体成功");

    assert_eq!(report.exported.len(), 1);
    assert_eq!(
        std::fs::read(&conflicting).expect("回读被覆盖目标"),
        body_bytes(&f, &f.png_hash, "png"),
        "覆盖后目标必须是原始字节"
    );
}

#[test]
fn auto_number_policy_writes_a_numbered_copy_without_touching_the_original() {
    let f = fixture();
    let conflicting = f.target.join("风景.png");
    std::fs::write(&conflicting, b"stale-target-bytes").expect("预置冲突文件");

    let runs = ImportRuns::new();
    let run = begin_run(&runs, &f.library);
    let request = ExportRequest {
        target_dir: f.target.clone(),
        policy: ConflictPolicy::AutoNumber,
    };
    let report = export_assets(
        &f.library,
        &[f.png_hash.clone()],
        &request,
        &run,
        &mut NoopObserver,
    )
    .expect("导出整体成功");

    assert_eq!(report.exported, vec!["风景 (2).png".to_string()]);
    assert_eq!(
        std::fs::read(&conflicting).expect("回读既有文件"),
        b"stale-target-bytes".to_vec(),
        "自动编号不得改写既有文件"
    );
    assert_eq!(
        std::fs::read(f.target.join("风景 (2).png")).expect("读取编号副本"),
        body_bytes(&f, &f.png_hash, "png")
    );
}

#[test]
fn auto_number_finds_the_first_free_number_in_a_dense_directory() {
    let f = fixture();
    // 目录里已经排到 (2)：编号必须继续向后找空位，而不是覆盖已有的编号副本。
    std::fs::write(f.target.join("风景.png"), b"stale-one").expect("预置原名冲突");
    std::fs::write(f.target.join("风景 (2).png"), b"stale-two").expect("预置二号冲突");

    let runs = ImportRuns::new();
    let run = begin_run(&runs, &f.library);
    let request = ExportRequest {
        target_dir: f.target.clone(),
        policy: ConflictPolicy::AutoNumber,
    };
    let report = export_assets(
        &f.library,
        &[f.png_hash.clone()],
        &request,
        &run,
        &mut NoopObserver,
    )
    .expect("导出整体成功");

    assert_eq!(report.exported, vec!["风景 (3).png".to_string()]);
    assert_eq!(
        std::fs::read(f.target.join("风景 (2).png")).expect("回读二号"),
        b"stale-two".to_vec()
    );
}

// —— 组四：逐项失败隔离 ——

#[test]
fn one_failed_asset_does_not_block_the_rest() {
    let f = fixture();
    // 孤儿哈希：库里没有对应本体与侧车，导出必须单独失败而不拖垮其余项。
    let orphan = ContentHash::of_bytes(b"orphan-asset-that-does-not-exist");

    let runs = ImportRuns::new();
    let run = begin_run(&runs, &f.library);
    let report = export_assets(
        &f.library,
        &[orphan.clone(), f.png_hash.clone(), f.jpeg_hash.clone()],
        &skip_request(f.target.clone()),
        &run,
        &mut NoopObserver,
    )
    .expect("存在单项失败时导出整体仍算完成");

    assert_eq!(report.exported.len(), 2, "其余两项照常导出");
    assert_eq!(report.failed.len(), 1, "失败逐项报告");
    // 失败项按调用方交来的哈希定位；孤儿没有可报的显示名。
    assert_eq!(report.failed[0].hash, orphan);
    assert!(report.failed[0].display_filename.is_none());
    assert!(f.target.join("风景.png").is_file());
    assert!(f.target.join("人像.jpg").is_file());
}

// —— 组五：单文件边界的安全停止 ——

/// 第 `limit` 个进度回调时提交停止请求的观察者（与导入协调器测试同一手法）。
struct StopAtProgress<'a> {
    limit: usize,
    seen: usize,
    run: &'a ImportRun,
}

impl ImportObserver for StopAtProgress<'_> {
    fn on_progress(&mut self, _done: usize, _total: usize, _current: &str) {
        self.seen += 1;
        if self.seen == self.limit {
            self.run.request_stop();
        }
    }
}

#[test]
fn stopping_at_a_file_boundary_keeps_finished_and_counts_pending() {
    let f = fixture();
    let runs = ImportRuns::new();
    let run = begin_run(&runs, &f.library);
    let hashes = [f.png_hash.clone(), f.jpeg_hash.clone()];
    let mut observer = StopAtProgress {
        limit: 1,
        seen: 0,
        run: run.as_ref(),
    };

    let report = export_assets(
        &f.library,
        &hashes,
        &skip_request(f.target.clone()),
        &run,
        &mut observer,
    )
    .expect("停止不是整体失败");

    // 只有协调器确认退出才进入 stopped（asset-transfer 规格）。
    assert_eq!(run.state(), ImportRunState::Stopped);
    assert_eq!(
        report.exported.len() + report.skipped_existing + report.failed.len(),
        1,
        "第一项完成后停止：已完成项保留"
    );
    assert_eq!(report.pending_count, 1, "后续项计为未处理而不是失败");
    assert_eq!(
        report.exported.len()
            + report.skipped_existing
            + report.failed.len()
            + report.pending_count,
        hashes.len(),
        "四桶数量守恒"
    );
    // 半成品防护：目标目录里不得残留 .part 之类的临时文件。
    let leftovers: Vec<_> = std::fs::read_dir(&f.target)
        .expect("列出目标目录")
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".part"))
        .collect();
    assert!(leftovers.is_empty(), "不得残留半写文件：{leftovers:?}");
}

// —— 组六：库级并发闸与稳定错误 ——

#[test]
fn export_run_shares_the_library_scoped_concurrency_gate() {
    let f = fixture();
    let runs = ImportRuns::new();

    // 活跃导出期间：第二个导出与导入都必须等待同一把库级闸。
    let exporter = begin_run(&runs, &f.library);
    assert!(
        runs.begin_export(&f.library).is_err(),
        "已有运行中的导出时不得开始第二个"
    );
    assert!(runs.begin(&f.library).is_err(), "导出运行中不得开始导入");

    // 经真实协调器跑完一次导出，确认退出后槽位释放。
    let report = export_assets(
        &f.library,
        &[f.png_hash.clone()],
        &skip_request(f.target.clone()),
        &exporter,
        &mut NoopObserver,
    )
    .expect("导出整体成功");
    assert_eq!(report.pending_count, 0);
    drop(exporter);
    assert!(
        runs.begin_export(&f.library).is_ok(),
        "协调器确认结束后应能再次导出"
    );
}

#[test]
fn exporting_into_a_missing_directory_is_a_stable_error() {
    let f = fixture();
    let runs = ImportRuns::new();
    let run = begin_run(&runs, &f.library);
    let request = ExportRequest {
        target_dir: f.src.join("不存在的导出目录"),
        policy: ConflictPolicy::Skip,
    };
    let err: AppError = export_assets(
        &f.library,
        &[f.png_hash.clone()],
        &request,
        &run,
        &mut NoopObserver,
    )
    .expect_err("目标目录不存在必须报错");

    // 即使整体出错，协调器返回即确认退出，槽位随之释放。
    assert_eq!(run.state(), ImportRunState::Stopped);
    assert!(
        err.detail.as_deref().is_some_and(|d| !d.is_empty()),
        "错误必须带可读说明"
    );
}
