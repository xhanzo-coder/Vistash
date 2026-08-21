//! 提示词的库内回收站生命周期：删除、还原与永久删除。
//!
//! 与 [`super::prompt_metadata`] 的关键差别同图片侧一样：组织变更回滚的是文件内容，
//! 生命周期变更移动的是权威文件本身，回滚必须把文件搬回原位置。与图片侧
//! [`super::lifecycle`] 也分开成两个模块：提示词只有一份 JSON 权威文件，没有
//! "本体 + 侧车"对，阶段与回滚结构都更少；混进同一个文件只会让两边都背着
//! 对方用不到的分支。
//!
//! 错误码沿用分域规则：提示词回收站的失败报 `prompt.trash_*` 而不是图片侧的
//! `trash.*`。两棵树的同名路径可以各自存在，失败也必须能归因到各自那一侧。
//!
//! 每个阶段之间留有 [`PromptLifecycleStage`] 观察点，使"在第 n 步失败"成为
//! 可注入的输入，与图片侧的理由相同：不这样做，"移动成功但删除原件失败"这类
//! 分支就只能靠制造真实的文件系统故障来覆盖。

use super::write_raw_atomic;
use crate::error::{AppError, Code, Result};
use crate::index::{FolderSelection, PromptRow};
use crate::prompt::{PromptAsset, PromptId};
use serde::Serialize;
use std::path::Path;

use super::Catalog;

/// 提示词生命周期的阶段观察点。语义与图片侧的 `LifecycleStage` 相同，阶段本身
/// 更少：提示词没有本体文件，一次移动就是全部。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PromptLifecycleStage {
    /// 回收站里的权威文件已写入。
    TrashPromptWritten,
    /// 正常库里的原文件已删除。
    OriginalPromptRemoved,
    /// 还原：正常库里的权威文件已写入。
    NormalPromptWritten,
    /// 还原：回收站里的文件已删除。
    TrashPromptRemoved,
}

/// 还原完成后需要向使用者说明的缺失提示词文件夹。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PromptRestoreOutcome {
    pub missing_folders: Vec<String>,
}

/// 逐项清理提示词回收站时的单项失败。与图片侧的 `PurgeFailure` 分开：
/// 提示词以 ID 与可选标题标识，没有哈希与原始文件名可报。
#[derive(Debug, Clone, Serialize)]
pub struct PromptPurgeFailure {
    pub id: String,
    pub title: Option<String>,
    pub error: AppError,
}

#[derive(Debug, Clone, Serialize)]
pub struct PromptPurgeReport {
    pub purged: usize,
    pub failures: Vec<PromptPurgeFailure>,
}

impl Catalog {
    /// 把一条正常库中的提示词移入库内提示词回收站。
    ///
    /// 只移动归属，不改写任何使用者数据：正文、标题、标签、收藏、备注与关联全部
    /// 原样保留，只有文件夹移入 `deleted_from_folders`——与图片侧一致，回收站里
    /// 的素材脱离组织树，但必须仍能按标签和文本被找到。
    pub fn delete_prompt(&mut self, id: &PromptId) -> Result<()> {
        let path = self.library.prompt_path(id);
        let trash_path = self.library.prompt_trash_path(id);
        if !path.exists() {
            // 先区分"已在回收站"与"哪里都找不到"：前者是状态问题（去回收站找），
            // 后者才意味着 ID 有误或列表过期。
            if trash_path.exists() {
                return Err(AppError::detailed(
                    Code::PromptTrashDeleteFailed,
                    format!("提示词已经在回收站：{id}"),
                ));
            }
            return Err(AppError::detailed(
                Code::PromptNotFound,
                format!("正常库中不存在该提示词：{id}"),
            ));
        }
        let original_bytes = std::fs::read(&path).map_err(|error| {
            prompt_lifecycle_io(
                Code::PromptTrashDeleteFailed,
                "读取原提示词文件失败",
                &path,
                error,
            )
        })?;
        let mut prompt = PromptAsset::read(&path)?;
        if prompt.is_deleted() {
            return Err(AppError::detailed(
                Code::PromptTrashDeleteFailed,
                format!("提示词已经在回收站：{id}"),
            ));
        }
        let previous_folders = std::mem::take(&mut prompt.folders);
        prompt.deleted_from_folders = Some(previous_folders);
        prompt.deleted_at = Some(chrono::Utc::now());

        let mut trash_written = false;
        let mut original_removed = false;
        let operation = (|| -> Result<()> {
            // write_atomic 自建父目录并先校验后落盘：回收站目录不存在不是前置步骤。
            prompt.write_atomic(&trash_path).map_err(|error| {
                AppError::detailed(
                    Code::PromptTrashDeleteFailed,
                    format!("写入回收站提示词失败：{error:?}"),
                )
            })?;
            trash_written = true;
            self.after_prompt_lifecycle_stage(PromptLifecycleStage::TrashPromptWritten)?;

            std::fs::remove_file(&path).map_err(|error| {
                prompt_lifecycle_io(
                    Code::PromptTrashDeleteFailed,
                    "删除正常提示词文件失败",
                    &path,
                    error,
                )
            })?;
            original_removed = true;
            self.after_prompt_lifecycle_stage(PromptLifecycleStage::OriginalPromptRemoved)
        })();
        if let Err(error) = operation {
            rollback_delete_prompt(DeletePromptRollback {
                path: &path,
                trash_path: &trash_path,
                original_bytes: &original_bytes,
                trash_written,
                original_removed,
            })?;
            return Err(error);
        }
        if let Err(error) = self.index_mut()?.upsert_prompt(&prompt) {
            return self.rebuild_after_index_failure(error);
        }
        Ok(())
    }

    /// 把一条回收站提示词还原回正常库，回到仍然存在的原提示词文件夹。
    ///
    /// 已被删除的原文件夹不重建（与图片侧一致）：还原是恢复素材，不是恢复组织
    /// 历史；缺失的文件夹经 [`PromptRestoreOutcome`] 向使用者说明。全部缺失时
    /// 回到根位置，而不是让还原失败。
    pub fn restore_prompt(&mut self, id: &PromptId) -> Result<PromptRestoreOutcome> {
        let path = self.library.prompt_path(id);
        let trash_path = self.library.prompt_trash_path(id);
        if !trash_path.exists() {
            return Err(AppError::detailed(
                Code::PromptTrashRestoreFailed,
                format!("回收站中没有该提示词：{id}"),
            ));
        }
        let trash_bytes = std::fs::read(&trash_path).map_err(|error| {
            prompt_lifecycle_io(
                Code::PromptTrashRestoreFailed,
                "读取回收站提示词文件失败",
                &trash_path,
                error,
            )
        })?;
        let mut prompt = PromptAsset::read(&trash_path)?;
        if !prompt.is_deleted() {
            return Err(AppError::detailed(
                Code::PromptTrashRestoreFailed,
                format!("回收站文件没有删除状态：{id}"),
            ));
        }
        let Some(previous_folders) = prompt.deleted_from_folders.clone() else {
            return Err(AppError::detailed(
                Code::PromptTrashRestoreFailed,
                format!("回收站提示词缺少删除前文件夹：{id}"),
            ));
        };
        let folder_list = self.library.read_prompt_folders()?;
        let mut restored_folders = Vec::new();
        let mut missing_folders = Vec::new();
        for folder in previous_folders {
            if folder_list.folders.iter().any(|existing| existing == &folder) {
                restored_folders.push(folder);
            } else {
                missing_folders.push(folder);
            }
        }
        restored_folders.sort();
        missing_folders.sort();
        prompt.folders = restored_folders;
        prompt.deleted_at = None;
        prompt.deleted_from_folders = None;

        let mut normal_written = false;
        let mut trash_removed = false;
        let operation = (|| -> Result<()> {
            prompt.write_atomic(&path).map_err(|error| {
                AppError::detailed(
                    Code::PromptTrashRestoreFailed,
                    format!("写入正常提示词文件失败：{error:?}"),
                )
            })?;
            normal_written = true;
            self.after_prompt_lifecycle_stage(PromptLifecycleStage::NormalPromptWritten)?;

            std::fs::remove_file(&trash_path).map_err(|error| {
                prompt_lifecycle_io(
                    Code::PromptTrashRestoreFailed,
                    "删除回收站提示词文件失败",
                    &trash_path,
                    error,
                )
            })?;
            trash_removed = true;
            self.after_prompt_lifecycle_stage(PromptLifecycleStage::TrashPromptRemoved)
        })();
        if let Err(error) = operation {
            rollback_restore_prompt(RestorePromptRollback {
                path: &path,
                trash_path: &trash_path,
                trash_bytes: &trash_bytes,
                normal_written,
                trash_removed,
            })?;
            return Err(error);
        }
        if let Err(error) = self.index_mut()?.upsert_prompt(&prompt) {
            return self
                .rebuild_after_index_failure(error)
                .map(|()| PromptRestoreOutcome {
                    missing_folders: missing_folders.clone(),
                });
        }
        Ok(PromptRestoreOutcome { missing_folders })
    }

    fn after_prompt_lifecycle_stage(&self, _stage: PromptLifecycleStage) -> Result<()> {
        #[cfg(test)]
        if self.fail_prompt_lifecycle_stage == Some(_stage) {
            let code = match _stage {
                PromptLifecycleStage::NormalPromptWritten
                | PromptLifecycleStage::TrashPromptRemoved => Code::PromptTrashRestoreFailed,
                PromptLifecycleStage::TrashPromptWritten
                | PromptLifecycleStage::OriginalPromptRemoved => Code::PromptTrashDeleteFailed,
            };
            return Err(AppError::detailed(
                code,
                format!("注入提示词生命周期阶段失败：{_stage:?}"),
            ));
        }
        Ok(())
    }

    #[cfg(test)]
    fn inject_prompt_lifecycle_failure(&mut self, stage: PromptLifecycleStage) {
        self.fail_prompt_lifecycle_stage = Some(stage);
    }

    /// 逐项清空提示词回收站：永久删除每一条回收站提示词的权威文件，
    /// 派生关联随索引重建一并清除。
    ///
    /// 逐项失败隔离与图片侧一致：一条失败不阻止其余条目，失败项连同 ID、标题
    /// 与稳定错误码进入报告。只修改提示词文件——图片本体、侧车与缩略图不在
    /// 这条路径上，普通关联是派生行，由末尾的索引重建从"文件已不存在"推导清除。
    pub fn purge_prompt_trash(&mut self) -> Result<PromptPurgeReport> {
        let trashed: Vec<PromptRow> = self
            .index()?
            .query_prompts(true, FolderSelection::All, &[], None, "")?;
        let mut report = PromptPurgeReport {
            purged: 0,
            failures: Vec::new(),
        };
        for row in &trashed {
            match self.purge_one_prompt(row) {
                Ok(()) => report.purged += 1,
                Err(error) => report.failures.push(PromptPurgeFailure {
                    id: row.id.clone(),
                    title: row.title.clone(),
                    error,
                }),
            }
        }
        self.rebuild_index()?;
        Ok(report)
    }

    fn purge_one_prompt(&self, row: &PromptRow) -> Result<()> {
        #[cfg(test)]
        if self.fail_prompt_purge_id.as_deref() == Some(row.id.as_str()) {
            return Err(AppError::detailed(
                Code::PromptTrashPurgeFailed,
                format!("注入提示词 purge 失败：{}", row.id),
            ));
        }
        let id = PromptId::parse(&row.id)?;
        let trash_path = self.library.prompt_trash_path(&id);
        let staged = trash_path.with_extension("json.purge");
        if staged.exists() {
            return Err(AppError::detailed(
                Code::PromptTrashPurgeFailed,
                format!("存在上次未处理的 purge 临时文件：{id}"),
            ));
        }
        // 两阶段删除与图片侧同构：先改名成 .purge 标记意图，再真正删除。进程在
        // 两步之间中断时，残留的 .purge 文件让下次运行拒绝而不是静默半删。
        std::fs::rename(&trash_path, &staged).map_err(|error| {
            prompt_lifecycle_io(
                Code::PromptTrashPurgeFailed,
                "暂存 purge 提示词失败",
                &trash_path,
                error,
            )
        })?;
        if let Err(error) = std::fs::remove_file(&staged) {
            std::fs::rename(&staged, &trash_path).map_err(|rollback_error| {
                prompt_lifecycle_io(
                    Code::PromptTrashPurgeFailed,
                    "purge 删除失败后恢复提示词失败",
                    &staged,
                    rollback_error,
                )
            })?;
            return Err(prompt_lifecycle_io(
                Code::PromptTrashPurgeFailed,
                "删除 purge 提示词失败",
                &staged,
                error,
            ));
        }
        Ok(())
    }

    #[cfg(test)]
    fn inject_prompt_purge_failure(&mut self, id: &str) {
        self.fail_prompt_purge_id = Some(id.to_owned());
    }
}

struct DeletePromptRollback<'a> {
    path: &'a Path,
    trash_path: &'a Path,
    original_bytes: &'a [u8],
    trash_written: bool,
    original_removed: bool,
}

struct RestorePromptRollback<'a> {
    path: &'a Path,
    trash_path: &'a Path,
    trash_bytes: &'a [u8],
    normal_written: bool,
    trash_removed: bool,
}

fn rollback_delete_prompt(state: DeletePromptRollback<'_>) -> Result<()> {
    if state.original_removed {
        write_raw_atomic(
            state.path,
            state.original_bytes,
            Code::PromptTrashDeleteFailed,
        )?;
    }
    if state.trash_written && state.trash_path.exists() {
        std::fs::remove_file(state.trash_path).map_err(|error| {
            prompt_lifecycle_io(
                Code::PromptTrashDeleteFailed,
                "回滚时删除回收站提示词失败",
                state.trash_path,
                error,
            )
        })?;
    }
    Ok(())
}

fn rollback_restore_prompt(state: RestorePromptRollback<'_>) -> Result<()> {
    if state.trash_removed {
        write_raw_atomic(
            state.trash_path,
            state.trash_bytes,
            Code::PromptTrashRestoreFailed,
        )?;
    }
    if state.normal_written && state.path.exists() {
        std::fs::remove_file(state.path).map_err(|error| {
            prompt_lifecycle_io(
                Code::PromptTrashRestoreFailed,
                "回滚时删除已还原的提示词失败",
                state.path,
                error,
            )
        })?;
    }
    Ok(())
}

fn prompt_lifecycle_io(code: Code, what: &str, path: &Path, error: std::io::Error) -> AppError {
    AppError::detailed(code, format!("{what} {}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::image_metadata::FolderName;
    use crate::catalog::query::{FolderFilter, PromptLocation, PromptQuery};
    use crate::catalog::testing::{fixture, import_with, write_png};
    use crate::catalog::NewPrompt;
    use crate::hashing::ContentHash;
    use crate::prompt::PROMPT_FORMAT_VERSION;

    fn name(raw: &str) -> FolderName {
        FolderName::parse(raw).expect("合法文件夹名")
    }

    /// 经生产入口创建一条带组织信息与收藏状态的提示词。
    fn crafted(catalog: &mut Catalog, body: &str, folders: &[&str], tags: &[&str]) -> PromptAsset {
        let prompt = catalog
            .create_prompt(&NewPrompt {
                body: body.to_owned(),
                title: Some("样例标题".to_owned()),
                model: None,
                parameters: None,
                folders: folders.iter().map(|f| (*f).to_owned()).collect(),
                tags: tags.iter().map(|t| (*t).to_owned()).collect(),
            })
            .expect("创建提示词");
        catalog
            .set_prompt_favorite(&prompt.id, true)
            .expect("设置收藏");
        PromptAsset::read(&catalog.library().prompt_path(&prompt.id)).expect("读回权威文件")
    }

    fn query(location: PromptLocation) -> PromptQuery {
        PromptQuery {
            text: String::new(),
            tags: Vec::new(),
            folder: FolderFilter::All,
            favorite: None,
            location,
        }
    }

    #[test]
    fn deleting_a_prompt_moves_the_authoritative_file_into_the_prompt_trash() {
        let mut fixture = fixture();
        fixture
            .catalog
            .create_prompt_folder(None, &name("人物"))
            .expect("创建提示词文件夹");
        let prompt = crafted(&mut fixture.catalog, "逆光人像，胶片颗粒", &["人物"], &["逆光"]);

        fixture
            .catalog
            .delete_prompt(&prompt.id)
            .expect("删除提示词");

        assert!(!fixture.catalog.library().prompt_path(&prompt.id).exists());
        let trash_path = fixture.catalog.library().prompt_trash_path(&prompt.id);
        assert!(trash_path.is_file());
        let deleted = PromptAsset::read(&trash_path).expect("读取回收站提示词");
        assert!(deleted.is_deleted());
        assert!(deleted.folders.is_empty());
        assert_eq!(
            deleted.deleted_from_folders,
            Some(vec!["人物".to_owned()])
        );
        // 删除只移动归属：正文、标题、标签与收藏都是使用者的数据，回收站里必须原样可查。
        assert_eq!(deleted.body, "逆光人像，胶片颗粒");
        assert_eq!(deleted.tags, vec!["逆光".to_owned()]);
        assert!(deleted.favorite);
        let active = fixture
            .catalog
            .prompt_snapshot(&query(PromptLocation::Active))
            .expect("查询正常库");
        assert!(active.prompts.is_empty());
        let trash = fixture
            .catalog
            .prompt_snapshot(&query(PromptLocation::Trash))
            .expect("查询回收站");
        assert_eq!(trash.trash_count, 1);
        assert_eq!(trash.prompts[0].id, prompt.id.as_str());
    }

    #[test]
    fn deleting_an_unknown_or_already_deleted_prompt_is_refused() {
        let mut fixture = fixture();
        let unknown = PromptId::parse("018f3c9e-6c00-7000-8000-00000000dead").expect("合法 ID");
        let err = fixture
            .catalog
            .delete_prompt(&unknown)
            .expect_err("本应拒绝不存在的提示词");
        assert_eq!(err.code, Code::PromptNotFound);

        let prompt = crafted(&mut fixture.catalog, "只有正文", &[], &[]);
        fixture
            .catalog
            .delete_prompt(&prompt.id)
            .expect("首次删除");
        let err = fixture
            .catalog
            .delete_prompt(&prompt.id)
            .expect_err("本应拒绝重复删除");
        assert_eq!(err.code, Code::PromptTrashDeleteFailed);
        assert!(fixture
            .catalog
            .library()
            .prompt_trash_path(&prompt.id)
            .is_file());
    }

    #[test]
    fn restoring_a_prompt_returns_to_surviving_folders_and_reports_missing_ones() {
        let mut fixture = fixture();
        fixture
            .catalog
            .create_prompt_folder(None, &name("人物"))
            .expect("创建保留文件夹");
        let removed = fixture
            .catalog
            .create_prompt_folder(None, &name("临时"))
            .expect("创建待删文件夹");
        let prompt = crafted(&mut fixture.catalog, "多文件夹正文", &["人物", "临时"], &[]);
        fixture.catalog.delete_prompt(&prompt.id).expect("删除");
        fixture
            .catalog
            .delete_prompt_folder(&removed)
            .expect("删除历史文件夹");

        let outcome = fixture.catalog.restore_prompt(&prompt.id).expect("还原");

        assert_eq!(outcome.missing_folders, vec!["临时".to_owned()]);
        let restored = PromptAsset::read(&fixture.catalog.library().prompt_path(&prompt.id))
            .expect("读取还原后的权威文件");
        assert!(!restored.is_deleted());
        assert_eq!(restored.folders, vec!["人物".to_owned()]);
        assert_eq!(restored.deleted_from_folders, None);
        assert!(!fixture
            .catalog
            .library()
            .prompt_trash_path(&prompt.id)
            .exists());
        let active = fixture
            .catalog
            .prompt_snapshot(&query(PromptLocation::Active))
            .expect("查询正常库");
        assert_eq!(active.prompts.len(), 1);
        assert_eq!(
            fixture
                .catalog
                .prompt_snapshot(&query(PromptLocation::Trash))
                .expect("查询回收站")
                .trash_count,
            0
        );
    }

    #[test]
    fn restoring_to_root_when_every_previous_folder_is_missing() {
        let mut fixture = fixture();
        let only = fixture
            .catalog
            .create_prompt_folder(None, &name("临时"))
            .expect("创建文件夹");
        let prompt = crafted(&mut fixture.catalog, "只有正文", &["临时"], &[]);
        fixture.catalog.delete_prompt(&prompt.id).expect("删除");
        fixture.catalog.delete_prompt_folder(&only).expect("删除");

        let outcome = fixture.catalog.restore_prompt(&prompt.id).expect("还原到根");

        assert_eq!(outcome.missing_folders, vec!["临时".to_owned()]);
        let restored = PromptAsset::read(&fixture.catalog.library().prompt_path(&prompt.id))
            .expect("读取还原后的权威文件");
        assert!(restored.folders.is_empty());
    }

    #[test]
    fn a_prompt_delete_rolls_back_after_every_injected_stage() {
        for stage in [
            PromptLifecycleStage::TrashPromptWritten,
            PromptLifecycleStage::OriginalPromptRemoved,
        ] {
            let mut fixture = fixture();
            let prompt = crafted(&mut fixture.catalog, "回滚样例", &[], &[]);
            let path = fixture.catalog.library().prompt_path(&prompt.id);
            let original_bytes = std::fs::read(&path).expect("读取原文件字节");
            fixture.catalog.inject_prompt_lifecycle_failure(stage);

            fixture
                .catalog
                .delete_prompt(&prompt.id)
                .expect_err("注入失败本应阻止删除");

            assert!(path.is_file());
            assert_eq!(
                std::fs::read(&path).expect("读回原文件字节"),
                original_bytes,
                "阶段 {stage:?} 注入失败后原文件必须逐字节复原"
            );
            let back = PromptAsset::read(&path).expect("读回原文件");
            assert!(!back.is_deleted(), "阶段 {stage:?} 注入失败后原文件不得带删除状态");
        }
    }

    #[test]
    fn a_prompt_restore_rolls_back_after_every_injected_stage() {
        for stage in [
            PromptLifecycleStage::NormalPromptWritten,
            PromptLifecycleStage::TrashPromptRemoved,
        ] {
            let mut fixture = fixture();
            let prompt = crafted(&mut fixture.catalog, "还原回滚样例", &[], &[]);
            fixture.catalog.delete_prompt(&prompt.id).expect("删除");
            let trash_path = fixture.catalog.library().prompt_trash_path(&prompt.id);
            let trash_bytes = std::fs::read(&trash_path).expect("读取回收站文件字节");
            fixture.catalog.inject_prompt_lifecycle_failure(stage);

            fixture
                .catalog
                .restore_prompt(&prompt.id)
                .expect_err("注入失败本应阻止还原");

            assert!(trash_path.is_file());
            assert_eq!(
                std::fs::read(&trash_path).expect("读回回收站文件"),
                trash_bytes,
                "阶段 {stage:?} 注入失败后回收站文件必须逐字节复原"
            );
            assert!(!fixture.catalog.library().prompt_path(&prompt.id).exists());
        }
    }

    #[test]
    fn deleting_a_prompt_leaves_image_assets_byte_identical() {
        let mut fixture = fixture();
        let source = write_png(&fixture.source, "人物.png", [255, 0, 0, 255]);
        let sidecar = import_with(&mut fixture.catalog, &source, &["参考"], &[]);
        fixture
            .catalog
            .create_prompt_folder(None, &name("人物"))
            .expect("创建提示词文件夹");
        let prompt = crafted(&mut fixture.catalog, "提示词正文", &["人物"], &[]);
        let folders_path = fixture.catalog.library().folders_path();
        let folders_before = std::fs::read(&folders_path).expect("读取图片文件夹清单");
        let sidecar_path = fixture.catalog.library().sidecar_path(&sidecar.hash);
        let sidecar_before = std::fs::read(&sidecar_path).expect("读取图片侧车");

        fixture
            .catalog
            .delete_prompt(&prompt.id)
            .expect("删除提示词");

        assert_eq!(
            std::fs::read(&folders_path).expect("读回图片文件夹清单"),
            folders_before,
            "删除提示词不得改动图片文件夹清单"
        );
        assert_eq!(
            std::fs::read(&sidecar_path).expect("读回图片侧车"),
            sidecar_before,
            "删除提示词不得改动图片侧车"
        );
    }

    /// 直接构造一条带关联图片的回收站提示词。普通关联的 link/unlink 入口属于
    /// 任务 6.x；purge 的"清理派生关联"语义现在就能用权威文件里的有序哈希钉住。
    fn placed_deleted_prompt(
        catalog: &mut Catalog,
        id: &str,
        body: &str,
        linked: &[ContentHash],
    ) -> PromptAsset {
        let prompt = PromptAsset {
            format_version: PROMPT_FORMAT_VERSION,
            id: PromptId::parse(id).expect("合法 ID"),
            body: body.to_owned(),
            title: Some("待清空标题".to_owned()),
            model: None,
            parameters: None,
            note: String::new(),
            favorite: false,
            folders: Vec::new(),
            tags: Vec::new(),
            linked_image_hashes: linked.to_vec(),
            cover_image_hash: None,
            created_at: chrono::DateTime::from_timestamp(0, 0).expect("固定时间戳"),
            updated_at: chrono::DateTime::from_timestamp(0, 0).expect("固定时间戳"),
            deleted_at: Some(chrono::DateTime::from_timestamp(60, 0).expect("固定时间戳")),
            deleted_from_folders: None,
        };
        let path = catalog.library().prompt_trash_path(&prompt.id);
        prompt.write_atomic(&path).expect("写入回收站提示词");
        catalog
            .index_mut()
            .expect("索引")
            .upsert_prompt(&prompt)
            .expect("写入索引");
        prompt
    }

    #[test]
    fn purging_prompt_trash_removes_files_and_derived_links() {
        let mut fixture = fixture();
        let source = write_png(&fixture.source, "人物.png", [255, 0, 0, 255]);
        let sidecar = import_with(&mut fixture.catalog, &source, &[], &[]);
        let linked = placed_deleted_prompt(
            &mut fixture.catalog,
            "018f3c9e-6c00-7000-8000-0000000000d1",
            "带关联的正文",
            std::slice::from_ref(&sidecar.hash),
        );
        let plain = crafted(&mut fixture.catalog, "普通正文", &[], &[]);
        fixture.catalog.delete_prompt(&plain.id).expect("删除");
        let sidecar_path = fixture.catalog.library().sidecar_path(&sidecar.hash);
        let sidecar_before = std::fs::read(&sidecar_path).expect("读取图片侧车");

        let report = fixture.catalog.purge_prompt_trash().expect("清空提示词回收站");

        assert_eq!(report.purged, 2);
        assert!(report.failures.is_empty());
        for id in [&linked.id, &plain.id] {
            assert!(!fixture.catalog.library().prompt_trash_path(id).exists());
            assert!(!fixture.catalog.library().prompt_path(id).exists());
        }
        // 派生关联随文件消失：重建后的索引只从文件推导，提示词行与其 prompt_images
        // 子表一并清除，而图片侧一个字节都不动。
        fixture.catalog.rebuild_index().expect("重建索引");
        let trash = fixture
            .catalog
            .prompt_snapshot(&query(PromptLocation::Trash))
            .expect("查询回收站");
        assert_eq!(trash.trash_count, 0);
        assert_eq!(
            std::fs::read(&sidecar_path).expect("读回图片侧车"),
            sidecar_before,
            "purge 提示词不得改动图片侧车"
        );
    }

    #[test]
    fn purging_prompt_trash_isolates_failures_and_keeps_the_failed_file() {
        let mut fixture = fixture();
        let failed = placed_deleted_prompt(
            &mut fixture.catalog,
            "018f3c9e-6c00-7000-8000-0000000000d2",
            "失败样例",
            &[],
        );
        let successful = placed_deleted_prompt(
            &mut fixture.catalog,
            "018f3c9e-6c00-7000-8000-0000000000d3",
            "成功样例",
            &[],
        );
        fixture
            .catalog
            .inject_prompt_purge_failure(failed.id.as_str());

        let report = fixture.catalog.purge_prompt_trash().expect("清空回收站");

        assert_eq!(report.purged, 1);
        assert_eq!(report.failures.len(), 1);
        assert_eq!(report.failures[0].id, failed.id.as_str());
        assert_eq!(
            report.failures[0].title.as_deref(),
            Some("待清空标题")
        );
        assert_eq!(report.failures[0].error.code, Code::PromptTrashPurgeFailed);
        assert!(fixture
            .catalog
            .library()
            .prompt_trash_path(&failed.id)
            .is_file());
        assert!(!fixture
            .catalog
            .library()
            .prompt_trash_path(&successful.id)
            .exists());
    }

    #[test]
    fn purging_an_empty_trash_changes_nothing() {
        // 核心层的"取消无写入"等价物：回收站为空时逐项循环零次，除例行的索引
        // 重建外不触碰任何权威文件——确认与取消在结果上不可区分。
        let mut fixture = fixture();
        let active = crafted(&mut fixture.catalog, "正常库中的提示词", &[], &[]);
        let path = fixture.catalog.library().prompt_path(&active.id);
        let before = std::fs::read(&path).expect("读取原文件字节");

        let report = fixture.catalog.purge_prompt_trash().expect("清空空回收站");

        assert_eq!(report.purged, 0);
        assert!(report.failures.is_empty());
        assert_eq!(std::fs::read(&path).expect("读回原文件字节"), before);
    }
}
