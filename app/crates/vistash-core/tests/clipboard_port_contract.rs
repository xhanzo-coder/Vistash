//! ClipboardPort 契约测试（任务 5.1）。
//!
//! 内存 adapter 与生产 Windows adapter 都必须满足同一组分流转交规则：
//! 文件列表优先于位图——资源管理器复制图片文件时剪贴板往往同时带可显示位图，
//! 先读位图会把原始 JPEG 错误重编码成 PNG 并丢失来源信息；位图优先于纯文本；
//! 纯文本与网址不触发任何导入。打开剪贴板失败必须是稳定的 `clipboard.busy`，
//! 不得冒充空剪贴板。

use vistash_core::clipboard::{
    arbitrate, BitmapImage, ClipboardAvailability, ClipboardPayload, ClipboardPort,
    MemoryClipboard, MAX_BITMAP_PIXELS,
};
use vistash_core::error::Code;

/// 构造一张全透明的小测试位图。
fn bitmap(width: usize, height: usize) -> BitmapImage {
    BitmapImage::new(width, height, vec![0; width * height * 4]).expect("构造合法测试位图")
}

#[test]
fn empty_clipboard_reports_empty_payload() {
    let mut port = MemoryClipboard::empty();
    assert_eq!(
        port.snapshot().expect("空剪贴板不是错误"),
        ClipboardPayload::Empty
    );
}

#[test]
fn file_list_wins_over_bitmap_and_text() {
    // 资源管理器复制图片文件的典型形态：CF_HDROP 与系统合成的可显示位图并存。
    // MUST 优先文件列表，且快照只交出一个载荷——调用方据此不会把同一批内容
    // 既按路径导入又按位图重复导入。
    let mut port = MemoryClipboard::with_availability(
        ClipboardAvailability::new()
            .with_files(vec![std::path::PathBuf::from(r"E:\素材\逆光.png")])
            .with_bitmap(bitmap(2, 2))
            .with_text(r"E:\素材\逆光.png"),
    );
    match port.snapshot().expect("有内容的剪贴板不是错误") {
        ClipboardPayload::Files(paths) => {
            assert_eq!(paths, vec![std::path::PathBuf::from(r"E:\素材\逆光.png")]);
        }
        other => panic!("文件列表在场时必须分流到 Files，实际是 {other:?}"),
    }
}

#[test]
fn bitmap_without_files_routes_to_bitmap() {
    // 截图工具只放位图与可选文本说明：没有文件路径时位图接管，
    // 位图携带的宽高与 RGBA 长度保持一致，供后续 PNG 编码使用。
    let mut port = MemoryClipboard::with_availability(
        ClipboardAvailability::new()
            .with_bitmap(bitmap(3, 2))
            .with_text("截图说明文字"),
    );
    match port.snapshot().expect("有内容的剪贴板不是错误") {
        ClipboardPayload::Bitmap(image) => {
            assert_eq!(image.width(), 3);
            assert_eq!(image.height(), 2);
            assert_eq!(image.rgba().len(), 3 * 2 * 4);
        }
        other => panic!("无文件列表时必须分流到 Bitmap，实际是 {other:?}"),
    }
}

#[test]
fn text_only_reports_text_without_any_import() {
    // 纯文本与图片网址第一阶段都不处理：端口如实报告 Text 载荷，
    // 由命令层据此不启动导入任务、也不发起网络下载（asset-transfer 规格的
    // "拒绝网址抓取"场景）。端口自身绝不去抓取或改写剪贴板。
    let mut port =
        MemoryClipboard::with_availability(ClipboardAvailability::new().with_text("https://example.com/pic.jpg"));
    assert_eq!(
        port.snapshot().expect("纯文本剪贴板不是错误"),
        ClipboardPayload::Text("https://example.com/pic.jpg".to_string())
    );
}

#[test]
fn busy_is_a_stable_error_not_an_empty_clipboard() {
    // OpenClipboard 失败（例如其他进程正在独占）必须以稳定的 clipboard.busy
    // 上抛，让界面能提示重试；把它当成空剪贴板会让人以为粘贴无效。
    let mut port = MemoryClipboard::empty();
    port.set_busy(true);
    let err = port.snapshot().expect_err("占用状态必须报错");
    assert_eq!(err.code, Code::ClipboardBusy);
}

#[test]
fn arbitration_matrix_pins_the_shared_dispatch_rule() {
    // 生产 adapter 只负责从 Win32 取出"有什么"，分流一律走同一个 arbitrate。
    // 对 arbitrate 的完整矩阵验证因此同时约束两个 adapter：内存 adapter 直接
    // 调用它，Windows adapter 在关闭剪贴板后也交给它裁决。
    let files = || vec![std::path::PathBuf::from(r"C:\a.png")];

    assert_eq!(
        arbitrate(ClipboardAvailability::new()),
        ClipboardPayload::Empty
    );
    assert_eq!(
        arbitrate(ClipboardAvailability::new().with_files(files())),
        ClipboardPayload::Files(files())
    );
    assert_eq!(
        arbitrate(
            ClipboardAvailability::new()
                .with_files(files())
                .with_bitmap(bitmap(1, 1))
        ),
        ClipboardPayload::Files(files())
    );
    assert!(matches!(
        arbitrate(ClipboardAvailability::new().with_bitmap(bitmap(1, 1))),
        ClipboardPayload::Bitmap(_)
    ));
    assert!(matches!(
        arbitrate(ClipboardAvailability::new().with_text("t")),
        ClipboardPayload::Text(_)
    ));
    assert!(matches!(
        arbitrate(
            ClipboardAvailability::new()
                .with_bitmap(bitmap(1, 1))
                .with_text("t")
        ),
        ClipboardPayload::Bitmap(_)
    ));
}

#[test]
fn bitmap_validation_rejects_malformed_buffers() {
    // 零尺寸与长度不符都是形状非法，不是"过大"：前者不可能来自真实截图，
    // 后者意味着像素缓冲被截断或拼错，继续编码只会产出损坏的 PNG。
    assert!(BitmapImage::new(0, 5, Vec::new()).is_err());
    assert!(BitmapImage::new(2, 2, vec![0; 3]).is_err());
    // 宽高相乘先溢出校验，再比较上限：不允许借构造超大 Vec 来试探边界。
    assert!(BitmapImage::new(usize::MAX, 2, vec![0; 8]).is_err());
    assert!(BitmapImage::new(MAX_BITMAP_PIXELS + 1, 1, vec![0; 8]).is_err());
}
