//! 默认程序打开的只读临时副本管理器。
//!
//! 默认程序打开绝不能交库内本体路径：外部程序的写入与删除不可控，而本体是
//! 权威对象。替代模型是把原始字节复制到应用缓存侧的会话目录
//! `<root>/<session-id>/<显示文件名>`，设只读属性后**只把副本路径**交给系统打开。
//! 同一素材复用同一份不可变副本，重复打开不产生副本堆积。
//!
//! 清理的边界同样冻结：
//! - 只有清单（`manifest.json`）记录、且由本应用创建的会话目录在射程内；
//!   清单缺失时什么都不删——没有证据就不做猜测性破坏。
//! - 删除前先清只读属性；被其他进程占用（`ERROR_SHARING_VIOLATION`）的目录
//!   留在清单里等下次启动重试。
//! - 保守过期策略：非当前会话且超过 [`SESSION_EXPIRY`] 才删；当前会话无论多旧
//!   都不自删。
//! - 副本全部位于 `<root>` 之下且路径只能由清单条目拼出——库根、内容哈希树与
//!   使用者选择的导出目录在结构上不可能进入清理逻辑。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::Serialize;

use crate::error::{AppError, Code, Result};
use crate::export;
use crate::hashing::ContentHash;
use crate::library::Library;

/// 会话目录的保守保留期。非当前会话且最后登记时间早于此时长才可清理。
///
/// 没有这个期限会怎样：外部程序可能把副本留在资源管理器窗口或最近列表里，
/// 使用者第二天再从那里打开时文件必须还在——按"上次退出就清空"实现会让这条
/// 路径悄悄失效。
pub const SESSION_EXPIRY: Duration = Duration::from_secs(24 * 60 * 60);

/// 会话清单文件名。位于副本根目录下，格式为 `{ "<session-id>": "<RFC3339>" }`。
const MANIFEST_NAME: &str = "manifest.json";

/// 一座应用缓存内的会话目录管理器。`session_id` 是本次应用运行的标识。
#[derive(Debug, Clone)]
pub struct ExternalOpenManager {
    root: PathBuf,
    session_id: String,
}

/// 一次清理的报告。被占用而延后的会话仍在清单中，下次启动重试。
#[derive(Debug, Clone, Default, Serialize)]
pub struct CleanupReport {
    pub removed_sessions: Vec<String>,
    pub deferred_sessions: Vec<String>,
}

/// 会话清单的磁盘形态：扁平映射 `{ "<session-id>": "<RFC3339 创建时刻>" }`。
/// 扁平而不是嵌套对象——清单本身就是一张表，没有第二类字段值得为它加一层。
type SessionManifest = BTreeMap<String, String>;

impl ExternalOpenManager {
    /// `root` 是调用方给定的副本根目录（生产环境为 `<app_cache_dir>/external-open/v1`）。
    pub fn new(root: PathBuf, session_id: String) -> Self {
        Self { root, session_id }
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// 生成一次应用运行的会话 ID（规范 UUIDv7 字面值）。
    ///
    /// 会话 ID 会直接成为缓存目录名，因此必须复用 [`crate::ids`] 的唯一字面值
    /// 规则——这里不允许出现第二种 UUID 拼法。装配层每次运行调用一次并持有结果。
    pub fn new_session_id() -> String {
        crate::ids::generate_canonical_uuid_v7()
    }

    fn session_dir(&self) -> PathBuf {
        self.root.join(&self.session_id)
    }

    /// 为素材准备只读副本，返回交给系统打开的路径。
    ///
    /// 同一素材复用同一份副本：目标已存在时原样返回，绝不重写（副本是不可变的，
    /// 重写会破坏"外部程序正拿着这份文件"的前提）。
    pub fn prepare(&self, lib: &Library, hash: &ContentHash) -> Result<PathBuf> {
        let (sidecar, body) = export::resolve_asset(lib, hash)?;
        // 先登记会话再写副本：进程在复制中途崩溃时，残留目录也已被记录，
        // 下次启动的清理能够认领它。
        self.register_session()?;
        std::fs::create_dir_all(self.session_dir()).map_err(|e| {
            AppError::detailed(
                Code::LibraryIoFailed,
                format!("建立临时副本会话目录失败：{e}"),
            )
        })?;

        let target = self.session_dir().join(export::composed_name(&sidecar));
        if target.is_file() {
            ensure_readonly(&target)?;
            return Ok(target);
        }
        // 原子落盘：先写临时名并设只读，再改名提交。
        let tmp = self.session_dir().join(format!(
            "{}.part",
            target
                .file_name()
                .expect("由显示名拼出，必有文件名")
                .to_string_lossy()
        ));
        remove_if_exists(&tmp)?;
        std::fs::copy(&body, &tmp).map_err(|e| {
            AppError::detailed(
                Code::LibraryIoFailed,
                format!("复制临时副本失败 {}: {e}", tmp.display()),
            )
        })?;
        make_readonly(&tmp)?;
        if let Err(e) = std::fs::rename(&tmp, &target) {
            let _ = std::fs::remove_file(&tmp);
            return Err(AppError::detailed(
                Code::LibraryIoFailed,
                format!("提交临时副本失败 {}: {e}", target.display()),
            ));
        }
        Ok(target)
    }

    /// 把当前会话登记进清单（幂等）。首次登记时间为准，续用同一会话不改时间。
    fn register_session(&self) -> Result<()> {
        let mut manifest = self.read_manifest()?;
        if manifest.contains_key(&self.session_id) {
            return Ok(());
        }
        manifest.insert(self.session_id.clone(), Utc::now().to_rfc3339());
        self.write_manifest(&manifest)
    }

    fn manifest_path(&self) -> PathBuf {
        self.root.join(MANIFEST_NAME)
    }

    fn read_manifest(&self) -> Result<SessionManifest> {
        match std::fs::read_to_string(self.manifest_path()) {
            Ok(text) => serde_json::from_str(&text).map_err(|error| {
                AppError::detailed(
                    Code::ExternalOpenFailed,
                    format!("临时副本会话清单损坏：{error}"),
                )
            }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(SessionManifest::default())
            }
            Err(error) => Err(AppError::detailed(
                Code::ExternalOpenFailed,
                format!("读取临时副本会话清单失败：{error}"),
            )),
        }
    }

    fn write_manifest(&self, manifest: &SessionManifest) -> Result<()> {
        std::fs::create_dir_all(&self.root).map_err(|e| {
            AppError::detailed(
                Code::ExternalOpenFailed,
                format!("建立临时副本根目录失败：{e}"),
            )
        })?;
        let text = serde_json::to_string_pretty(manifest).map_err(|e| {
            AppError::detailed(Code::ExternalOpenFailed, format!("序列化清单失败：{e}"))
        })?;
        std::fs::write(self.manifest_path(), text).map_err(|e| {
            AppError::detailed(Code::ExternalOpenFailed, format!("写会话清单失败：{e}"))
        })
    }

    /// 启动时清理过期会话。边界见模块文档；报告列出删了什么、什么被占用留待重试。
    pub fn cleanup(&self, now: DateTime<Utc>) -> Result<CleanupReport> {
        let mut report = CleanupReport::default();
        let mut manifest = self.read_manifest()?;
        if manifest.is_empty() {
            return Ok(report);
        }
        let expiry = chrono::Duration::seconds(SESSION_EXPIRY.as_secs() as i64);
        let cutoff = now - expiry;
        let mut expired = Vec::new();
        for (session_id, created_at) in &manifest {
            let created = DateTime::parse_from_rfc3339(created_at).map_err(|error| {
                AppError::detailed(
                    Code::ExternalOpenFailed,
                    format!("会话 {session_id} 的清单时间损坏：{error}"),
                )
            })?;
            if session_id != &self.session_id && created.with_timezone(&Utc) <= cutoff {
                expired.push(session_id.clone());
            }
        }

        for session_id in expired {
            let dir = self.root.join(&session_id);
            if !dir.exists() {
                // 目录已经不在（例如使用者手动清了缓存）：登记失去意义，直接移除。
                manifest.remove(&session_id);
                report.removed_sessions.push(session_id);
                continue;
            }
            match remove_session_tree(&dir) {
                Ok(()) => {
                    manifest.remove(&session_id);
                    report.removed_sessions.push(session_id);
                }
                // 多半是 ERROR_SHARING_VIOLATION：留在清单里，下次启动重试。
                Err(RemoveSessionError::Busy) => report.deferred_sessions.push(session_id),
                Err(RemoveSessionError::Other(error)) => return Err(error),
            }
        }
        self.write_manifest(&manifest)?;
        Ok(report)
    }
}

fn make_readonly(path: &Path) -> Result<()> {
    let mut permissions = std::fs::metadata(path)
        .map_err(|error| {
            AppError::detailed(
                Code::ExternalOpenFailed,
                format!("读取临时副本权限失败 {}: {error}", path.display()),
            )
        })?
        .permissions();
    permissions.set_readonly(true);
    std::fs::set_permissions(path, permissions).map_err(|error| {
        AppError::detailed(
            Code::ExternalOpenFailed,
            format!("设置临时副本只读失败 {}: {error}", path.display()),
        )
    })
}

/// 目标已存在但丢了只读属性时补上（自愈，不算失败）。
fn ensure_readonly(path: &Path) -> Result<()> {
    make_readonly(path)
}

fn remove_if_exists(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(AppError::detailed(
            Code::ExternalOpenFailed,
            format!("清理临时副本残留失败 {}: {error}", path.display()),
        )),
    }
}

/// 删除一个会话目录树：先把所有文件的只读属性清掉再整体删除。
///
/// Windows 上带只读属性的文件无法删除，跳过预清理会让每个会话目录都变成永久残留。
/// 被其他进程占用（共享冲突）时整体放弃——部分删除的状态留在磁盘上也无妨，
/// 下次重试会先清一遍属性再继续。
enum RemoveSessionError {
    Busy,
    Other(AppError),
}

fn remove_session_tree(dir: &Path) -> std::result::Result<(), RemoveSessionError> {
    clear_readonly_recursive(dir).map_err(RemoveSessionError::Other)?;
    std::fs::remove_dir_all(dir).map_err(|error| {
        if error.raw_os_error() == Some(32) {
            RemoveSessionError::Busy
        } else {
            RemoveSessionError::Other(AppError::detailed(
                Code::ExternalOpenFailed,
                format!("删除临时副本会话失败 {}: {error}", dir.display()),
            ))
        }
    })
}

/// `set_readonly(false)` 在 Unix 上等价于补回写权限位，这正是该 lint 存在的理由；
/// 但这里的对象只有本应用刚创建、位于自己缓存目录里的副本文件与目录，
/// 且该动作只服务于"随后立刻删除"，不会把任何使用者文件的权限写宽。
#[allow(clippy::permissions_set_readonly_false)]
fn clear_readonly_recursive(dir: &Path) -> Result<()> {
    for entry in std::fs::read_dir(dir).map_err(|error| {
        AppError::detailed(
            Code::ExternalOpenFailed,
            format!("读取临时副本会话失败 {}: {error}", dir.display()),
        )
    })? {
        let entry = entry.map_err(|error| {
            AppError::detailed(
                Code::ExternalOpenFailed,
                format!("读取临时副本项失败：{error}"),
            )
        })?;
        let path = entry.path();
        if path.is_dir() {
            // 先清子树再清目录自身：Windows 上带只读属性的目录无法被父级删除。
            clear_readonly_recursive(&path)?;
            let mut permissions = std::fs::metadata(&path)
                .map_err(|error| AppError::detailed(Code::ExternalOpenFailed, error))?
                .permissions();
            if permissions.readonly() {
                permissions.set_readonly(false);
                std::fs::set_permissions(&path, permissions)
                    .map_err(|error| AppError::detailed(Code::ExternalOpenFailed, error))?;
            }
        } else {
            let mut permissions = std::fs::metadata(&path)
                .map_err(|error| AppError::detailed(Code::ExternalOpenFailed, error))?
                .permissions();
            if permissions.readonly() {
                permissions.set_readonly(false);
                std::fs::set_permissions(&path, permissions)
                    .map_err(|error| AppError::detailed(Code::ExternalOpenFailed, error))?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_session_ids_are_canonical_uuid_v7() {
        let id = ExternalOpenManager::new_session_id();
        let parsed = crate::ids::parse_canonical_uuid(&id, crate::error::Code::PromptIdInvalid)
            .expect("会话 ID 必须是规范 UUID 字面值");
        assert_eq!(parsed.get_version_num(), 7, "会话 ID 应是时间可排序的 v7");
        // 会话 ID 直接成为缓存目录名：不得含路径分隔符，也不能长得像上级引用。
        assert!(!id.contains('/') && !id.contains('\\') && id != "..");
    }

    #[test]
    fn readonly_failure_is_explicit() {
        let directory = tempfile::tempdir().expect("建立临时目录");
        let missing = directory.path().join("不存在.png");

        let error = make_readonly(&missing).expect_err("缺失文件不能静默标记只读");

        assert_eq!(error.code, Code::ExternalOpenFailed);
    }
}
