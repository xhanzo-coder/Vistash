//! `Catalog` 各子模块共用的测试夹具。
//!
//! 夹具单独成模块而不是放进其中一个子模块：三组测试都需要"一个真实库加一张真实
//! 图片"，把它放在任意一个领域模块里，另外两个模块就得跨领域引用一个与自己无关的
//! 名字。夹具用真实 PNG 与真实临时目录，不用内存假实现——`Catalog` 的正确性几乎
//! 全部落在文件移动与原子写入上，假掉文件系统等于假掉被测对象。

use super::Catalog;
use crate::import::{import_one, ImportOptions, NoopObserver};
use crate::library::Library;
use crate::sidecar::AssetSidecar;
use image::{DynamicImage, ImageFormat, Rgba, RgbaImage};
use std::path::{Path, PathBuf};

// `synthetic_sidecar` 只服务 release 性能基线，debug 构建不编译它，import 也一并门控，
// 否则 debug 下会报 unused import。
#[cfg(not(debug_assertions))]
use crate::colorcard::ColorCard;
#[cfg(not(debug_assertions))]
use crate::error::Code;
#[cfg(not(debug_assertions))]
use crate::hashing::{ContentHash, HASH_ALGO_ID};
#[cfg(not(debug_assertions))]
use crate::media::MediaType;
#[cfg(not(debug_assertions))]
use crate::sidecar::SIDECAR_FORMAT_VERSION_V2;

pub(super) struct Fixture {
    pub(super) catalog: Catalog,
    pub(super) source: PathBuf,
    pub(super) _dir: tempfile::TempDir,
}

pub(super) fn fixture() -> Fixture {
    let temp_root =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/vistash-test-temp");
    std::fs::create_dir_all(&temp_root).expect("建立 E 盘项目测试目录");
    let dir = tempfile::tempdir_in(temp_root).expect("建立项目临时目录");
    let source = dir.path().join("source");
    std::fs::create_dir(&source).expect("建立来源目录");
    let library = Library::create(&dir.path().join("library")).expect("建立库");
    let catalog = Catalog::open(library).expect("打开目录");
    Fixture {
        catalog,
        source,
        _dir: dir,
    }
}

pub(super) fn write_png(dir: &Path, name: &str, color: [u8; 4]) -> PathBuf {
    let path = dir.join(name);
    DynamicImage::ImageRgba8(RgbaImage::from_pixel(16, 16, Rgba(color)))
        .save_with_format(&path, ImageFormat::Png)
        .expect("写入图片");
    path
}

pub(super) fn import_with(
    catalog: &mut Catalog,
    source: &Path,
    folders: &[&str],
    tags: &[&str],
) -> AssetSidecar {
    let options = ImportOptions {
        folders: folders.iter().map(|folder| (*folder).to_owned()).collect(),
        tags: tags.iter().map(|tag| (*tag).to_owned()).collect(),
    };
    let sidecar =
        import_one(catalog.library(), source, &options, &mut NoopObserver).expect("导入素材");
    catalog
        .index_imported(std::slice::from_ref(&sidecar))
        .expect("写入索引");
    sidecar
}

#[cfg(not(debug_assertions))]
pub(super) fn synthetic_sidecar(index: usize, folders: &[&str], tags: &[&str]) -> AssetSidecar {
    AssetSidecar {
        format_version: SIDECAR_FORMAT_VERSION_V2,
        hash: ContentHash::of_bytes(&index.to_le_bytes()),
        hash_algo: HASH_ALGO_ID.to_owned(),
        media_type: MediaType::Png,
        ext: "png".to_owned(),
        byte_size: 1,
        width: 1,
        height: 1,
        imported_at: chrono::DateTime::from_timestamp(index as i64, 0).expect("构造固定时间戳"),
        original_filename: format!("素材-{index:05}-人物.png"),
        source_path: None,
        folders: folders.iter().map(|value| (*value).to_owned()).collect(),
        tags: tags.iter().map(|value| (*value).to_owned()).collect(),
        color_card: ColorCard::failed(Code::ColorCardInsufficientOpaquePixels),
        note: String::new(),
        favorite: false,
        deleted_at: None,
        deleted_from_folders: None,
    }
}

