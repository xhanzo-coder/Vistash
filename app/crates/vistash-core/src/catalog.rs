//! 素材编目：逻辑文件夹、标签、查询和回收站生命周期的一致性入口。

use crate::error::{AppError, Code, Result};
use crate::hashing::ContentHash;
use crate::index::{AssetRow, FolderSelection, Index};
use crate::library::{FolderList, Library};
use crate::sidecar::AssetSidecar;
use serde::Serialize;
use std::path::{Path, PathBuf};

/// 一个经过验证的逻辑文件夹名称段。
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct FolderName(String);

impl FolderName {
    /// 规范化并验证名称段。
    pub fn parse(raw: &str) -> Result<Self> {
        let value = raw.trim();
        if value.is_empty()
            || value == "."
            || value == ".."
            || value.contains('/')
            || value.chars().any(char::is_control)
        {
            return Err(AppError::detailed(
                Code::LibraryFolderInvalid,
                format!("非法文件夹名称：{raw:?}"),
            ));
        }
        Ok(Self(value.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// 一个由已验证名称段组成的逻辑文件夹路径。
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct FolderPath(String);

impl FolderPath {
    /// 规范化每个路径段并拒绝空段。
    pub fn parse(raw: &str) -> Result<Self> {
        if raw.is_empty() {
            return Err(invalid_folder_path(raw));
        }
        let mut segments = Vec::new();
        for segment in raw.split('/') {
            if segment.is_empty() {
                return Err(invalid_folder_path(raw));
            }
            segments.push(FolderName::parse(segment)?.0);
        }
        Ok(Self(segments.join("/")))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn parent(&self) -> Option<Self> {
        self.0
            .rsplit_once('/')
            .map(|(parent, _)| Self(parent.to_owned()))
    }

    pub fn join(&self, name: &FolderName) -> Self {
        Self(format!("{}/{}", self.0, name.as_str()))
    }

    /// 只接受完整段边界，且路径自身不算自己的后代。
    pub fn is_descendant_of(&self, ancestor: &Self) -> bool {
        self.0
            .strip_prefix(ancestor.as_str())
            .is_some_and(|suffix| suffix.starts_with('/'))
    }

    /// 把路径所在子树从旧根映射到新根；不在子树中时返回 `None`。
    pub fn rebase(&self, from: &Self, to: &Self) -> Option<Self> {
        if self == from {
            return Some(to.clone());
        }
        let suffix = self.0.strip_prefix(from.as_str())?;
        let suffix = suffix.strip_prefix('/')?;
        Some(Self(format!("{}/{suffix}", to.as_str())))
    }
}

fn invalid_folder_path(raw: &str) -> AppError {
    AppError::detailed(
        Code::LibraryFolderInvalid,
        format!("非法文件夹路径：{raw:?}"),
    )
}

/// 一个经过规范化与验证的素材标签。
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Tag(String);

impl Tag {
    pub fn parse(raw: &str) -> Result<Self> {
        let value = raw.trim();
        if value.is_empty() || value.chars().any(char::is_control) {
            return Err(AppError::detailed(
                Code::LibraryTagInvalid,
                format!("非法标签：{raw:?}"),
            ));
        }
        Ok(Self(value.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

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

/// 批量重命名逻辑文件夹时的权威侧车写入进度。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FolderMutationProgress {
    pub done: usize,
    pub total: usize,
    pub current_filename: String,
}

/// 素材组织、查询与生命周期的一致性入口。
pub struct Catalog {
    library: Library,
    index: Option<Index>,
    #[cfg(test)]
    fail_metadata_write_at: Option<usize>,
    #[cfg(test)]
    metadata_writes_seen: usize,
    #[cfg(test)]
    fail_lifecycle_stage: Option<LifecycleStage>,
    #[cfg(test)]
    fail_purge_hash: Option<ContentHash>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LifecycleStage {
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

/// 捕获一次批量权威元数据修改前的原始字节，供任一写入失败时逆序回滚。
struct MetadataTransaction {
    originals: Vec<(PathBuf, Vec<u8>)>,
}

impl MetadataTransaction {
    fn capture(sidecars: &[(PathBuf, AssetSidecar)], folders_path: &Path) -> Result<Self> {
        let mut originals = Vec::with_capacity(sidecars.len() + 1);
        for (path, _) in sidecars {
            originals.push((
                path.clone(),
                std::fs::read(path)
                    .map_err(|error| metadata_error("读取原侧车失败", path, error))?,
            ));
        }
        originals.push((
            folders_path.to_path_buf(),
            std::fs::read(folders_path)
                .map_err(|error| metadata_error("读取原文件夹清单失败", folders_path, error))?,
        ));
        Ok(Self { originals })
    }

    fn rollback(&self) -> Result<()> {
        for (path, bytes) in self.originals.iter().rev() {
            write_raw_atomic(path, bytes, Code::LibraryAssetMetadataWriteFailed)?;
        }
        Ok(())
    }
}

impl Catalog {
    pub fn open(library: Library) -> Result<Self> {
        let index = Index::open(&library)?;
        Ok(Self {
            library,
            index: Some(index),
            #[cfg(test)]
            fail_metadata_write_at: None,
            #[cfg(test)]
            metadata_writes_seen: 0,
            #[cfg(test)]
            fail_lifecycle_stage: None,
            #[cfg(test)]
            fail_purge_hash: None,
        })
    }

    pub fn library(&self) -> &Library {
        &self.library
    }

    pub fn index_imported(&mut self, sidecars: &[AssetSidecar]) -> Result<()> {
        if let Err(error) = self.index_mut()?.upsert_assets(sidecars) {
            return self.rebuild_after_index_failure(error);
        }
        Ok(())
    }

    pub fn asset_ext(&self, hash: &str) -> Result<String> {
        self.index()?.asset_ext(hash)
    }

    pub fn read_asset_body(&self, hash: &ContentHash) -> Result<Vec<u8>> {
        let index = self.index()?;
        let ext = index.asset_ext(hash.as_str())?;
        if index.asset_is_deleted(hash.as_str())? {
            let path = self.library.trash_body_path(hash, &ext);
            std::fs::read(&path).map_err(|error| {
                AppError::detailed(
                    Code::LibraryIoFailed,
                    format!("读取回收站素材本体失败 {}: {error}", path.display()),
                )
            })
        } else {
            self.library.read_body(hash, &ext)
        }
    }

    pub fn create_folder(
        &mut self,
        parent: Option<&FolderPath>,
        name: &FolderName,
    ) -> Result<FolderPath> {
        let mut list = self.library.read_folders()?;
        if let Some(parent) = parent {
            if !list.folders.iter().any(|path| path == parent.as_str()) {
                return Err(AppError::detailed(
                    Code::LibraryFolderNotFound,
                    format!("父文件夹不存在：{}", parent.as_str()),
                ));
            }
        }
        let target = match parent {
            Some(parent) => parent.join(name),
            None => FolderPath::parse(name.as_str())?,
        };
        if list.folders.iter().any(|path| path == target.as_str()) {
            return Err(AppError::detailed(
                Code::LibraryFolderExists,
                format!("文件夹已经存在：{}", target.as_str()),
            ));
        }
        list.folders.push(target.as_str().to_owned());
        list.folders.sort();
        self.library.write_folders(&list)?;
        if let Err(error) = self.index_mut()?.set_folders(&list) {
            self.rebuild_after_index_failure(error)?;
        }
        Ok(target)
    }

    pub fn set_asset_folders(&mut self, hash: &ContentHash, folders: &[FolderPath]) -> Result<()> {
        let list = self.library.read_folders()?;
        for folder in folders {
            if !list.folders.iter().any(|path| path == folder.as_str()) {
                return Err(AppError::detailed(
                    Code::LibraryFolderNotFound,
                    format!("文件夹不存在：{}", folder.as_str()),
                ));
            }
        }
        let path = self.library.sidecar_path(hash);
        let mut sidecar = AssetSidecar::read(&path)?;
        if sidecar.is_deleted() {
            return Err(AppError::detailed(
                Code::LibraryAssetMetadataWriteFailed,
                format!("回收站素材不能修改文件夹：{hash}"),
            ));
        }
        let mut canonical: Vec<String> = folders
            .iter()
            .map(|folder| folder.as_str().to_owned())
            .collect();
        canonical.sort();
        canonical.dedup();
        sidecar.folders = canonical;
        sidecar.write_atomic(&path).map_err(|error| {
            AppError::detailed(
                Code::LibraryAssetMetadataWriteFailed,
                format!("写入素材文件夹失败：{error:?}"),
            )
        })?;
        if let Err(error) = self.index_mut()?.upsert_asset(&sidecar) {
            return self.rebuild_after_index_failure(error);
        }
        Ok(())
    }

    pub fn set_asset_tags(&mut self, hash: &ContentHash, tags: &[Tag]) -> Result<()> {
        let path = self.library.sidecar_path(hash);
        let mut sidecar = AssetSidecar::read(&path)?;
        if sidecar.is_deleted() {
            return Err(AppError::detailed(
                Code::LibraryAssetMetadataWriteFailed,
                format!("回收站素材不能修改标签：{hash}"),
            ));
        }
        let mut canonical: Vec<String> = tags.iter().map(|tag| tag.as_str().to_owned()).collect();
        canonical.sort();
        canonical.dedup();
        sidecar.tags = canonical;
        sidecar.write_atomic(&path).map_err(|error| {
            AppError::detailed(
                Code::LibraryAssetMetadataWriteFailed,
                format!("写入素材标签失败：{error:?}"),
            )
        })?;
        if let Err(error) = self.index_mut()?.upsert_asset(&sidecar) {
            return self.rebuild_after_index_failure(error);
        }
        Ok(())
    }

    pub fn rename_folder<F>(
        &mut self,
        source: &FolderPath,
        new_name: &FolderName,
        mut on_progress: F,
    ) -> Result<FolderPath>
    where
        F: FnMut(FolderMutationProgress) -> Result<()>,
    {
        let original_list = self.library.read_folders()?;
        if !original_list
            .folders
            .iter()
            .any(|path| path == source.as_str())
        {
            return Err(AppError::detailed(
                Code::LibraryFolderNotFound,
                format!("文件夹不存在：{}", source.as_str()),
            ));
        }
        let target = match source.parent() {
            Some(parent) => parent.join(new_name),
            None => FolderPath::parse(new_name.as_str())?,
        };
        let source_tree: Vec<FolderPath> = original_list
            .folders
            .iter()
            .map(|path| FolderPath::parse(path))
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .filter(|path| path == source || path.is_descendant_of(source))
            .collect();
        let mapped_paths: Vec<FolderPath> = source_tree
            .iter()
            .map(|path| {
                path.rebase(source, &target).ok_or_else(|| {
                    AppError::detailed(
                        Code::LibraryFolderInvalid,
                        format!("路径不在重命名子树中：{}", path.as_str()),
                    )
                })
            })
            .collect::<Result<Vec<_>>>()?;
        for mapped in &mapped_paths {
            if original_list.folders.iter().any(|existing| {
                existing == mapped.as_str()
                    && !source_tree
                        .iter()
                        .any(|source_path| source_path.as_str() == existing)
            }) {
                return Err(AppError::detailed(
                    Code::LibraryFolderExists,
                    format!("重命名目标已经存在：{}", mapped.as_str()),
                ));
            }
        }

        let mut next_folders: Vec<String> = original_list
            .folders
            .iter()
            .map(|existing| {
                let path = FolderPath::parse(existing)?;
                let mapped = match path.rebase(source, &target) {
                    Some(mapped) => mapped,
                    None => path,
                };
                Ok(mapped.as_str().to_owned())
            })
            .collect::<Result<Vec<_>>>()?;
        next_folders.sort();
        next_folders.dedup();
        let next_list = FolderList {
            format_version: original_list.format_version,
            folders: next_folders,
        };

        let mut changed_sidecars = Vec::new();
        for asset in self.index()?.list_assets(false)? {
            let mut affected = false;
            for folder in &asset.folders {
                let path = FolderPath::parse(folder)?;
                if path == *source || path.is_descendant_of(source) {
                    affected = true;
                    break;
                }
            }
            if !affected {
                continue;
            }
            let hash = ContentHash::parse(&asset.hash)?;
            let path = self.library.sidecar_path(&hash);
            let mut sidecar = AssetSidecar::read(&path)?;
            sidecar.folders = sidecar
                .folders
                .iter()
                .map(|folder| {
                    let path = FolderPath::parse(folder)?;
                    let mapped = match path.rebase(source, &target) {
                        Some(mapped) => mapped,
                        None => path,
                    };
                    Ok(mapped.as_str().to_owned())
                })
                .collect::<Result<Vec<_>>>()?;
            sidecar.folders.sort();
            sidecar.folders.dedup();
            changed_sidecars.push((path, sidecar));
        }
        let total = changed_sidecars.len();
        self.commit_metadata(&changed_sidecars, &next_list, |done, sidecar| {
            on_progress(FolderMutationProgress {
                done,
                total,
                current_filename: sidecar.original_filename.clone(),
            })
        })?;
        Ok(target)
    }

    pub fn delete_folder(&mut self, source: &FolderPath) -> Result<()> {
        let original_list = self.library.read_folders()?;
        if !original_list
            .folders
            .iter()
            .any(|path| path == source.as_str())
        {
            return Err(AppError::detailed(
                Code::LibraryFolderNotFound,
                format!("文件夹不存在：{}", source.as_str()),
            ));
        }
        let mut remaining_folders = Vec::new();
        for folder in &original_list.folders {
            let path = FolderPath::parse(folder)?;
            if path != *source && !path.is_descendant_of(source) {
                remaining_folders.push(folder.clone());
            }
        }
        let next_list = FolderList {
            format_version: original_list.format_version,
            folders: remaining_folders,
        };

        let mut changed_sidecars = Vec::new();
        for asset in self.index()?.list_assets(false)? {
            let mut affected = false;
            for folder in &asset.folders {
                let path = FolderPath::parse(folder)?;
                if path == *source || path.is_descendant_of(source) {
                    affected = true;
                    break;
                }
            }
            if !affected {
                continue;
            }
            let hash = ContentHash::parse(&asset.hash)?;
            let path = self.library.sidecar_path(&hash);
            let mut sidecar = AssetSidecar::read(&path)?;
            let mut retained = Vec::new();
            for folder in &sidecar.folders {
                let path = FolderPath::parse(folder)?;
                if path != *source && !path.is_descendant_of(source) {
                    retained.push(folder.clone());
                }
            }
            sidecar.folders = retained;
            changed_sidecars.push((path, sidecar));
        }
        self.commit_metadata(&changed_sidecars, &next_list, |_, _| Ok(()))
    }

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

    fn commit_metadata<F>(
        &mut self,
        sidecars: &[(PathBuf, AssetSidecar)],
        folders: &FolderList,
        mut on_written: F,
    ) -> Result<()>
    where
        F: FnMut(usize, &AssetSidecar) -> Result<()>,
    {
        let folders_path = self.library.folders_path();
        let transaction = MetadataTransaction::capture(sidecars, &folders_path)?;

        for (index, (path, sidecar)) in sidecars.iter().enumerate() {
            if let Err(error) = self.before_metadata_write() {
                transaction.rollback()?;
                return Err(error);
            }
            if let Err(error) = sidecar.write_atomic(path) {
                transaction.rollback()?;
                return Err(AppError::detailed(
                    Code::LibraryAssetMetadataWriteFailed,
                    format!("批量写入素材侧车失败：{error:?}"),
                ));
            }
            if let Err(error) = on_written(index + 1, sidecar) {
                transaction.rollback()?;
                return Err(error);
            }
        }
        if let Err(error) = self.before_metadata_write() {
            transaction.rollback()?;
            return Err(error);
        }
        if let Err(error) = self.library.write_folders(folders) {
            transaction.rollback()?;
            return Err(AppError::detailed(
                Code::LibraryAssetMetadataWriteFailed,
                format!("批量写入文件夹清单失败：{error:?}"),
            ));
        }

        let updated_sidecars: Vec<AssetSidecar> = sidecars
            .iter()
            .map(|(_, sidecar)| sidecar.clone())
            .collect();
        if let Err(error) = self.index_mut()?.upsert_assets(&updated_sidecars) {
            return self.rebuild_after_index_failure(error);
        }
        if let Err(error) = self.index_mut()?.set_folders(folders) {
            return self.rebuild_after_index_failure(error);
        }
        Ok(())
    }

    fn before_metadata_write(&mut self) -> Result<()> {
        #[cfg(test)]
        {
            let current = self.metadata_writes_seen;
            self.metadata_writes_seen += 1;
            if self.fail_metadata_write_at == Some(current) {
                return Err(AppError::detailed(
                    Code::LibraryAssetMetadataWriteFailed,
                    format!("注入第 {current} 个元数据写入失败"),
                ));
            }
        }
        Ok(())
    }

    #[cfg(test)]
    fn inject_metadata_failure_at(&mut self, write_index: usize) {
        self.fail_metadata_write_at = Some(write_index);
        self.metadata_writes_seen = 0;
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

    pub fn rebuild_index(&mut self) -> Result<()> {
        self.index.take();
        self.index = Some(Index::rebuild(&self.library)?);
        Ok(())
    }

    fn rebuild_after_index_failure(&mut self, cause: AppError) -> Result<()> {
        self.rebuild_index()?;
        Err(cause)
    }

    fn index(&self) -> Result<&Index> {
        self.index.as_ref().ok_or_else(|| {
            AppError::detailed(Code::LibraryIndexRebuildFailed, "Catalog 索引暂时不可用")
        })
    }

    fn index_mut(&mut self) -> Result<&mut Index> {
        self.index.as_mut().ok_or_else(|| {
            AppError::detailed(Code::LibraryIndexRebuildFailed, "Catalog 索引暂时不可用")
        })
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

fn metadata_error(what: &str, path: &Path, error: std::io::Error) -> AppError {
    AppError::detailed(
        Code::LibraryAssetMetadataWriteFailed,
        format!("{what} {}: {error}", path.display()),
    )
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

fn write_raw_atomic(path: &Path, bytes: &[u8], code: Code) -> Result<()> {
    let temporary = path.with_extension("rollback.tmp");
    std::fs::write(&temporary, bytes).map_err(|error| {
        AppError::detailed(
            code,
            format!("写入回滚临时文件失败 {}: {error}", temporary.display()),
        )
    })?;
    std::fs::rename(&temporary, path).map_err(|error| {
        AppError::detailed(
            code,
            format!("提交回滚文件失败 {}: {error}", path.display()),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(not(debug_assertions))]
    use crate::colorcard::ColorCard;
    use crate::error::Code;
    #[cfg(not(debug_assertions))]
    use crate::hashing::HASH_ALGO_ID;
    use crate::import::{import_one, ImportOptions, NoopObserver};
    use crate::library::Library;
    #[cfg(not(debug_assertions))]
    use crate::media::MediaType;
    #[cfg(not(debug_assertions))]
    use crate::sidecar::SIDECAR_FORMAT_VERSION;
    use image::{DynamicImage, ImageFormat, Rgba, RgbaImage};
    use std::path::{Path, PathBuf};
    #[cfg(not(debug_assertions))]
    use std::time::{Duration, Instant};

    struct Fixture {
        catalog: Catalog,
        source: PathBuf,
        _dir: tempfile::TempDir,
    }

    fn fixture() -> Fixture {
        let temp_root =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/vistash-test-temp");
        std::fs::create_dir_all(&temp_root).expect("建立 E 盘项目测试目录");
        let dir = tempfile::tempdir_in(temp_root).expect("建立项目临时目录");
        let source = dir.path().join("source");
        std::fs::create_dir(&source).expect("建立来源目录");
        let library = Library::create(&dir.path().join("library")).expect("建立库");
        let catalog = Catalog::open(library).expect("打开目录");
        Fixture {
            catalog,
            source,
            _dir: dir,
        }
    }

    fn write_png(dir: &Path, name: &str, color: [u8; 4]) -> PathBuf {
        let path = dir.join(name);
        DynamicImage::ImageRgba8(RgbaImage::from_pixel(16, 16, Rgba(color)))
            .save_with_format(&path, ImageFormat::Png)
            .expect("写入图片");
        path
    }

    fn import_with(
        catalog: &mut Catalog,
        source: &Path,
        folders: &[&str],
        tags: &[&str],
    ) -> AssetSidecar {
        let options = ImportOptions {
            folders: folders.iter().map(|folder| (*folder).to_owned()).collect(),
            tags: tags.iter().map(|tag| (*tag).to_owned()).collect(),
        };
        let sidecar =
            import_one(catalog.library(), source, &options, &mut NoopObserver).expect("导入素材");
        catalog
            .index_imported(std::slice::from_ref(&sidecar))
            .expect("写入索引");
        sidecar
    }

    #[cfg(not(debug_assertions))]
    fn synthetic_sidecar(index: usize, folders: &[&str], tags: &[&str]) -> AssetSidecar {
        AssetSidecar {
            format_version: SIDECAR_FORMAT_VERSION,
            hash: ContentHash::of_bytes(&index.to_le_bytes()),
            hash_algo: HASH_ALGO_ID.to_owned(),
            media_type: MediaType::Png,
            ext: "png".to_owned(),
            byte_size: 1,
            width: 1,
            height: 1,
            imported_at: chrono::DateTime::from_timestamp(index as i64, 0).expect("构造固定时间戳"),
            original_filename: format!("素材-{index:05}-人物.png"),
            source_path: None,
            folders: folders.iter().map(|value| (*value).to_owned()).collect(),
            tags: tags.iter().map(|value| (*value).to_owned()).collect(),
            color_card: ColorCard::failed(Code::ColorCardInsufficientOpaquePixels),
            deleted_at: None,
            deleted_from_folders: None,
        }
    }

    #[test]
    fn folder_name_trims_surrounding_whitespace() {
        let name = FolderName::parse("  构图  ").expect("名称应有效");
        assert_eq!(name.as_str(), "构图");
    }

    #[test]
    fn folder_name_rejects_invalid_segments() {
        for raw in ["", "   ", ".", "..", "人物/肖像", "人物\n肖像"] {
            let error = FolderName::parse(raw).expect_err("名称本应被拒绝");
            assert_eq!(error.code, Code::LibraryFolderInvalid, "输入：{raw:?}");
        }
    }

    #[test]
    fn folder_path_normalizes_every_segment() {
        let path = FolderPath::parse(" 参考 / 构图 ").expect("路径应有效");
        assert_eq!(path.as_str(), "参考/构图");
    }

    #[test]
    fn folder_path_rejects_empty_segments() {
        let error = FolderPath::parse("参考//构图").expect_err("空段本应被拒绝");
        assert_eq!(error.code, Code::LibraryFolderInvalid);
    }

    #[test]
    fn folder_path_prefix_checks_respect_segment_boundaries() {
        let parent = FolderPath::parse("参考").expect("父路径");
        let child = FolderPath::parse("参考/构图").expect("子路径");
        let lookalike = FolderPath::parse("参考图").expect("相似路径");
        assert!(child.is_descendant_of(&parent));
        assert!(!lookalike.is_descendant_of(&parent));
    }

    #[test]
    fn folder_path_rebases_a_subtree() {
        let source = FolderPath::parse("参考/构图/三分法").expect("来源路径");
        let from = FolderPath::parse("参考").expect("旧根");
        let to = FolderPath::parse("灵感").expect("新根");
        assert_eq!(
            source.rebase(&from, &to).expect("应位于旧根下").as_str(),
            "灵感/构图/三分法"
        );
    }

    #[test]
    fn tag_trims_whitespace_and_rejects_control_characters() {
        assert_eq!(
            Tag::parse("  人物参考  ").expect("标签应有效").as_str(),
            "人物参考"
        );
        let error = Tag::parse("人物\t参考").expect_err("控制字符本应被拒绝");
        assert_eq!(error.code, Code::LibraryTagInvalid);
    }

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
    fn create_folder_requires_an_existing_parent_and_persists_the_child() {
        let mut fixture = fixture();
        let parent_name = FolderName::parse("参考").expect("父名称");
        let parent = fixture
            .catalog
            .create_folder(None, &parent_name)
            .expect("创建父文件夹");
        let child = fixture
            .catalog
            .create_folder(Some(&parent), &FolderName::parse("构图").expect("子名称"))
            .expect("创建子文件夹");

        assert_eq!(
            fixture
                .catalog
                .library()
                .read_folders()
                .expect("读取清单")
                .folders,
            vec!["参考".to_owned(), "参考/构图".to_owned()]
        );
        assert_eq!(child.as_str(), "参考/构图");
    }

    #[test]
    fn create_folder_refuses_missing_parent() {
        let mut fixture = fixture();
        let missing = FolderPath::parse("不存在").expect("路径");
        let error = fixture
            .catalog
            .create_folder(Some(&missing), &FolderName::parse("子项").expect("名称"))
            .expect_err("不存在的父路径本应失败");
        assert_eq!(error.code, Code::LibraryFolderNotFound);
    }

    #[test]
    fn create_folder_refuses_duplicate_path() {
        let mut fixture = fixture();
        fixture
            .catalog
            .create_folder(None, &FolderName::parse("参考").expect("名称"))
            .expect("首次创建");
        let duplicate = fixture
            .catalog
            .create_folder(None, &FolderName::parse("参考").expect("名称"))
            .expect_err("重复路径本应失败");
        assert_eq!(duplicate.code, Code::LibraryFolderExists);
    }

    #[test]
    fn set_asset_folders_supports_multiple_memberships_and_return_to_root() {
        let mut fixture = fixture();
        let source = write_png(&fixture.source, "人物.png", [255, 0, 0, 255]);
        let sidecar = import_with(&mut fixture.catalog, &source, &[], &[]);
        let reference = fixture
            .catalog
            .create_folder(None, &FolderName::parse("参考").expect("名称"))
            .expect("创建文件夹");
        let palette = fixture
            .catalog
            .create_folder(None, &FolderName::parse("配色").expect("名称"))
            .expect("创建文件夹");

        fixture
            .catalog
            .set_asset_folders(&sidecar.hash, &[reference, palette])
            .expect("设置多文件夹");
        let stored = AssetSidecar::read(&fixture.catalog.library().sidecar_path(&sidecar.hash))
            .expect("读取侧车");
        assert_eq!(stored.folders, vec!["参考".to_owned(), "配色".to_owned()]);

        fixture
            .catalog
            .set_asset_folders(&sidecar.hash, &[])
            .expect("移回根文件夹");
        let rooted = AssetSidecar::read(&fixture.catalog.library().sidecar_path(&sidecar.hash))
            .expect("读取侧车");
        assert!(rooted.folders.is_empty());
    }

    #[test]
    fn set_asset_folders_refuses_a_missing_folder_without_changing_sidecar() {
        let mut fixture = fixture();
        let source = write_png(&fixture.source, "人物.png", [255, 0, 0, 255]);
        let sidecar = import_with(&mut fixture.catalog, &source, &[], &[]);
        let before = std::fs::read(fixture.catalog.library().sidecar_path(&sidecar.hash))
            .expect("读取原始侧车");

        let error = fixture
            .catalog
            .set_asset_folders(&sidecar.hash, &[FolderPath::parse("不存在").expect("路径")])
            .expect_err("不存在的文件夹本应失败");

        assert_eq!(error.code, Code::LibraryFolderNotFound);
        assert_eq!(
            std::fs::read(fixture.catalog.library().sidecar_path(&sidecar.hash))
                .expect("重新读取侧车"),
            before
        );
    }

    #[test]
    fn set_asset_tags_is_sorted_deduplicated_and_idempotent() {
        let mut fixture = fixture();
        let source = write_png(&fixture.source, "人物.png", [255, 0, 0, 255]);
        let sidecar = import_with(&mut fixture.catalog, &source, &[], &[]);
        let person = Tag::parse("人物").expect("标签");
        let backlit = Tag::parse("逆光").expect("标签");

        fixture
            .catalog
            .set_asset_tags(&sidecar.hash, &[backlit, person.clone(), person])
            .expect("设置标签");
        fixture
            .catalog
            .set_asset_tags(
                &sidecar.hash,
                &[
                    Tag::parse("人物").expect("标签"),
                    Tag::parse("逆光").expect("标签"),
                ],
            )
            .expect("重复设置应幂等成功");

        let stored = AssetSidecar::read(&fixture.catalog.library().sidecar_path(&sidecar.hash))
            .expect("读取侧车");
        assert_eq!(stored.tags, vec!["人物".to_owned(), "逆光".to_owned()]);
    }

    #[test]
    fn set_asset_tags_can_remove_the_last_tag_repeatedly() {
        let mut fixture = fixture();
        let source = write_png(&fixture.source, "人物.png", [255, 0, 0, 255]);
        let sidecar = import_with(&mut fixture.catalog, &source, &[], &["人物"]);

        fixture
            .catalog
            .set_asset_tags(&sidecar.hash, &[])
            .expect("移除最后一个标签");
        fixture
            .catalog
            .set_asset_tags(&sidecar.hash, &[])
            .expect("重复移除应幂等成功");

        let stored = AssetSidecar::read(&fixture.catalog.library().sidecar_path(&sidecar.hash))
            .expect("读取侧车");
        assert!(stored.tags.is_empty());
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
    fn rename_folder_updates_descendants_and_every_asset_membership() {
        let mut fixture = fixture();
        let reference = fixture
            .catalog
            .create_folder(None, &FolderName::parse("参考").expect("名称"))
            .expect("创建父文件夹");
        let composition = fixture
            .catalog
            .create_folder(Some(&reference), &FolderName::parse("构图").expect("名称"))
            .expect("创建子文件夹");
        let source = write_png(&fixture.source, "三分法.png", [255, 0, 0, 255]);
        let sidecar = import_with(&mut fixture.catalog, &source, &[composition.as_str()], &[]);
        let mut progress = Vec::new();

        let renamed = fixture
            .catalog
            .rename_folder(
                &reference,
                &FolderName::parse("灵感").expect("名称"),
                |event| {
                    progress.push(event);
                    Ok(())
                },
            )
            .expect("重命名文件夹");

        assert_eq!(renamed.as_str(), "灵感");
        assert_eq!(
            progress,
            vec![FolderMutationProgress {
                done: 1,
                total: 1,
                current_filename: "三分法.png".to_owned(),
            }]
        );
        assert_eq!(
            fixture
                .catalog
                .library()
                .read_folders()
                .expect("读取清单")
                .folders,
            vec!["灵感".to_owned(), "灵感/构图".to_owned()]
        );
        assert_eq!(
            AssetSidecar::read(&fixture.catalog.library().sidecar_path(&sidecar.hash))
                .expect("读取侧车")
                .folders,
            vec!["灵感/构图".to_owned()]
        );
    }

    #[test]
    fn rename_folder_rolls_back_every_authoritative_file_when_a_later_write_fails() {
        let mut fixture = fixture();
        let reference = fixture
            .catalog
            .create_folder(None, &FolderName::parse("参考").expect("名称"))
            .expect("创建文件夹");
        let first = write_png(&fixture.source, "一.png", [255, 0, 0, 255]);
        let second = write_png(&fixture.source, "二.png", [0, 255, 0, 255]);
        let first_sidecar = import_with(&mut fixture.catalog, &first, &[reference.as_str()], &[]);
        let second_sidecar = import_with(&mut fixture.catalog, &second, &[reference.as_str()], &[]);
        let authoritative_paths = [
            fixture.catalog.library().folders_path(),
            fixture.catalog.library().sidecar_path(&first_sidecar.hash),
            fixture.catalog.library().sidecar_path(&second_sidecar.hash),
        ];
        let before: Vec<Vec<u8>> = authoritative_paths
            .iter()
            .map(|path| std::fs::read(path).expect("读取原始字节"))
            .collect();
        fixture.catalog.inject_metadata_failure_at(1);

        let error = fixture
            .catalog
            .rename_folder(
                &reference,
                &FolderName::parse("灵感").expect("名称"),
                |_| Ok(()),
            )
            .expect_err("第二个侧车写入本应失败");

        assert_eq!(error.code, Code::LibraryAssetMetadataWriteFailed);
        assert_eq!(
            authoritative_paths
                .iter()
                .map(|path| std::fs::read(path).expect("读取回滚后字节"))
                .collect::<Vec<_>>(),
            before
        );
    }

    #[test]
    fn delete_folder_removes_the_subtree_membership_without_deleting_assets() {
        let mut fixture = fixture();
        let reference = fixture
            .catalog
            .create_folder(None, &FolderName::parse("参考").expect("名称"))
            .expect("创建文件夹");
        let composition = fixture
            .catalog
            .create_folder(Some(&reference), &FolderName::parse("构图").expect("名称"))
            .expect("创建子文件夹");
        let palette = fixture
            .catalog
            .create_folder(None, &FolderName::parse("配色").expect("名称"))
            .expect("创建文件夹");
        let source = write_png(&fixture.source, "人物.png", [255, 0, 0, 255]);
        let sidecar = import_with(
            &mut fixture.catalog,
            &source,
            &[composition.as_str(), palette.as_str()],
            &[],
        );

        fixture
            .catalog
            .delete_folder(&reference)
            .expect("删除文件夹子树");

        assert_eq!(
            fixture
                .catalog
                .library()
                .read_folders()
                .expect("读取清单")
                .folders,
            vec!["配色".to_owned()]
        );
        assert_eq!(
            AssetSidecar::read(&fixture.catalog.library().sidecar_path(&sidecar.hash))
                .expect("读取侧车")
                .folders,
            vec!["配色".to_owned()]
        );
        assert!(fixture
            .catalog
            .library()
            .body_path(&sidecar.hash, &sidecar.ext)
            .is_file());
    }

    #[test]
    fn delete_folder_rolls_back_when_a_sidecar_write_fails() {
        let mut fixture = fixture();
        let reference = fixture
            .catalog
            .create_folder(None, &FolderName::parse("参考").expect("名称"))
            .expect("创建文件夹");
        let source = write_png(&fixture.source, "人物.png", [255, 0, 0, 255]);
        let sidecar = import_with(&mut fixture.catalog, &source, &[reference.as_str()], &[]);
        let folders_path = fixture.catalog.library().folders_path();
        let sidecar_path = fixture.catalog.library().sidecar_path(&sidecar.hash);
        let before = [
            std::fs::read(&folders_path).expect("文件夹原始字节"),
            std::fs::read(&sidecar_path).expect("侧车原始字节"),
        ];
        fixture.catalog.inject_metadata_failure_at(0);

        let error = fixture
            .catalog
            .delete_folder(&reference)
            .expect_err("注入失败本应返回错误");

        assert_eq!(error.code, Code::LibraryAssetMetadataWriteFailed);
        assert_eq!(
            [
                std::fs::read(&folders_path).expect("文件夹回滚字节"),
                std::fs::read(&sidecar_path).expect("侧车回滚字节"),
            ],
            before
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

    #[test]
    #[cfg(not(debug_assertions))]
    #[ignore = "release 性能基线：显式运行 --release --ignored"]
    fn release_rename_of_one_thousand_sidecars_records_baseline() {
        let mut fixture = fixture();
        let folder = fixture
            .catalog
            .create_folder(None, &FolderName::parse("参考").expect("文件夹名"))
            .expect("创建文件夹");
        let rows: Vec<AssetSidecar> = (0..1_000)
            .map(|index| synthetic_sidecar(index, &[folder.as_str()], &["人物"]))
            .collect();
        for sidecar in &rows {
            sidecar
                .write_atomic(&fixture.catalog.library().sidecar_path(&sidecar.hash))
                .expect("写入侧车 fixture");
        }
        fixture
            .catalog
            .index_imported(&rows)
            .expect("构造索引 fixture");

        let started = Instant::now();
        fixture
            .catalog
            .rename_folder(
                &folder,
                &FolderName::parse("灵感").expect("新名称"),
                |_| Ok(()),
            )
            .expect("重命名文件夹");
        let elapsed = started.elapsed();

        eprintln!("1,000 个侧车重命名：{elapsed:?}");
        if elapsed > Duration::from_secs(2) {
            eprintln!("超过 2 s：必须在界面中呈现后台进度");
        }
    }
}
