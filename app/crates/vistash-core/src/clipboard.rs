//! Windows 剪贴板端口（任务 5.1，选型冻结于设计第十一条与
//! `research/windows-platform-integration.md`）。
//!
//! 端口只回答"剪贴板上有什么"，并把分流裁决收敛到 [`arbitrate`] 一个函数：
//! 文件列表优先于位图——资源管理器复制图片文件时系统往往同时合成可显示位图，
//! 先读位图会把原始 JPEG 错误重编码成 PNG 并丢失来源；位图优先于纯文本；
//! 纯文本与网址不触发导入。生产 adapter（Windows `CF_HDROP` 经 Win32 读取）
//! 与内存测试 adapter 都把取到的可用性交给同一个裁决函数，因此契约测试对
//! 内存 adapter 的验证同时约束生产行为。
//!
//! 打开剪贴板失败必须返回稳定的 `clipboard.busy`，不得冒充空剪贴板；
//! 即使内容来自"剪切"，后续导入也只复制进库，绝不移动或删除源文件。

use std::path::PathBuf;

use crate::error::{AppError, Code, Result};

/// 位图允许的最大像素数。8K 截图约 33MP，这里留出约一倍余量；
/// 超限的粘贴更可能是误操作而非真实素材，直接拒绝而不是分配数百 MB 缓冲。
pub const MAX_BITMAP_PIXELS: usize = 64 * 1024 * 1024;

/// 一张已解码的 RGBA 位图。
///
/// 构造即校验：宽高非零、相乘不溢出、不超过 [`MAX_BITMAP_PIXELS`]、
/// 且 `rgba` 长度恰好是 `width * height * 4`。校验失败分别给出
/// `clipboard.image_invalid` 与 `clipboard.image_too_large`，
/// 让"缓冲被截断"和"截图过大"呈现为不同的稳定诊断。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BitmapImage {
    width: usize,
    height: usize,
    rgba: Vec<u8>,
}

impl BitmapImage {
    pub fn new(width: usize, height: usize, rgba: Vec<u8>) -> Result<Self> {
        let area = width
            .checked_mul(height)
            .ok_or_else(|| AppError::new(Code::ClipboardImageTooLarge))?;
        if area == 0 {
            return Err(AppError::detailed(
                Code::ClipboardImageInvalid,
                "位图宽高必须为正",
            ));
        }
        if area > MAX_BITMAP_PIXELS {
            return Err(AppError::detailed(
                Code::ClipboardImageTooLarge,
                format!("{area} 像素超出上限 {MAX_BITMAP_PIXELS}"),
            ));
        }
        if rgba.len() != area * 4 {
            return Err(AppError::detailed(
                Code::ClipboardImageInvalid,
                format!("RGBA 长度 {} 与 {width}x{height} 不符", rgba.len()),
            ));
        }
        Ok(Self {
            width,
            height,
            rgba,
        })
    }

    pub fn width(&self) -> usize {
        self.width
    }

    pub fn height(&self) -> usize {
        self.height
    }

    pub fn rgba(&self) -> &[u8] {
        &self.rgba
    }

    /// 消耗自身并取出像素缓冲，供 PNG 编码避免一次整份复制。
    pub fn into_rgba(self) -> Vec<u8> {
        self.rgba
    }
}

/// 一次剪贴板快照交出的唯一载荷。
///
/// 四个变体互斥：文件列表在场时位图与文本一律不出现，这是规格里
/// "MUST NOT 重复导入"的实现方式——调用方拿到的载荷天然只有一种。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClipboardPayload {
    /// 具有真实文件系统路径的对象列表（来自 `CF_HDROP`）。Shell 虚拟文件
    /// （`CFSTR_FILEDESCRIPTOR`/`CFSTR_FILECONTENTS`）第一阶段明确不支持。
    Files(Vec<PathBuf>),
    /// 已解码位图，由调用方在 Rust 侧编码为 PNG 后进入既有导入管线。
    Bitmap(BitmapImage),
    /// 纯文本或网址。第一阶段不处理：调用方据此不启动导入、不发起下载。
    Text(String),
    /// 剪贴板为空或不含任何受支持格式。
    Empty,
}

/// 从 Win32 取出的剪贴板可用性。`None` 表示该格式不在场。
///
/// 生产 adapter 在 `CloseClipboard` **之前**把句柄内容完整复制成自有数据，
/// 目录扫描、PNG 编码等耗时工作只能在关闭剪贴板之后进行，避免长时间独占
/// 系统剪贴板。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ClipboardAvailability {
    pub files: Option<Vec<PathBuf>>,
    pub bitmap: Option<BitmapImage>,
    pub text: Option<String>,
}

impl ClipboardAvailability {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_files(mut self, files: Vec<PathBuf>) -> Self {
        self.files = Some(files);
        self
    }

    pub fn with_bitmap(mut self, bitmap: BitmapImage) -> Self {
        self.bitmap = Some(bitmap);
        self
    }

    pub fn with_text(mut self, text: impl Into<String>) -> Self {
        self.text = Some(text.into());
        self
    }
}

/// 分流裁决的唯一权威：文件列表 > 位图 > 纯文本 > 空。
///
/// 两个 adapter 都调用它，规则改动只需发生在一处。
pub fn arbitrate(available: ClipboardAvailability) -> ClipboardPayload {
    let ClipboardAvailability {
        files,
        bitmap,
        text,
    } = available;
    if let Some(files) = files {
        return ClipboardPayload::Files(files);
    }
    if let Some(bitmap) = bitmap {
        return ClipboardPayload::Bitmap(bitmap);
    }
    if let Some(text) = text {
        return ClipboardPayload::Text(text);
    }
    ClipboardPayload::Empty
}

/// 剪贴板端口：读取当前系统剪贴板并按 [`arbitrate`] 分流。
///
/// 实现必须是独占使用（`&mut self`）：Windows 剪贴板是全局单例，并发打开
/// 很容易得到 `clipboard.busy`。命令层负责把访问串行化到单一 blocking worker。
pub trait ClipboardPort {
    /// 读取当前内容。打开失败返回稳定的 `clipboard.busy`，读取失败返回
    /// `clipboard.read_failed`；两者都不冒充空剪贴板。
    fn snapshot(&mut self) -> Result<ClipboardPayload>;
}

/// 内存 adapter：确定性行为，供契约测试与非 Tauri 测试播种场景。
///
/// 它不模拟 Win32，只持有一份 [`ClipboardAvailability`] 并走同一个
/// [`arbitrate`] 裁决——这正是它足以代表生产 adapter 分流行为的理由。
#[derive(Debug, Default)]
pub struct MemoryClipboard {
    available: ClipboardAvailability,
    busy: bool,
}

impl MemoryClipboard {
    pub fn empty() -> Self {
        Self::default()
    }

    pub fn with_availability(available: ClipboardAvailability) -> Self {
        Self {
            available,
            busy: false,
        }
    }

    /// 模拟其他进程独占剪贴板的占用状态。
    pub fn set_busy(&mut self, busy: bool) {
        self.busy = busy;
    }
}

impl ClipboardPort for MemoryClipboard {
    fn snapshot(&mut self) -> Result<ClipboardPayload> {
        if self.busy {
            return Err(AppError::new(Code::ClipboardBusy));
        }
        Ok(arbitrate(self.available.clone()))
    }
}
