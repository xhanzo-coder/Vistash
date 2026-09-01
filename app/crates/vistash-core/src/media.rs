//! 媒体处理：解码、降采样与缩略图编码。
//!
//! 全部像素读取都发生在这里。界面层只消费本模块产出的缩略图与色卡结果，不得自行
//! 用 `Canvas` 一类手段读取像素——把像素处理集中在 Rust 侧，是为了让缩放与采样的
//! 结果可被测试锁定，而浏览器的缩放行为会随内核版本变化。

use crate::error::{AppError, Code, Result};
use image::imageops::FilterType;
use image::{DynamicImage, ImageFormat, ImageReader};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// 缩略图长边像素数。
///
/// 普通画幅的卡片宽度不大，但超长图会在保留画幅时产生 500px 以上的 CSS 长边。
/// 512 长边会被 WebView 再放大；1024 让当前中等密度在 1× DPI 下不放大，
/// 并为高 DPI 留出明显余量。缩略图是派生数据，调整该值只触发缩略图树重建。
pub const THUMBNAIL_LONG_EDGE: u32 = 1024;

/// 色卡取样用的长边像素数。
///
/// 聚类在降采样后的图上进行，因此色卡耗时与原图尺寸无关。该值参与色卡的确定性，
/// 改动必须提升 `colorcard::ALGO_VERSION`。
pub const COLOR_SAMPLE_LONG_EDGE: u32 = 160;

/// 重采样滤波器。写死而不做可配置项：它参与色卡的确定性。
pub const RESAMPLE_FILTER: FilterType = FilterType::Lanczos3;

/// 缩略图的 WebP 有损质量。
///
/// 取 80 的依据是任务 6.4 在真实素材上的实测（结论已写回设计第四条）：512 长边下
/// q=80 产出 17–18 KB，而无损是 168–189 KB，相差十倍；再往上到 85 与 90 分别多花
/// 25% 与 60% 的体积。
///
/// 改动它必须同时提升 `import::THUMBNAIL_FORMAT_VERSION`，否则库里会混着两代缩略图
/// 而不报任何错。
pub const THUMBNAIL_WEBP_QUALITY: f32 = 80.0;

/// 本变更支持的图片格式。
///
/// PSD 与 RAW 已被 asset-library 的 v1 范围需求显式排除；AVIF 与 HEIC 排除的原因
/// 是其解码通常需要额外的系统级依赖，会把"引入一个 C 库"的成本压进第一个变更。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MediaType {
    Png,
    Jpeg,
    Webp,
    Gif,
    Bmp,
}

pub const SUPPORTED_MEDIA_TYPES: &[MediaType] = &[
    MediaType::Png,
    MediaType::Jpeg,
    MediaType::Webp,
    MediaType::Gif,
    MediaType::Bmp,
];

impl MediaType {
    /// 由文件扩展名判定。大小写不敏感。
    pub fn from_extension(ext: &str) -> Option<Self> {
        match ext.to_ascii_lowercase().as_str() {
            "png" => Some(Self::Png),
            "jpg" | "jpeg" => Some(Self::Jpeg),
            "webp" => Some(Self::Webp),
            "gif" => Some(Self::Gif),
            "bmp" => Some(Self::Bmp),
            _ => None,
        }
    }

    fn from_image_format(f: ImageFormat) -> Option<Self> {
        match f {
            ImageFormat::Png => Some(Self::Png),
            ImageFormat::Jpeg => Some(Self::Jpeg),
            ImageFormat::WebP => Some(Self::Webp),
            ImageFormat::Gif => Some(Self::Gif),
            ImageFormat::Bmp => Some(Self::Bmp),
            _ => None,
        }
    }

    /// 稳定的字符串标识，与本类型的序列化形式一致。
    ///
    /// 与 `library_ext` 不是一回事：`Jpeg` 的标识是 `jpeg`，而库内扩展名是 `jpg`。
    /// 索引与界面用本方法，路径拼接用 `library_ext`。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpeg",
            Self::Webp => "webp",
            Self::Gif => "gif",
            Self::Bmp => "bmp",
        }
    }

    /// 库内本体使用的扩展名。同一格式的多种外部扩展名（jpg/jpeg）在库内归一。
    pub fn library_ext(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpg",
            Self::Webp => "webp",
            Self::Gif => "gif",
            Self::Bmp => "bmp",
        }
    }
}

/// 一次解码的结果。
#[derive(Debug)]
pub struct Decoded {
    pub media_type: MediaType,
    pub image: DynamicImage,
}

impl Decoded {
    pub fn width(&self) -> u32 {
        self.image.width()
    }

    pub fn height(&self) -> u32 {
        self.image.height()
    }
}

/// 解码一个文件。
///
/// 先按扩展名筛掉清单外的格式，再用文件头确认真实格式也在清单内。两道检查都需要：
/// 扩展名检查给出的失败信息更有用，文件头检查防止改名的文件绕过清单。
pub fn decode(path: &Path) -> Result<Decoded> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default();
    let by_ext = MediaType::from_extension(ext).ok_or_else(|| {
        AppError::detailed(
            Code::ImportUnsupportedMediaType,
            format!("扩展名不在支持清单内：{}", path.display()),
        )
    })?;

    let reader = ImageReader::open(path)
        .map_err(|e| {
            AppError::detailed(
                Code::ImportSourceUnreadable,
                format!("{}: {e}", path.display()),
            )
        })?
        .with_guessed_format()
        .map_err(|e| {
            AppError::detailed(
                Code::ImportDecodeFailed,
                format!("无法判定格式 {}: {e}", path.display()),
            )
        })?;

    let detected = reader
        .format()
        .and_then(MediaType::from_image_format)
        .ok_or_else(|| {
            AppError::detailed(
                Code::ImportUnsupportedMediaType,
                format!("文件头指向的格式不在支持清单内：{}", path.display()),
            )
        })?;

    // 扩展名与真实格式不一致时以真实格式为准，但仍要求它在清单内。
    let _ = by_ext;

    let image = reader.decode().map_err(|e| {
        AppError::detailed(
            Code::ImportDecodeFailed,
            format!("{}: {e}", path.display()),
        )
    })?;
    finish_decode(image, detected)
}

/// 解码一段内存字节（设计第十一条：剪贴板位图在 Rust 侧编码为 PNG 后直接
/// 进入导入管线，没有源文件可读）。格式只由文件头判定。
pub fn decode_bytes(bytes: &[u8]) -> Result<Decoded> {
    let reader = ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| AppError::detailed(Code::ImportDecodeFailed, format!("无法判定格式：{e}")))?;
    let detected = reader
        .format()
        .and_then(MediaType::from_image_format)
        .ok_or_else(|| {
            AppError::detailed(
                Code::ImportUnsupportedMediaType,
                "字节内容指向的格式不在支持清单内",
            )
        })?;
    let image = reader.decode().map_err(|e| {
        AppError::detailed(Code::ImportDecodeFailed, format!("解码失败：{e}"))
    })?;
    finish_decode(image, detected)
}

fn finish_decode(image: DynamicImage, media_type: MediaType) -> Result<Decoded> {
    Ok(Decoded { media_type, image })
}

/// 按长边等比缩放后的目标尺寸。小于目标的图不放大。
pub fn fit_within(width: u32, height: u32, long_edge: u32) -> (u32, u32) {
    if width == 0 || height == 0 {
        return (width, height);
    }
    if width.max(height) <= long_edge {
        return (width, height);
    }
    let scale = long_edge as f64 / width.max(height) as f64;
    // 至少保留 1 像素，避免极端画幅缩成 0 宽或 0 高。
    let w = ((width as f64 * scale).round() as u32).max(1);
    let h = ((height as f64 * scale).round() as u32).max(1);
    (w, h)
}

/// 生成缩略图的 WebP 字节。
///
/// 选 WebP 而不是 JPEG 的原因是素材可以带透明区域，JPEG 无透明通道会显示为一个
/// 并不存在的实色背景。保持宽高比而不裁成方形，因为画幅是素材的关键属性。
pub fn encode_thumbnail(image: &DynamicImage) -> Result<Vec<u8>> {
    let (w, h) = fit_within(image.width(), image.height(), THUMBNAIL_LONG_EDGE);
    let scaled = if (w, h) == (image.width(), image.height()) {
        image.clone()
    } else {
        image.resize_exact(w, h, RESAMPLE_FILTER)
    };
    let rgba = scaled.to_rgba8();
    // 有损而非无损。`image` 自带的 WebP 编码器只能无损（crate 自己写着"要有损就得用
    // libwebp"），而无损 WebP 在照片上没有任何体积优势——实测一张 152 KB 的 JPEG，
    // 其 512 长边无损缩略图是 168 KB，比原图还大。缩略图的存在意义就是让网格加载得比
    // 读原图快，比原图还大等于把这个意义抵消掉。
    //
    // 透明通道不受影响：libwebp 对 alpha 平面单独做无损压缩，实测 q=75 与 q=90 下
    // 全透明与全不透明区域的 alpha 都精确保留。
    let encoded = webp::Encoder::from_rgba(rgba.as_raw(), rgba.width(), rgba.height())
        .encode(THUMBNAIL_WEBP_QUALITY);
    Ok(encoded.to_vec())
}

/// 为色卡取样降采样。返回 RGBA8 像素与其尺寸。
pub fn sample_for_color_card(image: &DynamicImage) -> image::RgbaImage {
    let (w, h) = fit_within(image.width(), image.height(), COLOR_SAMPLE_LONG_EDGE);
    if (w, h) == (image.width(), image.height()) {
        image.to_rgba8()
    } else {
        image.resize_exact(w, h, RESAMPLE_FILTER).to_rgba8()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgba, RgbaImage};

    fn solid(w: u32, h: u32, px: Rgba<u8>) -> DynamicImage {
        DynamicImage::ImageRgba8(RgbaImage::from_pixel(w, h, px))
    }

    #[test]
    fn extension_mapping_is_case_insensitive_and_normalises_jpeg() {
        assert_eq!(MediaType::from_extension("PNG"), Some(MediaType::Png));
        assert_eq!(MediaType::from_extension("jpg"), Some(MediaType::Jpeg));
        assert_eq!(MediaType::from_extension("JPEG"), Some(MediaType::Jpeg));
        assert_eq!(MediaType::from_extension("jpeg").unwrap().library_ext(), "jpg");
        assert_eq!(MediaType::from_extension("psd"), None);
        assert_eq!(MediaType::from_extension("avif"), None);
    }

    #[test]
    fn as_str_matches_the_serialized_form() {
        // 索引把 as_str 的结果存成 TEXT，而侧车存的是序列化形式。两者一旦分叉，
        // 同一个格式在索引与侧车里就是两个不同的字符串。
        for &m in SUPPORTED_MEDIA_TYPES {
            let json = serde_json::to_string(&m).expect("序列化媒体类型");
            assert_eq!(json, format!("\"{}\"", m.as_str()));
        }
    }

    #[test]
    fn supported_list_has_exactly_five_entries() {
        // 设计第八条把本次范围收窄为五种。数量变化必须是有意的。
        assert_eq!(SUPPORTED_MEDIA_TYPES.len(), 5);
    }

    #[test]
    fn images_smaller_than_the_target_are_not_upscaled() {
        assert_eq!(fit_within(100, 80, 512), (100, 80));
        assert_eq!(fit_within(512, 300, 512), (512, 300));
    }

    #[test]
    fn aspect_ratio_survives_downscaling() {
        // 画幅是素材的关键属性，方形裁切会让使用者在网格里对画幅产生误判。
        let (w, h) = fit_within(4000, 2000, 512);
        assert_eq!((w, h), (512, 256));
        let (w, h) = fit_within(2000, 4000, 512);
        assert_eq!((w, h), (256, 512));
    }

    #[test]
    fn tall_material_thumbnail_covers_the_medium_waterfall_card_without_upscaling() {
        let image = solid(676, 1726, Rgba([25, 45, 65, 255]));
        let bytes = encode_thumbnail(&image).expect("编码超长图缩略图");
        let decoded = image::load_from_memory(&bytes).expect("解回超长图缩略图");
        assert_eq!((decoded.width(), decoded.height()), (401, 1024));
    }

    #[test]
    fn extreme_aspect_ratios_keep_at_least_one_pixel() {
        let (w, h) = fit_within(10_000, 3, 512);
        assert_eq!(w, 512);
        assert!(h >= 1, "极端画幅缩成了 0 高");
    }

    #[test]
    fn thumbnail_encodes_to_webp_and_preserves_alpha() {
        // 透明素材若被编码进无透明通道的格式，会显示出一个并不存在的实色背景。
        let img = solid(800, 400, Rgba([10, 20, 30, 0]));
        let bytes = encode_thumbnail(&img).expect("编码缩略图");
        assert!(bytes.len() > 12, "缩略图字节过短");
        assert_eq!(&bytes[0..4], b"RIFF", "不是 RIFF 容器");
        assert_eq!(&bytes[8..12], b"WEBP", "不是 WebP");

        let decoded = image::load_from_memory(&bytes).expect("解回缩略图");
        assert_eq!((decoded.width(), decoded.height()), (800, 400));
        assert_eq!(decoded.to_rgba8().get_pixel(0, 0)[3], 0, "透明通道丢失");
    }

    #[test]
    fn thumbnail_of_a_small_image_keeps_its_original_size() {
        let img = solid(64, 32, Rgba([1, 2, 3, 255]));
        let bytes = encode_thumbnail(&img).expect("编码缩略图");
        let decoded = image::load_from_memory(&bytes).expect("解回缩略图");
        assert_eq!((decoded.width(), decoded.height()), (64, 32));
    }

    #[test]
    fn color_sample_downscales_to_the_documented_long_edge() {
        let img = solid(4000, 2000, Rgba([9, 9, 9, 255]));
        let s = sample_for_color_card(&img);
        assert_eq!((s.width(), s.height()), (160, 80));
    }

    #[test]
    fn renamed_file_cannot_bypass_the_supported_list() {
        // 把不支持的内容改成 .png 扩展名后，仍应因文件头判定而被拒绝。
        let dir = tempfile::tempdir().expect("建立临时目录");
        let p = dir.path().join("伪装.png");
        std::fs::write(&p, "这不是任何图片格式的文件头".as_bytes()).expect("写入伪装文件");
        let err = decode(&p).expect_err("本应拒绝");
        assert!(
            err.code == Code::ImportUnsupportedMediaType || err.code == Code::ImportDecodeFailed,
            "错误码不符预期：{}",
            err.code
        );
    }

    #[test]
    fn unsupported_extension_is_refused_before_decoding() {
        let dir = tempfile::tempdir().expect("建立临时目录");
        let p = dir.path().join("图层.psd");
        std::fs::write(&p, b"8BPS").expect("写入样本");
        let err = decode(&p).expect_err("本应拒绝");
        assert_eq!(err.code, Code::ImportUnsupportedMediaType);
    }

    #[test]
    fn missing_file_reports_source_unreadable() {
        let err = decode(Path::new("不存在的目录/不存在.png")).expect_err("本应失败");
        assert_eq!(err.code, Code::ImportSourceUnreadable);
    }

    #[test]
    fn a_real_png_round_trips_through_decode() {
        let dir = tempfile::tempdir().expect("建立临时目录");
        let p = dir.path().join("样例.png");
        solid(20, 10, Rgba([200, 100, 50, 255]))
            .save_with_format(&p, ImageFormat::Png)
            .expect("写入 PNG");
        let d = decode(&p).expect("解码 PNG");
        assert_eq!(d.media_type, MediaType::Png);
        assert_eq!((d.width(), d.height()), (20, 10));
    }
}
