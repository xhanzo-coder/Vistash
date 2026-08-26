use chrono::DateTime;
use serde_json::json;
use vistash_core::colorcard::ColorCard;
use vistash_core::error::Code;
use vistash_core::hashing::{ContentHash, HASH_ALGO_ID};
use vistash_core::media::MediaType;
use vistash_core::sidecar::{
    AssetSidecarV3, AssetSource, DisplayFilename, SIDECAR_FORMAT_VERSION_V3,
};

fn filesystem_sidecar() -> AssetSidecarV3 {
    AssetSidecarV3 {
        format_version: SIDECAR_FORMAT_VERSION_V3,
        hash: ContentHash::of_bytes(b"v3-sidecar"),
        hash_algo: HASH_ALGO_ID.to_owned(),
        media_type: MediaType::Jpeg,
        ext: "jpg".to_owned(),
        byte_size: 10,
        width: 3024,
        height: 4032,
        imported_at: DateTime::from_timestamp(1_777_777_777, 0).expect("固定时间戳"),
        source: AssetSource::Filesystem {
            path: Some("D:/素材/IMG_0042.JPG".to_owned()),
            filename: "IMG_0042.JPG".to_owned(),
        },
        display_filename: DisplayFilename::new("雨夜街道", MediaType::Jpeg)
            .expect("合法显示文件名"),
        folder: Some("项目甲/场景".to_owned()),
        tags: vec!["夜景".to_owned()],
        color_card: ColorCard::failed(Code::ColorCardInsufficientOpaquePixels),
        note: "低照度参考".to_owned(),
        favorite: true,
        deleted_at: None,
        deleted_from_folder: None,
    }
}

#[test]
fn v3_explicit_source_display_filename_and_single_folder_round_trip() {
    let directory = tempfile::tempdir().expect("建立临时目录");
    let path = directory.path().join("asset.json");
    let expected = filesystem_sidecar();

    expected.write_atomic(&path).expect("写入 v3 侧车");
    let actual = AssetSidecarV3::read(&path).expect("读回 v3 侧车");

    assert_eq!(actual, expected);
}

#[test]
fn v3_serializes_the_new_identity_fields_without_a_folders_array() {
    let value = serde_json::to_value(filesystem_sidecar()).expect("序列化 v3 侧车");
    let actual = json!({
        "source": value["source"].clone(),
        "display_filename": value["display_filename"].clone(),
        "folder": value["folder"].clone(),
        "folders": value.get("folders").cloned(),
    });
    let expected = json!({
        "source": {
            "kind": "filesystem",
            "path": "D:/素材/IMG_0042.JPG",
            "filename": "IMG_0042.JPG",
        },
        "display_filename": "雨夜街道.jpg",
        "folder": "项目甲/场景",
        "folders": null,
    });

    assert_eq!(actual, expected);
}

#[test]
fn v3_reader_refuses_a_missing_display_filename() {
    let directory = tempfile::tempdir().expect("建立临时目录");
    let path = directory.path().join("asset.json");
    let mut value = serde_json::to_value(filesystem_sidecar()).expect("序列化 v3 侧车");
    value
        .as_object_mut()
        .expect("侧车必须是对象")
        .remove("display_filename");
    std::fs::write(
        &path,
        serde_json::to_vec_pretty(&value).expect("序列化损坏 fixture"),
    )
    .expect("写入损坏 fixture");

    let error = AssetSidecarV3::read(&path).expect_err("本应拒绝缺少显示文件名的侧车");

    assert_eq!(error.code, Code::LibraryMetadataCorrupt);
}

#[test]
fn v3_reader_refuses_the_legacy_folders_array() {
    let directory = tempfile::tempdir().expect("建立临时目录");
    let path = directory.path().join("asset.json");
    let mut value = serde_json::to_value(filesystem_sidecar()).expect("序列化 v3 侧车");
    let object = value.as_object_mut().expect("侧车必须是对象");
    object.remove("folder");
    object.insert("folders".to_owned(), json!(["参考", "配色"]));
    std::fs::write(
        &path,
        serde_json::to_vec_pretty(&value).expect("序列化旧字段 fixture"),
    )
    .expect("写入旧字段 fixture");

    let error = AssetSidecarV3::read(&path).expect_err("本应拒绝旧 folders 数组");

    assert_eq!(error.code, Code::LibraryMetadataCorrupt);
}

#[test]
fn v3_filesystem_source_preserves_an_explicitly_missing_legacy_path() {
    let directory = tempfile::tempdir().expect("建立临时目录");
    let path = directory.path().join("asset.json");
    let mut sidecar = filesystem_sidecar();
    sidecar.source = AssetSource::Filesystem {
        path: None,
        filename: "IMG_0042.JPG".to_owned(),
    };

    sidecar.write_atomic(&path).expect("写入无来源路径侧车");
    let value: serde_json::Value =
        serde_json::from_slice(&std::fs::read(path).expect("读取侧车")).expect("解析侧车 JSON");

    assert_eq!(value["source"]["path"], serde_json::Value::Null);
}

#[test]
fn display_filename_refuses_an_empty_stem() {
    let error = DisplayFilename::new("   ", MediaType::Png).expect_err("本应拒绝空名称主体");

    assert_eq!(error.code, Code::LibraryFilenameInvalid);
}

#[test]
fn display_filename_refuses_a_user_supplied_media_extension() {
    let error = DisplayFilename::new("参考图.jpg", MediaType::Png).expect_err("本应拒绝伪造扩展名");

    assert_eq!(error.code, Code::LibraryFilenameInvalid);
}

#[test]
fn renaming_display_filename_preserves_the_immutable_source() {
    let mut sidecar = filesystem_sidecar();
    let original_source = sidecar.source.clone();

    sidecar
        .rename_display_filename("雨夜街道选片")
        .expect("修改显示文件名");

    assert_eq!(
        (sidecar.display_filename.as_str(), &sidecar.source),
        ("雨夜街道选片.jpg", &original_source),
    );
}

#[test]
fn invalid_rename_keeps_the_previous_display_filename() {
    let mut sidecar = filesystem_sidecar();
    let previous = sidecar.display_filename.clone();

    let error = sidecar
        .rename_display_filename("参考图.png")
        .expect_err("本应拒绝带图片扩展名的改名");

    assert_eq!(
        (error.code, sidecar.display_filename),
        (Code::LibraryFilenameInvalid, previous),
    );
}

#[test]
fn moving_to_a_folder_replaces_the_previous_single_assignment() {
    let mut sidecar = filesystem_sidecar();

    sidecar
        .move_to_folder(Some("项目乙/定稿"))
        .expect("移动到另一个文件夹");

    assert_eq!(sidecar.folder.as_deref(), Some("项目乙/定稿"));
}

#[test]
fn moving_to_unclassified_clears_the_single_folder() {
    let mut sidecar = filesystem_sidecar();

    sidecar.move_to_folder(None).expect("移动到未分类");

    assert_eq!(sidecar.folder, None);
}

#[test]
fn invalid_folder_move_keeps_the_previous_assignment() {
    let mut sidecar = filesystem_sidecar();
    let previous = sidecar.folder.clone();

    let error = sidecar
        .move_to_folder(Some("项目甲//场景"))
        .expect_err("本应拒绝包含空段的文件夹路径");

    assert_eq!(
        (error.code, sidecar.folder),
        (Code::LibraryFolderInvalid, previous),
    );
}
