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
use crate::{colorcard, colorcard::ColorCard, media};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use super::Catalog;

/// 同级相邻交换方向；序列化词与前端调用约定一致（"up" / "down"）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FolderReorder {
    Up,
    Down,
}

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

    pub fn name(&self) -> FolderName {
        let segment = self
            .0
            .rsplit('/')
            .next()
            .expect("FolderPath 构造保证至少包含一个非空路径段");
        FolderName(segment.to_owned())
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

/// 按父路径分组（保持传入的相对顺序）；父路径缺失的孤儿条目按根节点处理，
/// 与前端树构建保持同一兜底。
fn folder_children_map(paths: &[FolderPath]) -> HashMap<Option<String>, Vec<FolderPath>> {
    let known: HashSet<&str> = paths.iter().map(|path| path.as_str()).collect();
    let mut children: HashMap<Option<String>, Vec<FolderPath>> = HashMap::new();
    for path in paths {
        let key = match path.parent() {
            Some(parent) if known.contains(parent.as_str()) => {
                Some(parent.as_str().to_owned())
            }
            _ => None,
        };
        children.entry(key).or_default().push(path.clone());
    }
    children
}

/// 以深度优先顺序展开分组：父节点先于整棵子树，同级保持分组内的相对顺序。
fn emit_folder_order(children: &HashMap<Option<String>, Vec<FolderPath>>) -> Vec<String> {
    fn emit(
        path: &FolderPath,
        children: &HashMap<Option<String>, Vec<FolderPath>>,
        next: &mut Vec<String>,
    ) {
        next.push(path.as_str().to_owned());
        if let Some(offspring) = children.get(&Some(path.as_str().to_owned())) {
            for child in offspring {
                emit(child, children, next);
            }
        }
    }
    let mut next = Vec::new();
    if let Some(roots) = children.get(&None).cloned() {
        for root in &roots {
            emit(root, children, &mut next);
        }
    }
    next
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
        // 清单顺序即界面呈现顺序（同级手动排序的权威记录）：新子文件夹插到父子树
        // 末尾，顶层文件夹追加到清单末尾；不再字母排序，避免覆盖使用者的排列。
        let insert_at = match parent {
            Some(parent) => list
                .folders
                .iter()
                .rposition(|path| {
                    path == parent.as_str()
                        || FolderPath::parse(path)
                            .map(|path| path.is_descendant_of(parent))
                            .unwrap_or(false)
                })
                .map(|index| index + 1)
                .unwrap_or(list.folders.len()),
            None => list.folders.len(),
        };
        list.folders.insert(insert_at, target.as_str().to_owned());
        self.library.write_folders(&list)?;
        if let Err(error) = self.index_mut()?.set_folders(&list) {
            self.rebuild_after_index_failure(error)?;
        }
        Ok(target)
    }

    /// 读取一条可修改的正常库素材侧车。
    ///
    /// 与提示词侧的 `load_editable_prompt` 同一语义：先区分"在回收站"（状态问题，
    /// 去回收站还原后才能改）与"哪里都找不到"（ID 有误或列表过期），两者都拒绝
    /// 而不是让调用方拿到一个指向缺失路径的 IO 错误。
    fn load_editable_sidecar(&self, hash: &ContentHash, what: &str) -> Result<(PathBuf, AssetSidecar)> {
        let path = self.library.sidecar_path(hash);
        if !path.exists() {
            if self.library.trash_sidecar_path(hash).exists() {
                return Err(AppError::detailed(
                    Code::LibraryAssetMetadataWriteFailed,
                    format!("回收站素材不能修改{what}：{hash}"),
                ));
            }
            return Err(AppError::detailed(
                Code::LibraryAssetMetadataWriteFailed,
                format!("正常库中不存在该素材：{hash}"),
            ));
        }
        let sidecar = AssetSidecar::read(&path)?;
        if sidecar.is_deleted() {
            return Err(AppError::detailed(
                Code::LibraryAssetMetadataWriteFailed,
                format!("回收站素材不能修改{what}：{hash}"),
            ));
        }
        Ok((path, sidecar))
    }

    /// 把素材移动到唯一目标文件夹（单归属）。
    ///
    /// `target` 为 `Some` 时要求该文件夹已存在，否则整体拒绝且不改动旧归属；
    /// 为 `None` 时移出所有文件夹、回到未分类。回收站素材先还原再操作。
    pub fn move_asset_to_folder(
        &mut self,
        hash: &ContentHash,
        target: Option<&FolderPath>,
    ) -> Result<()> {
        // 主体状态先于目标校验：素材在回收站时根本不可改，此时目标是否在清单里
        // 是次要问题——回收站拒改（LibraryAssetMetadataWriteFailed）优先报出。
        let (path, mut sidecar) = self.load_editable_sidecar(hash, "文件夹")?;
        if let Some(folder) = target {
            let list = self.library.read_folders()?;
            if !list.folders.iter().any(|path| path == folder.as_str()) {
                return Err(AppError::detailed(
                    Code::LibraryFolderNotFound,
                    format!("文件夹不存在：{}", folder.as_str()),
                ));
            }
        }
        sidecar.move_to_folder(target.map(|folder| folder.as_str()))?;
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

    /// 修改图片显示文件名，同时保持来源身份和内容哈希对象不变。
    pub fn rename_asset_display_filename(
        &mut self,
        hash: &ContentHash,
        stem: &str,
    ) -> Result<()> {
        let (path, mut sidecar) = self.load_editable_sidecar(hash, "显示文件名")?;
        sidecar.rename_display_filename(stem)?;
        sidecar.write_atomic(&path).map_err(|error| {
            AppError::detailed(
                Code::LibraryAssetMetadataWriteFailed,
                format!("写入素材显示文件名失败：{error:?}"),
            )
        })?;
        if let Err(error) = self.index_mut()?.upsert_asset(&sidecar) {
            return self.rebuild_after_index_failure(error);
        }
        Ok(())
    }

    pub fn set_asset_tags(&mut self, hash: &ContentHash, tags: &[Tag]) -> Result<()> {
        let (path, mut sidecar) = self.load_editable_sidecar(hash, "标签")?;
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

    /// 设置素材备注（多行纯文本，逐字保留）。
    ///
    /// 与提示词备注同一语义：备注是独立自动保存流，写入不推进任何时间字段，
    /// 也不触碰组织与收藏状态。
    pub fn set_asset_note(&mut self, hash: &ContentHash, note: &str) -> Result<()> {
        let (path, mut sidecar) = self.load_editable_sidecar(hash, "备注")?;
        sidecar.note = note.to_owned();
        sidecar.write_atomic(&path).map_err(|error| {
            AppError::detailed(
                Code::LibraryAssetMetadataWriteFailed,
                format!("写入素材备注失败：{error:?}"),
            )
        })?;
        if let Err(error) = self.index_mut()?.upsert_asset(&sidecar) {
            return self.rebuild_after_index_failure(error);
        }
        Ok(())
    }

    /// 设置素材收藏（纯二值）。
    pub fn set_asset_favorite(&mut self, hash: &ContentHash, favorite: bool) -> Result<()> {
        let (path, mut sidecar) = self.load_editable_sidecar(hash, "收藏状态")?;
        sidecar.favorite = favorite;
        sidecar.write_atomic(&path).map_err(|error| {
            AppError::detailed(
                Code::LibraryAssetMetadataWriteFailed,
                format!("写入素材收藏状态失败：{error:?}"),
            )
        })?;
        if let Err(error) = self.index_mut()?.upsert_asset(&sidecar) {
            return self.rebuild_after_index_failure(error);
        }
        Ok(())
    }

    /// 从库内权威原图重新分析色卡并原子更新侧车与派生索引。
    pub fn regenerate_color_card(&mut self, hash: &ContentHash) -> Result<ColorCard> {
        let (sidecar_path, mut sidecar) = self.load_editable_sidecar(hash, "色卡")?;
        let body_path = self.library.body_path(hash, &sidecar.ext);
        let decoded = media::decode(&body_path).map_err(|error| {
            AppError::detailed(
                Code::ColorCardDecodeFailed,
                format!("重新分析色卡时解码原图失败：{error}"),
            )
        })?;
        let card = colorcard::analyze(&decoded.image);
        sidecar.color_card = card.clone();
        sidecar.write_atomic(&sidecar_path).map_err(|error| {
            AppError::detailed(
                Code::LibraryAssetMetadataWriteFailed,
                format!("写入重新分析的色卡失败：{error:?}"),
            )
        })?;
        if let Err(error) = self.index_mut()?.upsert_asset(&sidecar) {
            self.rebuild_after_index_failure(error)?;
        }
        Ok(card)
    }

    pub fn rename_folder<F>(
        &mut self,
        source: &FolderPath,
        new_name: &FolderName,
        on_progress: F,
    ) -> Result<FolderPath>
    where
        F: FnMut(FolderMutationProgress) -> Result<()>,
    {
        let target = match source.parent() {
            Some(parent) => parent.join(new_name),
            None => FolderPath::parse(new_name.as_str())?,
        };
        if target == *source {
            return Ok(source.clone());
        }
        self.rebase_folder(source, &target, on_progress)
    }

    /// 把完整文件夹子树移动到另一个父节点或库根位置。
    ///
    /// 目标父节点必须存在，且不能是源节点或其后代。目标路径碰撞、任一侧车或
    /// 文件夹清单写入失败时，权威元数据保持操作前状态。
    pub fn move_folder<F>(
        &mut self,
        source: &FolderPath,
        destination_parent: Option<&FolderPath>,
        on_progress: F,
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
        if let Some(parent) = destination_parent {
            if !original_list
                .folders
                .iter()
                .any(|path| path == parent.as_str())
            {
                return Err(AppError::detailed(
                    Code::LibraryFolderNotFound,
                    format!("目标父文件夹不存在：{}", parent.as_str()),
                ));
            }
            if parent == source || parent.is_descendant_of(source) {
                return Err(AppError::detailed(
                    Code::LibraryFolderInvalid,
                    format!("不能把文件夹移动到自身或后代：{}", parent.as_str()),
                ));
            }
        }
        let name = source.name();
        let target = match destination_parent {
            Some(parent) => parent.join(&name),
            None => FolderPath::parse(name.as_str())?,
        };
        if target == *source {
            return Ok(source.clone());
        }
        self.rebase_folder(source, &target, on_progress)
    }

    fn rebase_folder<F>(
        &mut self,
        source: &FolderPath,
        target: &FolderPath,
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
                path.rebase(source, target).ok_or_else(|| {
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
                let mapped = match path.rebase(source, target) {
                    Some(mapped) => mapped,
                    None => path,
                };
                Ok(mapped.as_str().to_owned())
            })
            .collect::<Result<Vec<_>>>()?;
        // 保持清单相对顺序：子树在原地完成路径改写，使用者的同级排列不被重置。
        next_folders.dedup();
        // 原地改写可能让子树越过其新父节点；按深度优先重整，同级相对顺序不变。
        let reparented: Vec<FolderPath> = next_folders
            .iter()
            .map(|path| FolderPath::parse(path))
            .collect::<Result<Vec<_>>>()?;
        let next_folders = emit_folder_order(&folder_children_map(&reparented));
        let next_list = FolderList {
            format_version: original_list.format_version,
            folders: next_folders,
        };

        let mut changed_sidecars = Vec::new();
        for asset in self.index()?.list_assets(false)? {
            let Some(asset_folder) = asset.folder.as_deref() else {
                continue;
            };
            let path = FolderPath::parse(asset_folder)?;
            if path != *source && !path.is_descendant_of(source) {
                continue;
            }
            let hash = ContentHash::parse(&asset.hash)?;
            let sidecar_path = self.library.sidecar_path(&hash);
            let mut sidecar = AssetSidecar::read(&sidecar_path)?;
            // 命中即整棵子树内，单归属下 rebase 必然成功。
            let mapped = path.rebase(source, target).ok_or_else(|| {
                AppError::detailed(
                    Code::LibraryFolderInvalid,
                    format!("路径不在重命名子树中：{}", path.as_str()),
                )
            })?;
            sidecar.folder = Some(mapped.as_str().to_owned());
            changed_sidecars.push((sidecar_path, sidecar));
        }
        let total = changed_sidecars.len();
        self.commit_metadata(&changed_sidecars, &next_list, |done, sidecar| {
            on_progress(FolderMutationProgress {
                done,
                total,
                current_filename: sidecar.source.filename().to_owned(),
            })
        })?;
        Ok(target.clone())
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
            let Some(asset_folder) = asset.folder.as_deref() else {
                continue;
            };
            let path = FolderPath::parse(asset_folder)?;
            if path != *source && !path.is_descendant_of(source) {
                continue;
            }
            let hash = ContentHash::parse(&asset.hash)?;
            let sidecar_path = self.library.sidecar_path(&hash);
            let mut sidecar = AssetSidecar::read(&sidecar_path)?;
            // 单归属下被删子树就是唯一归属：清空即回到未分类。
            sidecar.folder = None;
            changed_sidecars.push((sidecar_path, sidecar));
        }
        self.commit_metadata(&changed_sidecars, &next_list, |_, _| Ok(()))
    }

    /// 同级相邻交换文件夹顺序。
    ///
    /// 只改动 `folders.json` 的条目顺序，不触碰任何侧车与图片归属；到达同级分组
    /// 边界时是安静的无操作（界面可能持有过期快照，重复点击不应报错）。交换以
    /// 深度优先重建整份清单：被移动节点的完整子树随它一起换位置，其余节点的
    /// 相对顺序保持不变。
    pub fn reorder_folder(&mut self, source: &FolderPath, direction: FolderReorder) -> Result<()> {
        let list = self.library.read_folders()?;
        if !list.folders.iter().any(|path| path == source.as_str()) {
            return Err(AppError::detailed(
                Code::LibraryFolderNotFound,
                format!("文件夹不存在：{}", source.as_str()),
            ));
        }
        let paths: Vec<FolderPath> = list
            .folders
            .iter()
            .map(|path| FolderPath::parse(path))
            .collect::<Result<Vec<_>>>()?;
        let mut children = folder_children_map(&paths);
        let source_parent = children
            .iter()
            .find(|(_, group)| group.iter().any(|path| path == source))
            .map(|(key, _)| key.clone())
            .expect("源文件夹已校验存在于清单，必然出现在某个父级分组中");
        let mut siblings = children
            .get(&source_parent)
            .cloned()
            .expect("源文件夹所在分组必然存在");
        let position = siblings
            .iter()
            .position(|path| path == source)
            .expect("源文件夹已校验存在于清单，必然出现在其同级分组中");
        match direction {
            FolderReorder::Up => {
                if position == 0 {
                    return Ok(());
                }
                siblings.swap(position, position - 1);
            }
            FolderReorder::Down => {
                if position + 1 >= siblings.len() {
                    return Ok(());
                }
                siblings.swap(position, position + 1);
            }
        }
        children.insert(source_parent, siblings);
        let next = emit_folder_order(&children);
        let next_list = FolderList {
            format_version: list.format_version,
            folders: next,
        };
        self.library.write_folders(&next_list)?;
        if let Err(error) = self.index_mut()?.set_folders(&next_list) {
            self.rebuild_after_index_failure(error)?;
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
    use crate::catalog::query::{AssetLocation, AssetQuery, FolderFilter};
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
    fn move_asset_to_folder_replaces_the_single_membership_and_returns_to_root() {
        let mut fixture = fixture();
        let source = write_png(&fixture.source, "人物.png", [255, 0, 0, 255]);
        let sidecar = import_with(&mut fixture.catalog, &source, None, &[]);
        let reference = fixture
            .catalog
            .create_folder(None, &FolderName::parse("参考").expect("名称"))
            .expect("创建文件夹");
        let palette = fixture
            .catalog
            .create_folder(None, &FolderName::parse("配色").expect("名称"))
            .expect("创建文件夹");

        // 移入：唯一归属指向目标文件夹。
        fixture
            .catalog
            .move_asset_to_folder(&sidecar.hash, Some(&reference))
            .expect("移入文件夹");
        let stored = AssetSidecar::read(&fixture.catalog.library().sidecar_path(&sidecar.hash))
            .expect("读取侧车");
        assert_eq!(stored.folder.as_deref(), Some("参考"));

        // 再移动是替换而不是叠加：单归属下不允许同时挂在两个文件夹。
        fixture
            .catalog
            .move_asset_to_folder(&sidecar.hash, Some(&palette))
            .expect("移动到另一文件夹");
        let moved = AssetSidecar::read(&fixture.catalog.library().sidecar_path(&sidecar.hash))
            .expect("读取侧车");
        assert_eq!(moved.folder.as_deref(), Some("配色"));

        // 移回根：回到未分类。
        fixture
            .catalog
            .move_asset_to_folder(&sidecar.hash, None)
            .expect("移回未分类");
        let rooted = AssetSidecar::read(&fixture.catalog.library().sidecar_path(&sidecar.hash))
            .expect("读取侧车");
        assert_eq!(rooted.folder, None);
    }

    #[test]
    fn move_asset_to_folder_refuses_a_missing_folder_without_changing_sidecar() {
        let mut fixture = fixture();
        let source = write_png(&fixture.source, "人物.png", [255, 0, 0, 255]);
        let sidecar = import_with(
            &mut fixture.catalog,
            &source,
            Some("参考"),
            &[],
        );
        let before = std::fs::read(fixture.catalog.library().sidecar_path(&sidecar.hash))
            .expect("读取原始侧车");

        let error = fixture
            .catalog
            .move_asset_to_folder(
                &sidecar.hash,
                Some(&FolderPath::parse("不存在").expect("路径")),
            )
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
        let sidecar = import_with(&mut fixture.catalog, &source, None, &[]);
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
        let sidecar = import_with(&mut fixture.catalog, &source, None, &["人物"]);

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
    fn asset_note_and_favorite_write_without_touching_other_fields() {
        let mut fixture = fixture();
        let source = write_png(&fixture.source, "人物.png", [255, 0, 0, 255]);
        let sidecar = import_with(&mut fixture.catalog, &source, Some("参考"), &["人物"]);
        let path = fixture.catalog.library().sidecar_path(&sidecar.hash);
        let before = AssetSidecar::read(&path).expect("读取侧车");

        fixture
            .catalog
            .set_asset_note(&sidecar.hash, "第一行\n第二行  末尾空格 ")
            .expect("写入备注");
        let noted = AssetSidecar::read(&path).expect("读回侧车");
        // 备注是独立自动保存流：逐字保留换行与空格，不触碰组织、收藏与导入时间。
        assert_eq!(noted.note, "第一行\n第二行  末尾空格 ");
        assert_eq!(noted.folder, before.folder);
        assert_eq!(noted.tags, before.tags);
        assert!(!noted.favorite);
        assert_eq!(noted.imported_at, before.imported_at);

        fixture
            .catalog
            .set_asset_favorite(&sidecar.hash, true)
            .expect("设置收藏");
        let favored = AssetSidecar::read(&path).expect("读回侧车");
        assert!(favored.favorite);
        assert_eq!(favored.note, noted.note, "收藏写入不得改动备注");
        assert_eq!(favored.imported_at, before.imported_at);
    }

    #[test]
    fn asset_note_and_favorite_survive_an_index_rebuild() {
        let mut fixture = fixture();
        let source = write_png(&fixture.source, "人物.png", [255, 0, 0, 255]);
        let sidecar = import_with(&mut fixture.catalog, &source, None, &[]);
        fixture
            .catalog
            .set_asset_note(&sidecar.hash, "重建后仍在")
            .expect("写入备注");
        fixture
            .catalog
            .set_asset_favorite(&sidecar.hash, true)
            .expect("设置收藏");

        fixture.catalog.rebuild_index().expect("重建索引");

        let snapshot = fixture
            .catalog
            .snapshot(&AssetQuery {
                text: String::new(),
                tags: Vec::new(),
                folder: FolderFilter::All,
                favorite: None,
                location: AssetLocation::Active,
            })
            .expect("查询快照");
        assert_eq!(snapshot.assets.len(), 1);
        assert_eq!(snapshot.assets[0].note, "重建后仍在");
        assert!(snapshot.assets[0].favorite);
    }

    #[test]
    fn trashed_assets_refuse_note_and_favorite_writes_without_touching_bytes() {
        let mut fixture = fixture();
        let source = write_png(&fixture.source, "人物.png", [255, 0, 0, 255]);
        let sidecar = import_with(&mut fixture.catalog, &source, None, &[]);
        fixture.catalog.delete_asset(&sidecar.hash).expect("删除");
        let trash_path = fixture
            .catalog
            .library()
            .trash_sidecar_path(&sidecar.hash);
        let before = std::fs::read(&trash_path).expect("读取回收站侧车字节");

        let note_error = fixture
            .catalog
            .set_asset_note(&sidecar.hash, "不应写入")
            .expect_err("本应拒绝修改回收站素材");
        let favorite_error = fixture
            .catalog
            .set_asset_favorite(&sidecar.hash, true)
            .expect_err("本应拒绝收藏回收站素材");
        assert_eq!(
            note_error.code,
            Code::LibraryAssetMetadataWriteFailed
        );
        assert_eq!(
            favorite_error.code,
            Code::LibraryAssetMetadataWriteFailed
        );
        assert_eq!(
            std::fs::read(&trash_path).expect("读回回收站侧车字节"),
            before,
            "被拒绝的写入不得改动回收站侧车"
        );
    }

    #[test]
    fn a_failed_note_write_leaves_the_sidecar_untouched() {
        let mut fixture = fixture();
        let source = write_png(&fixture.source, "人物.png", [255, 0, 0, 255]);
        let sidecar = import_with(&mut fixture.catalog, &source, None, &[]);
        let path = fixture.catalog.library().sidecar_path(&sidecar.hash);
        let before = std::fs::read(&path).expect("读取侧车字节");
        // 用同名目录占住原子写入的临时文件路径，确定性注入写入失败。
        let tmp = path.with_extension("json.tmp");
        std::fs::create_dir(&tmp).expect("占用临时文件路径");

        let error = fixture
            .catalog
            .set_asset_note(&sidecar.hash, "不应落盘")
            .expect_err("本应写入失败");
        assert_eq!(error.code, Code::LibraryAssetMetadataWriteFailed);
        assert_eq!(
            std::fs::read(&path).expect("读回侧车字节"),
            before,
            "失败的写入不得改动权威文件"
        );
    }

    #[test]
    fn asset_query_filters_by_favorite() {
        let mut fixture = fixture();
        let favored_source = write_png(&fixture.source, "收藏.png", [255, 0, 0, 255]);
        let favored = import_with(&mut fixture.catalog, &favored_source, None, &[]);
        fixture
            .catalog
            .set_asset_favorite(&favored.hash, true)
            .expect("设置收藏");
        let plain_source = write_png(&fixture.source, "普通.png", [0, 255, 0, 255]);
        let plain = import_with(&mut fixture.catalog, &plain_source, None, &[]);

        let only_favorites = fixture
            .catalog
            .snapshot(&AssetQuery {
                text: String::new(),
                tags: Vec::new(),
                folder: FolderFilter::All,
                favorite: Some(true),
                location: AssetLocation::Active,
            })
            .expect("查询收藏");
        assert_eq!(only_favorites.assets.len(), 1);
        assert_eq!(only_favorites.assets[0].hash, favored.hash.as_str());

        let only_plain = fixture
            .catalog
            .snapshot(&AssetQuery {
                text: String::new(),
                tags: Vec::new(),
                folder: FolderFilter::All,
                favorite: Some(false),
                location: AssetLocation::Active,
            })
            .expect("查询未收藏");
        assert_eq!(only_plain.assets.len(), 1);
        assert_eq!(only_plain.assets[0].hash, plain.hash.as_str());

        // 回收站排除：收藏素材进回收站后，正常库的收藏查询不再含它。
        fixture.catalog.delete_asset(&favored.hash).expect("删除");
        let after_delete = fixture
            .catalog
            .snapshot(&AssetQuery {
                text: String::new(),
                tags: Vec::new(),
                folder: FolderFilter::All,
                favorite: Some(true),
                location: AssetLocation::Active,
            })
            .expect("查询收藏");
        assert!(after_delete.assets.is_empty());
    }

    #[test]
    fn regenerate_color_card_replaces_a_historical_failure_without_touching_other_metadata() {
        let mut fixture = fixture();
        let source = write_png(&fixture.source, "旧色卡.png", [40, 120, 180, 255]);
        let imported = import_with(&mut fixture.catalog, &source, None, &[]);
        let sidecar_path = fixture.catalog.library().sidecar_path(&imported.hash);
        let mut historical = AssetSidecar::read(&sidecar_path).expect("读取侧车");
        historical.note = "保留备注".to_owned();
        historical.color_card = crate::colorcard::ColorCard::failed(
            Code::ColorCardInsufficientOpaquePixels,
        );
        historical.write_atomic(&sidecar_path).expect("写入历史失败色卡");

        let regenerated = fixture
            .catalog
            .regenerate_color_card(&imported.hash)
            .expect("重新分析色卡");

        assert!(regenerated.is_ok(), "不透明原图应生成色卡：{regenerated:?}");
        let persisted = AssetSidecar::read(&sidecar_path).expect("读回侧车");
        assert!(persisted.color_card.is_ok());
        assert_eq!(persisted.note, "保留备注");
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
        let sidecar = import_with(&mut fixture.catalog, &source, Some(composition.as_str()), &[]);
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
                .folder
                .as_deref(),
            Some("灵感/构图")
        );
    }

    #[test]
    fn move_folder_reparents_the_whole_subtree_and_every_asset_membership() {
        let mut fixture = fixture();
        let reference = fixture
            .catalog
            .create_folder(None, &FolderName::parse("参考").expect("名称"))
            .expect("创建来源父文件夹");
        let composition = fixture
            .catalog
            .create_folder(Some(&reference), &FolderName::parse("构图").expect("名称"))
            .expect("创建待移动文件夹");
        fixture
            .catalog
            .create_folder(Some(&composition), &FolderName::parse("人物").expect("名称"))
            .expect("创建后代文件夹");
        let project = fixture
            .catalog
            .create_folder(None, &FolderName::parse("项目 A").expect("名称"))
            .expect("创建目标父文件夹");
        let source = write_png(&fixture.source, "三分法.png", [255, 0, 0, 255]);
        let sidecar = import_with(
            &mut fixture.catalog,
            &source,
            Some("参考/构图/人物"),
            &[],
        );

        let moved = fixture
            .catalog
            .move_folder(&composition, Some(&project), |_| Ok(()))
            .expect("移动文件夹子树");

        assert_eq!(moved.as_str(), "项目 A/构图");
        assert_eq!(
            fixture
                .catalog
                .library()
                .read_folders()
                .expect("读取清单")
                .folders,
            vec![
                "参考".to_owned(),
                "项目 A".to_owned(),
                "项目 A/构图".to_owned(),
                "项目 A/构图/人物".to_owned(),
            ]
        );
        assert_eq!(
            AssetSidecar::read(&fixture.catalog.library().sidecar_path(&sidecar.hash))
                .expect("读取侧车")
                .folder
                .as_deref(),
            Some("项目 A/构图/人物")
        );
    }

    #[test]
    fn move_folder_refuses_its_own_descendant_without_changing_authority() {
        let mut fixture = fixture();
        let reference = fixture
            .catalog
            .create_folder(None, &FolderName::parse("参考").expect("名称"))
            .expect("创建来源文件夹");
        let composition = fixture
            .catalog
            .create_folder(Some(&reference), &FolderName::parse("构图").expect("名称"))
            .expect("创建后代文件夹");
        let folders_before = std::fs::read(fixture.catalog.library().folders_path())
            .expect("读取原文件夹清单字节");

        let error = fixture
            .catalog
            .move_folder(&reference, Some(&composition), |_| Ok(()))
            .expect_err("本应拒绝移动到自身后代");

        assert_eq!(error.code, Code::LibraryFolderInvalid);
        assert_eq!(
            std::fs::read(fixture.catalog.library().folders_path()).expect("读回文件夹清单字节"),
            folders_before
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
        let first_sidecar = import_with(&mut fixture.catalog, &first, Some(reference.as_str()), &[]);
        let second_sidecar =
            import_with(&mut fixture.catalog, &second, Some(reference.as_str()), &[]);
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
        let sidecar = import_with(&mut fixture.catalog, &source, Some(composition.as_str()), &[]);
        let outside_source = write_png(&fixture.source, "配色.png", [0, 255, 255, 255]);
        let outside = import_with(
            &mut fixture.catalog,
            &outside_source,
            Some(palette.as_str()),
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
        // 单归属下被删子树就是唯一归属：素材回到未分类，本体不删。
        let orphaned = AssetSidecar::read(&fixture.catalog.library().sidecar_path(&sidecar.hash))
            .expect("读取侧车");
        assert_eq!(orphaned.folder, None);
        assert!(fixture
            .catalog
            .library()
            .body_path(&sidecar.hash, &sidecar.ext)
            .is_file());
        // 子树外的素材不受影响。
        let untouched = AssetSidecar::read(&fixture.catalog.library().sidecar_path(&outside.hash))
            .expect("读取侧车");
        assert_eq!(untouched.folder.as_deref(), Some("配色"));
    }

    #[test]
    fn delete_folder_rolls_back_when_a_sidecar_write_fails() {
        let mut fixture = fixture();
        let reference = fixture
            .catalog
            .create_folder(None, &FolderName::parse("参考").expect("名称"))
            .expect("创建文件夹");
        let source = write_png(&fixture.source, "人物.png", [255, 0, 0, 255]);
        let sidecar = import_with(&mut fixture.catalog, &source, Some(reference.as_str()), &[]);
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
            .map(|index| synthetic_sidecar(index, Some(folder.as_str()), &["人物"]))
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
