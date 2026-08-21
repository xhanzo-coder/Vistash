//! 图片素材的库内回收站生命周期：删除、还原与永久删除。
//!
//! 与图片组织元数据（[`super::image_metadata`]）的关键差别是回滚对象：组织变更回滚的是
//! 文件内容，因此可以先读原字节再逆序写回；生命周期变更移动的是本体与侧车文件本身，
//! 回滚必须把文件搬回原位置。两者混用一套事务只会让回滚在两种语义之间摇摆。
//!
//! 每个阶段之间都留有 [`LifecycleStage`] 观察点，使"在第 n 步失败"成为可注入的输入。
//! 不这样做的话，"移动成功但写侧车失败"这类分支就只能靠制造真实的文件系统故障来覆盖。

use super::write_raw_atomic;
use crate::error::{AppError, Code, Result};
use crate::hashing::ContentHash;
use crate::index::AssetRow;
use crate::sidecar::AssetSidecar;
use serde::Serialize;
use std::path::Path;

use super::Catalog;

/// 生命周期的阶段观察点。
///
/// 对 `catalog` 及其子模块可见而不是完全私有：`Catalog` 的注入字段声明在 `mod.rs`，
/// 而阶段本身属于本模块。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum LifecycleStage {
    BodyMoved,
    TrashSidecarWritten,
    OriginalSidecarRemoved,
    RestoreBodyMoved,
    NormalSidecarWritten,
    TrashSidecarRemoved,
}

/// 还原完成后需要向使用者说明的缺失文件夹。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RestoreOutcome {
    pub missing_folders: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PurgeFailure {
    pub hash: String,
    pub original_filename: String,
    pub error: AppError,
}

#[derive(Debug, Clone, Serialize)]
pub struct PurgeReport {
    pub purged: usize,
    pub failures: Vec<PurgeFailure>,
}

impl Catalog {
    pub fn delete_asset(&mut self, hash: &ContentHash) -> Result<()> {
        let ext = self.asset_ext(hash.as_str())?;
        let body = self.library.body_path(hash, &ext);
        let sidecar_path = self.library.sidecar_path(hash);
        let trash_body = self.library.trash_body_path(hash, &ext);
        let trash_sidecar = self.library.trash_sidecar_path(hash);
        let original_bytes = std::fs::read(&sidecar_path).map_err(|error| {
            lifecycle_io(
                Code::TrashDeleteFailed,
                "读取原侧车失败",
                &sidecar_path,
                error,
            )
        })?;
        let mut sidecar = AssetSidecar::read(&sidecar_path)?;
        if sidecar.is_deleted() {
            return Err(AppError::detailed(
                Code::TrashDeleteFailed,
                format!("素材已经在回收站：{hash}"),
            ));
        }
        let previous_folders = sidecar.folders.clone();
        sidecar.folders.clear();
        sidecar.deleted_from_folders = Some(previous_folders);
        sidecar.deleted_at = Some(chrono::Utc::now());

        if let Some(parent) = trash_body.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                lifecycle_io(
                    Code::TrashDeleteFailed,
                    "建立回收站叶目录失败",
                    parent,
                    error,
                )
            })?;
        }
        let mut body_moved = false;
        let mut trash_written = false;
        let mut original_removed = false;
        let operation = (|| -> Result<()> {
            std::fs::rename(&body, &trash_body).map_err(|error| {
                lifecycle_io(Code::TrashDeleteFailed, "移动素材本体失败", &body, error)
            })?;
            body_moved = true;
            self.after_lifecycle_stage(LifecycleStage::BodyMoved)?;

            sidecar.write_atomic(&trash_sidecar).map_err(|error| {
                AppError::detailed(
                    Code::TrashDeleteFailed,
                    format!("写入回收站侧车失败：{error:?}"),
                )
            })?;
            trash_written = true;
            self.after_lifecycle_stage(LifecycleStage::TrashSidecarWritten)?;

            std::fs::remove_file(&sidecar_path).map_err(|error| {
                lifecycle_io(
                    Code::TrashDeleteFailed,
                    "删除正常侧车失败",
                    &sidecar_path,
                    error,
                )
            })?;
            original_removed = true;
            self.after_lifecycle_stage(LifecycleStage::OriginalSidecarRemoved)
        })();
        if let Err(error) = operation {
            rollback_delete(DeleteRollback {
                body: &body,
                sidecar: &sidecar_path,
                trash_body: &trash_body,
                trash_sidecar: &trash_sidecar,
                original_sidecar: &original_bytes,
                body_moved,
                trash_written,
                original_removed,
            })?;
            return Err(error);
        }
        if let Err(error) = self.index_mut()?.upsert_asset(&sidecar) {
            return self.rebuild_after_index_failure(error);
        }
        Ok(())
    }

    pub fn restore_asset(&mut self, hash: &ContentHash) -> Result<RestoreOutcome> {
        let ext = self.asset_ext(hash.as_str())?;
        let body = self.library.body_path(hash, &ext);
        let sidecar_path = self.library.sidecar_path(hash);
        let trash_body = self.library.trash_body_path(hash, &ext);
        let trash_sidecar = self.library.trash_sidecar_path(hash);
        let trash_bytes = std::fs::read(&trash_sidecar).map_err(|error| {
            lifecycle_io(
                Code::TrashRestoreFailed,
                "读取回收站侧车失败",
                &trash_sidecar,
                error,
            )
        })?;
        let mut sidecar = AssetSidecar::read(&trash_sidecar)?;
        if !sidecar.is_deleted() {
            return Err(AppError::detailed(
                Code::TrashRestoreFailed,
                format!("回收站侧车没有删除状态：{hash}"),
            ));
        }
        let Some(previous_folders) = sidecar.deleted_from_folders.clone() else {
            return Err(AppError::detailed(
                Code::TrashRestoreFailed,
                format!("回收站侧车缺少删除前文件夹：{hash}"),
            ));
        };
        let folder_list = self.library.read_folders()?;
        let mut restored_folders = Vec::new();
        let mut missing_folders = Vec::new();
        for folder in previous_folders {
            if folder_list
                .folders
                .iter()
                .any(|existing| existing == &folder)
            {
                restored_folders.push(folder);
            } else {
                missing_folders.push(folder);
            }
        }
        restored_folders.sort();
        missing_folders.sort();
        sidecar.folders = restored_folders;
        sidecar.deleted_at = None;
        sidecar.deleted_from_folders = None;

        if let Some(parent) = body.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                lifecycle_io(
                    Code::TrashRestoreFailed,
                    "建立正常素材叶目录失败",
                    parent,
                    error,
                )
            })?;
        }
        let mut body_moved = false;
        let mut normal_written = false;
        let mut trash_removed = false;
        let operation = (|| -> Result<()> {
            std::fs::rename(&trash_body, &body).map_err(|error| {
                lifecycle_io(
                    Code::TrashRestoreFailed,
                    "移回素材本体失败",
                    &trash_body,
                    error,
                )
            })?;
            body_moved = true;
            self.after_lifecycle_stage(LifecycleStage::RestoreBodyMoved)?;

            sidecar.write_atomic(&sidecar_path).map_err(|error| {
                AppError::detailed(
                    Code::TrashRestoreFailed,
                    format!("写入正常侧车失败：{error:?}"),
                )
            })?;
            normal_written = true;
            self.after_lifecycle_stage(LifecycleStage::NormalSidecarWritten)?;

            std::fs::remove_file(&trash_sidecar).map_err(|error| {
                lifecycle_io(
                    Code::TrashRestoreFailed,
                    "删除回收站侧车失败",
                    &trash_sidecar,
                    error,
                )
            })?;
            trash_removed = true;
            self.after_lifecycle_stage(LifecycleStage::TrashSidecarRemoved)
        })();
        if let Err(error) = operation {
            rollback_restore(RestoreRollback {
                body: &body,
                sidecar: &sidecar_path,
                trash_body: &trash_body,
                trash_sidecar: &trash_sidecar,
                trash_sidecar_bytes: &trash_bytes,
                body_moved,
                normal_written,
                trash_removed,
            })?;
            return Err(error);
        }
        if let Err(error) = self.index_mut()?.upsert_asset(&sidecar) {
            return self
                .rebuild_after_index_failure(error)
                .map(|()| RestoreOutcome {
                    missing_folders: missing_folders.clone(),
                });
        }
        Ok(RestoreOutcome { missing_folders })
    }

    pub fn purge_trash(&mut self) -> Result<PurgeReport> {
        let trash_assets: Vec<AssetRow> = self
            .index()?
            .list_assets(true)?
            .into_iter()
            .filter(|asset| asset.deleted_at.is_some())
            .collect();
        let mut report = PurgeReport {
            purged: 0,
            failures: Vec::new(),
        };
        for asset in &trash_assets {
            match self.purge_one(asset) {
                Ok(()) => report.purged += 1,
                Err(error) => report.failures.push(PurgeFailure {
                    hash: asset.hash.clone(),
                    original_filename: asset.original_filename.clone(),
                    error,
                }),
            }
        }
        self.rebuild_index()?;
        Ok(report)
    }

    fn purge_one(&self, asset: &AssetRow) -> Result<()> {
        let hash = ContentHash::parse(&asset.hash)?;
        #[cfg(test)]
        if self.fail_purge_hash.as_ref() == Some(&hash) {
            return Err(AppError::detailed(
                Code::TrashPurgeFailed,
                format!("注入 purge 失败：{hash}"),
            ));
        }
        let body = self.library.trash_body_path(&hash, &asset.ext);
        let sidecar = self.library.trash_sidecar_path(&hash);
        let thumbnail = self.library.thumbnail_path(&hash);
        let body_staged = body.with_extension(format!("{}.purge", asset.ext));
        let sidecar_staged = sidecar.with_extension("json.purge");
        if body_staged.exists() || sidecar_staged.exists() {
            return Err(AppError::detailed(
                Code::TrashPurgeFailed,
                format!("存在上次未处理的 purge 临时文件：{hash}"),
            ));
        }
        let sidecar_bytes = std::fs::read(&sidecar).map_err(|error| {
            lifecycle_io(
                Code::TrashPurgeFailed,
                "读取 purge 侧车失败",
                &sidecar,
                error,
            )
        })?;
        if thumbnail.exists() {
            std::fs::remove_file(&thumbnail).map_err(|error| {
                lifecycle_io(
                    Code::TrashPurgeFailed,
                    "删除 purge 缩略图失败",
                    &thumbnail,
                    error,
                )
            })?;
        }
        std::fs::rename(&body, &body_staged).map_err(|error| {
            lifecycle_io(Code::TrashPurgeFailed, "暂存 purge 本体失败", &body, error)
        })?;
        if let Err(error) = std::fs::rename(&sidecar, &sidecar_staged) {
            std::fs::rename(&body_staged, &body).map_err(|rollback_error| {
                lifecycle_io(
                    Code::TrashPurgeFailed,
                    "purge 侧车暂存失败后恢复本体失败",
                    &body_staged,
                    rollback_error,
                )
            })?;
            return Err(lifecycle_io(
                Code::TrashPurgeFailed,
                "暂存 purge 侧车失败",
                &sidecar,
                error,
            ));
        }
        if let Err(error) = std::fs::remove_file(&sidecar_staged) {
            std::fs::rename(&sidecar_staged, &sidecar).map_err(|rollback_error| {
                lifecycle_io(
                    Code::TrashPurgeFailed,
                    "purge 删除侧车失败后恢复侧车失败",
                    &sidecar_staged,
                    rollback_error,
                )
            })?;
            std::fs::rename(&body_staged, &body).map_err(|rollback_error| {
                lifecycle_io(
                    Code::TrashPurgeFailed,
                    "purge 删除侧车失败后恢复本体失败",
                    &body_staged,
                    rollback_error,
                )
            })?;
            return Err(lifecycle_io(
                Code::TrashPurgeFailed,
                "删除 purge 侧车失败",
                &sidecar_staged,
                error,
            ));
        }
        if let Err(error) = std::fs::remove_file(&body_staged) {
            std::fs::rename(&body_staged, &body).map_err(|rollback_error| {
                lifecycle_io(
                    Code::TrashPurgeFailed,
                    "purge 删除本体失败后恢复本体失败",
                    &body_staged,
                    rollback_error,
                )
            })?;
            write_raw_atomic(&sidecar, &sidecar_bytes, Code::TrashPurgeFailed)?;
            return Err(lifecycle_io(
                Code::TrashPurgeFailed,
                "删除 purge 本体失败",
                &body_staged,
                error,
            ));
        }
        Ok(())
    }

    fn after_lifecycle_stage(&self, _stage: LifecycleStage) -> Result<()> {
        #[cfg(test)]
        if self.fail_lifecycle_stage == Some(_stage) {
            let code = match _stage {
                LifecycleStage::RestoreBodyMoved
                | LifecycleStage::NormalSidecarWritten
                | LifecycleStage::TrashSidecarRemoved => Code::TrashRestoreFailed,
                LifecycleStage::BodyMoved
                | LifecycleStage::TrashSidecarWritten
                | LifecycleStage::OriginalSidecarRemoved => Code::TrashDeleteFailed,
            };
            return Err(AppError::detailed(
                code,
                format!("注入生命周期阶段失败：{_stage:?}"),
            ));
        }
        Ok(())
    }

    #[cfg(test)]
    fn inject_lifecycle_failure(&mut self, stage: LifecycleStage) {
        self.fail_lifecycle_stage = Some(stage);
    }

    #[cfg(test)]
    fn inject_purge_failure(&mut self, hash: &ContentHash) {
        self.fail_purge_hash = Some(hash.clone());
    }

}

fn lifecycle_io(code: Code, what: &str, path: &Path, error: std::io::Error) -> AppError {
    AppError::detailed(code, format!("{what} {}: {error}", path.display()))
}

struct DeleteRollback<'a> {
    body: &'a Path,
    sidecar: &'a Path,
    trash_body: &'a Path,
    trash_sidecar: &'a Path,
    original_sidecar: &'a [u8],
    body_moved: bool,
    trash_written: bool,
    original_removed: bool,
}

struct RestoreRollback<'a> {
    body: &'a Path,
    sidecar: &'a Path,
    trash_body: &'a Path,
    trash_sidecar: &'a Path,
    trash_sidecar_bytes: &'a [u8],
    body_moved: bool,
    normal_written: bool,
    trash_removed: bool,
}

fn rollback_delete(state: DeleteRollback<'_>) -> Result<()> {
    if state.original_removed {
        write_raw_atomic(
            state.sidecar,
            state.original_sidecar,
            Code::TrashDeleteFailed,
        )?;
    }
    if state.trash_written && state.trash_sidecar.exists() {
        std::fs::remove_file(state.trash_sidecar).map_err(|error| {
            lifecycle_io(
                Code::TrashDeleteFailed,
                "回滚时删除回收站侧车失败",
                state.trash_sidecar,
                error,
            )
        })?;
    }
    if state.body_moved && state.trash_body.exists() {
        std::fs::rename(state.trash_body, state.body).map_err(|error| {
            lifecycle_io(
                Code::TrashDeleteFailed,
                "回滚时移回素材本体失败",
                state.trash_body,
                error,
            )
        })?;
    }
    Ok(())
}

fn rollback_restore(state: RestoreRollback<'_>) -> Result<()> {
    if state.trash_removed {
        write_raw_atomic(
            state.trash_sidecar,
            state.trash_sidecar_bytes,
            Code::TrashRestoreFailed,
        )?;
    }
    if state.normal_written && state.sidecar.exists() {
        std::fs::remove_file(state.sidecar).map_err(|error| {
            lifecycle_io(
                Code::TrashRestoreFailed,
                "回滚时删除正常侧车失败",
                state.sidecar,
                error,
            )
        })?;
    }
    if state.body_moved && state.body.exists() {
        std::fs::rename(state.body, state.trash_body).map_err(|error| {
            lifecycle_io(
                Code::TrashRestoreFailed,
                "回滚时移回回收站本体失败",
                state.body,
                error,
            )
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::image_metadata::FolderName;
    use crate::catalog::query::{AssetLocation, AssetQuery, FolderFilter};
    use crate::catalog::testing::{fixture, import_with, write_png};
    use crate::error::Code;

    #[test]
    fn delete_asset_moves_a_complete_pair_and_records_previous_folders() {
        let mut fixture = fixture();
        let source = write_png(&fixture.source, "人物.png", [255, 0, 0, 255]);
        let sidecar = import_with(&mut fixture.catalog, &source, &["参考", "配色"], &["人物"]);

        fixture
            .catalog
            .delete_asset(&sidecar.hash)
            .expect("删除素材");

        assert!(!fixture
            .catalog
            .library()
            .body_path(&sidecar.hash, &sidecar.ext)
            .exists());
        assert!(!fixture
            .catalog
            .library()
            .sidecar_path(&sidecar.hash)
            .exists());
        assert!(fixture
            .catalog
            .library()
            .trash_body_path(&sidecar.hash, &sidecar.ext)
            .is_file());
        let deleted =
            AssetSidecar::read(&fixture.catalog.library().trash_sidecar_path(&sidecar.hash))
                .expect("读取回收站侧车");
        assert!(deleted.is_deleted());
        assert!(deleted.folders.is_empty());
        assert_eq!(
            deleted.deleted_from_folders,
            Some(vec!["参考".to_owned(), "配色".to_owned()])
        );
    }

    #[test]
    fn delete_asset_rolls_back_after_every_injected_stage() {
        for stage in [
            LifecycleStage::BodyMoved,
            LifecycleStage::TrashSidecarWritten,
            LifecycleStage::OriginalSidecarRemoved,
        ] {
            let mut fixture = fixture();
            let source = write_png(&fixture.source, "人物.png", [255, 0, 0, 255]);
            let sidecar = import_with(&mut fixture.catalog, &source, &[], &[]);
            fixture.catalog.inject_lifecycle_failure(stage);

            fixture
                .catalog
                .delete_asset(&sidecar.hash)
                .expect_err("注入失败本应阻止删除");

            assert!(fixture
                .catalog
                .library()
                .body_path(&sidecar.hash, &sidecar.ext)
                .is_file());
            assert!(fixture
                .catalog
                .library()
                .sidecar_path(&sidecar.hash)
                .is_file());
            assert!(!fixture
                .catalog
                .library()
                .trash_body_path(&sidecar.hash, &sidecar.ext)
                .exists());
            assert!(!fixture
                .catalog
                .library()
                .trash_sidecar_path(&sidecar.hash)
                .exists());
        }
    }

    #[test]
    fn restore_asset_keeps_existing_folders_and_reports_missing_ones() {
        let mut fixture = fixture();
        let reference = fixture
            .catalog
            .create_folder(None, &FolderName::parse("参考").expect("名称"))
            .expect("创建文件夹");
        let removed = fixture
            .catalog
            .create_folder(None, &FolderName::parse("待删除").expect("名称"))
            .expect("创建文件夹");
        let source = write_png(&fixture.source, "人物.png", [255, 0, 0, 255]);
        let sidecar = import_with(
            &mut fixture.catalog,
            &source,
            &[reference.as_str(), removed.as_str()],
            &[],
        );
        fixture
            .catalog
            .delete_asset(&sidecar.hash)
            .expect("删除素材");
        fixture
            .catalog
            .delete_folder(&removed)
            .expect("删除历史文件夹");

        let outcome = fixture
            .catalog
            .restore_asset(&sidecar.hash)
            .expect("还原素材");

        assert_eq!(outcome.missing_folders, vec!["待删除".to_owned()]);
        let restored = AssetSidecar::read(&fixture.catalog.library().sidecar_path(&sidecar.hash))
            .expect("读取正常侧车");
        assert_eq!(restored.folders, vec!["参考".to_owned()]);
        assert!(!restored.is_deleted());
    }

    #[test]
    fn restore_asset_rolls_back_after_every_injected_stage() {
        for stage in [
            LifecycleStage::RestoreBodyMoved,
            LifecycleStage::NormalSidecarWritten,
            LifecycleStage::TrashSidecarRemoved,
        ] {
            let mut fixture = fixture();
            let source = write_png(&fixture.source, "人物.png", [255, 0, 0, 255]);
            let sidecar = import_with(&mut fixture.catalog, &source, &[], &[]);
            fixture
                .catalog
                .delete_asset(&sidecar.hash)
                .expect("删除素材");
            fixture.catalog.inject_lifecycle_failure(stage);

            fixture
                .catalog
                .restore_asset(&sidecar.hash)
                .expect_err("注入失败本应阻止还原");

            assert!(fixture
                .catalog
                .library()
                .trash_body_path(&sidecar.hash, &sidecar.ext)
                .is_file());
            assert!(fixture
                .catalog
                .library()
                .trash_sidecar_path(&sidecar.hash)
                .is_file());
            assert!(!fixture
                .catalog
                .library()
                .body_path(&sidecar.hash, &sidecar.ext)
                .exists());
            assert!(!fixture
                .catalog
                .library()
                .sidecar_path(&sidecar.hash)
                .exists());
        }
    }

    #[test]
    fn restore_asset_returns_to_root_when_every_previous_folder_is_missing() {
        let mut fixture = fixture();
        let folder = fixture
            .catalog
            .create_folder(None, &FolderName::parse("临时").expect("名称"))
            .expect("创建文件夹");
        let source = write_png(&fixture.source, "人物.png", [255, 0, 0, 255]);
        let sidecar = import_with(&mut fixture.catalog, &source, &[folder.as_str()], &[]);
        fixture
            .catalog
            .delete_asset(&sidecar.hash)
            .expect("删除素材");
        fixture.catalog.delete_folder(&folder).expect("删除文件夹");

        let outcome = fixture
            .catalog
            .restore_asset(&sidecar.hash)
            .expect("还原到根文件夹");

        assert_eq!(outcome.missing_folders, vec!["临时".to_owned()]);
        assert!(
            AssetSidecar::read(&fixture.catalog.library().sidecar_path(&sidecar.hash))
                .expect("读取侧车")
                .folders
                .is_empty()
        );
    }

    #[test]
    fn purge_trash_removes_bodies_sidecars_thumbnails_and_index_rows() {
        let mut fixture = fixture();
        let first = write_png(&fixture.source, "一.png", [255, 0, 0, 255]);
        let second = write_png(&fixture.source, "二.png", [0, 255, 0, 255]);
        let first_sidecar = import_with(&mut fixture.catalog, &first, &[], &[]);
        let second_sidecar = import_with(&mut fixture.catalog, &second, &[], &[]);
        fixture
            .catalog
            .delete_asset(&first_sidecar.hash)
            .expect("删除一");
        fixture
            .catalog
            .delete_asset(&second_sidecar.hash)
            .expect("删除二");

        let report = fixture.catalog.purge_trash().expect("清空回收站");

        assert_eq!(report.purged, 2);
        assert!(report.failures.is_empty());
        for sidecar in [first_sidecar, second_sidecar] {
            assert!(!fixture
                .catalog
                .library()
                .trash_body_path(&sidecar.hash, &sidecar.ext)
                .exists());
            assert!(!fixture
                .catalog
                .library()
                .trash_sidecar_path(&sidecar.hash)
                .exists());
            assert!(!fixture
                .catalog
                .library()
                .thumbnail_path(&sidecar.hash)
                .exists());
        }
        assert_eq!(
            fixture
                .catalog
                .snapshot(&AssetQuery {
                    text: String::new(),
                    tags: Vec::new(),
                    folder: FolderFilter::All,
                    location: AssetLocation::Trash,
                })
                .expect("查询回收站")
                .trash_count,
            0
        );
    }

    #[test]
    fn purge_trash_isolates_a_failed_asset_and_keeps_its_authority_pair() {
        let mut fixture = fixture();
        let first = write_png(&fixture.source, "一.png", [255, 0, 0, 255]);
        let second = write_png(&fixture.source, "二.png", [0, 255, 0, 255]);
        let failed = import_with(&mut fixture.catalog, &first, &[], &[]);
        let successful = import_with(&mut fixture.catalog, &second, &[], &[]);
        fixture
            .catalog
            .delete_asset(&failed.hash)
            .expect("删除失败目标");
        fixture
            .catalog
            .delete_asset(&successful.hash)
            .expect("删除成功目标");
        fixture.catalog.inject_purge_failure(&failed.hash);

        let report = fixture.catalog.purge_trash().expect("清空回收站");

        assert_eq!(report.purged, 1);
        assert_eq!(report.failures.len(), 1);
        assert_eq!(report.failures[0].error.code, Code::TrashPurgeFailed);
        assert!(fixture
            .catalog
            .library()
            .trash_body_path(&failed.hash, &failed.ext)
            .is_file());
        assert!(fixture
            .catalog
            .library()
            .trash_sidecar_path(&failed.hash)
            .is_file());
        assert!(!fixture
            .catalog
            .library()
            .trash_body_path(&successful.hash, &successful.ext)
            .exists());
    }

}
