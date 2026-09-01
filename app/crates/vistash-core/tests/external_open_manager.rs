//! 默认程序打开的只读临时副本管理器合同。
//!
//! 隔离模型：默认程序打开不交库内本体路径（外部程序的写入与
//! 删除不可控），而是把原始字节复制到 `<app_cache_dir>/external-open/v1/<session>/`，
//! 以显示文件名加真实扩展名命名，设只读属性；同一素材复用同一份不可变副本。
//! 清理只作用于清单记录的 Vistash 自建会话目录，删除前先清只读，被占用
//! （ERROR_SHARING_VIOLATION）的留待下次启动重试；过期策略保守——非当前会话
//! 且超过 24 小时才删。库根、内容哈希目录、导出目标永远不在清理射程内。

use std::path::{Path, PathBuf};

use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
use vistash_core::external_open::ExternalOpenManager;
use vistash_core::hashing::ContentHash;
use vistash_core::import::{ImportOptions, NoopTransferObserver};
use vistash_core::library::Library;

struct Fixture {
    _dir: tempfile::TempDir,
    library: Library,
    root: PathBuf,
    png_hash: ContentHash,
}

fn fixture() -> Fixture {
    let temp_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/vistash-test-temp");
    std::fs::create_dir_all(&temp_root).expect("建立项目测试目录");
    let dir = tempfile::tempdir_in(temp_root).expect("建立临时目录");
    let library = Library::create(&dir.path().join("library")).expect("建立库");

    let src = dir.path().join("风景.png");
    DynamicImage::ImageRgb8(RgbImage::from_pixel(8, 8, Rgb([9, 99, 199])))
        .save_with_format(&src, ImageFormat::Png)
        .expect("写入样本图");
    let sidecar = vistash_core::import::import_one(
        &library,
        &src,
        &ImportOptions::default(),
        &mut NoopTransferObserver,
    )
    .expect("导入样本图");

    Fixture {
        root: dir.path().join("cache/external-open/v1"),
        png_hash: sidecar.hash,
        library,
        _dir: dir,
    }
}

fn at(hour: u32) -> chrono::DateTime<chrono::Utc> {
    use chrono::TimeZone;
    chrono::Utc
        .with_ymd_and_hms(2026, 8, 26, hour, 0, 0)
        .single()
        .expect("合法时刻")
}

/// 直接在清单里登记一个会话目录并放入一个文件，模拟历史会话残留。
/// 清单格式与实现共享同一约定：`{ "<session-id>": "<RFC3339 创建时刻>" }`。
fn seed_session(root: &Path, session_id: &str, created_at: &str, readonly: bool) -> PathBuf {
    let dir = root.join(session_id);
    std::fs::create_dir_all(&dir).expect("建立会话目录");
    let file = dir.join("风景.png");
    std::fs::write(&file, b"stale-session-copy").expect("写入会话文件");
    if readonly {
        make_readonly(&file);
    }
    let manifest_path = root.join("manifest.json");
    let mut manifest = read_manifest_json(&manifest_path);
    manifest
        .entry(session_id.to_owned())
        .and_modify(|_| panic!("会话 {session_id} 不应重复登记"))
        .or_insert_with(|| created_at.to_owned());
    write_manifest_json(&manifest_path, &manifest);
    dir
}

fn make_readonly(path: &Path) {
    let mut permissions = std::fs::metadata(path).expect("读取元数据").permissions();
    permissions.set_readonly(true);
    std::fs::set_permissions(path, permissions).expect("设置只读");
}

type ManifestMap = std::collections::BTreeMap<String, String>;

fn read_manifest_json(path: &Path) -> ManifestMap {
    match std::fs::read_to_string(path) {
        Ok(text) => {
            serde_json::from_str::<ManifestMap>(&text).expect("清单必须是 {session: rfc3339}")
        }
        Err(_) => ManifestMap::new(),
    }
}

fn write_manifest_json(path: &Path, manifest: &ManifestMap) {
    std::fs::create_dir_all(path.parent().expect("清单必有父目录")).ok();
    std::fs::write(
        path,
        serde_json::to_string_pretty(manifest).expect("序列化清单"),
    )
    .expect("写清单");
}

#[test]
fn corrupt_manifest_is_an_explicit_error_not_an_empty_cache() {
    let f = fixture();
    std::fs::create_dir_all(&f.root).expect("建立缓存根");
    std::fs::write(f.root.join("manifest.json"), b"{ corrupt manifest").expect("写入损坏清单");
    let manager = ExternalOpenManager::new(f.root, "sess-now".into());

    let error = manager.cleanup(at(12)).expect_err("损坏清单必须显式失败");

    assert_eq!(error.code, vistash_core::error::Code::ExternalOpenFailed);
}

#[cfg(windows)]
#[test]
fn manifest_rewrite_failure_is_reported_after_cleanup() {
    let f = fixture();
    seed_session(&f.root, "sess-expired", "2026-08-20T00:00:00Z", false);
    make_readonly(&f.root.join("manifest.json"));
    let manager = ExternalOpenManager::new(f.root, "sess-now".into());

    let error = manager
        .cleanup(at(12))
        .expect_err("只读清单回写必须显式失败");

    assert_eq!(error.code, vistash_core::error::Code::ExternalOpenFailed);
}

// —— 组一：副本准备 ——

#[test]
fn prepared_copy_uses_display_filename_and_is_readonly() {
    let f = fixture();
    let manager = ExternalOpenManager::new(f.root.clone(), "sess-a".into());

    let copy = manager
        .prepare(&f.library, &f.png_hash)
        .expect("准备副本应成功");

    assert_eq!(
        copy.file_name().map(|n| n.to_string_lossy().into_owned()),
        Some("风景.png".to_string()),
        "副本必须用显示文件名加真实扩展名命名"
    );
    let body = std::fs::read(f.library.body_path(&f.png_hash, "png")).expect("读库内本体");
    assert_eq!(
        std::fs::read(&copy).expect("读副本"),
        body,
        "副本字节必须与权威本体一致"
    );
    assert!(
        std::fs::metadata(&copy)
            .expect("读副本元数据")
            .permissions()
            .readonly(),
        "副本必须设只读属性"
    );
}

#[test]
fn preparing_the_same_asset_twice_reuses_the_immutable_copy() {
    let f = fixture();
    let manager = ExternalOpenManager::new(f.root.clone(), "sess-a".into());
    let first = manager
        .prepare(&f.library, &f.png_hash)
        .expect("第一次准备");
    // 记录首次创建时间：复用意味着第二次调用不得重写文件。
    let first_modified = std::fs::metadata(&first)
        .expect("读取首份副本元数据")
        .modified()
        .expect("读取修改时间");

    let second = manager
        .prepare(&f.library, &f.png_hash)
        .expect("第二次准备");

    assert_eq!(first, second, "同素材必须复用同一份副本路径");
    assert_eq!(
        std::fs::metadata(&second)
            .expect("回读元数据")
            .modified()
            .expect("回读修改时间"),
        first_modified,
        "复用时不得重写副本文件"
    );
}

// —— 组二：缓存清理的边界 ——

#[test]
fn cleanup_removes_only_expired_recorded_sessions() {
    let f = fixture();
    // 三个登记会话：过期的他方会话（删）、新鲜的他方会话（留）、过期的当前会话（留）。
    let expired_dir = seed_session(&f.root, "sess-expired", "2026-08-24T00:00:00Z", false);
    seed_session(&f.root, "sess-fresh", "2026-08-26T10:00:00Z", false);
    seed_session(&f.root, "sess-current-old", "2026-08-24T00:00:00Z", false);
    // 清单之外的同形目录：哪怕名字再像会话目录也绝不动。
    let stray_dir = f.root.join("sess-stray");
    std::fs::create_dir_all(&stray_dir).expect("建立清单外目录");
    std::fs::write(stray_dir.join("x.txt"), b"stray").expect("写入清单外文件");

    let manager = ExternalOpenManager::new(f.root.clone(), "sess-current-old".into());
    let report = manager.cleanup(at(12)).expect("清理过期会话");

    assert_eq!(report.removed_sessions, vec!["sess-expired".to_string()]);
    assert!(!expired_dir.exists(), "过期且已记录的会话目录应被删除");
    assert!(
        f.root.join("sess-fresh").exists(),
        "未到 24 小时的会话必须保留"
    );
    assert!(
        f.root.join("sess-current-old").exists(),
        "当前会话无论多旧都不得自删"
    );
    assert!(stray_dir.exists(), "清单之外的目录绝不在清理射程内");
    // 清单同步收缩：被删条目移除，保留条目原样。
    let manifest = read_manifest_json(&f.root.join("manifest.json"));
    assert!(!manifest.contains_key("sess-expired"));
    assert!(manifest.contains_key("sess-fresh"));
    assert!(manifest.contains_key("sess-current-old"));
}

#[test]
fn cleanup_clears_readonly_attributes_before_delete() {
    let f = fixture();
    // Windows 上带着只读属性的文件无法直接删除：清理必须先清属性。
    let stale = seed_session(&f.root, "sess-locked", "2026-08-20T00:00:00Z", true);

    let manager = ExternalOpenManager::new(f.root.clone(), "sess-now".into());
    let report = manager.cleanup(at(12)).expect("清理只读会话");

    assert_eq!(report.removed_sessions, vec!["sess-locked".to_string()]);
    assert!(!stale.exists(), "清掉只读后整个会话目录应可删除");
}

#[test]
fn cleanup_without_a_manifest_touches_nothing() {
    let f = fixture();
    // 没有清单就没有任何"确认属于 Vistash 会话"的证据：什么都不删。
    let lookalike = f.root.join("sess-lookalike");
    std::fs::create_dir_all(&lookalike).expect("建立同形目录");
    std::fs::write(lookalike.join("a.png"), b"x").expect("写入文件");

    let manager = ExternalOpenManager::new(f.root.clone(), "sess-now".into());
    let report = manager.cleanup(at(12)).expect("无清单清理应成功");

    assert!(report.removed_sessions.is_empty());
    assert!(lookalike.exists(), "无清单时不得猜测性删除任何目录");
}

// —— 组三：被占用文件的延后重试 ——

/// 以"禁止删除共享"的方式占用副本文件，制造真实的 `ERROR_SHARING_VIOLATION`。
///
/// 现代 Rust 的 std 在 Windows 上打开文件自带 `FILE_SHARE_DELETE`，普通的
/// `std::fs::File` 句柄挡不住删除——必须用 `CreateFileW` 显式排除 DELETE
/// 共享位。共享模式只给读和写：这正是外部程序（看图器、资源管理器预览）
/// 持有副本时的典型形态。
#[cfg(windows)]
fn open_without_delete_sharing(path: &Path) -> ExclusiveHandle {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_MODE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        OPEN_EXISTING,
    };
    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // 期望访问只给 GENERIC_READ（0x8000_0000）：读权限足以让删除产生共享冲突。
    let desired_access = 0x8000_0000u32;
    // 共享位刻意不含 FILE_SHARE_DELETE——这就是冲突的来源。
    let share_mode = FILE_SHARE_MODE(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0);
    let handle = unsafe {
        CreateFileW(
            PCWSTR(wide.as_ptr()),
            desired_access,
            share_mode,
            None,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            None,
        )
    }
    .expect("以独占删除模式打开副本文件");
    ExclusiveHandle(handle)
}

/// 持有期间保持内核句柄打开，丢弃时显式 `CloseHandle`——只有真正关闭句柄，
/// "下次启动重试"那一轮清理才能成功。
#[cfg(windows)]
struct ExclusiveHandle(windows::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl Drop for ExclusiveHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

/// 被占用的会话必须留在清单里等下次启动重试，而不是把整轮清理变成失败。
#[cfg(windows)]
#[test]
fn files_in_use_defer_their_session_to_next_startup() {
    let f = fixture();
    let busy_dir = seed_session(&f.root, "sess-busy", "2026-08-20T00:00:00Z", false);
    let held = open_without_delete_sharing(&busy_dir.join("风景.png"));

    let manager = ExternalOpenManager::new(f.root.clone(), "sess-now".into());
    let report = manager.cleanup(at(12)).expect("占用会话应延后");

    assert_eq!(report.deferred_sessions, vec!["sess-busy".to_string()]);
    assert!(report.removed_sessions.is_empty());
    assert!(busy_dir.exists(), "被占用的会话目录本轮不得删除");
    let manifest = read_manifest_json(&f.root.join("manifest.json"));
    assert!(
        manifest.contains_key("sess-busy"),
        "被占用的登记必须保留以便下次重试"
    );

    // 释放句柄后再跑一轮清理——即"下次启动重试"的语义。
    drop(held);
    let retried = manager.cleanup(at(13)).expect("释放占用后重试清理");
    assert_eq!(retried.removed_sessions, vec!["sess-busy".to_string()]);
    assert!(!busy_dir.exists());
}
