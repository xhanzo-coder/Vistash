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
use crate::error::{AppError, Code, Result};
use crate::prompt::{PromptAsset, PromptId, PROMPT_FORMAT_VERSION};
use chrono::Utc;

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
}
