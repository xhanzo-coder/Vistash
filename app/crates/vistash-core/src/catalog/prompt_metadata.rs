//! 提示词元数据：创建、显式保存与按需详情读取。
//!
//! 与 [`super::image_metadata`] 平行的提示词侧领域模块（设计第五条）。提示词的权威
//! 文件就是它的全部当前值：创建生成稳定 ID 并落盘，显式保存用完整编辑结果原子覆盖
//! 同一份文件（设计第二条），不存在历史版本集合。
//!
//! 编辑器保存的只有正文、标题、模型/平台与参数说明四个主字段；备注、收藏、文件夹
//! 与标签各有独立入口，不混进显式保存——它们的保存时机不同（自动保存 vs 显式保存），
//! 混在一个入口里会让"哪次按键触发哪份写入"变得无法回答。

use super::Catalog;
use super::{FolderName, FolderPath, Tag};
use crate::error::{AppError, Code, Result};
use crate::prompt::{PromptAsset, PromptFolderList, PromptId, PROMPT_FORMAT_VERSION};
use chrono::Utc;
use std::path::Path;

/// 创建一条提示词所需的输入。
///
/// 正文是唯一必填项；标题、模型与参数可以缺省（规格允许）。文件夹与标签在创建时
/// 即可归属，与图片导入时的组织方式对齐。
pub struct NewPrompt {
    pub body: String,
    pub title: Option<String>,
    pub model: Option<String>,
    pub parameters: Option<String>,
    pub folders: Vec<String>,
    pub tags: Vec<String>,
}

/// 显式保存允许覆盖的主字段。
///
/// 刻意不含 note/favorite/folders/tags：它们各有自己的入口与保存时机，见模块文档。
pub struct PromptEdit {
    pub body: String,
    pub title: Option<String>,
    pub model: Option<String>,
    pub parameters: Option<String>,
}

/// 捕获一次批量提示词权威写入前的原始字节，供任一写入失败时逆序回滚。
///
/// 与图片侧的 `MetadataTransaction` 分开而不是共用一个泛型实现，理由与
/// `prompt.rs` 中分开两个 `write_json_atomic` 相同：回滚失败的错误码不同
/// （`prompt.write_failed` 对 `library.asset_metadata_write_failed`），合并后
/// 错误码就得变成参数，"提示词写失败报什么码"会分散到每个调用点。
struct PromptMetadataTransaction {
    originals: Vec<(std::path::PathBuf, Vec<u8>)>,
}

impl PromptMetadataTransaction {
    fn capture(prompts: &[(std::path::PathBuf, PromptAsset)], folders_path: &Path) -> Result<Self> {
        let mut originals = Vec::with_capacity(prompts.len() + 1);
        for (path, _) in prompts {
            originals.push((
                path.clone(),
                std::fs::read(path)
                    .map_err(|error| prompt_metadata_error("读取原提示词文件失败", path, error))?,
            ));
        }
        originals.push((
            folders_path.to_path_buf(),
            std::fs::read(folders_path).map_err(|error| {
                prompt_metadata_error("读取原提示词文件夹清单失败", folders_path, error)
            })?,
        ));
        Ok(Self { originals })
    }

    fn rollback(&self) -> Result<()> {
        for (path, bytes) in self.originals.iter().rev() {
            super::write_raw_atomic(path, bytes, Code::PromptWriteFailed)?;
        }
        Ok(())
    }
}

fn prompt_metadata_error(what: &str, path: &Path, error: std::io::Error) -> AppError {
    AppError::detailed(
        Code::PromptWriteFailed,
        format!("{what} {}: {error}", path.display()),
    )
}

impl Catalog {
    /// 创建提示词：生成稳定 ID，写入权威文件并写入派生索引。
    pub fn create_prompt(&mut self, draft: &NewPrompt) -> Result<PromptAsset> {
        // 归属校验先于任何文件写入：未知文件夹必须在权威文件诞生之前被拒绝。
        let mut folders = draft.folders.clone();
        folders.sort();
        folders.dedup();
        let list = self.library.read_prompt_folders()?;
        for folder in &folders {
            if !list.folders.iter().any(|known| known == folder) {
                return Err(AppError::detailed(
                    Code::PromptFolderNotFound,
                    format!("提示词文件夹不存在：{folder}"),
                ));
            }
        }
        let mut tags = draft.tags.clone();
        tags.sort();
        tags.dedup();
        let now = Utc::now();
        let prompt = PromptAsset {
            format_version: PROMPT_FORMAT_VERSION,
            id: PromptId::generate(),
            body: draft.body.clone(),
            title: draft.title.clone(),
            model: draft.model.clone(),
            parameters: draft.parameters.clone(),
            note: String::new(),
            favorite: false,
            folders,
            tags,
            linked_image_hashes: Vec::new(),
            cover_image_hash: None,
            created_at: now,
            updated_at: now,
            deleted_at: None,
            deleted_from_folders: None,
        };
        // write_atomic 先校验正文再触碰文件系统，空白正文不会留下半个素材。
        prompt.write_atomic(&self.library.prompt_path(&prompt.id))?;
        if let Err(error) = self.index_mut()?.upsert_prompt(&prompt) {
            return self.rebuild_after_index_failure(error).map(|()| prompt);
        }
        Ok(prompt)
    }

    /// 按需读取一条提示词的完整权威记录。
    ///
    /// 列表与搜索只加载轻量行；完整正文、备注与关联只在检查器打开时经这里读取。
    pub fn prompt_detail(&self, id: &PromptId) -> Result<PromptAsset> {
        let path = self.library.prompt_path(id);
        if !path.exists() {
            return Err(AppError::detailed(
                Code::PromptNotFound,
                format!("正常库中不存在这条提示词：{id}"),
            ));
        }
        PromptAsset::read(&path)
    }

    /// 显式保存：用完整编辑结果原子覆盖当前值，身份与组织字段保持不变。
    ///
    /// 只改主字段；note/favorite/folders/tags 与关联由各自的入口维护。编辑就是
    /// 覆盖同一份文件（设计第二条），这里没有任何历史版本集合。
    pub fn update_prompt(&mut self, id: &PromptId, edit: &PromptEdit) -> Result<PromptAsset> {
        let path = self.library.prompt_path(id);
        if !path.exists() {
            return Err(AppError::detailed(
                Code::PromptNotFound,
                format!("正常库中不存在这条提示词：{id}"),
            ));
        }
        let mut prompt = PromptAsset::read(&path)?;
        prompt.body = edit.body.clone();
        prompt.title = edit.title.clone();
        prompt.model = edit.model.clone();
        prompt.parameters = edit.parameters.clone();
        prompt.updated_at = Utc::now();
        prompt.write_atomic(&path)?;
        if let Err(error) = self.index_mut()?.upsert_prompt(&prompt) {
            return self.rebuild_after_index_failure(error).map(|()| prompt);
        }
        Ok(prompt)
    }

    /// 在提示词文件夹树中创建文件夹。
    ///
    /// 与图片侧 `create_folder` 逻辑相同，但读写的是提示词文件夹清单——两棵树的
    /// 独立性正体现在这里没有共享任何一份清单文件。
    pub fn create_prompt_folder(
        &mut self,
        parent: Option<&FolderPath>,
        name: &FolderName,
    ) -> Result<FolderPath> {
        let mut list = self.library.read_prompt_folders()?;
        if let Some(parent) = parent {
            if !list.folders.iter().any(|path| path == parent.as_str()) {
                return Err(AppError::detailed(
                    Code::PromptFolderNotFound,
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
                Code::PromptFolderExists,
                format!("文件夹已经存在：{}", target.as_str()),
            ));
        }
        list.folders.push(target.as_str().to_owned());
        list.folders.sort();
        self.library.write_prompt_folders(&list)?;
        if let Err(error) = self.index_mut()?.set_prompt_folders(&list) {
            self.rebuild_after_index_failure(error)?;
        }
        Ok(target)
    }

    /// 设置一条提示词所属的提示词文件夹（多文件夹成员，空集表示根位置）。
    pub fn set_prompt_folders(&mut self, id: &PromptId, folders: &[FolderPath]) -> Result<()> {
        let list = self.library.read_prompt_folders()?;
        for folder in folders {
            if !list.folders.iter().any(|path| path == folder.as_str()) {
                return Err(AppError::detailed(
                    Code::PromptFolderNotFound,
                    format!("文件夹不存在：{}", folder.as_str()),
                ));
            }
        }
        let (path, mut prompt) = self.load_editable_prompt(id, "文件夹")?;
        let mut canonical: Vec<String> = folders
            .iter()
            .map(|folder| folder.as_str().to_owned())
            .collect();
        canonical.sort();
        canonical.dedup();
        prompt.folders = canonical;
        prompt.write_atomic(&path)?;
        if let Err(error) = self.index_mut()?.upsert_prompt(&prompt) {
            return self.rebuild_after_index_failure(error);
        }
        Ok(())
    }

    /// 重命名提示词文件夹子树，并同步改写受影响提示词的归属。
    pub fn rename_prompt_folder(
        &mut self,
        source: &FolderPath,
        new_name: &FolderName,
    ) -> Result<FolderPath> {
        let original_list = self.library.read_prompt_folders()?;
        if !original_list
            .folders
            .iter()
            .any(|path| path == source.as_str())
        {
            return Err(AppError::detailed(
                Code::PromptFolderNotFound,
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
                        Code::PromptFolderNotFound,
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
                    Code::PromptFolderExists,
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
        let next_list = PromptFolderList {
            format_version: original_list.format_version,
            folders: next_folders,
        };

        let mut changed_prompts = Vec::new();
        for row in self.index()?.list_prompts()? {
            let mut affected = false;
            for existing in &row.folders {
                let path = FolderPath::parse(existing)?;
                if path == *source || path.is_descendant_of(source) {
                    affected = true;
                    break;
                }
            }
            if !affected {
                continue;
            }
            let id = PromptId::parse(&row.id)?;
            let path = self.library.prompt_path(&id);
            let mut prompt = PromptAsset::read(&path)?;
            prompt.folders = prompt
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
            prompt.folders.sort();
            prompt.folders.dedup();
            changed_prompts.push((path, prompt));
        }
        self.commit_prompt_metadata(&changed_prompts, &next_list)?;
        Ok(target)
    }

    /// 删除提示词文件夹子树，并从受影响提示词上摘除这些归属。
    pub fn delete_prompt_folder(&mut self, source: &FolderPath) -> Result<()> {
        let original_list = self.library.read_prompt_folders()?;
        if !original_list
            .folders
            .iter()
            .any(|path| path == source.as_str())
        {
            return Err(AppError::detailed(
                Code::PromptFolderNotFound,
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
        let next_list = PromptFolderList {
            format_version: original_list.format_version,
            folders: remaining_folders,
        };

        let mut changed_prompts = Vec::new();
        for row in self.index()?.list_prompts()? {
            let mut affected = false;
            for existing in &row.folders {
                let path = FolderPath::parse(existing)?;
                if path == *source || path.is_descendant_of(source) {
                    affected = true;
                    break;
                }
            }
            if !affected {
                continue;
            }
            let id = PromptId::parse(&row.id)?;
            let path = self.library.prompt_path(&id);
            let mut prompt = PromptAsset::read(&path)?;
            let mut retained = Vec::new();
            for existing in &prompt.folders {
                let path = FolderPath::parse(existing)?;
                if path != *source && !path.is_descendant_of(source) {
                    retained.push(existing.clone());
                }
            }
            prompt.folders = retained;
            changed_prompts.push((path, prompt));
        }
        self.commit_prompt_metadata(&changed_prompts, &next_list)?;
        Ok(())
    }

    /// 读取一条可修改的提示词：必须存在于正常库，且不处于回收站状态。
    ///
    /// 返回权威文件路径与内容，供各组织写入入口共用同一套拒绝语义。
    fn load_editable_prompt(&self, id: &PromptId, what: &str) -> Result<(std::path::PathBuf, PromptAsset)> {
        let path = self.library.prompt_path(id);
        if !path.exists() {
            return Err(AppError::detailed(
                Code::PromptNotFound,
                format!("正常库中不存在这条提示词：{id}"),
            ));
        }
        let prompt = PromptAsset::read(&path)?;
        if prompt.is_deleted() {
            return Err(AppError::detailed(
                Code::PromptWriteFailed,
                format!("回收站提示词不能修改{what}：{id}"),
            ));
        }
        Ok((path, prompt))
    }

    /// 设置一条提示词的共享标签（幂等，词表与图片共用）。
    pub fn set_prompt_tags(&mut self, id: &PromptId, tags: &[Tag]) -> Result<()> {
        // 词法校验先于任何读取：非法标签在触碰库之前就被拒绝。
        let mut canonical: Vec<String> = tags.iter().map(|tag| tag.as_str().to_owned()).collect();
        canonical.sort();
        canonical.dedup();
        let (path, mut prompt) = self.load_editable_prompt(id, "标签")?;
        prompt.tags = canonical;
        prompt.write_atomic(&path)?;
        if let Err(error) = self.index_mut()?.upsert_prompt(&prompt) {
            return self.rebuild_after_index_failure(error);
        }
        Ok(())
    }

    /// 写入提示词备注（多行纯文本，逐字保留）。备注自动保存不改变 `updated_at`。
    pub fn set_prompt_note(&mut self, id: &PromptId, note: &str) -> Result<()> {
        let (path, mut prompt) = self.load_editable_prompt(id, "备注")?;
        prompt.note = note.to_owned();
        prompt.write_atomic(&path)?;
        if let Err(error) = self.index_mut()?.upsert_prompt(&prompt) {
            return self.rebuild_after_index_failure(error);
        }
        Ok(())
    }

    /// 设置提示词收藏。二值状态，没有星级或旗标等中间态。
    pub fn set_prompt_favorite(&mut self, id: &PromptId, favorite: bool) -> Result<()> {
        let (path, mut prompt) = self.load_editable_prompt(id, "收藏")?;
        prompt.favorite = favorite;
        prompt.write_atomic(&path)?;
        if let Err(error) = self.index_mut()?.upsert_prompt(&prompt) {
            return self.rebuild_after_index_failure(error);
        }
        Ok(())
    }
    fn commit_prompt_metadata(
        &mut self,
        prompts: &[(std::path::PathBuf, PromptAsset)],
        folders: &PromptFolderList,
    ) -> Result<()> {
        let transaction =
            PromptMetadataTransaction::capture(prompts, &self.library.prompt_folders_path())?;
        for (path, prompt) in prompts {
            if let Err(error) = self.before_metadata_write() {
                transaction.rollback()?;
                return Err(error);
            }
            if let Err(error) = prompt.write_atomic(path) {
                transaction.rollback()?;
                return Err(AppError::detailed(
                    Code::PromptWriteFailed,
                    format!("批量写入提示词失败：{error:?}"),
                ));
            }
        }
        if let Err(error) = self.before_metadata_write() {
            transaction.rollback()?;
            return Err(error);
        }
        if let Err(error) = self.library.write_prompt_folders(folders) {
            transaction.rollback()?;
            return Err(AppError::detailed(
                Code::PromptWriteFailed,
                format!("批量写入提示词文件夹清单失败：{error:?}"),
            ));
        }
        let updated: Vec<PromptAsset> = prompts.iter().map(|(_, prompt)| prompt.clone()).collect();
        if let Err(error) = self.index_mut()?.upsert_prompts(&updated) {
            return self.rebuild_after_index_failure(error);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::testing::fixture;

    fn draft(body: &str) -> NewPrompt {
        NewPrompt {
            body: body.to_owned(),
            title: None,
            model: None,
            parameters: None,
            folders: vec![],
            tags: vec![],
        }
    }

    #[test]
    fn creating_a_prompt_persists_the_authoritative_file_and_indexes_it() {
        let mut fixture = fixture();
        let created = fixture
            .catalog
            .create_prompt(&NewPrompt {
                body: "逆光人像，胶片颗粒，暖色高光".to_owned(),
                title: Some("逆光人像".to_owned()),
                model: Some("某生图模型 v3".to_owned()),
                parameters: Some("steps=30, cfg=6".to_owned()),
                folders: vec![],
                tags: vec!["人物".to_owned()],
            })
            .expect("创建提示词");

        // 身份是新生成的合法 UUIDv7，创建时刻与更新时刻一致。
        PromptId::parse(created.id.as_str()).expect("新生成的 ID 必须合法");
        assert_eq!(created.created_at, created.updated_at);
        assert_eq!(created.note, "");
        assert!(!created.favorite);
        assert!(created.linked_image_hashes.is_empty());

        // 权威文件落盘且与返回值逐字段一致。
        let path = fixture.catalog.library().prompt_path(&created.id);
        assert_eq!(PromptAsset::read(&path).expect("读回权威文件"), created);

        // 派生索引里出现同一条轻量行。
        let snapshot = fixture.catalog.index().expect("索引").snapshot().expect("快照");
        let row = snapshot
            .prompts
            .iter()
            .find(|row| row.id == created.id.as_str())
            .expect("索引中应有新提示词");
        assert_eq!(row.body, created.body);
        assert_eq!(row.title.as_deref(), Some("逆光人像"));
        assert_eq!(row.tags, vec!["人物".to_owned()]);
    }

    #[test]
    fn a_blank_body_refuses_creation_and_leaves_no_file_behind() {
        let mut fixture = fixture();
        let error = fixture
            .catalog
            .create_prompt(&draft("   \n\t "))
            .expect_err("空白正文必须被拒绝");
        assert_eq!(error.code, Code::PromptBodyEmpty);
        let objects = fixture.catalog.library().prompt_objects_dir();
        let leftovers: Vec<_> = std::fs::read_dir(&objects)
            .expect("读取提示词目录")
            .filter_map(|entry| entry.ok())
            .collect();
        assert!(leftovers.is_empty(), "拒绝后不得留下任何文件：{leftovers:?}");
    }

    #[test]
    fn a_prompt_created_without_a_title_stores_none_instead_of_a_derived_title() {
        // 派生标题（正文首行）是查询层的展示语义；权威文件与索引都必须保存"使用者
        // 没填过标题"这一事实，否则无法区分缺省与显式空。
        let mut fixture = fixture();
        let created = fixture
            .catalog
            .create_prompt(&draft("只有正文，没有标题"))
            .expect("创建无标题提示词");
        assert!(created.title.is_none());
        let back = fixture
            .catalog
            .prompt_detail(&created.id)
            .expect("读回详情");
        assert!(back.title.is_none());
        let snapshot = fixture.catalog.index().expect("索引").snapshot().expect("快照");
        let row = snapshot
            .prompts
            .iter()
            .find(|row| row.id == created.id.as_str())
            .expect("索引中应有新提示词");
        assert!(row.title.is_none());
    }

    #[test]
    fn updating_a_prompt_overwrites_the_current_value_without_creating_versions() {
        let mut fixture = fixture();
        let created = fixture.catalog.create_prompt(&draft("第一版正文")).expect("创建");

        let updated = fixture
            .catalog
            .update_prompt(
                &created.id,
                &PromptEdit {
                    body: "第二版正文".to_owned(),
                    title: Some("补上的标题".to_owned()),
                    model: None,
                    parameters: None,
                },
            )
            .expect("显式保存");

        // 同一身份被覆盖：编辑不是新建，也不产生第二个文件。
        assert_eq!(updated.id, created.id);
        assert_eq!(updated.body, "第二版正文");
        assert_eq!(updated.title.as_deref(), Some("补上的标题"));
        assert!(updated.updated_at >= updated.created_at);
        let objects = fixture.catalog.library().prompt_objects_dir();
        let files: Vec<_> = std::fs::read_dir(&objects)
            .expect("读取提示词目录")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(files.len(), 1, "编辑不得创建历史版本：{files:?}");
        // 权威文件与索引都呈现新当前值。
        assert_eq!(
            PromptAsset::read(&fixture.catalog.library().prompt_path(&created.id))
                .expect("读回权威文件"),
            updated
        );
        let snapshot = fixture.catalog.index().expect("索引").snapshot().expect("快照");
        let row = snapshot
            .prompts
            .iter()
            .find(|row| row.id == created.id.as_str())
            .expect("索引中应有这条提示词");
        assert_eq!(row.body, "第二版正文");
    }

    #[test]
    fn a_failed_save_leaves_the_authoritative_file_untouched() {
        let mut fixture = fixture();
        let created = fixture.catalog.create_prompt(&draft("保存前的正文")).expect("创建");

        // 用同名目录占住原子写入的临时文件路径，使提交必然失败。
        let path = fixture.catalog.library().prompt_path(&created.id);
        let tmp = path.with_extension("json.tmp");
        std::fs::create_dir(&tmp).expect("占用临时文件路径");

        let error = fixture
            .catalog
            .update_prompt(
                &created.id,
                &PromptEdit {
                    body: "不会写入的正文".to_owned(),
                    title: None,
                    model: None,
                    parameters: None,
                },
            )
            .expect_err("写入被阻断时本应失败");
        assert_eq!(error.code, Code::PromptWriteFailed);

        std::fs::remove_dir(&tmp).expect("清理占位目录");
        // 权威文件必须保持保存前的完整内容，草稿语义由前端负责。
        let back = PromptAsset::read(&path).expect("读回权威文件");
        assert_eq!(back.body, "保存前的正文");
        assert_eq!(back.updated_at, created.updated_at);
    }

    #[test]
    fn saving_or_reading_an_unknown_prompt_reports_not_found() {
        // "找不到"必须有独立错误码：它说明素材已被删除或 ID 有误，与瞬时 IO 失败
        // 的处置方式完全不同。
        let mut fixture = fixture();
        let missing = PromptId::parse("018f3c9e-6c00-7000-8000-00000000dead").expect("构造 ID");
        let error = fixture
            .catalog
            .prompt_detail(&missing)
            .expect_err("读取不存在的提示词本应报告缺失");
        assert_eq!(error.code, Code::PromptNotFound);
        let error = fixture
            .catalog
            .update_prompt(
                &missing,
                &PromptEdit {
                    body: "正文".to_owned(),
                    title: None,
                    model: None,
                    parameters: None,
                },
            )
            .expect_err("保存不存在的提示词本应报告缺失");
        assert_eq!(error.code, Code::PromptNotFound);
    }

    #[test]
    fn creation_refuses_folders_that_do_not_exist_in_the_prompt_folder_list() {
        // 与图片侧同一不变量：素材归属的文件夹必须已在清单中，否则文件夹树与
        // 素材归属会各自漂移。夹具的提示词文件夹清单为空，因此任何归属都应被拒。
        let mut fixture = fixture();
        let error = fixture
            .catalog
            .create_prompt(&NewPrompt {
                body: "正文".to_owned(),
                title: None,
                model: None,
                parameters: None,
                folders: vec!["人物/室内".to_owned()],
                tags: vec![],
            })
            .expect_err("未知提示词文件夹必须被拒绝");
        assert_eq!(error.code, Code::PromptFolderNotFound);
    }

    fn folder(raw: &str) -> FolderPath {
        FolderPath::parse(raw).expect("合法文件夹路径")
    }

    #[test]
    fn prompt_folders_form_a_tree_independent_of_image_folders() {
        let mut fixture = fixture();
        // 图片树先有同名根文件夹：提示词树必须允许同路径字面值各自存在。
        fixture
            .catalog
            .create_folder(None, &crate::catalog::FolderName::parse("人物").expect("文件夹名"))
            .expect("创建图片文件夹");
        let root = fixture
            .catalog
            .create_prompt_folder(None, &crate::catalog::FolderName::parse("人物").expect("文件夹名"))
            .expect("创建同名提示词根文件夹");
        fixture
            .catalog
            .create_prompt_folder(
                Some(&root),
                &crate::catalog::FolderName::parse("室内").expect("文件夹名"),
            )
            .expect("创建子文件夹");

        let prompt_list = fixture.catalog.library().read_prompt_folders().expect("读回提示词清单");
        assert_eq!(prompt_list.folders, vec!["人物".to_owned(), "人物/室内".to_owned()]);
        let image_list = fixture.catalog.library().read_folders().expect("读回图片清单");
        assert_eq!(
            image_list.folders,
            vec!["人物".to_owned()],
            "提示词文件夹不得写进图片清单"
        );
    }

    #[test]
    fn renaming_a_prompt_folder_remaps_descendants_and_member_prompts() {
        let mut fixture = fixture();
        let people = fixture
            .catalog
            .create_prompt_folder(None, &crate::catalog::FolderName::parse("人物").expect("文件夹名"))
            .expect("创建根文件夹");
        fixture
            .catalog
            .create_prompt_folder(Some(&people), &crate::catalog::FolderName::parse("室内").expect("文件夹名"))
            .expect("创建子文件夹");
        fixture
            .catalog
            .create_prompt_folder(None, &crate::catalog::FolderName::parse("构图").expect("文件夹名"))
            .expect("创建另一根文件夹");
        // 同名图片文件夹与其中一张图片：重命名提示词文件夹不得波及它们。
        fixture
            .catalog
            .create_folder(None, &crate::catalog::FolderName::parse("人物").expect("文件夹名"))
            .expect("创建同名图片文件夹");
        let source = fixture.source.join("样例.png");
        crate::catalog::testing::write_png(&fixture.source, "样例.png", [255, 0, 0, 255]);
        let image = crate::catalog::testing::import_with(
            &mut fixture.catalog,
            &source,
            &["人物"],
            &[],
        );
        let created = fixture
            .catalog
            .create_prompt(&NewPrompt {
                body: "正文".to_owned(),
                title: None,
                model: None,
                parameters: None,
                folders: vec!["人物/室内".to_owned(), "构图".to_owned()],
                tags: vec![],
            })
            .expect("创建多文件夹成员提示词");

        let renamed = fixture
            .catalog
            .rename_prompt_folder(&folder("人物"), &crate::catalog::FolderName::parse("人像").expect("文件夹名"))
            .expect("重命名提示词文件夹");

        assert_eq!(renamed.as_str(), "人像");
        let prompt_list = fixture.catalog.library().read_prompt_folders().expect("读回提示词清单");
        assert_eq!(
            prompt_list.folders,
            vec!["人像".to_owned(), "人像/室内".to_owned(), "构图".to_owned()]
        );
        let detail = fixture.catalog.prompt_detail(&created.id).expect("读回详情");
        assert_eq!(detail.folders, vec!["人像/室内".to_owned(), "构图".to_owned()]);
        let snapshot = fixture.catalog.index().expect("索引").snapshot().expect("快照");
        let row = snapshot
            .prompts
            .iter()
            .find(|row| row.id == created.id.as_str())
            .expect("索引中应有这条提示词");
        assert_eq!(row.folders, vec!["人像/室内".to_owned(), "构图".to_owned()]);
        // 图片侧逐字节未动：同名字面值属于两棵独立的树。
        let image_sidecar = crate::sidecar::AssetSidecar::read(
            &fixture.catalog.library().sidecar_path(&image.hash),
        )
        .expect("读回图片侧车");
        assert_eq!(image_sidecar.folders, vec!["人物".to_owned()]);
        let image_list = fixture.catalog.library().read_folders().expect("读回图片清单");
        assert_eq!(image_list.folders, vec!["人物".to_owned()]);
    }

    #[test]
    fn deleting_a_prompt_folder_strips_membership_but_keeps_other_folders() {
        let mut fixture = fixture();
        let people = fixture
            .catalog
            .create_prompt_folder(None, &crate::catalog::FolderName::parse("人物").expect("文件夹名"))
            .expect("创建根文件夹");
        fixture
            .catalog
            .create_prompt_folder(Some(&people), &crate::catalog::FolderName::parse("室内").expect("文件夹名"))
            .expect("创建子文件夹");
        fixture
            .catalog
            .create_prompt_folder(None, &crate::catalog::FolderName::parse("构图").expect("文件夹名"))
            .expect("创建另一根文件夹");
        let created = fixture
            .catalog
            .create_prompt(&NewPrompt {
                body: "正文".to_owned(),
                title: None,
                model: None,
                parameters: None,
                folders: vec!["人物/室内".to_owned(), "构图".to_owned()],
                tags: vec![],
            })
            .expect("创建提示词");

        fixture
            .catalog
            .delete_prompt_folder(&folder("人物"))
            .expect("删除提示词文件夹");

        let prompt_list = fixture.catalog.library().read_prompt_folders().expect("读回提示词清单");
        assert_eq!(prompt_list.folders, vec!["构图".to_owned()], "子目录一并移除");
        let detail = fixture.catalog.prompt_detail(&created.id).expect("读回详情");
        assert_eq!(detail.folders, vec!["构图".to_owned()], "其余归属保留");
        let snapshot = fixture.catalog.index().expect("索引").snapshot().expect("快照");
        let row = snapshot
            .prompts
            .iter()
            .find(|row| row.id == created.id.as_str())
            .expect("索引中应有这条提示词");
        assert_eq!(row.folders, vec!["构图".to_owned()]);
    }

    #[test]
    fn membership_updates_cover_multi_folder_and_root_locations() {
        let mut fixture = fixture();
        fixture
            .catalog
            .create_prompt_folder(None, &crate::catalog::FolderName::parse("人物").expect("文件夹名"))
            .expect("创建根文件夹");
        fixture
            .catalog
            .create_prompt_folder(None, &crate::catalog::FolderName::parse("构图").expect("文件夹名"))
            .expect("创建另一根文件夹");
        let created = fixture.catalog.create_prompt(&draft("正文")).expect("创建");

        // 多文件夹成员：归属是集合语义，重复与顺序由权威写入规范化。
        fixture
            .catalog
            .set_prompt_folders(&created.id, &[folder("构图"), folder("人物"), folder("构图")])
            .expect("设置多个文件夹");
        let detail = fixture.catalog.prompt_detail(&created.id).expect("读回详情");
        assert_eq!(detail.folders, vec!["人物".to_owned(), "构图".to_owned()]);

        // 清空归属即回到根位置：空集是合法状态而不是错误。
        fixture
            .catalog
            .set_prompt_folders(&created.id, &[])
            .expect("清空归属");
        let detail = fixture.catalog.prompt_detail(&created.id).expect("读回详情");
        assert!(detail.folders.is_empty(), "空归属即根位置");
    }

    #[test]
    fn an_interrupted_prompt_folder_rename_rolls_back_every_byte() {
        let mut fixture = fixture();
        let people = fixture
            .catalog
            .create_prompt_folder(None, &crate::catalog::FolderName::parse("人物").expect("文件夹名"))
            .expect("创建根文件夹");
        fixture
            .catalog
            .create_prompt_folder(Some(&people), &crate::catalog::FolderName::parse("室内").expect("文件夹名"))
            .expect("创建子文件夹");
        let first = fixture
            .catalog
            .create_prompt(&NewPrompt {
                body: "第一条".to_owned(),
                title: None,
                model: None,
                parameters: None,
                folders: vec!["人物/室内".to_owned()],
                tags: vec![],
            })
            .expect("创建第一条");
        let second = fixture
            .catalog
            .create_prompt(&NewPrompt {
                body: "第二条".to_owned(),
                title: None,
                model: None,
                parameters: None,
                folders: vec!["人物/室内".to_owned()],
                tags: vec![],
            })
            .expect("创建第二条");
        let paths = [
            fixture.catalog.library().prompt_path(&first.id),
            fixture.catalog.library().prompt_path(&second.id),
            fixture.catalog.library().prompt_folders_path(),
        ];
        let before: Vec<(std::path::PathBuf, Vec<u8>)> = paths
            .iter()
            .map(|path| (path.clone(), std::fs::read(path).expect("读取原始字节")))
            .collect();

        // 注入第 1 次（第二条提示词）写入失败：第一条已改写、清单未写，
        // 回滚必须把全部字节恢复原状。
        fixture.catalog.inject_metadata_failure_at(1);
        let error = fixture
            .catalog
            .rename_prompt_folder(&folder("人物"), &crate::catalog::FolderName::parse("人像").expect("文件夹名"))
            .expect_err("注入失败后本应失败");
        assert_eq!(error.code, Code::LibraryAssetMetadataWriteFailed);

        for (path, original) in &before {
            let current = std::fs::read(path).expect("读取回滚后字节");
            assert_eq!(&current, original, "回滚后字节不一致：{}", path.display());
        }
    }

    #[test]
    fn duplicate_or_missing_prompt_folders_are_refused() {
        let mut fixture = fixture();
        fixture
            .catalog
            .create_prompt_folder(None, &crate::catalog::FolderName::parse("人物").expect("文件夹名"))
            .expect("创建根文件夹");
        let error = fixture
            .catalog
            .create_prompt_folder(None, &crate::catalog::FolderName::parse("人物").expect("文件夹名"))
            .expect_err("重复创建本应被拒");
        assert_eq!(error.code, Code::PromptFolderExists);
        let error = fixture
            .catalog
            .create_prompt_folder(
                Some(&folder("不存在")),
                &crate::catalog::FolderName::parse("室内").expect("文件夹名"),
            )
            .expect_err("父文件夹缺失本应被拒");
        assert_eq!(error.code, Code::PromptFolderNotFound);
        let error = fixture
            .catalog
            .rename_prompt_folder(&folder("不存在"), &crate::catalog::FolderName::parse("改名").expect("文件夹名"))
            .expect_err("重命名不存在的文件夹本应被拒");
        assert_eq!(error.code, Code::PromptFolderNotFound);
        fixture
            .catalog
            .create_prompt_folder(None, &crate::catalog::FolderName::parse("构图").expect("文件夹名"))
            .expect("创建另一根文件夹");
        let error = fixture
            .catalog
            .rename_prompt_folder(&folder("人物"), &crate::catalog::FolderName::parse("构图").expect("文件夹名"))
            .expect_err("重命名到已存在的同级路径本应被拒");
        assert_eq!(error.code, Code::PromptFolderExists);
        let error = fixture
            .catalog
            .delete_prompt_folder(&folder("不存在"))
            .expect_err("删除不存在的文件夹本应被拒");
        assert_eq!(error.code, Code::PromptFolderNotFound);

        let created = fixture.catalog.create_prompt(&draft("正文")).expect("创建");
        let error = fixture
            .catalog
            .set_prompt_folders(&created.id, &[folder("不存在")])
            .expect_err("归属未知文件夹本应被拒");
        assert_eq!(error.code, Code::PromptFolderNotFound);
        let missing = crate::prompt::PromptId::parse("018f3c9e-6c00-7000-8000-00000000dead")
            .expect("构造 ID");
        let error = fixture
            .catalog
            .set_prompt_folders(&missing, &[])
            .expect_err("给不存在的提示词设置归属本应报告缺失");
        assert_eq!(error.code, Code::PromptNotFound);
    }

    #[test]
    fn prompt_tags_share_the_vocabulary_but_keep_separate_counts() {
        let mut fixture = fixture();
        let source = fixture.source.join("样例.png");
        crate::catalog::testing::write_png(&fixture.source, "样例.png", [255, 0, 0, 255]);
        crate::catalog::testing::import_with(&mut fixture.catalog, &source, &[], &["人物"]);
        let created = fixture.catalog.create_prompt(&draft("正文")).expect("创建");

        fixture
            .catalog
            .set_prompt_tags(&created.id, &[tag("人物"), tag("仅提示词")])
            .expect("设置提示词标签");

        // 词面共用：同一个"人物"在两侧都能解析与使用。
        let prompt_counts = fixture
            .catalog
            .index()
            .expect("索引")
            .active_prompt_tag_counts()
            .expect("提示词标签计数");
        assert_eq!(
            prompt_counts,
            vec![("人物".to_owned(), 1), ("仅提示词".to_owned(), 1)]
        );
        let image_counts = fixture
            .catalog
            .index()
            .expect("索引")
            .active_tag_counts()
            .expect("图片标签计数");
        assert_eq!(
            image_counts,
            vec![("人物".to_owned(), 1)],
            "提示词标签不得计入图片分库计数"
        );
    }

    fn tag(raw: &str) -> super::Tag {
        Tag::parse(raw).expect("合法标签")
    }

    #[test]
    fn setting_prompt_tags_is_idempotent_and_canonical() {
        let mut fixture = fixture();
        fixture
            .catalog
            .create_prompt_folder(None, &crate::catalog::FolderName::parse("构图").expect("文件夹名"))
            .expect("创建文件夹");
        let created = fixture.catalog.create_prompt(&draft("正文")).expect("创建");
        let path = fixture.catalog.library().prompt_path(&created.id);

        fixture
            .catalog
            .set_prompt_tags(&created.id, &[tag("构图"), tag("人物"), tag("构图")])
            .expect("设置标签");
        let detail = fixture.catalog.prompt_detail(&created.id).expect("读回详情");
        // 码点序：人 < 构。重复项被吸收。
        assert!(detail.folders.is_empty());
        assert_eq!(detail.tags, vec!["人物".to_owned(), "构图".to_owned()]);
        let after_first = std::fs::read(&path).expect("读取权威文件");

        // 幂等：重复设置同一集合不产生任何字节变化。
        fixture
            .catalog
            .set_prompt_tags(&created.id, &[tag("人物"), tag("构图")])
            .expect("重复设置标签");
        let after_second = std::fs::read(&path).expect("读取权威文件");
        assert_eq!(after_second, after_first, "幂等设置不得改写权威文件");
    }

    #[test]
    fn note_autosave_writes_verbatim_without_touching_other_fields() {
        let mut fixture = fixture();
        let created = fixture
            .catalog
            .create_prompt(&NewPrompt {
                body: "正文".to_owned(),
                title: Some("标题".to_owned()),
                model: None,
                parameters: None,
                folders: vec![],
                tags: vec!["人物".to_owned()],
            })
            .expect("创建");

        fixture
            .catalog
            .set_prompt_note(&created.id, "第一行\n\n第三行  尾随空格  ")
            .expect("写入备注");

        let detail = fixture.catalog.prompt_detail(&created.id).expect("读回详情");
        assert_eq!(detail.note, "第一行\n\n第三行  尾随空格  ", "换行与空格逐字保留");
        // 备注是独立的自动保存流：不得改动主字段，也不得推进 updated_at——
        // 否则边打字边自动保存会让"更新时间"失去含义。
        assert_eq!(detail.title.as_deref(), Some("标题"));
        assert_eq!(detail.body, "正文");
        assert_eq!(detail.tags, vec!["人物".to_owned()]);
        assert_eq!(detail.updated_at, created.updated_at);
        let snapshot = fixture.catalog.index().expect("索引").snapshot().expect("快照");
        let row = snapshot
            .prompts
            .iter()
            .find(|row| row.id == created.id.as_str())
            .expect("索引中应有这条提示词");
        assert_eq!(row.note, "第一行\n\n第三行  尾随空格  ");
    }

    #[test]
    fn favorite_is_a_binary_state_that_persists() {
        let mut fixture = fixture();
        let created = fixture.catalog.create_prompt(&draft("正文")).expect("创建");

        fixture
            .catalog
            .set_prompt_favorite(&created.id, true)
            .expect("收藏");
        let detail = fixture.catalog.prompt_detail(&created.id).expect("读回详情");
        assert!(detail.favorite);
        let snapshot = fixture.catalog.index().expect("索引").snapshot().expect("快照");
        let row = snapshot
            .prompts
            .iter()
            .find(|row| row.id == created.id.as_str())
            .expect("索引中应有这条提示词");
        assert!(row.favorite);

        fixture
            .catalog
            .set_prompt_favorite(&created.id, false)
            .expect("取消收藏");
        let detail = fixture.catalog.prompt_detail(&created.id).expect("读回详情");
        assert!(!detail.favorite);
    }

    #[test]
    fn prompt_field_writes_refuse_missing_or_trashed_targets() {
        let mut fixture = fixture();
        let missing = crate::prompt::PromptId::parse("018f3c9e-6c00-7000-8000-00000000dead")
            .expect("构造 ID");
        for (what, error) in [
            (
                "标签",
                fixture.catalog.set_prompt_tags(&missing, &[tag("人物")]).expect_err("缺失目标应被拒"),
            ),
            ("备注", fixture.catalog.set_prompt_note(&missing, "n").expect_err("缺失目标应被拒")),
            (
                "收藏",
                fixture
                    .catalog
                    .set_prompt_favorite(&missing, true)
                    .expect_err("缺失目标应被拒"),
            ),
        ] {
            assert_eq!(error.code, Code::PromptNotFound, "{what} 写入的缺失语义错误");
        }

        // 回收站中的提示词（deleted_at 已置）即使文件仍在正常目录位置，
        // 也必须拒绝组织写入，而不是以正常素材身份被改写。
        let created = fixture.catalog.create_prompt(&draft("正文")).expect("创建");
        let path = fixture.catalog.library().prompt_path(&created.id);
        let mut trashed = fixture.catalog.prompt_detail(&created.id).expect("读回详情");
        trashed.deleted_at = Some(chrono::Utc::now());
        trashed.write_atomic(&path).expect("构造回收站状态");
        let error = fixture
            .catalog
            .set_prompt_favorite(&created.id, true)
            .expect_err("回收站提示词本应拒绝组织写入");
        assert_eq!(error.code, Code::PromptWriteFailed);
    }
}
