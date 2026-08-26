//! Windows 剪贴板生产 adapter（任务 5.1，选型冻结于设计第十一条）。
//!
//! 文件列表与纯文本经 Win32 读取：`OpenClipboard` 打开失败必须返回稳定的
//! `clipboard.busy`（其他进程独占剪贴板很常见，冒充空剪贴板会让界面把粘贴
//! 无效果误报成没有内容）；`GetClipboardData` 返回的句柄归剪贴板所有，因此
//! 在 RAII `CloseClipboard` guard 的保护内用 `DragQueryFileW` 把路径完整
//! 复制成自有 `PathBuf`，目录扫描、PNG 编码等耗时工作只能在关闭剪贴板之后。
//! 位图读取经 [`WindowsClipboard::new`] 注入：官方 `tauri-plugin-clipboard-manager`
//! 的 Rust API 需要 AppHandle，接线在任务 5.3 的剪贴板导入 command 完成，
//! 本模块不引入对 Tauri 运行时的依赖。
//!
//! 分流一律交给核心的 [`vistash_core::clipboard::arbitrate`]，本模块只负责
//! "取出有什么"，不做产品判断。真实系统剪贴板的端到端行为无法在自动化测试里
//! 确定性地播种，按设计第十一条的风险预案由 release Tauri 构建的 Windows 层
//! 验收（任务 11.5）覆盖；本模块的分流正确性由核心契约测试保证。

use std::path::PathBuf;

use vistash_core::clipboard::{arbitrate, BitmapImage, ClipboardAvailability, ClipboardPayload, ClipboardPort};
use vistash_core::error::{AppError, Code, Result};

/// 位图读取注入点的类型。闭包在调用方选定的 blocking worker 上执行，返回
/// `Ok(None)` 表示当前没有位图。设计第十一条要求它最终接到官方 clipboard
/// 插件的 Rust `read_image()`，并把像素转成已校验的 [`BitmapImage`]。
pub type ReadBitmap = Box<dyn FnMut() -> Result<Option<BitmapImage>> + Send>;

pub struct WindowsClipboard {
    read_bitmap: ReadBitmap,
}

impl WindowsClipboard {
    pub fn new(read_bitmap: impl FnMut() -> Result<Option<BitmapImage>> + Send + 'static) -> Self {
        Self {
            read_bitmap: Box::new(read_bitmap),
        }
    }
}

impl ClipboardPort for WindowsClipboard {
    fn snapshot(&mut self) -> Result<ClipboardPayload> {
        // 第一步：打开系统剪贴板复制文件列表与文本，随后立即关闭——句柄内容
        // 只在关闭前有效，且不能让外部程序长时间粘不上剪贴板。
        let mut availability = read_files_and_text()?;
        // 第二步：文件列表在场时连位图都不必读——裁决不需要它，也避免为同一次
        // 粘贴多开关一次全局剪贴板。位图注入点在剪贴板已关闭之后才运行。
        if availability.files.is_none() {
            availability.bitmap = (self.read_bitmap)()?;
        }
        Ok(arbitrate(availability))
    }
}

/// 打开期间存活的 guard：无论提前返回还是出错都保证配对的 `CloseClipboard`。
struct OpenClipboardGuard;

impl Drop for OpenClipboardGuard {
    fn drop(&mut self) {
        // 关闭失败没有可恢复动作；系统剪贴板会在下一次成功打开时自愈。
        unsafe {
            let _ = windows::Win32::System::DataExchange::CloseClipboard();
        }
    }
}

fn read_files_and_text() -> Result<ClipboardAvailability> {
    unsafe {
        use windows::Win32::System::DataExchange::OpenClipboard;
        // hwndOwner 传 None：剪贴板与当前线程关联即可，本应用只有一个窗口。
        if let Err(err) = OpenClipboard(None) {
            return Err(AppError::detailed(Code::ClipboardBusy, err));
        }
        let _guard = OpenClipboardGuard;
        collect_within_open_clipboard()
    }
}

/// 前置条件：调用线程已经成功 `OpenClipboard`。
unsafe fn collect_within_open_clipboard() -> Result<ClipboardAvailability> {
    use windows::Win32::System::Ole::{CF_HDROP, CF_UNICODETEXT};
    use windows::Win32::System::DataExchange::IsClipboardFormatAvailable;

    let mut availability = ClipboardAvailability::new();
    // CF_* 常量在 0.62 里是内层 u16 的 CLIPBOARD_FORMAT 新类型，Win32 函数按 u32 取值。
    let cf_hdrop = u32::from(CF_HDROP.0);
    let cf_unicode_text = u32::from(CF_UNICODETEXT.0);
    if IsClipboardFormatAvailable(cf_hdrop).is_ok() {
        availability.files = Some(read_hdrop_paths(cf_hdrop)?);
        // 文件列表在场时文本注定被裁决忽略，不必再取一次数据句柄。
        return Ok(availability);
    }
    if IsClipboardFormatAvailable(cf_unicode_text).is_ok() {
        availability.text = Some(read_unicode_text(cf_unicode_text)?);
    }
    Ok(availability)
}

/// 把 `CF_HDROP` 句柄里的路径序列复制成自有 `PathBuf`。
///
/// `DragQueryFileW` 以 `u32::MAX` 查询条目数、以有效索引先查长度再取内容；
/// 返回的字符数不含终止 NUL，因此缓冲区比它多留一格。
unsafe fn read_hdrop_paths(format: u32) -> Result<Vec<PathBuf>> {
    use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};

    let handle = clipboard_data(format)?;
    let hdrop = HDROP(handle.0);
    let count = DragQueryFileW(hdrop, u32::MAX, None);
    let mut paths = Vec::with_capacity(count as usize);
    for index in 0..count {
        let char_len = DragQueryFileW(hdrop, index, None) as usize;
        let mut buffer = vec![0u16; char_len + 1];
        let copied = DragQueryFileW(hdrop, index, Some(&mut buffer));
        buffer.truncate(copied as usize);
        paths.push(PathBuf::from(String::from_utf16_lossy(&buffer)));
    }
    Ok(paths)
}

/// 复制 `CF_UNICODETEXT` 的 NUL 终止 UTF-16 序列。
///
/// 全局内存块大小兜底扫描上限，防止畸形内容缺少终止符时越界；
/// 解码只在复制完成之后进行，锁定时间保持最短。
unsafe fn read_unicode_text(format: u32) -> Result<String> {
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

    let handle = clipboard_data(format)?;
    let block = HGLOBAL(handle.0);
    let pointer = GlobalLock(block);
    if pointer.is_null() {
        let err = windows::core::Error::from_thread();
        let _ = GlobalUnlock(block);
        return Err(AppError::detailed(Code::ClipboardReadFailed, err));
    }
    let unit_count = (GlobalSize(block) / 2).max(1);
    let units = std::slice::from_raw_parts(pointer.cast::<u16>(), unit_count);
    let end = units.iter().position(|&unit| unit == 0).unwrap_or(unit_count);
    let text = String::from_utf16_lossy(&units[..end]);
    let _ = GlobalUnlock(block);
    Ok(text)
}

/// 取当前格式的数据句柄并立即转成 `HANDLE`。句柄归剪贴板所有，调用方不得
/// 释放，只能在 `CloseClipboard` 之前使用。
unsafe fn clipboard_data(format: u32) -> Result<windows::Win32::Foundation::HANDLE> {
    use windows::Win32::System::DataExchange::GetClipboardData;
    GetClipboardData(format).map_err(|err| AppError::detailed(Code::ClipboardReadFailed, err))
}
