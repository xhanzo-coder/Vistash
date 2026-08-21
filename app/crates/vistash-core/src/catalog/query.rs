//! 派生索引上的组合查询与索引重建。
//!
//! 本模块只读派生索引，不写权威文件。这条边界是重建等价性的前提：只要查询只经过
//! 索引，"删掉索引重建一次"就必须得到同一批结果，而任何一个绕过索引直接读侧车的
//! 查询都会让这条等价性无法被测试证明。

use crate::error::Result;
use crate::index::{AssetRow, FolderSelection, Index};
use serde::Serialize;

use super::image_metadata::{FolderPath, Tag};
use super::Catalog;

/// 查询的文件夹范围。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FolderFilter {
    All,
    Root,
    Path(FolderPath),
}

/// 查询正常素材或回收站素材。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssetLocation {
    Active,
    Trash,
}

/// 素材编目的一次组合查询。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetQuery {
    pub text: String,
    pub tags: Vec<Tag>,
    pub folder: FolderFilter,
    pub location: AssetLocation,
}

/// 一个标签及其正常素材使用数量。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TagUsage {
    pub tag: String,
    pub count: usize,
}

/// 素材工作区一次刷新所需的一致快照。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CatalogSnapshot {
    pub assets: Vec<AssetRow>,
    pub folders: Vec<String>,
    pub tags: Vec<TagUsage>,
    pub trash_count: usize,
}

impl Catalog {
    pub fn rebuild_index(&mut self) -> Result<()> {
        self.index.take();
        self.index = Some(Index::rebuild(&self.library)?);
        Ok(())
    }


    pub fn snapshot(&self, query: &AssetQuery) -> Result<CatalogSnapshot> {
        let deleted = query.location == AssetLocation::Trash;
        let folder = match (&query.location, &query.folder) {
            (AssetLocation::Trash, _) | (_, FolderFilter::All) => FolderSelection::All,
            (_, FolderFilter::Root) => FolderSelection::Root,
            (_, FolderFilter::Path(path)) => FolderSelection::Exact(path.as_str()),
        };
        let tags: Vec<String> = query
            .tags
            .iter()
            .map(|tag| tag.as_str().to_owned())
            .collect();
        let index = self.index()?;
        let assets = index.query_assets(deleted, folder, &tags, &query.text)?;

        Ok(CatalogSnapshot {
            assets,
            folders: self.library.read_folders()?.folders,
            tags: index
                .active_tag_counts()?
                .into_iter()
                .map(|(tag, count)| TagUsage { tag, count })
                .collect(),
            trash_count: index.deleted_count()?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::image_metadata::FolderName;
    use crate::catalog::testing::{fixture, import_with, write_png};
    use crate::error::Code;
    use crate::import::{import_one, ImportOptions, NoopObserver};
    #[cfg(not(debug_assertions))]
    use crate::catalog::testing::synthetic_sidecar;
    #[cfg(not(debug_assertions))]
    use crate::colorcard::ColorCard;
    #[cfg(not(debug_assertions))]
    use crate::hashing::HASH_ALGO_ID;
    #[cfg(not(debug_assertions))]
    use crate::media::MediaType;
    #[cfg(not(debug_assertions))]
    use crate::sidecar::SIDECAR_FORMAT_VERSION;
    #[cfg(not(debug_assertions))]
    use std::time::{Duration, Instant};

    #[test]
    fn snapshot_combines_unicode_filename_and_all_selected_tags() {
        let mut fixture = fixture();
        let backlit = write_png(&fixture.source, "人物-逆光.png", [255, 0, 0, 255]);
        let front = write_png(&fixture.source, "人物-正面.png", [0, 255, 0, 255]);
        let landscape = write_png(&fixture.source, "风景.png", [0, 0, 255, 255]);
        import_with(&mut fixture.catalog, &backlit, &[], &["人物", "逆光"]);
        import_with(&mut fixture.catalog, &front, &[], &["人物"]);
        import_with(&mut fixture.catalog, &landscape, &[], &["逆光"]);

        let snapshot = fixture
            .catalog
            .snapshot(&AssetQuery {
                text: "人物".to_owned(),
                tags: vec![
                    Tag::parse("人物").expect("标签"),
                    Tag::parse("逆光").expect("标签"),
                ],
                folder: FolderFilter::All,
                location: AssetLocation::Active,
            })
            .expect("查询目录");

        assert_eq!(
            snapshot
                .assets
                .iter()
                .map(|asset| asset.original_filename.as_str())
                .collect::<Vec<_>>(),
            vec!["人物-逆光.png"]
        );
    }

    #[test]
    fn snapshot_root_filter_only_returns_assets_without_folder_membership() {
        let mut fixture = fixture();
        let root = write_png(&fixture.source, "根.png", [255, 0, 0, 255]);
        let filed = write_png(&fixture.source, "已归档.png", [0, 255, 0, 255]);
        import_with(&mut fixture.catalog, &root, &[], &[]);
        import_with(&mut fixture.catalog, &filed, &["参考"], &[]);

        let snapshot = fixture
            .catalog
            .snapshot(&AssetQuery {
                text: String::new(),
                tags: Vec::new(),
                folder: FolderFilter::Root,
                location: AssetLocation::Active,
            })
            .expect("查询根文件夹");

        assert_eq!(snapshot.assets[0].original_filename, "根.png");
    }

    #[test]
    fn snapshot_exact_folder_only_returns_direct_members() {
        let mut fixture = fixture();
        let exact = write_png(&fixture.source, "构图.png", [255, 0, 0, 255]);
        let child = write_png(&fixture.source, "三分法.png", [0, 255, 0, 255]);
        import_with(&mut fixture.catalog, &exact, &["参考"], &[]);
        import_with(&mut fixture.catalog, &child, &["参考/构图"], &[]);

        let snapshot = fixture
            .catalog
            .snapshot(&AssetQuery {
                text: String::new(),
                tags: Vec::new(),
                folder: FolderFilter::Path(FolderPath::parse("参考").expect("文件夹")),
                location: AssetLocation::Active,
            })
            .expect("查询文件夹");

        assert_eq!(snapshot.assets[0].original_filename, "构图.png");
    }

    #[test]
    fn snapshot_trash_location_excludes_active_assets() {
        let mut fixture = fixture();
        let active = write_png(&fixture.source, "正常.png", [255, 0, 0, 255]);
        let deleted = write_png(&fixture.source, "已删除.png", [0, 255, 0, 255]);
        import_with(&mut fixture.catalog, &active, &[], &[]);
        let mut deleted_sidecar = import_with(&mut fixture.catalog, &deleted, &[], &[]);
        deleted_sidecar.deleted_at = Some(chrono::Utc::now());
        deleted_sidecar.deleted_from_folders = Some(Vec::new());
        fixture
            .catalog
            .index_imported(&[deleted_sidecar])
            .expect("更新删除状态");

        let snapshot = fixture
            .catalog
            .snapshot(&AssetQuery {
                text: String::new(),
                tags: Vec::new(),
                folder: FolderFilter::All,
                location: AssetLocation::Trash,
            })
            .expect("查询回收站");

        assert_eq!(snapshot.assets[0].original_filename, "已删除.png");
    }


    #[test]
    fn snapshot_tag_usage_counts_only_active_assets() {
        let mut fixture = fixture();
        let first = write_png(&fixture.source, "一.png", [255, 0, 0, 255]);
        let second = write_png(&fixture.source, "二.png", [0, 255, 0, 255]);
        let deleted = write_png(&fixture.source, "删.png", [0, 0, 255, 255]);
        import_with(&mut fixture.catalog, &first, &[], &["人物"]);
        import_with(&mut fixture.catalog, &second, &[], &["人物", "逆光"]);
        let mut deleted_sidecar = import_with(&mut fixture.catalog, &deleted, &[], &["人物"]);
        deleted_sidecar.deleted_at = Some(chrono::Utc::now());
        deleted_sidecar.deleted_from_folders = Some(Vec::new());
        fixture
            .catalog
            .index_imported(&[deleted_sidecar])
            .expect("更新删除状态");

        let snapshot = fixture
            .catalog
            .snapshot(&AssetQuery {
                text: String::new(),
                tags: Vec::new(),
                folder: FolderFilter::All,
                location: AssetLocation::Active,
            })
            .expect("查询目录");

        assert_eq!(
            snapshot.tags,
            vec![
                TagUsage {
                    tag: "人物".to_owned(),
                    count: 2,
                },
                TagUsage {
                    tag: "逆光".to_owned(),
                    count: 1,
                },
            ]
        );
    }


    #[test]
    fn rebuilt_catalog_preserves_empty_folders_memberships_tags_and_queries() {
        let mut fixture = fixture();
        let reference = fixture
            .catalog
            .create_folder(None, &FolderName::parse("参考").expect("名称"))
            .expect("创建文件夹");
        fixture
            .catalog
            .create_folder(None, &FolderName::parse("空文件夹").expect("名称"))
            .expect("创建空文件夹");
        let source = write_png(&fixture.source, "人物.png", [255, 0, 0, 255]);
        let sidecar = import_with(&mut fixture.catalog, &source, &[], &[]);
        fixture
            .catalog
            .set_asset_folders(&sidecar.hash, &[reference])
            .expect("设置文件夹");
        fixture
            .catalog
            .set_asset_tags(&sidecar.hash, &[Tag::parse("人物").expect("标签")])
            .expect("设置标签");
        let query = AssetQuery {
            text: "人物".to_owned(),
            tags: vec![Tag::parse("人物").expect("标签")],
            folder: FolderFilter::Path(FolderPath::parse("参考").expect("路径")),
            location: AssetLocation::Active,
        };
        let before = fixture.catalog.snapshot(&query).expect("重建前快照");

        fixture.catalog.rebuild_index().expect("重建索引");
        let after = fixture.catalog.snapshot(&query).expect("重建后快照");

        assert_eq!(after, before);
        assert!(after.folders.contains(&"空文件夹".to_owned()));
    }


    #[test]
    fn rebuilt_catalog_preserves_trash_metadata_and_duplicate_detection() {
        let mut fixture = fixture();
        let folder = fixture
            .catalog
            .create_folder(None, &FolderName::parse("参考").expect("名称"))
            .expect("创建文件夹");
        let source = write_png(&fixture.source, "人物.png", [255, 0, 0, 255]);
        let sidecar = import_with(&mut fixture.catalog, &source, &[folder.as_str()], &["人物"]);
        fixture
            .catalog
            .delete_asset(&sidecar.hash)
            .expect("删除素材");
        let query = AssetQuery {
            text: "人物".to_owned(),
            tags: vec![Tag::parse("人物").expect("标签")],
            folder: FolderFilter::All,
            location: AssetLocation::Trash,
        };
        let before = fixture.catalog.snapshot(&query).expect("重建前快照");

        fixture.catalog.rebuild_index().expect("重建索引");
        let after = fixture.catalog.snapshot(&query).expect("重建后快照");
        let duplicate = import_one(
            fixture.catalog.library(),
            &source,
            &ImportOptions::default(),
            &mut NoopObserver,
        )
        .expect_err("回收站重复本应被拒绝");

        assert_eq!(after, before);
        assert_eq!(duplicate.code, Code::ImportDuplicateInTrash);
    }

    #[test]
    #[cfg(not(debug_assertions))]
    #[ignore = "release 性能基线：显式运行 --release --ignored"]
    fn release_query_of_ten_thousand_index_rows_finishes_within_200_ms() {
        let mut fixture = fixture();
        let folder = fixture
            .catalog
            .create_folder(None, &FolderName::parse("参考").expect("文件夹名"))
            .expect("创建文件夹");
        let rows: Vec<AssetSidecar> = (0..10_000)
            .map(|index| synthetic_sidecar(index, &[folder.as_str()], &["人物", "逆光"]))
            .collect();
        fixture
            .catalog
            .index_imported(&rows)
            .expect("构造索引 fixture");
        let query = AssetQuery {
            text: "09999".to_owned(),
            tags: vec![
                Tag::parse("人物").expect("标签"),
                Tag::parse("逆光").expect("标签"),
            ],
            folder: FolderFilter::Path(folder),
            location: AssetLocation::Active,
        };

        let started = Instant::now();
        let snapshot = fixture.catalog.snapshot(&query).expect("执行组合查询");
        let elapsed = started.elapsed();

        assert_eq!(snapshot.assets.len(), 1);
        eprintln!("10,000 条组合查询：{elapsed:?}");
        assert!(
            elapsed <= Duration::from_millis(200),
            "10,000 条组合查询耗时 {elapsed:?}，超过 200 ms"
        );
    }

}
