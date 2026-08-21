//! 图片素材的组织元数据：逻辑文件夹树、标签，以及它们的批量权威写入事务。
//!
//! 这里的每一次写入都同时改动侧车与 `folders.json` 两处权威文件，因此批量事务
//! [`MetadataTransaction`] 与提交路径 `Catalog::commit_metadata` 也留在本模块：
//! 把事务放到更上层会让"哪些文件属于同一次组织变更"这件事散到调用方。
//!
//! 生命周期（删除/还原/purge）的写入不走这条路径，见 [`super::lifecycle`]：它移动的是
//! 本体与侧车文件本身，回滚要恢复的是文件位置而不是文件内容。

use super::write_raw_atomic;
use crate::error::{AppError, Code, Result};
use crate::hashing::ContentHash;
use crate::library::FolderList;
use crate::sidecar::AssetSidecar;
use serde::Serialize;
use std::path::{Path, PathBuf};

use super::Catalog;

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

/// 批量重命名逻辑文件夹时的权威侧车写入进度。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FolderMutationProgress {
    pub done: usize,
    pub total: usize,
    pub current_filename: String,
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

}

fn metadata_error(what: &str, path: &Path, error: std::io::Error) -> AppError {
    AppError::detailed(
        Code::LibraryAssetMetadataWriteFailed,
        format!("{what} {}: {error}", path.display()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::testing::{fixture, import_with, write_png};
    use crate::error::Code;
    #[cfg(not(debug_assertions))]
    use crate::catalog::testing::synthetic_sidecar;
    #[cfg(not(debug_assertions))]
    use std::time::{Duration, Instant};

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
