use chrono::DateTime;
use vistash_core::colorcard::ColorCard;
use vistash_core::error::Code;
use vistash_core::hashing::{ContentHash, HASH_ALGO_ID};
use vistash_core::library::Library;
use vistash_core::media::MediaType;
use vistash_core::migration::{
    detect_library_format, LibraryFormatState, V3FolderPlan, V3FolderResolution,
    V3MigrationPlan,
};
use vistash_core::sidecar::{AssetSidecarV2, SIDECAR_FORMAT_VERSION_V2};

fn v2_sidecar(seed: &[u8], folders: &[&str]) -> AssetSidecarV2 {
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
        original_filename: "来源图片.png".to_owned(),
        source_path: Some("D:/素材/来源图片.png".to_owned()),
        folders: folders.iter().map(|folder| (*folder).to_owned()).collect(),
        tags: vec![],
        color_card: ColorCard::failed(Code::ColorCardInsufficientOpaquePixels),
        note: String::new(),
        favorite: false,
        deleted_at: None,
        deleted_from_folders: None,
    }
}

fn library_with_sidecar(sidecar: &AssetSidecarV2) -> (tempfile::TempDir, Library) {
    let directory = tempfile::tempdir().expect("建立临时目录");
    let library = Library::create(&directory.path().join("library")).expect("建立库");
    // 建库入口自任务 3.5 起直接产出 v3 库级元数据；本契约验证的是 v2→v3 规划，
    // 夹具因此显式把 library.json 降写回 v2，与下方按 v2 写出的侧车保持同代。
    let v2_meta = vistash_core::library::LibraryMetaV2 {
        format_version: vistash_core::library::LIBRARY_FORMAT_VERSION_V2,
        library_id: library.meta().library_id.clone(),
        hash_algo: library.meta().hash_algo.clone(),
        created_at: library.meta().created_at,
        created_by_app_version: library.meta().created_by_app_version.clone(),
    };
    v2_meta
        .write_atomic(&library.root().join(vistash_core::library::META_FILE))
        .expect("降写 v2 库级元数据");
    sidecar
        .write_atomic(&library.sidecar_path(&sidecar.hash))
        .expect("写入 v2 侧车");
    (directory, library)
}

#[test]
fn v2_library_is_reported_as_needing_v3_migration() {
    let sidecar = v2_sidecar(b"v2-open-gate", &["参考"]);
    let (_directory, library) = library_with_sidecar(&sidecar);

    let state = detect_library_format(library.root()).expect("识别 v2 库格式");

    assert!(matches!(state, LibraryFormatState::NeedsV3Migration(_)));
}

#[test]
fn production_library_open_refuses_v2_before_catalog_rebuild() {
    let sidecar = v2_sidecar(b"v2-production-open", &["参考"]);
    let (_directory, library) = library_with_sidecar(&sidecar);

    let error = Library::open(library.root()).expect_err("v2 库必须先迁移到 v3");

    assert_eq!(error.code, Code::LibraryFormatTooOld);
}

#[test]
fn v3_plan_maps_zero_folder_membership_to_unclassified() {
    let sidecar = v2_sidecar(b"zero-folder", &[]);
    let (_directory, library) = library_with_sidecar(&sidecar);

    let plan = V3MigrationPlan::inspect(library.root()).expect("生成 v3 迁移计划");

    assert_eq!(plan.entries[0].folder, V3FolderPlan::Automatic(None));
}

#[test]
fn v3_plan_keeps_a_single_folder_membership_automatically() {
    let sidecar = v2_sidecar(b"single-folder", &["参考/构图"]);
    let (_directory, library) = library_with_sidecar(&sidecar);

    let plan = V3MigrationPlan::inspect(library.root()).expect("生成 v3 迁移计划");

    assert_eq!(
        plan.entries[0].folder,
        V3FolderPlan::Automatic(Some("参考/构图".to_owned())),
    );
}

#[test]
fn v3_plan_exposes_every_multi_folder_membership_as_a_conflict() {
    let sidecar = v2_sidecar(b"multi-folder", &["参考", "配色"]);
    let (_directory, library) = library_with_sidecar(&sidecar);

    let plan = V3MigrationPlan::inspect(library.root()).expect("生成 v3 迁移计划");

    assert_eq!(
        plan.entries[0].folder,
        V3FolderPlan::Conflict(vec!["参考".to_owned(), "配色".to_owned()]),
    );
}

#[test]
fn inspecting_v3_plan_does_not_modify_authoritative_bytes() {
    let sidecar = v2_sidecar(b"read-only-plan", &["参考", "配色"]);
    let (_directory, library) = library_with_sidecar(&sidecar);
    let path = library.sidecar_path(&sidecar.hash);
    let before = std::fs::read(&path).expect("读取规划前侧车");

    V3MigrationPlan::inspect(library.root()).expect("生成只读迁移计划");
    let after = std::fs::read(&path).expect("读取规划后侧车");

    assert_eq!(after, before);
}

#[test]
fn v3_plan_requires_one_valid_choice_for_every_conflict() {
    let sidecar = v2_sidecar(b"resolve-conflict", &["参考", "配色"]);
    let (_directory, library) = library_with_sidecar(&sidecar);
    let plan = V3MigrationPlan::inspect(library.root()).expect("生成 v3 迁移计划");

    let resolved = plan
        .resolve(&[V3FolderResolution {
            hash: sidecar.hash.clone(),
            folder: "配色".to_owned(),
        }])
        .expect("解决多归属冲突");

    assert_eq!(resolved.entries[0].folder.as_deref(), Some("配色"));
}

#[test]
fn v3_plan_refuses_a_choice_that_was_not_an_original_membership() {
    let sidecar = v2_sidecar(b"invalid-resolution", &["参考", "配色"]);
    let (_directory, library) = library_with_sidecar(&sidecar);
    let plan = V3MigrationPlan::inspect(library.root()).expect("生成 v3 迁移计划");

    let error = plan
        .resolve(&[V3FolderResolution {
            hash: sidecar.hash,
            folder: "不存在的归属".to_owned(),
        }])
        .expect_err("本应拒绝原归属之外的选择");

    assert_eq!(error.code, Code::MigrationResolutionInvalid);
}

#[test]
fn v3_plan_detects_sidecar_changes_after_inspection() {
    let sidecar = v2_sidecar(b"stale-plan", &["参考"]);
    let (_directory, library) = library_with_sidecar(&sidecar);
    let plan = V3MigrationPlan::inspect(library.root()).expect("生成 v3 迁移计划");
    std::fs::write(library.sidecar_path(&sidecar.hash), b"changed after plan")
        .expect("模拟规划后外部改写");

    let error = plan
        .verify_source_unchanged(library.root())
        .expect_err("本应拒绝已经过期的计划");

    assert_eq!(error.code, Code::MigrationPlanStale);
}

#[test]
fn v3_plan_detects_a_sidecar_added_after_inspection() {
    let sidecar = v2_sidecar(b"initial-plan-entry", &["参考"]);
    let (_directory, library) = library_with_sidecar(&sidecar);
    let plan = V3MigrationPlan::inspect(library.root()).expect("生成 v3 迁移计划");
    let added = v2_sidecar(b"added-after-plan", &[]);
    added
        .write_atomic(&library.sidecar_path(&added.hash))
        .expect("规划后新增侧车");

    let error = plan
        .verify_source_unchanged(library.root())
        .expect_err("本应拒绝规划后新增的侧车");

    assert_eq!(error.code, Code::MigrationPlanStale);
}
