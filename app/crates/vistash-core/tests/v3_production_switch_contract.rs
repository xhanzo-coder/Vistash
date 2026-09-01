//! 任务 3.6 的失败测试：定义生产链路切换到 v3 之后的目标行为。
//!
//! 设计第 289 行要求"用迁移后的 v3 fixture 验证索引重建、双文件名查询与 Catalog
//! 单归属事务，再一次切换生产别名、SQLite、Catalog 和批量命令"。本文件因此先于
//! 切换存在，并在切换完成前保持编译失败或断言失败——这正是任务 3.6 的交付物。
//! 三组契约各自对应一条规格要求：
//!
//! 1. **索引重建**：迁移产出的 v3 侧车必须能完整重建派生索引，显示文件名进入
//!    索引且文件夹归属呈单值；"增量攒出的索引等于重建的索引"这一核心承诺在 v3
//!    下延续；
//! 2. **双文件名查询**：文件名文本同时按 Unicode 小写子串匹配显示文件名与来源
//!    文件名，回收站查询同样双名过滤且不混入正常素材；
//! 3. **单归属事务**：`move_asset_to_folder` 替换唯一归属、`None` 清除归属、
//!    拒绝不存在的目标且不触碰旧归属、拒绝修改回收站素材。
//!
//! 夹具刻意走真实迁移流程（inspect → resolve → commit）而不是手写 v3 侧车：
//! 被验证的对象正是"迁移之后的库"，手写等价物测不出迁移与索引之间的接缝。

use chrono::DateTime;
use vistash_core::catalog::{
    AssetLocation, AssetQuery, Catalog, FolderFilter, FolderPath,
};
use vistash_core::colorcard::ColorCard;
use vistash_core::error::Code;
use vistash_core::hashing::{ContentHash, HASH_ALGO_ID};
use vistash_core::index::Index;
use vistash_core::library::{
    FolderList, Library, LIBRARY_FORMAT_VERSION, LIBRARY_FORMAT_VERSION_V2, META_FILE,
};
use vistash_core::media::MediaType;
use vistash_core::migration::{V3MigrationCommit, V3MigrationPlan};
use vistash_core::sidecar::{
    AssetSidecarV2, AssetSidecarV3, AssetSource, DisplayFilename, SIDECAR_FORMAT_VERSION_V2,
    SIDECAR_FORMAT_VERSION_V3,
};

/// 一张最小可用的 v2 侧车。与 `migration_v3_plan_contract` 的同名夹具同一手法。
fn v2_sidecar(seed: &[u8], original_filename: &str, folders: &[&str]) -> AssetSidecarV2 {
    AssetSidecarV2 {
        format_version: SIDECAR_FORMAT_VERSION_V2,
        hash: ContentHash::of_bytes(seed),
        hash_algo: HASH_ALGO_ID.to_owned(),
        media_type: MediaType::Png,
        ext: "png".to_owned(),
        byte_size: seed.len() as u64,
        width: 16,
        height: 9,
        imported_at: DateTime::from_timestamp(1_777_777_777, 0).expect("固定时间戳"),
        original_filename: original_filename.to_owned(),
        source_path: Some(format!("D:/素材/{original_filename}")),
        folders: folders.iter().map(|folder| (*folder).to_owned()).collect(),
        tags: vec![],
        color_card: ColorCard::failed(Code::ColorCardInsufficientOpaquePixels),
        note: String::new(),
        favorite: false,
        deleted_at: None,
        deleted_from_folders: None,
    }
}

/// 一张最小可用的 v3 侧车，供回收站与改名后的场景直接落盘。
#[allow(dead_code)]
fn v3_sidecar(
    seed: &[u8],
    source_filename: &str,
    display_stem: &str,
    folder: Option<&str>,
) -> AssetSidecarV3 {
    AssetSidecarV3 {
        format_version: SIDECAR_FORMAT_VERSION_V3,
        hash: ContentHash::of_bytes(seed),
        hash_algo: HASH_ALGO_ID.to_owned(),
        media_type: MediaType::Png,
        ext: MediaType::Png.library_ext().to_owned(),
        byte_size: seed.len() as u64,
        width: 16,
        height: 9,
        imported_at: DateTime::from_timestamp(1_777_777_777, 0).expect("固定时间戳"),
        source: AssetSource::Filesystem {
            path: Some(format!("D:/素材/{source_filename}")),
            filename: source_filename.to_owned(),
        },
        display_filename: DisplayFilename::new(display_stem, MediaType::Png).expect("合法显示名"),
        folder: folder.map(str::to_owned),
        tags: vec![],
        color_card: ColorCard::failed(Code::ColorCardInsufficientOpaquePixels),
        note: String::new(),
        favorite: false,
        deleted_at: None,
        deleted_from_folder: None,
    }
}

/// 建一个 v2 库并写入给定侧车，然后走真实迁移流程得到 v3 库。
///
/// 迁移完成后以生产门禁 [`Library::open`] 重新打开——这同时持续验证任务 3.5 的
/// 门禁确实放行自己迁移出来的库。文件夹清单在建库后、提交前写入：生产里真实 v2
/// 库的清单本来就先于迁移存在（它属于使用者正在组织的工作区状态），而提交时的
/// 索引重建会读取当时的清单——增量索引等于重建索引的承诺要求两侧看到同一份。
fn migrated_library(sidecars: &[AssetSidecarV2], folders: &[&str]) -> (tempfile::TempDir, Library) {
    let directory = tempfile::tempdir().expect("建立临时目录");
    let root = directory.path().join("library");
    let library = Library::create(&root).expect("建立库");
    if !folders.is_empty() {
        library
            .write_folders(&FolderList {
                format_version: LIBRARY_FORMAT_VERSION,
                folders: folders.iter().map(|folder| (*folder).to_owned()).collect(),
            })
            .expect("写入迁移前的文件夹清单");
    }
    // 建库入口自任务 3.5 起直接产出 v3 元数据；迁移门禁只接受 v2 输入，
    // 因此夹具先把 library.json 降写回真实 v2 元数据。
    let v2_meta = vistash_core::library::LibraryMetaV2 {
        format_version: LIBRARY_FORMAT_VERSION_V2,
        library_id: library.meta().library_id.clone(),
        hash_algo: library.meta().hash_algo.clone(),
        created_at: library.meta().created_at,
        created_by_app_version: library.meta().created_by_app_version.clone(),
    };
    v2_meta
        .write_atomic(&root.join(META_FILE))
        .expect("降写 v2 库级元数据");
    for sidecar in sidecars {
        sidecar
            .write_atomic(&library.sidecar_path(&sidecar.hash))
            .expect("写入 v2 侧车");
    }

    let plan = V3MigrationPlan::inspect(&root).expect("生成只读迁移计划");
    // 夹具只包含零归属与单归属素材：两者都是确定映射，无需使用者选择。
    let resolved = plan.resolve(&[]).expect("无冲突计划应可直接解决");
    let mut rebuild =
        |index_root: &std::path::Path| Index::rebuild_at(index_root).map(|_| ());
    V3MigrationCommit::new(&resolved, &root)
        .run(&mut rebuild, &mut |_progress| {})
        .expect("提交 v2→v3 迁移");

    let library = Library::open(&root).expect("迁移后的库应以 v3 门禁打开");
    (directory, library)
}

fn all_active_query() -> AssetQuery {
    AssetQuery {
        text: String::new(),
        tags: vec![],
        folder: FolderFilter::All,
        favorite: None,
        location: AssetLocation::Active,
    }
}

// —— 组一：迁移后的 v3 侧车索引重建 ——

#[test]
fn the_migrated_library_rebuilds_its_index_from_v3_sidecars() {
    // 迁移把旧原始文件名复制进不可变的来源字段；显示名取名称主体加真实媒体类型的
    // 规范扩展名。夹具的磁盘名带大写扩展名——真实 v2 数据里 ext 是小写归一的，而
    // 文件名保留原样，剥离必须大小写不敏感才能不把整段名字落进主体。重建后的索引
    // 必须如实呈现两个名字与单值归属；零归属素材必须落在未分类而不是被猜测出归属。
    let renamed_source = v2_sidecar(b"renamed-in-migration", "IMG_0042.PNG", &["参考"]);
    let loose = v2_sidecar(b"loose-in-migration", "plain.png", &[]);
    // 哈希在夹具消费侧车前取出：迁移会拿走所有权。
    let renamed_hash = renamed_source.hash.clone();
    let loose_hash = loose.hash.clone();
    let (_directory, library) = migrated_library(&[renamed_source, loose], &["参考"]);

    // 删掉迁移提交时留下的索引，验证"仅凭磁盘上的 v3 元数据即可完整重建"。
    std::fs::remove_file(library.index_path()).expect("删除迁移后的索引");
    let rebuilt = Index::rebuild_at(library.root()).expect("v3 侧车应能重建索引");
    let snapshot = rebuilt.snapshot().expect("取重建快照");
    assert_eq!(snapshot.assets.len(), 2, "两张素材都应进入索引");

    let renamed = snapshot
        .assets
        .iter()
        .find(|asset| asset.hash == renamed_hash.as_str())
        .expect("应能找到带归属素材的行");
    assert_eq!(
        renamed.display_filename, "IMG_0042.png",
        "显示名应取剥离扩展名后的主体加媒体类型规范扩展名"
    );
    assert_eq!(
        renamed.original_filename, "IMG_0042.PNG",
        "来源文件名应原样保留磁盘上的大小写"
    );
    assert_eq!(
        renamed.folder.as_deref(),
        Some("参考"),
        "单归属应作为单值进入索引"
    );

    let loose_row = snapshot
        .assets
        .iter()
        .find(|asset| asset.hash == loose_hash.as_str())
        .expect("应能找到零归属素材的行");
    assert_eq!(
        loose_row.folder, None,
        "零归属素材迁移后必须位于未分类"
    );
}

#[test]
fn a_trashed_v3_sidecar_stays_in_the_rebuilt_index() {
    // 回收站中的 v3 侧车同样是权威元数据。只扫正常树会让它们在重建后消失，
    // 使用者会看到回收站突然变空。
    let active = v2_sidecar(b"active-asset", "active.png", &[]);
    let mut trashed = v2_sidecar(b"trashed-asset", "discarded.png", &["参考"]);
    trashed.deleted_at = Some(DateTime::from_timestamp(1_777_777_778, 0).expect("固定时间戳"));
    trashed.deleted_from_folders = Some(vec!["参考".to_owned()]);
    let (_directory, library) = migrated_library(&[active], &[]);

    // 回收站侧车无法经迁移产生（迁移只处理正常树），按 v3 形状手工落盘到回收站树。
    let trashed_v3 = AssetSidecarV3 {
        format_version: SIDECAR_FORMAT_VERSION_V3,
        hash: trashed.hash.clone(),
        hash_algo: HASH_ALGO_ID.to_owned(),
        media_type: MediaType::Png,
        ext: "png".to_owned(),
        byte_size: trashed.byte_size,
        width: 16,
        height: 9,
        imported_at: trashed.imported_at,
        source: AssetSource::Filesystem {
            path: Some("D:/素材/discarded.png".to_owned()),
            filename: "discarded.png".to_owned(),
        },
        display_filename: DisplayFilename::new("discarded", MediaType::Png).expect("合法显示名"),
        folder: None,
        tags: vec![],
        color_card: ColorCard::failed(Code::ColorCardInsufficientOpaquePixels),
        note: String::new(),
        favorite: false,
        deleted_at: trashed.deleted_at,
        deleted_from_folder: Some("参考".to_owned()),
    };
    trashed_v3
        .write_atomic(&library.trash_sidecar_path(&trashed.hash))
        .expect("写入回收站 v3 侧车");

    let rebuilt = Index::rebuild_at(library.root()).expect("混合两棵树的重建应成功");
    assert_eq!(
        rebuilt.asset_count().expect("统计素材"),
        2,
        "回收站素材应仍在索引中"
    );
}

#[test]
fn the_incrementally_built_v3_index_matches_a_full_rebuild() {
    // 项目最核心承诺的 v3 版本：导入/编辑时逐条 upsert 攒出的索引，与删掉索引后
    // 仅凭磁盘元数据重建的索引必须逐字段相等。两侧刻意不同源，增量写入路径与
    // 重建读取路径的分歧才测得出来。
    let first = v2_sidecar(b"equivalence-first", "first.png", &["参考"]);
    let second = v2_sidecar(b"equivalence-second", "second.png", &[]);
    let first_hash = first.hash.clone();
    let second_hash = second.hash.clone();
    let (_directory, library) = migrated_library(&[first, second], &["参考"]);

    // 把迁移后的 v3 侧车重新读出来，经增量入口再次写入同一索引。
    let v3_first =
        AssetSidecarV3::read(&library.sidecar_path(&first_hash)).expect("读取 v3 侧车");
    let v3_second =
        AssetSidecarV3::read(&library.sidecar_path(&second_hash)).expect("读取 v3 侧车");

    let mut index = Index::open(&library).expect("打开迁移留下的索引");
    index
        .upsert_asset(&v3_first)
        .expect("增量写入第一张 v3 侧车");
    index.upsert_asset(&v3_second).expect("增量写入第二张");
    let before = index.snapshot().expect("取增量侧快照");
    drop(index);

    std::fs::remove_file(library.index_path()).expect("删除索引文件");
    let rebuilt = Index::open(&library).expect("全量重建索引");
    let after = rebuilt.snapshot().expect("取重建侧快照");
    assert_eq!(before, after, "v3 增量索引与重建索引不一致");
}

// —— 组二：显示名/来源名双查询 ——

/// 三张素材的标准场景库：A 已改名（来源 IMG_0042.JPG → 显示 雨夜街道）、
/// B 显示名带英文大小写混合（Character-Sheet）、C 无关对照。
fn dual_name_library() -> (tempfile::TempDir, Library, ContentHash, ContentHash) {
    // 磁盘名保留原样大小写而 ext 小写归一，是真实 v2 数据——迁移剥离扩展名时
    // 必须大小写不敏感，否则这两张夹具都过不了显示名校验。
    let renamed = v2_sidecar(b"dual-renamed", "IMG_0042.PNG", &[]);
    let mixed_case = v2_sidecar(b"dual-mixed-case", "DSC_0100.PNG", &[]);
    let unrelated = v2_sidecar(b"dual-unrelated", "bg_0001.png", &[]);
    // 侧车会整体移进夹具，哈希先取出来供断言使用。
    let renamed_hash = renamed.hash.clone();
    let mixed_hash = mixed_case.hash.clone();
    let (_directory, library) = migrated_library(&[renamed, mixed_case, unrelated], &[]);

    // 模拟使用者改名：直接经 v3 公开 interface 修改显示文件名后落盘，
    // 并删除索引迫使下一次打开全量重建——查询看到的就是磁盘上的新名字。
    for (hash, stem) in [
        (&renamed_hash, "雨夜街道"),
        (&mixed_hash, "Character-Sheet"),
    ] {
        let path = library.sidecar_path(hash);
        let mut sidecar = AssetSidecarV3::read(&path).expect("读取待改名侧车");
        sidecar
            .rename_display_filename(stem)
            .expect("改名应保留真实扩展名");
        sidecar.write_atomic(&path).expect("落盘改名结果");
    }
    std::fs::remove_file(library.index_path()).expect("删除索引迫使重建");

    (_directory, library, renamed_hash, mixed_hash)
}

#[test]
fn filename_text_matches_display_and_source_filenames_case_insensitively() {
    let (_directory, library, renamed_hash, mixed_hash) = dual_name_library();
    let catalog = Catalog::open(library).expect("打开编目");

    // 场景"按显示文件名大小写不敏感搜索"：显示名为 Character-Sheet.png，搜小写
    // `character` 必须命中。
    let by_display = catalog
        .snapshot(&AssetQuery {
            text: "character".to_owned(),
            ..all_active_query()
        })
        .expect("按显示名搜索");
    assert_eq!(
        by_display.assets.iter().map(|a| a.hash.as_str()).collect::<Vec<_>>(),
        vec![mixed_hash.as_str()],
        "显示文件名应参与大小写折叠匹配"
    );

    // 场景"按来源文件名找到已改名素材"：显示名已是雨夜街道，搜来源名的
    // 小写形式仍必须命中。
    let by_source = catalog
        .snapshot(&AssetQuery {
            text: "img_0042".to_owned(),
            ..all_active_query()
        })
        .expect("按来源名搜索");
    assert_eq!(
        by_source.assets.iter().map(|a| a.hash.as_str()).collect::<Vec<_>>(),
        vec![renamed_hash.as_str()],
        "改名后按来源文件名搜索必须仍能找到素材"
    );

    // Unicode 子串：中文名按码点参与匹配，而不是只在 ASCII 上折叠。
    let by_unicode = catalog
        .snapshot(&AssetQuery {
            text: "雨夜".to_owned(),
            ..all_active_query()
        })
        .expect("按中文名搜索");
    assert_eq!(
        by_unicode.assets.iter().map(|a| a.hash.as_str()).collect::<Vec<_>>(),
        vec![renamed_hash.as_str()],
        "显示文件名的中文子串应可检索"
    );

    // 空文本不限制结果。
    let unfiltered = catalog
        .snapshot(&all_active_query())
        .expect("无条件查询");
    assert_eq!(unfiltered.assets.len(), 3, "空文本不得过滤任何素材");
}

#[test]
fn trash_query_filters_by_both_filenames_without_mixing_active_assets() {
    // 场景"查询回收站"：回收站内按显示名或来源名过滤，正常素材绝不混入。
    let active = v2_sidecar(b"trash-query-active", "keeper.png", &[]);
    let mut trashed = v2_sidecar(b"trash-query-trashed", "old_shot.PNG", &[]);
    trashed.deleted_at = Some(DateTime::from_timestamp(1_777_777_779, 0).expect("固定时间戳"));
    let (_directory, library) = migrated_library(&[active], &[]);

    let trashed_v3 = AssetSidecarV3 {
        format_version: SIDECAR_FORMAT_VERSION_V3,
        hash: trashed.hash.clone(),
        hash_algo: HASH_ALGO_ID.to_owned(),
        media_type: MediaType::Png,
        ext: "png".to_owned(),
        byte_size: trashed.byte_size,
        width: 16,
        height: 9,
        imported_at: trashed.imported_at,
        source: AssetSource::Filesystem {
            path: Some("D:/素材/old_shot.PNG".to_owned()),
            filename: "old_shot.PNG".to_owned(),
        },
        display_filename: DisplayFilename::new("废弃草图", MediaType::Png).expect("合法显示名"),
        folder: None,
        tags: vec![],
        color_card: ColorCard::failed(Code::ColorCardInsufficientOpaquePixels),
        note: String::new(),
        favorite: false,
        deleted_at: trashed.deleted_at,
        deleted_from_folder: None,
    };
    trashed_v3
        .write_atomic(&library.trash_sidecar_path(&trashed.hash))
        .expect("写入回收站 v3 侧车");
    // 回收站侧车是绕过增量入口手工落盘的，迁移提交留下的索引里没有它；
    // 删掉索引迫使打开时全量重建，查询看到的才是磁盘上的全部权威元数据。
    std::fs::remove_file(library.index_path()).expect("删除索引迫使重建");

    let catalog = Catalog::open(library).expect("打开编目");
    let trash_query = |text: &str| AssetQuery {
        text: text.to_owned(),
        location: AssetLocation::Trash,
        ..all_active_query()
    };

    // 按回收站素材的显示名（中文）命中。
    let by_display = catalog
        .snapshot(&trash_query("废弃"))
        .expect("按回收站显示名搜索");
    assert_eq!(
        by_display.assets.iter().map(|a| a.hash.as_str()).collect::<Vec<_>>(),
        vec![trashed.hash.as_str()],
        "回收站应按显示文件名过滤"
    );
    // 按回收站素材的来源名命中（大小写折叠）。
    let by_source = catalog
        .snapshot(&trash_query("OLD_SHOT"))
        .expect("按回收站来源名搜索");
    assert_eq!(
        by_source.assets.iter().map(|a| a.hash.as_str()).collect::<Vec<_>>(),
        vec![trashed.hash.as_str()],
        "回收站应按来源文件名过滤"
    );
    // 正常素材的名字不得把回收站查询引向它。
    let none = catalog.snapshot(&trash_query("keeper")).expect("互斥检查");
    assert!(
        none.assets.is_empty(),
        "回收站查询不得混入正常素材：{:?}",
        none.assets
    );
}

// —— 组三：Catalog 单归属写入 ——

/// 一张已归属于 `参考` 的素材所在的迁移后工作区。
fn single_folder_workspace() -> (tempfile::TempDir, Catalog, ContentHash) {
    let source = v2_sidecar(b"single-owner", "portrait.png", &["参考"]);
    let hash = source.hash.clone();
    let (_directory, library) = migrated_library(&[source], &["参考", "配色"]);
    let catalog = Catalog::open(library).expect("打开编目");
    (_directory, catalog, hash)
}

fn row_folder(catalog: &Catalog, hash: &ContentHash) -> Option<String> {
    catalog
        .snapshot(&all_active_query())
        .expect("取快照")
        .assets
        .into_iter()
        .find(|asset| asset.hash == hash.as_str())
        .expect("应能找到素材行")
        .folder
}

#[test]
fn moving_an_asset_to_another_folder_replaces_the_single_membership() {
    // 场景"把素材移动到另一个文件夹"：成功后唯一归属是新文件夹，旧的消失。
    let (_directory, mut catalog, hash) = single_folder_workspace();
    let target = FolderPath::parse("配色").expect("合法目标路径");

    catalog
        .move_asset_to_folder(&hash, Some(&target))
        .expect("移动到另一文件夹");

    assert_eq!(
        row_folder(&catalog, &hash).as_deref(),
        Some("配色"),
        "移动后唯一归属应为目标文件夹"
    );
    // 权威侧车同步：索引只是派生物，真正的承诺落在磁盘字节上。
    let persisted = AssetSidecarV3::read(&catalog.library().sidecar_path(&hash))
        .expect("读回权威侧车");
    assert_eq!(persisted.folder.as_deref(), Some("配色"), "权威侧车未更新");
}

#[test]
fn moving_an_asset_to_unclassified_clears_the_membership() {
    // 场景"把素材移到未分类"：清除归属后，未分类查询必须能找到它。
    let (_directory, mut catalog, hash) = single_folder_workspace();

    catalog.move_asset_to_folder(&hash, None).expect("移动到未分类");

    assert_eq!(
        row_folder(&catalog, &hash),
        None,
        "移动到未分类应清除唯一归属"
    );
    let unclassified = catalog
        .snapshot(&AssetQuery {
            folder: FolderFilter::Root,
            ..all_active_query()
        })
        .expect("查询未分类");
    assert_eq!(
        unclassified.assets.iter().map(|a| a.hash.as_str()).collect::<Vec<_>>(),
        vec![hash.as_str()],
        "未分类查询应命中清除了归属的素材"
    );
}

#[test]
fn moving_to_a_missing_folder_is_rejected_without_touching_the_old_membership() {
    // 场景"拒绝不存在的目标文件夹"：目标必须在清单中，且失败不触碰旧归属——
    // 半完成的移动比拒绝更危险。
    let (_directory, mut catalog, hash) = single_folder_workspace();
    let missing = FolderPath::parse("不存在的文件夹").expect("路径字面值本身合法");

    let error = catalog
        .move_asset_to_folder(&hash, Some(&missing))
        .expect_err("不存在的目标文件夹本应被拒绝");

    assert_eq!(error.code, Code::LibraryFolderNotFound);
    assert_eq!(
        row_folder(&catalog, &hash).as_deref(),
        Some("参考"),
        "失败的移动不得改变原归属"
    );
}

#[test]
fn trashed_assets_refuse_folder_moves() {
    // 规格：回收站素材 MUST NOT 被直接修改文件夹归属。还原语义负责恢复原归属，
    // 组织操作不得绕过它。
    let source = v2_sidecar(b"trashed-move-target", "archived.png", &["参考"]);
    let hash = source.hash.clone();
    let (_directory, library) = migrated_library(&[source], &["参考"]);
    let mut trashed = AssetSidecarV3::read(&library.sidecar_path(&hash)).expect("读取 v3 侧车");
    trashed.folder = None;
    trashed.deleted_at = Some(DateTime::from_timestamp(1_777_777_780, 0).expect("固定时间戳"));
    trashed.deleted_from_folder = Some("参考".to_owned());
    let body = library.body_path(&hash, "png");
    let trash_body = library.trash_body_path(&hash, "png");
    std::fs::create_dir_all(trash_body.parent().expect("回收站叶目录")).expect("建立回收站叶目录");
    // 迁移只搬运元数据，夹具里本体从未存在；真实回收流程移动的是有本体的素材，
    // 先补一个占位再移动，保持与生产相同的文件布局。
    std::fs::write(&body, b"trashed-body").expect("写入占位本体");
    std::fs::rename(&body, &trash_body).expect("移动本体到回收站");
    std::fs::remove_file(library.sidecar_path(&hash)).expect("删除正常树侧车");
    trashed
        .write_atomic(&library.trash_sidecar_path(&hash))
        .expect("写入回收站侧车");

    let mut catalog = Catalog::open(library).expect("打开编目");
    let target = FolderPath::parse("配色").expect("合法目标路径");
    let error = catalog
        .move_asset_to_folder(&hash, Some(&target))
        .expect_err("回收站素材本应拒绝移动");

    assert_eq!(error.code, Code::LibraryAssetMetadataWriteFailed);
}

#[test]
fn renaming_display_filename_preserves_source_identity_and_updates_the_index() {
    let source = v2_sidecar(b"rename-display", "IMG_0042.PNG", &[]);
    let hash = source.hash.clone();
    let (_directory, library) = migrated_library(&[source], &[]);
    let before = AssetSidecarV3::read(&library.sidecar_path(&hash)).expect("读取改名前侧车");
    let original_source = before.source.clone();
    let mut catalog = Catalog::open(library.clone()).expect("打开编目");

    catalog
        .rename_asset_display_filename(&hash, "雨夜街道")
        .expect("修改显示文件名");
    let after = AssetSidecarV3::read(&library.sidecar_path(&hash)).expect("读取改名后侧车");
    let snapshot = catalog
        .snapshot(&AssetQuery {
            text: "雨夜街道".to_owned(),
            tags: vec![],
            folder: FolderFilter::All,
            favorite: None,
            location: AssetLocation::Active,
        })
        .expect("按新显示名查询");

    assert_eq!(
        (
            after.display_filename.as_str(),
            after.source,
            snapshot.assets[0].display_filename.as_str(),
        ),
        ("雨夜街道.png", original_source, "雨夜街道.png"),
    );
}
