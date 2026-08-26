//! 任务 4.1 与 4.3 的失败测试：统一 [`ImportSource`] 协调器的目标、层级与停止合同。
//!
//! 设计第十条：文件选择、目录选择、拖放与剪贴板只负责产生 `ImportSource`，之后进入
//! 同一 Rust 导入协调器。本文件先于实现存在，在对应任务完成前保持编译失败——这正是
//! 失败测试的交付形态。各组契约对应规格的 MUST：
//!
//! 1. **文件导入目标**（asset-transfer"统一的图片导入入口"+ 设计第十条）：文件导入到
//!    当前具体逻辑文件夹；当前是全部、未分类或回收站时进入未分类；
//! 2. **文件夹相对层级**（asset-transfer"文件夹导入保留相对层级并合并同路径"）：
//!    以所选目录名称为逻辑根保留相对层级，非图片跳过并计入结果；
//! 3. **当前文件夹父级**：导入到当前逻辑文件夹时，该文件夹作为所选目录逻辑根的父级；
//! 4. **同逻辑路径合并**：规范化后的目标路径已存在时合并，不创建编号副本也不拒绝
//!    整批；内容重复的既有素材保持原归属，不因重复导入被静默移动；
//! 5. **任务身份与库级并发**（设计第十条）：每个长任务拥有唯一 `TaskId` 与库级
//!    并发键；同一时刻一个库只允许一个进行中的导入；
//! 6. **扫描阶段停止**（asset-transfer"在安全边界停止"）：目录扫描尚未开始写入时
//!    必须尽快停止，库内不留任何痕迹；
//! 7. **单素材事务边界停止**：处理期间在素材边界观察停止请求——已成功的保留，
//!    后续项记为未处理而不是失败；只有协调器确认退出后才进入 stopped。

use std::path::{Path, PathBuf};

use image::{DynamicImage, ImageFormat, Rgba, RgbaImage};
use vistash_core::error::Code;
use vistash_core::import::{
    ImportObserver, ImportOptions, ImportRequest, ImportRun, ImportRunState, ImportRuns,
    ImportSource, NoopObserver, import_one, import_sources,
};
use vistash_core::library::{FolderList, Library, LIBRARY_FORMAT_VERSION};
use vistash_core::sidecar::AssetSidecarV3;

/// 在项目盘上的临时目录里建立"库 + 来源区"。与 catalog 测试夹具同一手法：
/// 用真实 PNG 与真实临时目录，不假掉文件系统。
struct Fixture {
    _dir: tempfile::TempDir,
    library: Library,
    src: PathBuf,
}

fn fixture() -> Fixture {
    let temp_root =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/vistash-test-temp");
    std::fs::create_dir_all(&temp_root).expect("建立 E 盘项目测试目录");
    let dir = tempfile::tempdir_in(temp_root).expect("建立项目临时目录");
    let library = Library::create(&dir.path().join("library")).expect("建立库");
    let src = dir.path().join("source");
    std::fs::create_dir(&src).expect("建立来源目录");
    Fixture {
        _dir: dir,
        library,
        src,
    }
}

fn write_png(dir: &Path, relative: &str, color: [u8; 4]) -> PathBuf {
    let path = dir.join(relative);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("建立来源子目录");
    }
    DynamicImage::ImageRgba8(RgbaImage::from_pixel(16, 16, Rgba(color)))
        .save_with_format(&path, ImageFormat::Png)
        .expect("写入图片");
    path
}

fn folder_paths(library: &Library) -> Vec<String> {
    library.read_folders().expect("读文件夹清单").folders
}

/// 按显示名取回已入库的侧车，便于断言归属。
fn imported_with_stem<'a>(
    report: &'a vistash_core::import::SourceImportReport,
    stem: &str,
) -> &'a AssetSidecarV3 {
    report
        .imported
        .iter()
        .find(|s| s.display_filename.as_str() == format!("{stem}.png"))
        .unwrap_or_else(|| panic!("缺少显示名 {stem}.png 的素材"))
}

/// 占用一次导入运行。除并发拒绝测试外，所有用例都经它取得运行句柄。
fn begin_run(runs: &ImportRuns, library: &Library) -> std::sync::Arc<ImportRun> {
    runs.begin(library).expect("库空闲时应能开始导入")
}

/// 处理到第 `limit` 个进度回调时提交停止请求的观察者。
///
/// 停止经真实的运行句柄提交——与生产后端命令同一条通路，而不是测试私有的开关。
struct StopAtProgress<'a> {
    limit: usize,
    run: &'a ImportRun,
}

impl ImportObserver for StopAtProgress<'_> {
    fn on_progress(&mut self, done: usize, _total: usize, _source: &Path) {
        if done == self.limit {
            self.run.request_stop();
        }
    }
}

// —— 组一：文件导入目标 ——

#[test]
fn files_land_in_the_current_folder_or_unclassified() {
    let f = fixture();
    f.library
        .write_folders(&FolderList {
            format_version: LIBRARY_FORMAT_VERSION,
            folders: vec!["参考".to_owned()],
        })
        .expect("写入文件夹清单");
    let runs = ImportRuns::new();
    let run = begin_run(&runs, &f.library);

    // 当前是具体文件夹：两张都落到那里。
    let placed = import_sources(
        &f.library,
        &ImportRequest {
            sources: vec![
                ImportSource::File(write_png(&f.src, "甲.png", [1, 2, 3, 255])),
                ImportSource::File(write_png(&f.src, "乙.png", [4, 5, 6, 255])),
            ],
            current_folder: Some("参考".to_owned()),
        },
        &[],
        &run,
        &mut NoopObserver,
    )
    .expect("协调器应完成导入");
    assert_eq!(placed.imported.len(), 2, "两张都应入库");
    assert!(placed.duplicates.is_empty() && placed.failed.is_empty());
    for sidecar in &placed.imported {
        assert_eq!(
            sidecar.folder.as_deref(),
            Some("参考"),
            "文件导入必须落在当前具体文件夹"
        );
    }

    // 当前是全部/未分类/回收站位置（没有具体文件夹）：进入未分类。
    // 上一个任务已被协调器确认结束；一次运行就是一次导入，这里开新任务。
    let next_run = begin_run(&runs, &f.library);
    let unclassified = import_sources(
        &f.library,
        &ImportRequest {
            sources: vec![ImportSource::File(write_png(&f.src, "丙.png", [7, 8, 9, 255]))],
            current_folder: None,
        },
        &[],
        &next_run,
        &mut NoopObserver,
    )
    .expect("没有当前文件夹时协调器也应完成导入");
    assert_eq!(
        unclassified.imported[0].folder,
        None,
        "没有当前文件夹时文件必须落入未分类"
    );
}

// —— 组二：文件夹相对层级 ——

#[test]
fn a_directory_keeps_its_own_name_and_relative_levels() {
    let f = fixture();
    let travel = f.src.join("travel");
    write_png(&travel, "beach.png", [10, 20, 30, 255]);
    write_png(&travel, "city/night.png", [40, 50, 60, 255]);
    std::fs::write(travel.join("notes.txt"), "不是图片").expect("写入非图片");
    let runs = ImportRuns::new();
    let run = begin_run(&runs, &f.library);

    let report = import_sources(
        &f.library,
        &ImportRequest {
            sources: vec![ImportSource::Directory(travel)],
            current_folder: None,
        },
        &[],
        &run,
        &mut NoopObserver,
    )
    .expect("目录导入应完成");

    assert_eq!(report.imported.len(), 2, "两张图片都应入库");
    assert_eq!(
        report.skipped_non_images, 1,
        "目录中的非图片计入跳过而不是失败"
    );
    let paths = folder_paths(&f.library);
    assert!(
        paths.iter().any(|p| p == "travel"),
        "所选目录名必须是逻辑根：实际清单 {paths:?}"
    );
    assert!(
        paths.iter().any(|p| p == "travel/city"),
        "相对层级必须保留为嵌套逻辑路径：实际清单 {paths:?}"
    );
    assert_eq!(
        imported_with_stem(&report, "beach").folder.as_deref(),
        Some("travel"),
        "根层图片归属所选目录的逻辑根"
    );
    assert_eq!(
        imported_with_stem(&report, "night").folder.as_deref(),
        Some("travel/city"),
        "子目录图片保留相对层级"
    );
}

// —— 组三：当前文件夹父级 ——

#[test]
fn a_directory_nests_under_the_current_folder_when_present() {
    let f = fixture();
    f.library
        .write_folders(&FolderList {
            format_version: LIBRARY_FORMAT_VERSION,
            folders: vec!["参考".to_owned()],
        })
        .expect("写入文件夹清单");
    let travel = f.src.join("travel");
    write_png(&travel, "beach.png", [11, 22, 33, 255]);
    write_png(&travel, "city/night.png", [44, 55, 66, 255]);
    let runs = ImportRuns::new();
    let run = begin_run(&runs, &f.library);

    let report = import_sources(
        &f.library,
        &ImportRequest {
            sources: vec![ImportSource::Directory(travel)],
            current_folder: Some("参考".to_owned()),
        },
        &[],
        &run,
        &mut NoopObserver,
    )
    .expect("目录导入应完成");

    assert_eq!(report.imported.len(), 2);
    let paths = folder_paths(&f.library);
    assert!(
        paths.iter().any(|p| p == "参考/travel"),
        "当前逻辑文件夹必须是所选目录逻辑根的父级：实际清单 {paths:?}"
    );
    assert!(
        paths.iter().any(|p| p == "参考/travel/city"),
        "相对层级挂在父级之下：实际清单 {paths:?}"
    );
    assert!(
        !paths.iter().any(|p| p == "travel"),
        "不得在逻辑根之外另建同名顶层副本"
    );
    assert_eq!(
        imported_with_stem(&report, "beach").folder.as_deref(),
        Some("参考/travel")
    );
    assert_eq!(
        imported_with_stem(&report, "night").folder.as_deref(),
        Some("参考/travel/city")
    );
}

// —— 组四：同逻辑路径合并 ——

#[test]
fn same_logical_paths_merge_and_duplicates_keep_their_membership() {
    let f = fixture();
    let runs = ImportRuns::new();
    let run = begin_run(&runs, &f.library);

    // 第一次：导入磁盘位置一的同名目录。
    let first_trip = f.src.join("one/trip");
    let alpha = write_png(&first_trip, "alpha.png", [1, 1, 1, 255]);
    let first = import_sources(
        &f.library,
        &ImportRequest {
            sources: vec![ImportSource::Directory(first_trip)],
            current_folder: None,
        },
        &[],
        &run,
        &mut NoopObserver,
    )
    .expect("第一次目录导入应完成");
    assert_eq!(first.imported.len(), 1);

    // 第二次：另一个磁盘位置也有同名目录。规范化后的逻辑路径相同，
    // 必须合并进现有 "trip"，而不是创建编号副本或拒绝整批。
    let second_trip = f.src.join("two/trip");
    let beta = write_png(&second_trip, "beta.png", [2, 2, 2, 255]);
    let next_run = begin_run(&runs, &f.library);
    let second = import_sources(
        &f.library,
        &ImportRequest {
            sources: vec![ImportSource::Directory(second_trip)],
            current_folder: None,
        },
        &[],
        &next_run,
        &mut NoopObserver,
    )
    .expect("同路径第二次导入应整批继续而不是拒绝");
    assert_eq!(second.imported.len(), 1, "新内容应照常入库");
    assert_eq!(
        second.imported[0].folder.as_deref(),
        Some("trip"),
        "合并到现有逻辑路径"
    );
    let trips = folder_paths(&f.library)
        .into_iter()
        .filter(|p| p == "trip" || p.contains("trip ("))
        .collect::<Vec<_>>();
    assert_eq!(trips, vec!["trip".to_owned()], "不得出现编号副本");

    // 第三次：内容重复。既有素材保持原归属，不被静默移动，也不算失败。
    f.library
        .write_folders(&FolderList {
            format_version: LIBRARY_FORMAT_VERSION,
            folders: vec!["trip".to_owned(), "配色".to_owned()],
        })
        .expect("补写配色文件夹");
    let third_run = begin_run(&runs, &f.library);
    let again = import_sources(
        &f.library,
        &ImportRequest {
            sources: vec![ImportSource::File(alpha)],
            current_folder: Some("配色".to_owned()),
        },
        &[],
        &third_run,
        &mut NoopObserver,
    )
    .expect("重复内容的导入请求不应整体失败");
    assert!(again.imported.is_empty(), "重复内容不得再次复制入库");
    assert_eq!(again.duplicates.len(), 1, "重复应作为独立结果呈现");
    assert!(again.failed.is_empty(), "重复不是失败");
    let persisted =
        AssetSidecarV3::read(&f.library.sidecar_path(&first.imported[0].hash))
            .expect("读回权威侧车");
    assert_eq!(
        persisted.folder.as_deref(),
        Some("trip"),
        "既有素材必须保持在原文件夹，不得被移到配色"
    );

    // 对照：直接经旧入口 import_one 的重复仍是错误语义，供命令层对照使用。
    let opts = ImportOptions {
        folder: Some("配色".to_owned()),
        tags: vec![],
    };
    assert!(import_one(&f.library, &beta, &opts, &mut NoopObserver).is_err());
}

// —— 组五：任务身份与库级并发 ——

#[test]
fn each_run_has_a_unique_task_id_and_one_slot_per_library() {
    let f = fixture();
    let second_library = Library::create(&f.src.join("second-library")).expect("建立第二座库");

    let runs = ImportRuns::new();
    let first = begin_run(&runs, &f.library);
    assert_eq!(first.state(), ImportRunState::Running);

    // 同一座库：槽位已被占用。
    let refused = runs
        .begin(&f.library)
        .expect_err("同一库的第二次导入必须被拒绝");
    assert_eq!(refused.code, Code::ImportAlreadyRunning);

    // 另一座库：各占各的槽位，互不影响。
    let elsewhere = begin_run(&runs, &second_library);
    assert_ne!(
        first.concurrency_key(),
        elsewhere.concurrency_key(),
        "并发键按库隔离"
    );
    assert_ne!(first.id(), elsewhere.id(), "每个任务拥有唯一 TaskId");

    // 协调器跑完（空请求）即后端确认结束：进入 stopped 并释放槽位。
    import_sources(
        &f.library,
        &ImportRequest {
            sources: vec![],
            current_folder: None,
        },
        &[],
        &first,
        &mut NoopObserver,
    )
    .expect("空请求应正常完成");
    assert_eq!(first.state(), ImportRunState::Stopped, "只有后端确认才进入 stopped");
    let again = begin_run(&runs, &f.library);
    assert_ne!(first.id(), again.id(), "新任务必须拿到新的 TaskId");
}

#[test]
fn a_requested_stop_is_not_confirmed_until_the_coordinator_returns() {
    let f = fixture();
    let runs = ImportRuns::new();
    let run = begin_run(&runs, &f.library);

    run.request_stop();
    assert_eq!(
        run.state(),
        ImportRunState::Stopping,
        "请求停止只是意图，不得冒充已完成"
    );
    let refused = runs
        .begin(&f.library)
        .expect_err("正在停止的任务仍占用库级槽位");
    assert_eq!(refused.code, Code::ImportAlreadyRunning);

    import_sources(
        &f.library,
        &ImportRequest {
            sources: vec![],
            current_folder: None,
        },
        &[],
        &run,
        &mut NoopObserver,
    )
    .expect("空请求应确认停止并正常返回");
    assert_eq!(run.state(), ImportRunState::Stopped);
}

// —— 组六：扫描阶段停止 ——

#[test]
fn a_stop_before_the_scan_starts_writes_nothing_and_owes_no_failures() {
    let f = fixture();
    let travel = f.src.join("travel");
    write_png(&travel, "beach.png", [12, 24, 36, 255]);
    write_png(&travel, "city/night.png", [48, 60, 72, 255]);

    let runs = ImportRuns::new();
    let run = begin_run(&runs, &f.library);
    run.request_stop();

    let report = import_sources(
        &f.library,
        &ImportRequest {
            sources: vec![ImportSource::Directory(travel)],
            current_folder: None,
        },
        &[],
        &run,
        &mut NoopObserver,
    )
    .expect("扫描前的停止应让协调器干净地返回");

    assert!(
        report.imported.is_empty() && report.duplicates.is_empty(),
        "尚未写入就停止，不得有入库或重复记录"
    );
    assert!(
        report.failed.is_empty(),
        "未处理的项不是失败：实际 {:?}",
        report.failed
    );
    assert_eq!(report.pending_count, 0, "没有任何计划内项被处理");
    assert!(
        folder_paths(&f.library).is_empty(),
        "扫描中止不得创建任何逻辑文件夹：实际 {:?}",
        folder_paths(&f.library)
    );
    assert_eq!(run.state(), ImportRunState::Stopped, "协调器返回即后端确认");
}

// —— 组七：单素材事务边界停止 ——

#[test]
fn processing_stops_at_the_next_boundary_and_counts_the_rest_as_pending() {
    let f = fixture();
    let files = [
        write_png(&f.src, "甲.png", [1, 10, 100, 255]),
        write_png(&f.src, "乙.png", [2, 20, 200, 255]),
        write_png(&f.src, "丙.png", [3, 30, 30, 255]),
        write_png(&f.src, "丁.png", [4, 40, 40, 255]),
        write_png(&f.src, "戊.png", [5, 50, 50, 255]),
    ];
    let runs = ImportRuns::new();
    let run = begin_run(&runs, &f.library);

    // 第三个素材开跑前进度回调触发停止：前两个完整成功，其余停在边界外。
    let mut observer = StopAtProgress {
        limit: 2,
        run: &run,
    };
    let report = import_sources(
        &f.library,
        &ImportRequest {
            sources: files.iter().map(|p| ImportSource::File(p.clone())).collect(),
            current_folder: None,
        },
        &[],
        &run,
        &mut observer,
    )
    .expect("边界停止应让协调器带着报告返回");

    assert_eq!(report.imported.len(), 2, "已成功素材必须保留");
    assert_eq!(report.pending_count, 3, "后续项计为未处理");
    assert!(
        report.failed.is_empty() && report.duplicates.is_empty(),
        "未处理的项既不是失败也不是重复：失败 {:?}",
        report.failed
    );
    for sidecar in &report.imported {
        assert!(
            f.library.sidecar_path(&sidecar.hash).is_file(),
            "已成功素材的侧车必须在盘上：{}",
            sidecar.hash.as_str()
        );
    }
    // 计划按源路径排序，处理顺序不等于书写顺序；因此按集合断言：盘上侧车必须
    // 恰好对应已入库的素材，未处理的三个一个都不能有。
    let mut on_disk = 0usize;
    for file in &files {
        let hash = vistash_core::hashing::ContentHash::of_file(file)
            .expect("计算源文件哈希");
        if f.library.sidecar_path(&hash).is_file() {
            on_disk += 1;
        }
    }
    assert_eq!(
        on_disk,
        report.imported.len(),
        "盘上侧车数量必须与已成功素材一致"
    );
    assert_eq!(run.state(), ImportRunState::Stopped, "协调器返回即后端确认");
}
