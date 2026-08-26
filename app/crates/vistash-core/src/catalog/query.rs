//! 派生索引上的组合查询与索引重建。
//!
//! 本模块只读派生索引，不写权威文件。这条边界是重建等价性的前提：只要查询只经过
//! 索引，"删掉索引重建一次"就必须得到同一批结果，而任何一个绕过索引直接读侧车的
//! 查询都会让这条等价性无法被测试证明。

use crate::error::Result;
use crate::hashing::ContentHash;
use crate::index::{AssetRow, FolderSelection, Index, PromptRow};
use crate::prompt::PromptId;
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
    /// 收藏筛选。`None` 表示不限。与提示词侧共用同一语义。
    pub favorite: Option<bool>,
    pub location: AssetLocation,
}

/// 提示词查询正常库或回收站。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptLocation {
    Active,
    Trash,
}

/// 提示词库的一次组合查询。
///
/// 与 [`AssetQuery`] 平行但多了收藏筛选：提示词没有"文件名"可匹配，文本命中的是
/// 标题与正文；收藏是规格明确要求的独立筛选维度。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptQuery {
    /// 标题或正文的 Unicode 子串（大小写折叠）。空串表示不过滤。
    pub text: String,
    /// 全部必须命中的共享标签（AND 语义）。
    pub tags: Vec<Tag>,
    /// 提示词文件夹范围。与图片文件夹是两棵独立的树。
    pub folder: FolderFilter,
    /// 收藏筛选。`None` 表示不限。
    pub favorite: Option<bool>,
    pub location: PromptLocation,
}

/// 提示词工作区一次刷新所需的一致快照。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PromptSnapshot {
    /// 只含命中查询的轻量行；完整正文等详情经 `Catalog::prompt_detail` 按需读取。
    pub prompts: Vec<PromptRow>,
    /// 完整提示词文件夹树，与查询无关（左栏始终呈现整棵树）。
    pub folders: Vec<String>,
    /// 正常提示词的共享标签计数。分库计算，不含图片标签用量。
    pub tags: Vec<TagUsage>,
    pub trash_count: usize,
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

/// 全局搜索的一次结果：按素材类型分组的轻量行。
///
/// 分组本身就是类型定位——一条结果属于哪个组，它就是哪种素材；各组数量即
/// `assets.len()` / `prompts.len()`，界面据此显示分组计数而不混出无类型瀑布流。
/// 只携带派生索引里的轻量行：原图字节、色卡渲染与关联展开都留给检查器按需
/// 请求，全局搜索绝不逐项加载它们。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GlobalSearchResult {
    /// 命中的正常库图片，排序与图片视图一致（导入时间倒序）。
    pub assets: Vec<AssetRow>,
    /// 命中的正常库提示词，排序与提示词视图一致（创建时间倒序）。
    pub prompts: Vec<PromptRow>,
}

/// 图片检查器的一次按需详情。
///
/// 与 `prompt_detail` 同一分层：列表与搜索只拿轻量行，检查器打开时才组装
/// 这份详情。原图字节仍走 `read_asset_body` 单独请求，这里不读任何本体文件。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ImageDetail {
    pub asset: AssetRow,
    /// 关联这张图的全部提示词（含回收站提示词），经派生反查回答。
    pub linked_prompts: Vec<PromptRow>,
}

/// 提示词检查器里一张关联图片的状态。
///
/// 与 [`ImageDetail`] 的反查互为镜像：图片侧回答"关联了哪些提示词"，这里回答
/// "这条提示词关联了哪些图片"。关联一方进入回收站时关联必须保留且显式标记
/// （规格），因此这里回答"是否已删除"而不是把条目从列表里剔除。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LinkedImageState {
    pub hash: String,
    /// 该图片当前是否在图片库回收站里。还原后自动回到 `false`，无需重新关联。
    pub deleted: bool,
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
        let assets = index.query_assets(deleted, folder, &tags, query.favorite, &query.text)?;

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

    pub fn prompt_snapshot(&self, query: &PromptQuery) -> Result<PromptSnapshot> {
        let deleted = query.location == PromptLocation::Trash;
        // 回收站视图忽略文件夹范围：素材已脱离组织树，按文件夹过滤回收站只会
        // 让"它去哪了"更难回答。
        let folder = match (&query.location, &query.folder) {
            (PromptLocation::Trash, _) | (_, FolderFilter::All) => FolderSelection::All,
            (_, FolderFilter::Root) => FolderSelection::Root,
            (_, FolderFilter::Path(path)) => FolderSelection::Exact(path.as_str()),
        };
        let tags: Vec<String> = query
            .tags
            .iter()
            .map(|tag| tag.as_str().to_owned())
            .collect();
        let index = self.index()?;
        let prompts =
            index.query_prompts(deleted, folder, &tags, query.favorite, &query.text)?;

        Ok(PromptSnapshot {
            prompts,
            folders: self.library.read_prompt_folders()?.folders,
            tags: index
                .active_prompt_tag_counts()?
                .into_iter()
                .map(|(tag, count)| TagUsage { tag, count })
                .collect(),
            trash_count: index.deleted_prompt_count()?,
        })
    }

    /// 跨图片与提示词的全局搜索：文本命中图片来源名/显示名/标签或提示词标题/正文/标签。
    ///
    /// 只搜正常库——回收站素材不属于快速跳转的呈现范围。空白文本返回空结果而
    /// 不是全部素材。文本语义与各自视图一致：Rust 侧大小写折叠子串匹配，排序
    /// 直接复用两个视图查询的稳定顺序。
    pub fn global_search(&self, text: &str) -> Result<GlobalSearchResult> {
        let needle = text.trim().to_lowercase();
        if needle.is_empty() {
            return Ok(GlobalSearchResult {
                assets: Vec::new(),
                prompts: Vec::new(),
            });
        }
        let index = self.index()?;
        let mut assets = index.query_assets(false, FolderSelection::All, &[], None, "")?;
        assets.retain(|asset| {
            asset.original_filename.to_lowercase().contains(&needle)
                || asset.display_filename.to_lowercase().contains(&needle)
                || asset
                    .tags
                    .iter()
                    .any(|tag| tag.to_lowercase().contains(&needle))
        });
        let mut prompts = index.query_prompts(false, FolderSelection::All, &[], None, "")?;
        prompts.retain(|prompt| {
            prompt
                .title
                .as_deref()
                .is_some_and(|title| title.to_lowercase().contains(&needle))
                || prompt.body.to_lowercase().contains(&needle)
                || prompt
                    .tags
                    .iter()
                    .any(|tag| tag.to_lowercase().contains(&needle))
        });
        Ok(GlobalSearchResult { assets, prompts })
    }

    /// 图片检查器的按需详情：轻量行加关联提示词反查。
    pub fn image_detail(&self, hash: &ContentHash) -> Result<ImageDetail> {
        let index = self.index()?;
        Ok(ImageDetail {
            asset: index.asset_row(hash.as_str())?,
            linked_prompts: index.prompts_for_image(hash.as_str())?,
        })
    }

    /// 提示词检查器的按需关联状态：与权威文件同序的哈希加各自回收站标记。
    ///
    /// 顺序来自索引行（`ordinal` 升序），默认封面"取第一张正常关联图片"的判定
    /// 也依赖这个顺序。哈希在资产表里缺失属于不变量被破坏（永久删除会连带解除
    /// 关联），如实以错误传播而不是静默跳过。
    pub fn linked_image_states(&self, prompt_id: &PromptId) -> Result<Vec<LinkedImageState>> {
        let index = self.index()?;
        let row = index.prompt_row(prompt_id.as_str())?;
        row.linked_image_hashes
            .iter()
            .map(|hash| {
                Ok(LinkedImageState {
                    hash: hash.clone(),
                    deleted: index.asset_is_deleted(hash)?,
                })
            })
            .collect()
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
    use crate::sidecar::AssetSidecar;
    #[cfg(not(debug_assertions))]
    use std::time::{Duration, Instant};

    #[test]
    fn snapshot_combines_unicode_filename_and_all_selected_tags() {
        let mut fixture = fixture();
        let backlit = write_png(&fixture.source, "人物-逆光.png", [255, 0, 0, 255]);
        let front = write_png(&fixture.source, "人物-正面.png", [0, 255, 0, 255]);
        let landscape = write_png(&fixture.source, "风景.png", [0, 0, 255, 255]);
        import_with(&mut fixture.catalog, &backlit, None, &["人物", "逆光"]);
        import_with(&mut fixture.catalog, &front, None, &["人物"]);
        import_with(&mut fixture.catalog, &landscape, None, &["逆光"]);

        let snapshot = fixture
            .catalog
            .snapshot(&AssetQuery {
                text: "人物".to_owned(),
                tags: vec![
                    Tag::parse("人物").expect("标签"),
                    Tag::parse("逆光").expect("标签"),
                ],
                folder: FolderFilter::All,
                favorite: None,
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
        import_with(&mut fixture.catalog, &root, None, &[]);
        import_with(&mut fixture.catalog, &filed, Some("参考"), &[]);

        let snapshot = fixture
            .catalog
            .snapshot(&AssetQuery {
                text: String::new(),
                tags: Vec::new(),
                folder: FolderFilter::Root,
                favorite: None,
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
        import_with(&mut fixture.catalog, &exact, Some("参考"), &[]);
        import_with(&mut fixture.catalog, &child, Some("参考/构图"), &[]);

        let snapshot = fixture
            .catalog
            .snapshot(&AssetQuery {
                text: String::new(),
                tags: Vec::new(),
                folder: FolderFilter::Path(FolderPath::parse("参考").expect("文件夹")),
                favorite: None,
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
        import_with(&mut fixture.catalog, &active, None, &[]);
        let mut deleted_sidecar = import_with(&mut fixture.catalog, &deleted, None, &[]);
        deleted_sidecar.deleted_at = Some(chrono::Utc::now());
        deleted_sidecar.deleted_from_folder = None;
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
                favorite: None,
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
        import_with(&mut fixture.catalog, &first, None, &["人物"]);
        import_with(&mut fixture.catalog, &second, None, &["人物", "逆光"]);
        let mut deleted_sidecar = import_with(&mut fixture.catalog, &deleted, None, &["人物"]);
        deleted_sidecar.deleted_at = Some(chrono::Utc::now());
        deleted_sidecar.deleted_from_folder = None;
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
                favorite: None,
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
        let sidecar = import_with(&mut fixture.catalog, &source, None, &[]);
        fixture
            .catalog
            .move_asset_to_folder(&sidecar.hash, Some(&reference))
            .expect("设置文件夹");
        fixture
            .catalog
            .set_asset_tags(&sidecar.hash, &[Tag::parse("人物").expect("标签")])
            .expect("设置标签");
        let query = AssetQuery {
            text: "人物".to_owned(),
            tags: vec![Tag::parse("人物").expect("标签")],
            folder: FolderFilter::Path(FolderPath::parse("参考").expect("路径")),
            favorite: None,
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
        let sidecar = import_with(&mut fixture.catalog, &source, Some(folder.as_str()), &["人物"]);
        fixture
            .catalog
            .delete_asset(&sidecar.hash)
            .expect("删除素材");
        let query = AssetQuery {
            text: "人物".to_owned(),
            tags: vec![Tag::parse("人物").expect("标签")],
            folder: FolderFilter::All,
            favorite: None,
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
        let mut noted = import_with(&mut fixture.catalog, &noted_src, Some("人物/室内"), &["人物"]);
        noted.note = "第一行\n\n第三行".to_owned();
        noted.favorite = true;
        noted
            .write_atomic(&fixture.catalog.library().sidecar_path(&noted.hash))
            .expect("重写带备注侧车");
        fixture
            .catalog
            .index_imported(std::slice::from_ref(&noted))
            .expect("写入备注素材");
        let trashed = import_with(&mut fixture.catalog, &trashed_src, Some("参考/构图"), &["参考"]);
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
            .map(|index| synthetic_sidecar(index, Some(folder.as_str()), &["人物", "逆光"]))
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
            favorite: None,
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

    /// 用固定时间戳与显式 ID 构造提示词，使排序断言完全确定。
    fn crafted_prompt(
        id: &str,
        body: &str,
        title: Option<&str>,
        folders: &[&str],
        tags: &[&str],
        favorite: bool,
        created_secs: i64,
    ) -> PromptAsset {
        let created = chrono::DateTime::from_timestamp(created_secs, 0).expect("固定时间戳");
        PromptAsset {
            format_version: PROMPT_FORMAT_VERSION,
            id: PromptId::parse(id).expect("合法 ID"),
            body: body.to_owned(),
            title: title.map(|value| value.to_owned()),
            model: None,
            parameters: None,
            note: String::new(),
            favorite,
            folders: folders.iter().map(|value| (*value).to_owned()).collect(),
            tags: tags.iter().map(|value| (*value).to_owned()).collect(),
            linked_image_hashes: vec![],
            cover_image_hash: None,
            created_at: created,
            updated_at: created,
            deleted_at: None,
            deleted_from_folders: None,
        }
    }

    /// 经生产路径落盘并写入派生索引；回收站状态自动落到回收站目录。
    fn place_prompt(catalog: &mut crate::catalog::Catalog, prompt: &PromptAsset) {
        let path = if prompt.is_deleted() {
            catalog.library().prompt_trash_path(&prompt.id)
        } else {
            catalog.library().prompt_path(&prompt.id)
        };
        prompt.write_atomic(&path).expect("写入提示词权威文件");
        catalog
            .index_mut()
            .expect("索引")
            .upsert_prompt(prompt)
            .expect("写入提示词索引");
    }

    fn ids_of(snapshot: &PromptSnapshot) -> Vec<String> {
        snapshot.prompts.iter().map(|row| row.id.clone()).collect()
    }

    #[test]
    fn prompt_query_matches_unicode_substrings_in_title_and_body() {
        let mut fixture = fixture();
        place_prompt(
            &mut fixture.catalog,
            &crafted_prompt(
                "018f3c9e-6c00-7000-8000-0000000000c1",
                "cinematic lighting, warm tones",
                Some("逆光人像"),
                &[],
                &[],
                false,
                100,
            ),
        );
        place_prompt(
            &mut fixture.catalog,
            &crafted_prompt(
                "018f3c9e-6c00-7000-8000-0000000000c2",
                "夜色中的霓虹灯街道",
                None,
                &[],
                &[],
                false,
                200,
            ),
        );
        let query_with = |text: &str| PromptQuery {
            text: text.to_owned(),
            tags: vec![],
            folder: FolderFilter::All,
            favorite: None,
            location: PromptLocation::Active,
        };

        // 大小写折叠命中英文正文。
        assert_eq!(
            ids_of(&fixture.catalog.prompt_snapshot(&query_with("CINEMATIC")).expect("查询")),
            vec!["018f3c9e-6c00-7000-8000-0000000000c1"]
        );
        // 中文子串命中无标题素材的正文：标题缺省不是特殊情形。
        assert_eq!(
            ids_of(&fixture.catalog.prompt_snapshot(&query_with("霓虹")).expect("查询")),
            vec!["018f3c9e-6c00-7000-8000-0000000000c2"]
        );
        // 命中标题。
        assert_eq!(
            ids_of(&fixture.catalog.prompt_snapshot(&query_with("逆光")).expect("查询")),
            vec!["018f3c9e-6c00-7000-8000-0000000000c1"]
        );
        // 无命中就是空结果，而不是全部素材。
        assert!(fixture
            .catalog
            .prompt_snapshot(&query_with("不存在的词"))
            .expect("查询")
            .prompts
            .is_empty());
    }

    #[test]
    fn prompt_query_combines_folder_scope_root_and_tag_conjunction() {
        let mut fixture = fixture();
        let people = fixture
            .catalog
            .create_prompt_folder(None, &FolderName::parse("人物").expect("文件夹名"))
            .expect("创建根文件夹");
        fixture
            .catalog
            .create_prompt_folder(Some(&people), &FolderName::parse("室内").expect("文件夹名"))
            .expect("创建子文件夹");
        place_prompt(
            &mut fixture.catalog,
            &crafted_prompt(
                "018f3c9e-6c00-7000-8000-0000000000d1",
                "双标签",
                None,
                &["人物/室内"],
                &["人物", "逆光"],
                false,
                300,
            ),
        );
        place_prompt(
            &mut fixture.catalog,
            &crafted_prompt(
                "018f3c9e-6c00-7000-8000-0000000000d2",
                "单标签",
                None,
                &["人物/室内"],
                &["人物"],
                false,
                200,
            ),
        );
        place_prompt(
            &mut fixture.catalog,
            &crafted_prompt(
                "018f3c9e-6c00-7000-8000-0000000000d3",
                "根位置",
                None,
                &[],
                &["人物"],
                false,
                100,
            ),
        );
        let query_with = |folder: FolderFilter, tags: &[&str]| PromptQuery {
            text: String::new(),
            tags: tags
                .iter()
                .map(|raw| Tag::parse(raw).expect("标签"))
                .collect(),
            folder,
            favorite: None,
            location: PromptLocation::Active,
        };

        // 精确文件夹 + 双标签 AND：只有同时具备两个标签的成员命中。
        assert_eq!(
            ids_of(
                &fixture
                    .catalog
                    .prompt_snapshot(&query_with(
                        FolderFilter::Path(FolderPath::parse("人物/室内").expect("路径")),
                        &["人物", "逆光"]
                    ))
                    .expect("查询")
            ),
            vec!["018f3c9e-6c00-7000-8000-0000000000d1"]
        );
        // 根位置 = 没有任何文件夹归属。
        assert_eq!(
            ids_of(
                &fixture
                    .catalog
                    .prompt_snapshot(&query_with(FolderFilter::Root, &["人物"]))
                    .expect("查询")
            ),
            vec!["018f3c9e-6c00-7000-8000-0000000000d3"]
        );
        // 全范围单标签按创建时间倒序稳定排列。
        assert_eq!(
            ids_of(
                &fixture
                    .catalog
                    .prompt_snapshot(&query_with(FolderFilter::All, &["人物"]))
                    .expect("查询")
            ),
            vec![
                "018f3c9e-6c00-7000-8000-0000000000d1",
                "018f3c9e-6c00-7000-8000-0000000000d2",
                "018f3c9e-6c00-7000-8000-0000000000d3",
            ]
        );
    }

    #[test]
    fn prompt_query_filters_favorite_and_location() {
        let mut fixture = fixture();
        let people = fixture
            .catalog
            .create_prompt_folder(None, &FolderName::parse("人物").expect("文件夹名"))
            .expect("创建根文件夹");
        let _ = people;
        let mut trashed = crafted_prompt(
            "018f3c9e-6c00-7000-8000-0000000000e3",
            "已删除",
            None,
            &["人物/室内"],
            &[],
            false,
            200,
        );
        trashed.deleted_at = Some(chrono::DateTime::from_timestamp(900, 0).expect("固定时刻"));
        trashed.deleted_from_folders = Some(vec!["人物/室内".to_owned()]);
        place_prompt(&mut fixture.catalog, &trashed);
        place_prompt(
            &mut fixture.catalog,
            &crafted_prompt(
                "018f3c9e-6c00-7000-8000-0000000000e1",
                "收藏的",
                None,
                &[],
                &[],
                true,
                400,
            ),
        );
        place_prompt(
            &mut fixture.catalog,
            &crafted_prompt(
                "018f3c9e-6c00-7000-8000-0000000000e2",
                "未收藏的",
                None,
                &[],
                &[],
                false,
                300,
            ),
        );
        let query_with = |favorite: Option<bool>, location: PromptLocation| PromptQuery {
            text: String::new(),
            tags: vec![],
            folder: FolderFilter::All,
            favorite,
            location,
        };

        assert_eq!(
            ids_of(
                &fixture
                    .catalog
                    .prompt_snapshot(&query_with(Some(true), PromptLocation::Active))
                    .expect("查询")
            ),
            vec!["018f3c9e-6c00-7000-8000-0000000000e1"]
        );
        assert_eq!(
            ids_of(
                &fixture
                    .catalog
                    .prompt_snapshot(&query_with(Some(false), PromptLocation::Active))
                    .expect("查询")
            ),
            vec!["018f3c9e-6c00-7000-8000-0000000000e2"]
        );
        // 正常库不含回收站素材，且回收站计数独立呈现。
        let active = fixture
            .catalog
            .prompt_snapshot(&query_with(None, PromptLocation::Active))
            .expect("查询");
        assert_eq!(active.trash_count, 1);
        assert_eq!(
            ids_of(&active),
            vec![
                "018f3c9e-6c00-7000-8000-0000000000e1",
                "018f3c9e-6c00-7000-8000-0000000000e2"
            ]
        );
        // 回收站视图返回被删素材，且忽略文件夹范围——它已脱离组织树。
        let trash_view = fixture
            .catalog
            .prompt_snapshot(&PromptQuery {
                text: String::new(),
                tags: vec![],
                folder: FolderFilter::Path(FolderPath::parse("人物/室内").expect("路径")),
                favorite: None,
                location: PromptLocation::Trash,
            })
            .expect("查询");
        assert_eq!(
            ids_of(&trash_view),
            vec!["018f3c9e-6c00-7000-8000-0000000000e3"]
        );
    }

    #[test]
    fn prompt_query_orders_by_creation_descending_with_id_tiebreak() {
        let mut fixture = fixture();
        // 同一创建时刻的两条素材按 ID 倒序打破平局，保证排序全序且稳定。
        place_prompt(
            &mut fixture.catalog,
            &crafted_prompt(
                "018f3c9e-6c00-7000-8000-0000000000f1",
                "平局甲",
                None,
                &[],
                &[],
                false,
                500,
            ),
        );
        place_prompt(
            &mut fixture.catalog,
            &crafted_prompt(
                "018f3c9e-6c00-7000-8000-0000000000f2",
                "平局乙",
                None,
                &[],
                &[],
                false,
                500,
            ),
        );
        place_prompt(
            &mut fixture.catalog,
            &crafted_prompt(
                "018f3c9e-6c00-7000-8000-0000000000f3",
                "更早的",
                None,
                &[],
                &[],
                false,
                100,
            ),
        );
        let query = PromptQuery {
            text: String::new(),
            tags: vec![],
            folder: FolderFilter::All,
            favorite: None,
            location: PromptLocation::Active,
        };
        assert_eq!(
            ids_of(&fixture.catalog.prompt_snapshot(&query).expect("查询")),
            vec![
                "018f3c9e-6c00-7000-8000-0000000000f2",
                "018f3c9e-6c00-7000-8000-0000000000f1",
                "018f3c9e-6c00-7000-8000-0000000000f3",
            ]
        );
    }

    #[test]
    fn global_search_matches_filenames_tags_titles_and_bodies() {
        let mut fixture = fixture();
        import_with(
            &mut fixture.catalog,
            &write_png(&fixture.source, "逆光-构图.png", [255, 0, 0, 255]),
            None,
            &["风景"],
        );
        import_with(
            &mut fixture.catalog,
            &write_png(&fixture.source, "街景.png", [0, 255, 0, 255]),
            None,
            &["人物"],
        );
        place_prompt(
            &mut fixture.catalog,
            &crafted_prompt(
                "018f3c9e-6c00-7000-8000-0000000000a1",
                "cinematic lighting, warm tones",
                Some("逆光人像"),
                &[],
                &["人像"],
                false,
                100,
            ),
        );
        place_prompt(
            &mut fixture.catalog,
            &crafted_prompt(
                "018f3c9e-6c00-7000-8000-0000000000a2",
                "夜色中的霓虹灯街道",
                None,
                &[],
                &[],
                false,
                200,
            ),
        );
        let search = |catalog: &crate::catalog::Catalog, text: &str| {
            catalog.global_search(text).expect("全局搜索")
        };
        let names =
            |result: &GlobalSearchResult| result.assets.iter().map(|a| a.original_filename.clone()).collect::<Vec<_>>();
        let prompt_ids = |result: &GlobalSearchResult| {
            result.prompts.iter().map(|p| p.id.clone()).collect::<Vec<_>>()
        };

        // 文件名命中图片，标题命中提示词：同一文本分属两个类型分组。
        let backlit = search(&fixture.catalog, "逆光");
        assert_eq!(names(&backlit), vec!["逆光-构图.png".to_owned()]);
        assert_eq!(
            prompt_ids(&backlit),
            vec!["018f3c9e-6c00-7000-8000-0000000000a1".to_owned()]
        );
        // 标签命中：文件名里没有"风景"，靠标签命中。
        assert_eq!(names(&search(&fixture.catalog, "风景")), vec!["逆光-构图.png".to_owned()]);
        // 图片标签与提示词标签是两套词面，各自命中各自的分组。
        assert_eq!(names(&search(&fixture.catalog, "人物")), vec!["街景.png".to_owned()]);
        // 正文大小写折叠命中英文。
        assert_eq!(
            prompt_ids(&search(&fixture.catalog, "CINEMATIC")),
            vec!["018f3c9e-6c00-7000-8000-0000000000a1".to_owned()]
        );
        // 正文中文子串命中无标题素材；提示词标签也能命中。
        assert_eq!(
            prompt_ids(&search(&fixture.catalog, "霓虹")),
            vec!["018f3c9e-6c00-7000-8000-0000000000a2".to_owned()]
        );
        assert_eq!(
            prompt_ids(&search(&fixture.catalog, "人像")),
            vec!["018f3c9e-6c00-7000-8000-0000000000a1".to_owned()]
        );
        // 无命中就是空结果，而不是全部素材。
        let nothing = search(&fixture.catalog, "不存在的词");
        assert!(nothing.assets.is_empty() && nothing.prompts.is_empty());
    }

    #[test]
    fn global_search_groups_counts_and_excludes_both_trashes() {
        let mut fixture = fixture();
        import_with(
            &mut fixture.catalog,
            &write_png(&fixture.source, "逆光-a.png", [255, 0, 0, 255]),
            None,
            &[],
        );
        import_with(
            &mut fixture.catalog,
            &write_png(&fixture.source, "逆光-b.png", [0, 255, 0, 255]),
            None,
            &[],
        );
        let trashed_image = import_with(
            &mut fixture.catalog,
            &write_png(&fixture.source, "逆光-已删.png", [0, 0, 255, 255]),
            None,
            &[],
        );
        fixture
            .catalog
            .delete_asset(&trashed_image.hash)
            .expect("移入图片回收站");
        place_prompt(
            &mut fixture.catalog,
            &crafted_prompt(
                "018f3c9e-6c00-7000-8000-0000000000b1",
                "逆光正文",
                None,
                &[],
                &[],
                false,
                100,
            ),
        );
        let mut trashed_prompt = crafted_prompt(
            "018f3c9e-6c00-7000-8000-0000000000b2",
            "逆光的回收站正文",
            None,
            &[],
            &[],
            false,
            200,
        );
        trashed_prompt.deleted_at = Some(chrono::DateTime::from_timestamp(900, 0).expect("固定时刻"));
        trashed_prompt.deleted_from_folders = Some(Vec::new());
        place_prompt(&mut fixture.catalog, &trashed_prompt);

        let result = fixture
            .catalog
            .global_search("逆光")
            .expect("全局搜索");

        // 分组数量即各组长度；两类回收站都不进入快速跳转范围。
        assert_eq!(result.assets.len(), 2);
        assert_eq!(result.prompts.len(), 1);
        assert!(result
            .assets
            .iter()
            .all(|asset| asset.original_filename != "逆光-已删.png"));
        assert_eq!(
            result.prompts[0].id,
            "018f3c9e-6c00-7000-8000-0000000000b1"
        );
    }

    #[test]
    fn a_blank_global_search_returns_an_empty_result_instead_of_everything() {
        let mut fixture = fixture();
        import_with(
            &mut fixture.catalog,
            &write_png(&fixture.source, "存在.png", [255, 0, 0, 255]),
            None,
            &[],
        );
        place_prompt(
            &mut fixture.catalog,
            &crafted_prompt(
                "018f3c9e-6c00-7000-8000-0000000000c9",
                "存在的正文",
                None,
                &[],
                &[],
                false,
                100,
            ),
        );

        for text in ["", "   "] {
            let result = fixture.catalog.global_search(text).expect("全局搜索");
            assert!(
                result.assets.is_empty() && result.prompts.is_empty(),
                "空白文本 {text:?} 必须返回空结果"
            );
        }
    }

    #[test]
    fn image_detail_composes_the_row_and_every_linking_prompt() {
        let mut fixture = fixture();
        let image = import_with(
            &mut fixture.catalog,
            &write_png(&fixture.source, "详情.png", [255, 0, 0, 255]),
            None,
            &[],
        );
        let active = prompt_via_create(&mut fixture.catalog, "活跃的关联提示词");
        let later_trashed = prompt_via_create(&mut fixture.catalog, "之后进回收站的提示词");
        fixture
            .catalog
            .link_images(&active.id, std::slice::from_ref(&image.hash))
            .expect("关联第一张");
        fixture
            .catalog
            .link_images(&later_trashed.id, std::slice::from_ref(&image.hash))
            .expect("关联第二张");
        fixture
            .catalog
            .delete_prompt(&later_trashed.id)
            .expect("移入提示词回收站");

        let detail = fixture
            .catalog
            .image_detail(&image.hash)
            .expect("读取图片详情");
        assert_eq!(detail.asset.original_filename, "详情.png");
        // 反查含回收站提示词：检查器如实体现已删除状态。
        let linked_ids: Vec<String> = detail
            .linked_prompts
            .iter()
            .map(|prompt| prompt.id.clone())
            .collect();
        assert_eq!(linked_ids.len(), 2);
        assert!(linked_ids.contains(&active.id.as_str().to_owned()));
        assert!(linked_ids.contains(&later_trashed.id.as_str().to_owned()));

        // 从未入库的哈希给出明确错误，而不是空详情。
        let unknown = crate::hashing::ContentHash::of_bytes(b"unknown-detail-hash");
        let error = fixture
            .catalog
            .image_detail(&unknown)
            .expect_err("未知哈希应失败");
        assert_eq!(error.code, Code::LibraryNotFound);
    }

    /// 经生产创建路径拿到一条正常库提示词（与 crafted_prompt 的直写路径互补）。
    fn prompt_via_create(catalog: &mut crate::catalog::Catalog, body: &str) -> PromptAsset {
        catalog
            .create_prompt(&crate::catalog::NewPrompt {
                body: body.to_owned(),
                title: None,
                model: None,
                parameters: None,
                folders: vec![],
                tags: vec![],
            })
            .expect("创建提示词")
    }
}
