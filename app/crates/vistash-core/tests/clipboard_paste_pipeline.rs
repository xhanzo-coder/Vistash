//! 剪贴板粘贴进入导入管线的桥接测试（任务 5.2，接线随任务 5.3）。
//!
//! 资源管理器复制的文件与目录必须复用既有路径导入流程——按磁盘事实分类成
//! `ImportSource`，不允许另起一套粘贴语义；截图位图必须在 Rust 侧编码为
//! PNG 并获得包含本地时间的显示文件名（asset-library 规格与调研文档 2.2 节），
//! 前端全程不见像素。

use chrono::{Local, TimeZone};
use vistash_core::clipboard::{bitmap_to_png, clipboard_image_display_name, BitmapImage};
use vistash_core::import::{classify_paths, ImportSource};

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
    // 调研文档冻结的形态："剪贴板图片 YYYY-MM-DD HHMMSS.png"。时间取本地时区，
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
