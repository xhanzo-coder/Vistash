//! 剪贴板粘贴进入导入管线的桥接测试。
//!
//! 资源管理器复制的文件与目录必须复用既有路径导入流程——按磁盘事实分类成
//! `ImportSource`，不允许另起一套粘贴语义；截图位图必须在 Rust 侧编码为
//! PNG 并获得包含本地时间的显示文件名（产品契约），
//! 前端全程不见像素。末尾两组用例走真实协调器：粘贴入库的来源身份、归属与
//! 内容查重必须与文件导入完全一致。

use std::path::Path;
use std::time::{Duration, Instant};

use chrono::{TimeZone, Utc};
use vistash_core::clipboard::{bitmap_to_png, clipboard_image_display_name, BitmapImage};
use vistash_core::import::{
    classify_paths, import_sources, ImportRequest, TransferRuns, ImportSource, NoopTransferObserver,
};
use vistash_core::library::Library;
use vistash_core::sidecar::{AssetSource, AssetSidecarV3};

#[test]
fn explorer_files_and_directories_reuse_the_path_pipeline() {
    let temp = tempfile::tempdir().expect("创建临时目录");
    let file = temp.path().join("逆光.png");
    std::fs::write(&file, b"fake png bytes").expect("写入测试文件");
    let directory = temp.path().join("参考图");
    std::fs::create_dir(&directory).expect("创建测试目录");

    let sources = classify_paths(vec![file.clone(), directory.clone()]);

    assert_eq!(sources.len(), 2, "每个路径各产生一个来源");
    match &sources[0] {
        ImportSource::File(path) => assert_eq!(path, &file),
        other => panic!("普通文件必须分类为 File 来源，实际是 {other:?}"),
    }
    match &sources[1] {
        // 目录来源让协调器保留所选目录名与相对层级，粘贴与目录导入同语义。
        ImportSource::Directory(path) => assert_eq!(path, &directory),
        other => panic!("目录必须分类为 Directory 来源，实际是 {other:?}"),
    }
}

#[test]
fn a_clipboard_bitmap_encodes_to_a_decodable_png() {
    // 2x3 的非平凡像素：逐字节变化，保证编码不是靠空图碰巧通过。
    let rgba: Vec<u8> = (0..2 * 3 * 4).map(|i| (i % 251) as u8).collect();
    let image = BitmapImage::new(2, 3, rgba).expect("构造合法位图");

    let png = bitmap_to_png(&image).expect("PNG 编码");

    let decoded = image::load_from_memory(&png).expect("编码结果必须能被解码回来");
    assert_eq!((decoded.width(), decoded.height()), (2, 3));
}

#[test]
fn the_clipboard_display_name_carries_local_time_and_png_extension() {
    // 产品约定的形态："剪贴板图片 YYYY-MM-DD HHMMSS.png"。时间取本地时区，
    // 使用者在外部资源管理器里能按名字直接认出截图时刻。
    let at = chrono::Local
        .with_ymd_and_hms(2026, 8, 26, 14, 25, 30)
        .single()
        .expect("构造固定本地时间");
    assert_eq!(
        clipboard_image_display_name(at),
        "剪贴板图片 2026-08-26 142530.png"
    );
}

// —— 当前实现：经统一协调器的端到端合同 ——

struct Fixture {
    _dir: tempfile::TempDir,
    library: Library,
}

fn fixture() -> Fixture {
    // 与 catalog 及协调器测试同一手法：项目盘上的真实临时目录加真实库。
    let temp_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/vistash-test-temp");
    std::fs::create_dir_all(&temp_root).expect("建立项目测试目录");
    let dir = tempfile::tempdir_in(temp_root).expect("建立临时目录");
    let library = Library::create(&dir.path().join("library")).expect("建立库");
    Fixture { _dir: dir, library }
}

/// 一张 2x3 非平凡位图编码出的 PNG 字节（与上面的编码用例同一素材）。
fn sample_png() -> Vec<u8> {
    let rgba: Vec<u8> = (0..2 * 3 * 4).map(|i| (i % 251) as u8).collect();
    bitmap_to_png(&BitmapImage::new(2, 3, rgba).expect("构造合法位图")).expect("PNG 编码")
}

#[test]
fn pasted_bitmap_becomes_a_new_png_asset_via_the_coordinator() {
    let f = fixture();
    let bytes = sample_png();
    let captured_at = Utc
        .with_ymd_and_hms(2026, 8, 26, 6, 25, 30)
        .single()
        .expect("构造固定 UTC 时刻");
    // 生产侧由 Tauri 命令生成本地时间名；这里直接给出同一冻结形态。
    let filename = "剪贴板图片 2026-08-26 142530.png";

    let runs = TransferRuns::new();
    let run = runs.begin(&f.library).expect("库空闲时应能开始导入");
    let request = ImportRequest {
        sources: vec![ImportSource::PngBytes {
            bytes: bytes.clone(),
            filename: filename.to_owned(),
            captured_at,
        }],
        current_folder: None,
    };

    let report =
        import_sources(&f.library, &request, &[], &run, &mut NoopTransferObserver).expect("协调器不整体失败");

    assert_eq!(report.imported.len(), 1, "一次粘贴恰好入库一张");
    assert!(report.duplicates.is_empty());
    let asset: &AssetSidecarV3 = &report.imported[0];
    assert_eq!(asset.ext, "png", "剪贴板位图以 PNG 本体落盘");
    assert_eq!(asset.display_filename.as_str(), filename);
    assert_eq!(asset.folder, None, "当前在未分类时粘贴进未分类");
    match &asset.source {
        AssetSource::Clipboard {
            captured_at: at,
            filename: name,
        } => {
            assert_eq!(*at, captured_at, "来源时刻必须原样进入侧车");
            assert_eq!(name, filename);
        }
        other => panic!("来源身份必须是 Clipboard，实际是 {other:?}"),
    }
}

#[test]
fn realistic_clipboard_bitmap_pipeline_stays_within_the_interaction_budget() {
    const WIDTH: usize = 1254;
    const HEIGHT: usize = 1254;
    let mut rgba = Vec::with_capacity(WIDTH * HEIGHT * 4);
    for y in 0..HEIGHT {
        for x in 0..WIDTH {
            rgba.extend_from_slice(&[
                (x % 251) as u8,
                (y % 241) as u8,
                ((x + y) % 239) as u8,
                255,
            ]);
        }
    }
    let bitmap = BitmapImage::new(WIDTH, HEIGHT, rgba).expect("构造真实尺寸剪贴板位图");
    let started = Instant::now();
    let bytes = bitmap_to_png(&bitmap).expect("快速编码 PNG");
    let f = fixture();
    let runs = TransferRuns::new();
    let run = runs.begin(&f.library).expect("开始剪贴板导入");
    let request = ImportRequest {
        sources: vec![ImportSource::PngBytes {
            bytes,
            filename: "剪贴板图片 性能门禁.png".to_owned(),
            captured_at: Utc::now(),
        }],
        current_folder: None,
    };
    let report = import_sources(
        &f.library,
        &request,
        &[],
        &run,
        &mut NoopTransferObserver,
    )
    .expect("真实尺寸剪贴板位图导入");
    let elapsed = started.elapsed();

    assert_eq!(report.imported.len(), 1);
    assert!(
        elapsed < Duration::from_secs(5),
        "1254×1254 剪贴板位图完整管线耗时 {elapsed:?}，超过 5 秒交互门禁"
    );
}

#[test]
fn repasting_the_same_bitmap_reports_a_duplicate_not_a_second_copy() {
    let f = fixture();
    let bytes = sample_png();

    let request_for = |name: &str, at: chrono::DateTime<Utc>| ImportRequest {
        sources: vec![ImportSource::PngBytes {
            bytes: bytes.clone(),
            filename: name.to_owned(),
            captured_at: at,
        }],
        current_folder: None,
    };
    let first_at = Utc
        .with_ymd_and_hms(2026, 8, 26, 6, 25, 30)
        .single()
        .expect("构造第一次粘贴时刻");
    let second_at = Utc
        .with_ymd_and_hms(2026, 8, 26, 6, 30, 0)
        .single()
        .expect("构造第二次粘贴时刻");

    let runs = TransferRuns::new();
    let run = runs.begin(&f.library).expect("开始第一次导入");
    import_sources(
        &f.library,
        &request_for("剪贴板图片 2026-08-26 142530.png", first_at),
        &[],
        &run,
        &mut NoopTransferObserver,
    )
    .expect("第一次导入成功");

    // 协调器返回即释放库级槽位：同库的第二次粘贴必须能开始。
    let second_run = runs.begin(&f.library).expect("槽位释放后可再次导入");
    let report = import_sources(
        &f.library,
        &request_for("剪贴板图片 2026-08-26 143000.png", second_at),
        &[],
        &second_run,
        &mut NoopTransferObserver,
    )
    .expect("第二次导入整体成功");

    assert_eq!(report.duplicates.len(), 1, "内容重复只进重复桶");
    assert!(report.imported.is_empty(), "不得再写一份本体");
    let duplicate = &report.duplicates[0];
    // 重复记录指向正在处理的这次来源：名字随新粘贴变，哈希不变才是查重依据。
    assert_eq!(duplicate.original_filename, "剪贴板图片 2026-08-26 143000.png");
    assert!(!duplicate.in_trash);
}
