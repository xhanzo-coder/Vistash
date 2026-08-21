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
    use crate::library::{FolderList, LIBRARY_FORMAT_VERSION};
    use crate::prompt::{PromptAsset, PromptId, PromptFolderList, PROMPT_FORMAT_VERSION};
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
    fn deleting_and_rebuilding_the_index_reproduces_the_full_v2_snapshot() {
        // 任务 3.4：删除并重建索引后，完整快照与增量索引逐字段相等。比较范围刻意取
        // 整个 IndexSnapshot 而不是单侧查询：两套空文件夹、图片 note/favorite、提示词
        // 全字段、两类回收站与普通关联/封面都必须在重建后原样出现。
        let mut fixture = fixture();

        // 图片：一张带多行备注与收藏，一张经生产删除路径移入回收站（侧车进 trash 树）。
        let noted_src = write_png(&fixture.source, "带备注.png", [255, 0, 0, 255]);
        let trashed_src = write_png(&fixture.source, "已删除.png", [0, 0, 255, 255]);
        let mut noted = import_with(&mut fixture.catalog, &noted_src, &["人物/室内"], &["人物"]);
        noted.note = "第一行\n\n第三行".to_owned();
        noted.favorite = true;
        noted
            .write_atomic(&fixture.catalog.library().sidecar_path(&noted.hash))
            .expect("重写带备注侧车");
        fixture
            .catalog
            .index_imported(std::slice::from_ref(&noted))
            .expect("写入备注素材");
        let trashed = import_with(&mut fixture.catalog, &trashed_src, &["参考/构图"], &["参考"]);
        fixture
            .catalog
            .delete_asset(&trashed.hash)
            .expect("移入图片回收站");

        // 提示词：一条全字段，关联两张图片并显式指定封面；一条在回收站且保留关联。
        let full = PromptAsset {
            format_version: PROMPT_FORMAT_VERSION,
            id: PromptId::parse("018f3c9e-6c00-7000-8000-0000000000b1").expect("合法 ID"),
            body: "逆光人像，胶片颗粒".to_owned(),
            title: Some("逆光人像".to_owned()),
            model: Some("某生图模型 v3".to_owned()),
            parameters: Some("steps=30, cfg=6".to_owned()),
            note: "提示词备注".to_owned(),
            favorite: true,
            folders: vec!["人物/室内".to_owned()],
            tags: vec!["人物".to_owned(), "逆光".to_owned()],
            linked_image_hashes: vec![trashed.hash.clone(), noted.hash.clone()],
            cover_image_hash: Some(noted.hash.clone()),
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            deleted_at: None,
            deleted_from_folders: None,
        };
        let trashed_prompt = PromptAsset {
            format_version: PROMPT_FORMAT_VERSION,
            id: PromptId::parse("018f3c9e-6c00-7000-8000-0000000000b2").expect("合法 ID"),
            body: "已删除的正文".to_owned(),
            title: None,
            model: None,
            parameters: None,
            note: String::new(),
            favorite: false,
            folders: vec!["人物/室内".to_owned()],
            tags: vec!["人物".to_owned()],
            linked_image_hashes: vec![noted.hash.clone()],
            cover_image_hash: None,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            deleted_at: Some(chrono::Utc::now()),
            deleted_from_folders: Some(vec!["人物/室内".to_owned()]),
        };
        full
            .write_atomic(&fixture.catalog.library().prompt_path(&full.id))
            .expect("写入提示词权威文件");
        trashed_prompt
            .write_atomic(&fixture.catalog.library().prompt_trash_path(&trashed_prompt.id))
            .expect("写入回收站提示词文件");
        fixture
            .catalog
            .index_mut()
            .expect("索引")
            .upsert_prompts(&[full.clone(), trashed_prompt.clone()])
            .expect("写入提示词索引");

        // 两套清单独立持久化：同名路径各自存在，各自带一个不含素材的空文件夹。
        let folders = FolderList {
            format_version: LIBRARY_FORMAT_VERSION,
            folders: vec![
                "人物/室内".to_owned(),
                "参考/构图".to_owned(),
                "空文件夹".to_owned(),
            ],
        };
        fixture
            .catalog
            .library()
            .write_folders(&folders)
            .expect("写图片文件夹清单");
        fixture
            .catalog
            .index_mut()
            .expect("索引")
            .set_folders(&folders)
            .expect("写图片文件夹清单索引");
        let prompt_folders = PromptFolderList {
            format_version: PROMPT_FORMAT_VERSION,
            folders: vec![
                "人物/室内".to_owned(),
                "空提示词文件夹".to_owned(),
            ],
        };
        fixture
            .catalog
            .library()
            .write_prompt_folders(&prompt_folders)
            .expect("写提示词文件夹清单");
        fixture
            .catalog
            .index_mut()
            .expect("索引")
            .set_prompt_folders(&prompt_folders)
            .expect("写提示词文件夹清单索引");

        let before = fixture
            .catalog
            .index()
            .expect("索引")
            .snapshot()
            .expect("重建前快照");

        // rebuild_index 先删除旧索引文件再从权威文件全量重建（Index::rebuild_at），
        // 正是"删除并重建"的生产入口。
        fixture.catalog.rebuild_index().expect("删除并重建索引");
        let after = fixture
            .catalog
            .index()
            .expect("索引")
            .snapshot()
            .expect("重建后快照");

        assert_eq!(after, before);

        // 针对性断言记录等价必须覆盖的意图：即使整体比较被意外放宽，这些点也不得悄悄丢失。
        let trashed_row = after
            .assets
            .iter()
            .find(|a| a.original_filename == "已删除.png")
            .expect("回收站图片应在快照中");
        assert!(
            trashed_row.deleted_at.is_some(),
            "图片回收站状态在重建后丢失"
        );
        let full_row = after
            .prompts
            .iter()
            .find(|p| p.title.as_deref() == Some("逆光人像"))
            .expect("提示词行应在快照中");
        assert_eq!(
            full_row.linked_image_hashes,
            vec![trashed.hash.as_str().to_owned(), noted.hash.as_str().to_owned()],
            "关联顺序在重建后改变"
        );
        assert_eq!(
            full_row.cover_image_hash.as_deref(),
            Some(noted.hash.as_str()),
            "显式封面在重建后丢失"
        );
        let trashed_prompt_row = after
            .prompts
            .iter()
            .find(|p| p.body == "已删除的正文")
            .expect("回收站提示词应在快照中");
        assert!(
            trashed_prompt_row.deleted_at.is_some(),
            "提示词回收站状态在重建后丢失"
        );
        assert_eq!(
            trashed_prompt_row.linked_image_hashes,
            vec![noted.hash.as_str().to_owned()],
            "回收站提示词的关联在重建后丢失"
        );
        assert!(
            after.folders.contains(&"空文件夹".to_owned())
                && after.prompt_folders.contains(&"空提示词文件夹".to_owned()),
            "两套空文件夹都应在重建后存活：{:?} / {:?}",
            after.folders,
            after.prompt_folders
        );
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
