//! Windows 剪贴板生产 adapter（任务 5.1，选型冻结于设计第十一条）。
//!
//! 文件列表与纯文本经 Win32 读取：`OpenClipboard` 打开失败必须返回稳定的
//! `clipboard.busy`（其他进程独占剪贴板很常见，冒充空剪贴板会让界面把粘贴
//! 无效果误报成没有内容）；`GetClipboardData` 返回的句柄归剪贴板所有，因此
//! 在 RAII `CloseClipboard` guard 的保护内用 `DragQueryFileW` 把路径完整
//! 复制成自有 `PathBuf`，目录扫描、PNG 编码等耗时工作只能在关闭剪贴板之后。
//! 位图直接读取 `CF_DIBV5`/`CF_DIB` 的全局内存块。不能委托给插件的通用
//! `read_image()`：截图工具常用 delayed-rendered DIB，插件会在 Windows 已明确
//! 报告位图时仍返回格式转换失败。这里在同一次 `OpenClipboard` 会话内只校验固定头
//! 并复制有上限的 DIB 字节，关闭剪贴板后才解码，既避免二次打开竞态，也不让逐像素
//! 工作长时间占用系统剪贴板。
//!
//! 分流一律交给核心的 [`vistash_core::clipboard::arbitrate`]，本模块只负责
//! "取出有什么"，不做产品判断。真实系统剪贴板的端到端行为无法在自动化测试里
//! 确定性地播种，按设计第十一条的风险预案由 release Tauri 构建的 Windows 层
//! 验收（任务 11.5）覆盖；本模块的分流正确性由核心契约测试保证。

use std::path::PathBuf;

use vistash_core::clipboard::{
    arbitrate, BitmapImage, ClipboardAvailability, ClipboardPayload, ClipboardPort,
    MAX_BITMAP_PIXELS,
};
use vistash_core::error::{AppError, Code, Result};

#[derive(Default)]
pub struct WindowsClipboard;

impl WindowsClipboard {
    pub fn new() -> Self {
        Self
    }
}

impl ClipboardPort for WindowsClipboard {
    fn snapshot(&mut self) -> Result<ClipboardPayload> {
        Ok(arbitrate(read_available_content()?))
    }
}

struct RawClipboardContent {
    files: Option<Vec<PathBuf>>,
    dib: Option<Vec<u8>>,
    text: Option<String>,
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

fn read_available_content() -> Result<ClipboardAvailability> {
    let raw = unsafe {
        use windows::Win32::System::DataExchange::OpenClipboard;
        // hwndOwner 传 None：剪贴板与当前线程关联即可，本应用只有一个窗口。
        if let Err(err) = OpenClipboard(None) {
            return Err(AppError::detailed(Code::ClipboardBusy, err));
        }
        let _guard = OpenClipboardGuard;
        collect_within_open_clipboard()
    }?;
    let bitmap = raw.dib.map(|dib| decode_dib(&dib)).transpose()?;
    Ok(ClipboardAvailability {
        files: raw.files,
        bitmap,
        text: raw.text,
    })
}

/// 前置条件：调用线程已经成功 `OpenClipboard`。
unsafe fn collect_within_open_clipboard() -> Result<RawClipboardContent> {
    use windows::Win32::System::DataExchange::IsClipboardFormatAvailable;
    use windows::Win32::System::Ole::{CF_DIB, CF_DIBV5, CF_HDROP, CF_UNICODETEXT};

    let mut content = RawClipboardContent {
        files: None,
        dib: None,
        text: None,
    };
    // CF_* 常量在 0.62 里是内层 u16 的 CLIPBOARD_FORMAT 新类型，Win32 函数按 u32 取值。
    let cf_hdrop = u32::from(CF_HDROP.0);
    let cf_unicode_text = u32::from(CF_UNICODETEXT.0);
    if IsClipboardFormatAvailable(cf_hdrop).is_ok() {
        content.files = Some(read_hdrop_paths(cf_hdrop)?);
        // 文件列表在场时文本注定被裁决忽略，不必再取一次数据句柄。
        return Ok(content);
    }
    if IsClipboardFormatAvailable(cf_unicode_text).is_ok() {
        content.text = Some(read_unicode_text(cf_unicode_text)?);
    }
    let bitmap_formats = [u32::from(CF_DIBV5.0), u32::from(CF_DIB.0)];
    let mut last_bitmap_error = None;
    for format in bitmap_formats {
        if IsClipboardFormatAvailable(format).is_err() {
            continue;
        }
        match copy_dib(format) {
            Ok(dib) => {
                content.dib = Some(dib);
                return Ok(content);
            }
            Err(error) => last_bitmap_error = Some(error),
        }
    }
    if let Some(error) = last_bitmap_error {
        return Err(error);
    }
    Ok(content)
}

/// 在锁内只读取固定头、验证尺寸上限并复制确切像素范围；解码由 guard 释放后完成。
unsafe fn copy_dib(format: u32) -> Result<Vec<u8>> {
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

    let handle = clipboard_data(format)?;
    let block = HGLOBAL(handle.0);
    let byte_count = GlobalSize(block);
    if byte_count == 0 {
        return Err(AppError::detailed(
            Code::ClipboardImageInvalid,
            "Windows DIB 内存块为空",
        ));
    }
    let pointer = GlobalLock(block);
    if pointer.is_null() {
        let error = windows::core::Error::from_thread();
        let _ = GlobalUnlock(block);
        return Err(AppError::detailed(Code::ClipboardReadFailed, error));
    }
    let prefix_len = byte_count.min(140);
    let prefix = std::slice::from_raw_parts(pointer.cast::<u8>(), prefix_len);
    let copy_len = match validated_dib_copy_len(prefix, byte_count) {
        Ok(copy_len) => copy_len,
        Err(error) => {
            let _ = GlobalUnlock(block);
            return Err(error);
        }
    };
    let bytes = std::slice::from_raw_parts(pointer.cast::<u8>(), copy_len).to_vec();
    let _ = GlobalUnlock(block);
    Ok(bytes)
}

fn dib_invalid(detail: impl std::fmt::Display) -> AppError {
    AppError::detailed(Code::ClipboardImageInvalid, detail)
}

fn read_u16(bytes: &[u8], offset: usize, field: &str) -> Result<u16> {
    let slice = bytes
        .get(offset..offset + 2)
        .ok_or_else(|| dib_invalid(format!("DIB 缺少 {field}")))?;
    Ok(u16::from_le_bytes([slice[0], slice[1]]))
}

fn read_u32(bytes: &[u8], offset: usize, field: &str) -> Result<u32> {
    let slice = bytes
        .get(offset..offset + 4)
        .ok_or_else(|| dib_invalid(format!("DIB 缺少 {field}")))?;
    Ok(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn read_i32(bytes: &[u8], offset: usize, field: &str) -> Result<i32> {
    Ok(read_u32(bytes, offset, field)? as i32)
}

fn validated_dib_copy_len(prefix: &[u8], total_len: usize) -> Result<usize> {
    const BI_RGB: u32 = 0;
    const BI_BITFIELDS: u32 = 3;

    let header_size = read_u32(prefix, 0, "头长度")? as usize;
    if !matches!(header_size, 40 | 52 | 56 | 108 | 124) {
        return Err(dib_invalid(format!("不支持的 DIB 头长度：{header_size}")));
    }
    let width = read_i32(prefix, 4, "宽度")?;
    let signed_height = read_i32(prefix, 8, "高度")?;
    if width <= 0 || signed_height == 0 || signed_height == i32::MIN {
        return Err(dib_invalid(format!(
            "DIB 尺寸非法：{width}x{signed_height}"
        )));
    }
    if read_u16(prefix, 12, "平面数")? != 1 {
        return Err(dib_invalid("DIB 平面数必须为 1"));
    }
    let bits_per_pixel = read_u16(prefix, 14, "位深")?;
    if bits_per_pixel != 24 && bits_per_pixel != 32 {
        return Err(dib_invalid(format!("不支持的 DIB 位深：{bits_per_pixel}")));
    }
    let compression = read_u32(prefix, 16, "压缩方式")?;
    if compression != BI_RGB && compression != BI_BITFIELDS {
        return Err(dib_invalid(format!("不支持的 DIB 压缩方式：{compression}")));
    }
    if compression == BI_BITFIELDS && bits_per_pixel != 32 {
        return Err(dib_invalid("BI_BITFIELDS 目前只支持 32-bit DIB"));
    }
    let area = (width as usize)
        .checked_mul(signed_height.unsigned_abs() as usize)
        .ok_or_else(|| AppError::new(Code::ClipboardImageTooLarge))?;
    if area > MAX_BITMAP_PIXELS {
        return Err(AppError::detailed(
            Code::ClipboardImageTooLarge,
            format!("{area} 像素超出上限 {MAX_BITMAP_PIXELS}"),
        ));
    }
    let row_bits = (width as usize)
        .checked_mul(bits_per_pixel as usize)
        .ok_or_else(|| AppError::new(Code::ClipboardImageTooLarge))?;
    let row_stride = row_bits
        .checked_add(31)
        .and_then(|value| value.checked_div(32))
        .and_then(|value| value.checked_mul(4))
        .ok_or_else(|| AppError::new(Code::ClipboardImageTooLarge))?;
    let pixel_offset = if compression == BI_BITFIELDS && header_size == 40 {
        52
    } else {
        header_size
    };
    let pixel_end = row_stride
        .checked_mul(signed_height.unsigned_abs() as usize)
        .and_then(|pixel_bytes| pixel_offset.checked_add(pixel_bytes))
        .ok_or_else(|| AppError::new(Code::ClipboardImageTooLarge))?;
    if pixel_end > total_len {
        return Err(dib_invalid(format!(
            "DIB 像素缓冲被截断：需要 {pixel_end} 字节，实际 {total_len} 字节"
        )));
    }
    Ok(pixel_end)
}

#[derive(Clone, Copy)]
struct ChannelMasks {
    red: u32,
    green: u32,
    blue: u32,
    alpha: u32,
}

fn channel(value: u32, mask: u32, default: u8) -> Result<u8> {
    if mask == 0 {
        return Ok(default);
    }
    let shift = mask.trailing_zeros();
    let normalized_mask = mask >> shift;
    if !normalized_mask.wrapping_add(1).is_power_of_two() {
        return Err(dib_invalid(format!("DIB 颜色掩码不连续：0x{mask:08x}")));
    }
    let raw = (value & mask) >> shift;
    Ok(((u64::from(raw) * 255) / u64::from(normalized_mask)) as u8)
}

/// 解码剪贴板 DIB。首版覆盖 Windows 截图与主流截图工具实际提供的 24-bit
/// `BI_RGB` 和 32-bit `BI_RGB`/`BI_BITFIELDS`；其他压缩格式明确拒绝。
fn decode_dib(bytes: &[u8]) -> Result<BitmapImage> {
    const BI_RGB: u32 = 0;
    const BI_BITFIELDS: u32 = 3;

    let header_size = read_u32(bytes, 0, "头长度")? as usize;
    if !matches!(header_size, 40 | 52 | 56 | 108 | 124) || header_size > bytes.len() {
        return Err(dib_invalid(format!("不支持的 DIB 头长度：{header_size}")));
    }
    let width_i32 = read_i32(bytes, 4, "宽度")?;
    let signed_height = read_i32(bytes, 8, "高度")?;
    if width_i32 <= 0 || signed_height == 0 || signed_height == i32::MIN {
        return Err(dib_invalid(format!(
            "DIB 尺寸非法：{width_i32}x{signed_height}"
        )));
    }
    if read_u16(bytes, 12, "平面数")? != 1 {
        return Err(dib_invalid("DIB 平面数必须为 1"));
    }
    let bits_per_pixel = read_u16(bytes, 14, "位深")?;
    if bits_per_pixel != 24 && bits_per_pixel != 32 {
        return Err(dib_invalid(format!("不支持的 DIB 位深：{bits_per_pixel}")));
    }
    let compression = read_u32(bytes, 16, "压缩方式")?;
    if compression != BI_RGB && compression != BI_BITFIELDS {
        return Err(dib_invalid(format!("不支持的 DIB 压缩方式：{compression}")));
    }
    if compression == BI_BITFIELDS && bits_per_pixel != 32 {
        return Err(dib_invalid("BI_BITFIELDS 目前只支持 32-bit DIB"));
    }

    let width = width_i32 as usize;
    let height = signed_height.unsigned_abs() as usize;
    let area = width
        .checked_mul(height)
        .ok_or_else(|| AppError::new(Code::ClipboardImageTooLarge))?;
    if area > MAX_BITMAP_PIXELS {
        return Err(AppError::detailed(
            Code::ClipboardImageTooLarge,
            format!("{area} 像素超出上限 {MAX_BITMAP_PIXELS}"),
        ));
    }
    let row_bits = width
        .checked_mul(bits_per_pixel as usize)
        .ok_or_else(|| AppError::new(Code::ClipboardImageTooLarge))?;
    let row_stride = row_bits
        .checked_add(31)
        .and_then(|value| value.checked_div(32))
        .and_then(|value| value.checked_mul(4))
        .ok_or_else(|| AppError::new(Code::ClipboardImageTooLarge))?;
    let pixel_bytes = row_stride
        .checked_mul(height)
        .ok_or_else(|| AppError::new(Code::ClipboardImageTooLarge))?;

    let (masks, pixel_offset) = if compression == BI_BITFIELDS {
        if header_size >= 52 {
            (
                ChannelMasks {
                    red: read_u32(bytes, 40, "红色掩码")?,
                    green: read_u32(bytes, 44, "绿色掩码")?,
                    blue: read_u32(bytes, 48, "蓝色掩码")?,
                    alpha: if header_size >= 56 {
                        read_u32(bytes, 52, "透明度掩码")?
                    } else {
                        0
                    },
                },
                header_size,
            )
        } else {
            (
                ChannelMasks {
                    red: read_u32(bytes, header_size, "红色掩码")?,
                    green: read_u32(bytes, header_size + 4, "绿色掩码")?,
                    blue: read_u32(bytes, header_size + 8, "蓝色掩码")?,
                    alpha: 0,
                },
                header_size + 12,
            )
        }
    } else {
        (
            ChannelMasks {
                red: 0x00ff_0000,
                green: 0x0000_ff00,
                blue: 0x0000_00ff,
                alpha: 0,
            },
            header_size,
        )
    };
    let pixel_end = pixel_offset
        .checked_add(pixel_bytes)
        .ok_or_else(|| AppError::new(Code::ClipboardImageTooLarge))?;
    if pixel_end > bytes.len() {
        return Err(dib_invalid(format!(
            "DIB 像素缓冲被截断：需要 {pixel_end} 字节，实际 {} 字节",
            bytes.len()
        )));
    }

    let rgba_capacity = area
        .checked_mul(4)
        .ok_or_else(|| AppError::new(Code::ClipboardImageTooLarge))?;
    let mut rgba = Vec::with_capacity(rgba_capacity);
    for output_y in 0..height {
        let source_y = if signed_height < 0 {
            output_y
        } else {
            height - output_y - 1
        };
        let row_start = pixel_offset + source_y * row_stride;
        for x in 0..width {
            if bits_per_pixel == 24 {
                let offset = row_start + x * 3;
                rgba.extend_from_slice(&[bytes[offset + 2], bytes[offset + 1], bytes[offset], 255]);
            } else {
                let offset = row_start + x * 4;
                let value = u32::from_le_bytes([
                    bytes[offset],
                    bytes[offset + 1],
                    bytes[offset + 2],
                    bytes[offset + 3],
                ]);
                rgba.extend_from_slice(&[
                    channel(value, masks.red, 0)?,
                    channel(value, masks.green, 0)?,
                    channel(value, masks.blue, 0)?,
                    channel(value, masks.alpha, 255)?,
                ]);
            }
        }
    }
    BitmapImage::new(width, height, rgba)
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
    let end = units
        .iter()
        .position(|&unit| unit == 0)
        .unwrap_or(unit_count);
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

#[cfg(test)]
mod tests {
    use super::*;

    fn put_u16(bytes: &mut [u8], offset: usize, value: u16) {
        bytes[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
    }

    fn put_u32(bytes: &mut [u8], offset: usize, value: u32) {
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }

    fn put_i32(bytes: &mut [u8], offset: usize, value: i32) {
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }

    #[test]
    fn decodes_bottom_up_24_bit_dib_with_row_padding() {
        let mut dib = vec![0_u8; 40 + 16];
        put_u32(&mut dib, 0, 40);
        put_i32(&mut dib, 4, 2);
        put_i32(&mut dib, 8, 2);
        put_u16(&mut dib, 12, 1);
        put_u16(&mut dib, 14, 24);
        put_u32(&mut dib, 20, 16);
        dib[40..48].copy_from_slice(&[255, 0, 0, 255, 255, 255, 0, 0]);
        dib[48..56].copy_from_slice(&[0, 0, 255, 0, 255, 0, 0, 0]);

        let image = decode_dib(&dib).expect("24-bit DIB 应解码");

        assert_eq!((image.width(), image.height()), (2, 2));
        assert_eq!(
            image.rgba(),
            &[255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,]
        );
    }

    #[test]
    fn decodes_top_down_v5_bitfields_and_preserves_alpha() {
        let mut dib = vec![0_u8; 124 + 8];
        put_u32(&mut dib, 0, 124);
        put_i32(&mut dib, 4, 2);
        put_i32(&mut dib, 8, -1);
        put_u16(&mut dib, 12, 1);
        put_u16(&mut dib, 14, 32);
        put_u32(&mut dib, 16, 3);
        put_u32(&mut dib, 20, 8);
        put_u32(&mut dib, 40, 0x00ff_0000);
        put_u32(&mut dib, 44, 0x0000_ff00);
        put_u32(&mut dib, 48, 0x0000_00ff);
        put_u32(&mut dib, 52, 0xff00_0000);
        dib[124..132].copy_from_slice(&[0x30, 0x20, 0x10, 0x40, 0x03, 0x02, 0x01, 0xff]);

        let image = decode_dib(&dib).expect("V5 DIB 应解码");

        assert_eq!(
            image.rgba(),
            &[0x10, 0x20, 0x30, 0x40, 0x01, 0x02, 0x03, 0xff]
        );
    }

    #[test]
    fn refuses_oversized_dib_before_copying_the_reported_global_block() {
        let mut header = vec![0_u8; 40];
        put_u32(&mut header, 0, 40);
        put_i32(&mut header, 4, 16_384);
        put_i32(&mut header, 8, 16_384);
        put_u16(&mut header, 12, 1);
        put_u16(&mut header, 14, 32);

        let error =
            validated_dib_copy_len(&header, usize::MAX).expect_err("超大 DIB 应在复制前拒绝");

        assert_eq!(error.code, Code::ClipboardImageTooLarge);
    }

    #[test]
    fn decodes_52_byte_bitfields_header_with_embedded_rgb_masks() {
        let mut dib = vec![0_u8; 56];
        put_u32(&mut dib, 0, 52);
        put_i32(&mut dib, 4, 1);
        put_i32(&mut dib, 8, -1);
        put_u16(&mut dib, 12, 1);
        put_u16(&mut dib, 14, 32);
        put_u32(&mut dib, 16, 3);
        put_u32(&mut dib, 20, 4);
        put_u32(&mut dib, 40, 0x00ff_0000);
        put_u32(&mut dib, 44, 0x0000_ff00);
        put_u32(&mut dib, 48, 0x0000_00ff);
        dib[52..56].copy_from_slice(&[0x33, 0x22, 0x11, 0]);

        let image = decode_dib(&dib).expect("52-byte DIB 应读取头内 RGB 掩码");

        assert_eq!(image.rgba(), &[0x11, 0x22, 0x33, 0xff]);
    }
}
