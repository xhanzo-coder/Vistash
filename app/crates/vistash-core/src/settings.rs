//! 应用级设置：与库无关、跟随本机用户的少量状态。
//!
//! 它刻意**不在库目录内**。库是可以整体拷到另一台机器上直接打开的自包含目录，而"上次
//! 打开的是哪个库"是本机偏好；把它写进库里，会让同一个库在两台机器之间来回覆盖对方的
//! 选择，并且拷贝一份库就等于连带拷走了别人的界面状态。
//!
//! 设置文件的存放位置由调用方给出。本 crate 不去猜操作系统的配置目录：那需要判断平台，
//! 而平台判断属于应用装配层的职责。

use crate::error::{AppError, Code, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;

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
}
