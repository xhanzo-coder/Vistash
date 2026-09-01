//! 应用级设置：与库无关、跟随本机用户的少量状态。
//!
//! 它刻意**不在库目录内**。库是可以整体拷到另一台机器上直接打开的自包含目录，而"上次
//! 打开的是哪个库"是本机偏好；把它写进库里，会让同一个库在两台机器之间来回覆盖对方的
//! 选择，并且拷贝一份库就等于连带拷走了别人的界面状态。
//!
//! 设置文件的存放位置由调用方给出。本 crate 不去猜操作系统的配置目录：那需要判断平台，
//! 而平台判断属于应用装配层的职责。

use crate::error::{AppError, Code, Result};
use crate::library::LibraryId;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// 设置文件的格式版本。
pub const SETTINGS_FORMAT_VERSION: u32 = 1;

/// 应用级设置。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AppSettings {
    pub format_version: u32,
    /// 上次成功打开的库路径。`None` 表示还没有选过库。
    ///
    /// 只在成功打开之后才写入：若在选择时就写入，一个打不开的目录会被记住，
    /// 于是下次启动仍然撞在同一个错误上。
    pub last_library_path: Option<String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            format_version: SETTINGS_FORMAT_VERSION,
            last_library_path: None,
        }
    }
}

impl AppSettings {
    /// 读取设置。
    ///
    /// 文件不存在时返回默认值——首次运行没有设置文件是正常状态，不是失败。
    /// 但文件存在而无法解析时报错而不是重置：静默重置会让使用者的库选择凭空消失，
    /// 而他看到的现象只是"又要我选一次库"，无从归因。
    pub fn read(path: &Path) -> Result<Self> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let bytes = std::fs::read(path).map_err(|e| {
            AppError::detailed(
                Code::LibrarySettingsCorrupt,
                format!("读取设置失败 {}: {e}", path.display()),
            )
        })?;
        let settings: Self = serde_json::from_slice(&bytes).map_err(|e| {
            AppError::detailed(
                Code::LibrarySettingsCorrupt,
                format!("设置无法解析 {}: {e}", path.display()),
            )
        })?;
        if settings.format_version > SETTINGS_FORMAT_VERSION {
            return Err(AppError::detailed(
                Code::LibraryFormatTooNew,
                format!(
                    "设置格式版本 {} 高于程序支持的 {}：{}",
                    settings.format_version,
                    SETTINGS_FORMAT_VERSION,
                    path.display()
                ),
            ));
        }
        Ok(settings)
    }

    /// 写入设置。先写临时文件再改名，使进程在写入中途终止时不会留下半个 JSON。
    pub fn write_atomic(&self, path: &Path) -> Result<()> {
        let fail = |detail: String| AppError::detailed(Code::LibraryIoFailed, detail);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                fail(format!("建立设置目录失败 {}: {e}", parent.display()))
            })?;
        }
        let json = serde_json::to_vec_pretty(self)
            .map_err(|e| fail(format!("序列化设置失败: {e}")))?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, &json)
            .map_err(|e| fail(format!("写入临时设置失败 {}: {e}", tmp.display())))?;
        std::fs::rename(&tmp, path).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            fail(format!("提交设置失败 {}: {e}", path.display()))
        })
    }
}

/// 分库布局偏好的存放处：紧凑顶栏、视图、文件夹、筛选与滚动位置等界面状态。
///
/// 以库 ID 而不是库路径为键：库目录可以被整体移动或改名，布局跟随的是库的身份
/// 而不是它此刻在磁盘上的位置。目录与设置文件同理
/// 放在应用配置侧，不进任何库目录——布局是本机的界面偏好，不该跟着库目录被
/// 拷贝到别的机器上。
///
/// 文件内容是前端领域的任意 JSON：本类型只按键存储透传，不解释其结构。这样
/// 布局模型的演进（新增字段、改语义）永远不需要动后端，IPC 合同保持稳定。
pub struct LayoutStore {
    dir: PathBuf,
}

impl LayoutStore {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    fn path_for(&self, library_id: &LibraryId) -> PathBuf {
        self.dir.join(format!("{}.json", library_id.as_str()))
    }

    /// 读取一个库的布局偏好。从未保存过时返回 `None`。
    ///
    /// 文件存在而无法解析时报错而不是返回 `None`：静默丢弃会让使用者的工作区
    /// 布局凭空复位，而他看到的现象只是"布局怎么变了"，无从归因。
    pub fn read(&self, library_id: &LibraryId) -> Result<Option<serde_json::Value>> {
        let path = self.path_for(library_id);
        if !path.exists() {
            return Ok(None);
        }
        let bytes = std::fs::read(&path).map_err(|e| {
            AppError::detailed(
                Code::LibrarySettingsCorrupt,
                format!("读取布局偏好失败 {}: {e}", path.display()),
            )
        })?;
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|e| {
                AppError::detailed(
                    Code::LibrarySettingsCorrupt,
                    format!("布局偏好无法解析 {}: {e}", path.display()),
                )
            })
    }

    /// 写入一个库的布局偏好（整体覆盖）。先写临时文件再改名，与设置同一原子性。
    pub fn write(&self, library_id: &LibraryId, layout: &serde_json::Value) -> Result<()> {
        let fail = |detail: String| AppError::detailed(Code::LibraryIoFailed, detail);
        std::fs::create_dir_all(&self.dir)
            .map_err(|e| fail(format!("建立布局目录失败 {}: {e}", self.dir.display())))?;
        let path = self.path_for(library_id);
        let json = serde_json::to_vec_pretty(layout)
            .map_err(|e| fail(format!("序列化布局偏好失败: {e}")))?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, &json)
            .map_err(|e| fail(format!("写入临时布局失败 {}: {e}", tmp.display())))?;
        std::fs::rename(&tmp, &path).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            fail(format!("提交布局失败 {}: {e}", path.display()))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("建立临时目录");
        let p = dir.path().join("设置").join("settings.json");
        (dir, p)
    }

    #[test]
    fn a_missing_file_is_a_first_run_not_a_failure() {
        let (_d, p) = temp();
        let s = AppSettings::read(&p).expect("首次运行不应报错");
        assert_eq!(s, AppSettings::default());
        assert!(s.last_library_path.is_none());
        assert!(!p.exists(), "读取不应创建文件");
    }

    #[test]
    fn round_trips_through_json() {
        let (_d, p) = temp();
        let s = AppSettings {
            format_version: SETTINGS_FORMAT_VERSION,
            last_library_path: Some("D:/我的素材库".to_owned()),
        };
        s.write_atomic(&p).expect("写入设置");
        assert_eq!(AppSettings::read(&p).expect("读回设置"), s);
    }

    #[test]
    fn an_unparseable_file_is_reported_not_silently_reset() {
        let (_d, p) = temp();
        std::fs::create_dir_all(p.parent().expect("父目录")).expect("建立父目录");
        std::fs::write(&p, "{ 这不是合法 JSON".as_bytes()).expect("写入损坏内容");
        let err = AppSettings::read(&p).expect_err("本应报告损坏");
        assert_eq!(err.code, Code::LibrarySettingsCorrupt);
    }

    #[test]
    fn a_newer_format_version_is_refused() {
        let (_d, p) = temp();
        let s = AppSettings {
            format_version: SETTINGS_FORMAT_VERSION + 1,
            ..Default::default()
        };
        s.write_atomic(&p).expect("写入更高版本设置");
        let err = AppSettings::read(&p).expect_err("本应拒绝更高的格式版本");
        assert_eq!(err.code, Code::LibraryFormatTooNew);
    }

    #[test]
    fn atomic_write_leaves_no_temp_file_behind() {
        let (_d, p) = temp();
        AppSettings::default().write_atomic(&p).expect("写入设置");
        let leftovers: Vec<String> = std::fs::read_dir(p.parent().expect("父目录"))
            .expect("读取目录")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "残留临时文件：{leftovers:?}");
    }

    #[test]
    fn overwriting_an_existing_file_succeeds() {
        let (_d, p) = temp();
        let mut s = AppSettings::default();
        s.write_atomic(&p).expect("首次写入");
        s.last_library_path = Some("E:/另一个库".to_owned());
        s.write_atomic(&p).expect("覆盖写入");
        assert_eq!(
            AppSettings::read(&p).expect("读回").last_library_path.as_deref(),
            Some("E:/另一个库")
        );
    }

    // ---- LayoutStore：分库布局偏好 ----

    fn store(dir: &std::path::Path) -> super::LayoutStore {
        super::LayoutStore::new(dir.join("布局"))
    }

    /// 库 ID 只要求规范 UUID 形式；测试用固定字面值，避免引入生成器依赖。
    fn library_id(literal: &str) -> super::LibraryId {
        super::LibraryId::parse(literal).expect("测试库 ID 应合法")
    }

    #[test]
    fn a_never_saved_layout_reads_back_as_none() {
        let d = tempfile::tempdir().expect("建立临时目录");
        let id = library_id("018f3c9e-6c00-7000-8000-0000000000aa");
        assert_eq!(
            store(d.path()).read(&id).expect("首次读取不应报错"),
            None,
            "读取不应凭空造出布局"
        );
        assert!(!d.path().join("布局").exists(), "读取不应创建目录");
    }

    #[test]
    fn layout_round_trips_arbitrary_json_and_overwrites() {
        let d = tempfile::tempdir().expect("建立临时目录");
        let s = store(d.path());
        let id = library_id("018f3c9e-6c00-7000-8000-0000000000aa");
        // 任意嵌套 JSON 原样透传：后端不解释布局结构，这是 IPC 合同的一部分。
        let first = serde_json::json!({
            "image": { "view": "grid", "scroll": 1284 },
            "prompt": { "sort": "created_desc", "filters": ["收藏"] }
        });
        s.write(&id, &first).expect("写入布局");
        assert_eq!(s.read(&id).expect("读回布局"), Some(first));
        let second = serde_json::json!({ "image": { "view": "list" } });
        s.write(&id, &second).expect("覆盖写入");
        assert_eq!(s.read(&id).expect("再读回"), Some(second));
    }

    #[test]
    fn layouts_of_different_libraries_do_not_mix() {
        let d = tempfile::tempdir().expect("建立临时目录");
        let s = store(d.path());
        let a = library_id("018f3c9e-6c00-7000-8000-0000000000aa");
        let b = library_id("018f3c9e-6c00-7000-8000-0000000000bb");
        s.write(&a, &serde_json::json!({ "who": "a" }))
            .expect("写入 A 库布局");
        assert_eq!(
            s.read(&b).expect("读 B 库布局"),
            None,
            "A 库的布局不得泄漏给 B 库"
        );
    }

    #[test]
    fn a_corrupt_layout_file_is_reported_not_silently_reset() {
        let d = tempfile::tempdir().expect("建立临时目录");
        let s = store(d.path());
        let id = library_id("018f3c9e-6c00-7000-8000-0000000000aa");
        std::fs::create_dir_all(s.dir.clone()).expect("建立布局目录");
        let path = s.dir.join(format!("{}.json", id.as_str()));
        std::fs::write(&path, "{ 被截断的 JSON".as_bytes()).expect("写损坏内容");
        let err = s.read(&id).expect_err("本应报告损坏");
        assert_eq!(err.code, Code::LibrarySettingsCorrupt);
    }
}
