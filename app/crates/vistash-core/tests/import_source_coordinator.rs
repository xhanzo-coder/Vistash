//! 任务 4.1 的失败测试：统一 [`ImportSource`] 协调器的目标与层级合同。
//!
//! 设计第十条：文件选择、目录选择、拖放与剪贴板只负责产生 `ImportSource`，之后进入
//! 同一 Rust 导入协调器。本文件先于实现存在，在任务 4.2 完成前保持编译失败——这正是
//! 失败测试的交付形态。四组契约各自对应规格的一条 MUST：
//!
//! 1. **文件导入目标**（asset-transfer"统一的图片导入入口"+ 设计第十条）：文件导入到
//!    当前具体逻辑文件夹；当前是全部、未分类或回收站时进入未分类；
//! 2. **文件夹相对层级**（asset-transfer"文件夹导入保留相对层级并合并同路径"）：
//!    以所选目录名称为逻辑根保留相对层级，非图片跳过并计入结果；
//! 3. **当前文件夹父级**：导入到当前逻辑文件夹时，该文件夹作为所选目录逻辑根的父级；
//! 4. **同逻辑路径合并**：规范化后的目标路径已存在时合并，不创建编号副本也不拒绝
//!    整批；内容重复的既有素材保持原归属，不因重复导入被静默移动。

use std::path::{Path, PathBuf};

use image::{DynamicImage, ImageFormat, Rgba, RgbaImage};
use vistash_core::import::{
    ImportOptions, ImportRequest, ImportSource, NoopObserver, import_one, import_sources,
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
    let unclassified = import_sources(
        &f.library,
        &ImportRequest {
            sources: vec![ImportSource::File(write_png(&f.src, "丙.png", [7, 8, 9, 255]))],
            current_folder: None,
        },
        &[],
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

    let report = import_sources(
        &f.library,
        &ImportRequest {
            sources: vec![ImportSource::Directory(travel)],
            current_folder: None,
        },
        &[],
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

    let report = import_sources(
        &f.library,
        &ImportRequest {
            sources: vec![ImportSource::Directory(travel)],
            current_folder: Some("参考".to_owned()),
        },
        &[],
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
        &mut NoopObserver,
    )
    .expect("第一次目录导入应完成");
    assert_eq!(first.imported.len(), 1);

    // 第二次：另一个磁盘位置也有同名目录。规范化后的逻辑路径相同，
    // 必须合并进现有 "trip"，而不是创建编号副本或拒绝整批。
    let second_trip = f.src.join("two/trip");
    let beta = write_png(&second_trip, "beta.png", [2, 2, 2, 255]);
    let second = import_sources(
        &f.library,
        &ImportRequest {
            sources: vec![ImportSource::Directory(second_trip)],
            current_folder: None,
        },
        &[],
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
    let again = import_sources(
        &f.library,
        &ImportRequest {
            sources: vec![ImportSource::File(alpha)],
            current_folder: Some("配色".to_owned()),
        },
        &[],
        &mut NoopObserver,
    )
    .expect("重复内容的导入请求不应整体失败");
    assert!(again.imported.is_empty(), "重复内容不得再次复制入库");
    assert_eq!(again.duplicates.len(), 1, "重复应作为独立结果呈现");
    assert!(again.failed.is_empty(), "重复不是失败");
    let persisted = AssetSidecarV3::read(
        &f.library.sidecar_path(&first.imported[0].hash),
    )
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
