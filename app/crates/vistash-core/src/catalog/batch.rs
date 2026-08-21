//! 批量组织：逐项失败隔离与统一 [`BatchReport`]（设计第六条）。
//!
//! 批量标签、文件夹、收藏、普通关联与移入回收站对每个目标执行完整的单项权威
//! 写入与索引更新，一项失败不回滚先前成功项；返回值统一为 `BatchReport`，
//! 界面逐项显示失败。批量文件夹树重命名/删除不在这里——那是跨文件的逻辑
//! 操作，仍走已批准的 MetadataTransaction 全或无语义（两个元数据模块各自实现）。
//!
//! 结构上没有批量覆盖正文/备注的入口：正文是显式保存的单项编辑流，备注是
//! 独立的自动保存流，批量工具条永远不该出现它们——规格的 MUST NOT 由 API
//! 面本身满足，而不是靠调用方自律。
//!
//! 目标的当前组织值读自派生索引（与权威文件同步维护，重建等价性有专门测试），
//! 新集合仍经既有单项 setter 写入，因此文件夹清单校验、词法校验、回收站拒绝
//! 与索引兜底全部复用原路径，不出现第二套写入语义。已处于请求状态的目标
//! 计成功但不触碰权威文件——批量幂等落在字节层面。

use super::image_metadata::{FolderPath, Tag};
use super::Catalog;
use crate::error::{AppError, Result};
use crate::hashing::ContentHash;
use crate::index::PromptRow;
use crate::prompt::PromptId;
use serde::Serialize;

/// 单个目标的批量失败。
#[derive(Debug, Clone, Serialize)]
pub struct BatchFailure {
    pub id: String,
    pub display_name: String,
    pub error: AppError,
}

/// 一次批量组织的结果。部分成功是常态，因此这不是 `Result`。
#[derive(Debug, Clone, Serialize)]
pub struct BatchReport {
    pub succeeded: usize,
    pub failures: Vec<BatchFailure>,
}

/// 批量进度观察点：每处理完一项调用一次。
pub trait BatchProgress {
    fn on_progress(&mut self, _done: usize, _total: usize) {}
}

/// 什么都不做的观察者。
pub struct SilentProgress;
impl BatchProgress for SilentProgress {}

/// 提示词的显示名：标题缺省时取正文首行（与卡片语义一致）。
fn prompt_display_name(row: &PromptRow) -> String {
    row.title
        .clone()
        .unwrap_or_else(|| row.body.lines().next().unwrap_or_default().to_owned())
}

/// 批量目标：`(ID, 显示名, 计划)`。计划里的 `None` 表示已处于请求状态，
/// 计成功但不写入；构造阶段的错误与执行阶段的错误走同一失败通道。
type BatchTarget<P, T> = (
    String,
    String,
    std::result::Result<(P, Option<T>), AppError>,
);

/// 图片侧的批量目标。
type Target<T> = BatchTarget<ContentHash, T>;

/// 提示词侧的批量目标。`None` 语义与 [`Target`] 相同。
type PromptTarget<T> = BatchTarget<PromptId, T>;

impl Catalog {
    /// 逐项执行批量操作的核心循环：一项失败不回滚先前成功项，每项之后报进度。
    fn run_batch<T, P>(
        &mut self,
        progress: &mut dyn BatchProgress,
        targets: Vec<BatchTarget<P, T>>,
        mut apply: impl FnMut(&mut Self, P, T) -> Result<()>,
    ) -> BatchReport {
        let total = targets.len();
        let mut report = BatchReport {
            succeeded: 0,
            failures: Vec::new(),
        };
        for (done, (id, display_name, payload)) in targets.into_iter().enumerate() {
            match payload {
                Ok((key, Some(value))) => match apply(self, key, value) {
                    Ok(()) => report.succeeded += 1,
                    Err(error) => report.failures.push(BatchFailure {
                        id,
                        display_name,
                        error,
                    }),
                },
                // 已处于请求状态：幂等跳过，不触碰权威文件。
                Ok((_key, None)) => report.succeeded += 1,
                Err(error) => report.failures.push(BatchFailure {
                    id,
                    display_name,
                    error,
                }),
            }
            progress.on_progress(done + 1, total);
        }
        report
    }

    /// 批量把图片加入一个文件夹。已在目标文件夹的项幂等跳过。
    pub fn batch_add_asset_folder(
        &mut self,
        hashes: &[ContentHash],
        folder: &FolderPath,
        progress: &mut dyn BatchProgress,
    ) -> BatchReport {
        let mut targets: Vec<Target<Vec<FolderPath>>> = Vec::new();
        for hash in hashes {
            targets.push(self.planned_asset_folders(hash, |folders| {
                if folders.iter().any(|f| f == folder.as_str()) {
                    return Ok(false);
                }
                folders.push(folder.as_str().to_owned());
                folders.sort();
                Ok(true)
            }));
        }
        self.run_batch(progress, targets, |catalog, hash, folders| {
            catalog.set_asset_folders(&hash, &folders)
        })
    }

    /// 批量把图片移出一个文件夹。不在该文件夹的项幂等跳过。
    pub fn batch_remove_asset_folder(
        &mut self,
        hashes: &[ContentHash],
        folder: &FolderPath,
        progress: &mut dyn BatchProgress,
    ) -> BatchReport {
        let mut targets: Vec<Target<Vec<FolderPath>>> = Vec::new();
        for hash in hashes {
            targets.push(self.planned_asset_folders(hash, |folders| {
                if !folders.iter().any(|f| f == folder.as_str()) {
                    return Ok(false);
                }
                folders.retain(|f| f != folder.as_str());
                Ok(true)
            }));
        }
        self.run_batch(progress, targets, |catalog, hash, folders| {
            catalog.set_asset_folders(&hash, &folders)
        })
    }

    /// 批量添加共享标签。已持有该标签的项幂等跳过。
    pub fn batch_add_asset_tag(
        &mut self,
        hashes: &[ContentHash],
        tag: &Tag,
        progress: &mut dyn BatchProgress,
    ) -> BatchReport {
        let mut targets: Vec<Target<Vec<Tag>>> = Vec::new();
        for hash in hashes {
            targets.push(self.planned_asset_tags(hash, |tags| {
                if tags.iter().any(|t| t == tag.as_str()) {
                    return Ok(false);
                }
                tags.push(tag.as_str().to_owned());
                tags.sort();
                Ok(true)
            }));
        }
        self.run_batch(progress, targets, |catalog, hash, tags| {
            catalog.set_asset_tags(&hash, &tags)
        })
    }

    /// 批量移除共享标签。没有该标签的项幂等跳过。
    pub fn batch_remove_asset_tag(
        &mut self,
        hashes: &[ContentHash],
        tag: &Tag,
        progress: &mut dyn BatchProgress,
    ) -> BatchReport {
        let mut targets: Vec<Target<Vec<Tag>>> = Vec::new();
        for hash in hashes {
            targets.push(self.planned_asset_tags(hash, |tags| {
                if !tags.iter().any(|t| t == tag.as_str()) {
                    return Ok(false);
                }
                tags.retain(|t| t != tag.as_str());
                Ok(true)
            }));
        }
        self.run_batch(progress, targets, |catalog, hash, tags| {
            catalog.set_asset_tags(&hash, &tags)
        })
    }

    /// 批量设置收藏（纯二值）。已是目标状态的项幂等跳过。
    pub fn batch_set_asset_favorite(
        &mut self,
        hashes: &[ContentHash],
        favorite: bool,
        progress: &mut dyn BatchProgress,
    ) -> BatchReport {
        let mut targets: Vec<Target<bool>> = Vec::new();
        for hash in hashes {
            match self
                .index()
                .and_then(|index| index.asset_row(hash.as_str()))
            {
                Ok(row) => {
                    let changed = row.favorite != favorite;
                    targets.push((
                        hash.as_str().to_owned(),
                        row.original_filename,
                        Ok((hash.clone(), changed.then_some(favorite))),
                    ));
                }
                Err(error) => targets.push((
                    hash.as_str().to_owned(),
                    hash.as_str().to_owned(),
                    Err(error),
                )),
            }
        }
        self.run_batch(progress, targets, |catalog, hash, value| {
            catalog.set_asset_favorite(&hash, value)
        })
    }

    /// 批量建立普通关联：把每张图逐一关联到这条提示词。
    ///
    /// `link_images` 对未知哈希整体拒绝，批量语义要求逐项隔离，因此这里按单张
    /// 循环；重复关联是幂等空操作，重复选择同一张也安全。
    pub fn batch_link_to_prompt(
        &mut self,
        prompt_id: &PromptId,
        hashes: &[ContentHash],
        progress: &mut dyn BatchProgress,
    ) -> BatchReport {
        let mut targets: Vec<Target<()>> = Vec::new();
        for hash in hashes {
            let display_name = self
                .index()
                .and_then(|index| index.asset_row(hash.as_str()))
                .map(|row| row.original_filename)
                .unwrap_or_else(|_| hash.as_str().to_owned());
            targets.push((
                hash.as_str().to_owned(),
                display_name,
                Ok((hash.clone(), Some(()))),
            ));
        }
        self.run_batch(progress, targets, |catalog, hash, ()| {
            catalog.link_images(prompt_id, std::slice::from_ref(&hash))
        })
    }

    /// 批量把图片移入图片回收站。已在回收站的项由单项语义拒绝并逐项报告。
    pub fn batch_delete_assets(
        &mut self,
        hashes: &[ContentHash],
        progress: &mut dyn BatchProgress,
    ) -> BatchReport {
        let mut targets: Vec<Target<()>> = Vec::new();
        for hash in hashes {
            let display_name = self
                .index()
                .and_then(|index| index.asset_row(hash.as_str()))
                .map(|row| row.original_filename)
                .unwrap_or_else(|_| hash.as_str().to_owned());
            targets.push((
                hash.as_str().to_owned(),
                display_name,
                Ok((hash.clone(), Some(()))),
            ));
        }
        self.run_batch(progress, targets, |catalog, hash, ()| {
            catalog.delete_asset(&hash)
        })
    }

    /// 批量把提示词移入提示词回收站。
    pub fn batch_delete_prompts(
        &mut self,
        ids: &[PromptId],
        progress: &mut dyn BatchProgress,
    ) -> BatchReport {
        let mut targets: Vec<PromptTarget<()>> = Vec::new();
        for id in ids {
            let display_name = self
                .index()
                .and_then(|index| index.prompt_row(id.as_str()))
                .map(|row| prompt_display_name(&row))
                .unwrap_or_else(|_| id.as_str().to_owned());
            targets.push((
                id.as_str().to_owned(),
                display_name,
                Ok((id.clone(), Some(()))),
            ));
        }
        self.run_batch(progress, targets, |catalog, id, ()| {
            catalog.delete_prompt(&id)
        })
    }

    /// 批量把提示词加入一个提示词文件夹。已在目标文件夹的项幂等跳过。
    pub fn batch_add_prompt_folder(
        &mut self,
        ids: &[PromptId],
        folder: &FolderPath,
        progress: &mut dyn BatchProgress,
    ) -> BatchReport {
        let mut targets: Vec<PromptTarget<Vec<FolderPath>>> = Vec::new();
        for id in ids {
            targets.push(self.planned_prompt_folders(id, |folders| {
                if folders.iter().any(|f| f == folder.as_str()) {
                    return Ok(false);
                }
                folders.push(folder.as_str().to_owned());
                folders.sort();
                Ok(true)
            }));
        }
        self.run_batch(progress, targets, |catalog, id, folders| {
            catalog.set_prompt_folders(&id, &folders)
        })
    }

    /// 批量把提示词移出一个提示词文件夹。不在该文件夹的项幂等跳过。
    pub fn batch_remove_prompt_folder(
        &mut self,
        ids: &[PromptId],
        folder: &FolderPath,
        progress: &mut dyn BatchProgress,
    ) -> BatchReport {
        let mut targets: Vec<PromptTarget<Vec<FolderPath>>> = Vec::new();
        for id in ids {
            targets.push(self.planned_prompt_folders(id, |folders| {
                if !folders.iter().any(|f| f == folder.as_str()) {
                    return Ok(false);
                }
                folders.retain(|f| f != folder.as_str());
                Ok(true)
            }));
        }
        self.run_batch(progress, targets, |catalog, id, folders| {
            catalog.set_prompt_folders(&id, &folders)
        })
    }

    /// 批量添加共享标签。已持有该标签的项幂等跳过。
    pub fn batch_add_prompt_tag(
        &mut self,
        ids: &[PromptId],
        tag: &Tag,
        progress: &mut dyn BatchProgress,
    ) -> BatchReport {
        let mut targets: Vec<PromptTarget<Vec<Tag>>> = Vec::new();
        for id in ids {
            targets.push(self.planned_prompt_tags(id, |tags| {
                if tags.iter().any(|t| t == tag.as_str()) {
                    return Ok(false);
                }
                tags.push(tag.as_str().to_owned());
                tags.sort();
                Ok(true)
            }));
        }
        self.run_batch(progress, targets, |catalog, id, tags| {
            catalog.set_prompt_tags(&id, &tags)
        })
    }

    /// 批量移除共享标签。没有该标签的项幂等跳过。
    pub fn batch_remove_prompt_tag(
        &mut self,
        ids: &[PromptId],
        tag: &Tag,
        progress: &mut dyn BatchProgress,
    ) -> BatchReport {
        let mut targets: Vec<PromptTarget<Vec<Tag>>> = Vec::new();
        for id in ids {
            targets.push(self.planned_prompt_tags(id, |tags| {
                if !tags.iter().any(|t| t == tag.as_str()) {
                    return Ok(false);
                }
                tags.retain(|t| t != tag.as_str());
                Ok(true)
            }));
        }
        self.run_batch(progress, targets, |catalog, id, tags| {
            catalog.set_prompt_tags(&id, &tags)
        })
    }

    /// 批量设置收藏（纯二值）。已是目标状态的项幂等跳过。
    pub fn batch_set_prompt_favorite(
        &mut self,
        ids: &[PromptId],
        favorite: bool,
        progress: &mut dyn BatchProgress,
    ) -> BatchReport {
        let mut targets: Vec<PromptTarget<bool>> = Vec::new();
        for id in ids {
            match self
                .index()
                .and_then(|index| index.prompt_row(id.as_str()))
            {
                Ok(row) => {
                    let display_name = prompt_display_name(&row);
                    let changed = row.favorite != favorite;
                    targets.push((
                        id.as_str().to_owned(),
                        display_name,
                        Ok((id.clone(), changed.then_some(favorite))),
                    ));
                }
                Err(error) => targets.push((
                    id.as_str().to_owned(),
                    id.as_str().to_owned(),
                    Err(error),
                )),
            }
        }
        self.run_batch(progress, targets, |catalog, id, value| {
            catalog.set_prompt_favorite(&id, value)
        })
    }

    /// 图片侧批量组织的目标构造：读当前值、算新集合，错误进入同一失败通道。
    /// 计划闭包返回是否需要写入——`false` 即已处于请求状态，幂等跳过。
    fn planned_asset_folders(
        &self,
        hash: &ContentHash,
        plan: impl FnOnce(&mut Vec<String>) -> Result<bool>,
    ) -> Target<Vec<FolderPath>> {
        match self
            .index()
            .and_then(|index| index.asset_row(hash.as_str()))
        {
            Ok(row) => {
                let mut folders = row.folders.clone();
                let display_name = row.original_filename;
                match plan(&mut folders) {
                    Ok(false) => (
                        hash.as_str().to_owned(),
                        display_name,
                        Ok((hash.clone(), None)),
                    ),
                    Ok(true) => {
                        let parsed: std::result::Result<Vec<FolderPath>, AppError> =
                            folders.iter().map(|f| FolderPath::parse(f)).collect();
                        (
                            hash.as_str().to_owned(),
                            display_name,
                            parsed.map(|folders| (hash.clone(), Some(folders))),
                        )
                    }
                    Err(error) => (hash.as_str().to_owned(), display_name, Err(error)),
                }
            }
            Err(error) => (
                hash.as_str().to_owned(),
                hash.as_str().to_owned(),
                Err(error),
            ),
        }
    }

    fn planned_asset_tags(
        &self,
        hash: &ContentHash,
        plan: impl FnOnce(&mut Vec<String>) -> Result<bool>,
    ) -> Target<Vec<Tag>> {
        match self
            .index()
            .and_then(|index| index.asset_row(hash.as_str()))
        {
            Ok(row) => {
                let mut tags = row.tags.clone();
                let display_name = row.original_filename;
                match plan(&mut tags) {
                    Ok(false) => (
                        hash.as_str().to_owned(),
                        display_name,
                        Ok((hash.clone(), None)),
                    ),
                    Ok(true) => {
                        let parsed: std::result::Result<Vec<Tag>, AppError> =
                            tags.iter().map(|t| Tag::parse(t)).collect();
                        (
                            hash.as_str().to_owned(),
                            display_name,
                            parsed.map(|tags| (hash.clone(), Some(tags))),
                        )
                    }
                    Err(error) => (hash.as_str().to_owned(), display_name, Err(error)),
                }
            }
            Err(error) => (
                hash.as_str().to_owned(),
                hash.as_str().to_owned(),
                Err(error),
            ),
        }
    }

    /// 提示词侧批量组织的目标构造，语义与图片侧相同。
    fn planned_prompt_folders(
        &self,
        id: &PromptId,
        plan: impl FnOnce(&mut Vec<String>) -> Result<bool>,
    ) -> PromptTarget<Vec<FolderPath>> {
        match self
            .index()
            .and_then(|index| index.prompt_row(id.as_str()))
        {
            Ok(row) => {
                let display_name = prompt_display_name(&row);
                let mut folders = row.folders.clone();
                match plan(&mut folders) {
                    Ok(false) => (id.as_str().to_owned(), display_name, Ok((id.clone(), None))),
                    Ok(true) => {
                        let parsed: std::result::Result<Vec<FolderPath>, AppError> =
                            folders.iter().map(|f| FolderPath::parse(f)).collect();
                        (
                            id.as_str().to_owned(),
                            display_name,
                            parsed.map(|folders| (id.clone(), Some(folders))),
                        )
                    }
                    Err(error) => (id.as_str().to_owned(), display_name, Err(error)),
                }
            }
            Err(error) => (id.as_str().to_owned(), id.as_str().to_owned(), Err(error)),
        }
    }

    fn planned_prompt_tags(
        &self,
        id: &PromptId,
        plan: impl FnOnce(&mut Vec<String>) -> Result<bool>,
    ) -> PromptTarget<Vec<Tag>> {
        match self
            .index()
            .and_then(|index| index.prompt_row(id.as_str()))
        {
            Ok(row) => {
                let display_name = prompt_display_name(&row);
                let mut tags = row.tags.clone();
                match plan(&mut tags) {
                    Ok(false) => (id.as_str().to_owned(), display_name, Ok((id.clone(), None))),
                    Ok(true) => {
                        let parsed: std::result::Result<Vec<Tag>, AppError> =
                            tags.iter().map(|t| Tag::parse(t)).collect();
                        (
                            id.as_str().to_owned(),
                            display_name,
                            parsed.map(|tags| (id.clone(), Some(tags))),
                        )
                    }
                    Err(error) => (id.as_str().to_owned(), display_name, Err(error)),
                }
            }
            Err(error) => (id.as_str().to_owned(), id.as_str().to_owned(), Err(error)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::image_metadata::FolderName;
    use crate::catalog::testing::{fixture, import_with, write_png};
    use crate::catalog::NewPrompt;
    use crate::error::Code;
    use crate::prompt::PromptAsset;

    #[derive(Default)]
    struct RecordingProgress {
        calls: Vec<(usize, usize)>,
    }

    impl BatchProgress for RecordingProgress {
        fn on_progress(&mut self, done: usize, total: usize) {
            self.calls.push((done, total));
        }
    }

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

    fn prompt(catalog: &mut Catalog, body: &str) -> PromptAsset {
        catalog.create_prompt(&draft(body)).expect("创建提示词")
    }

    #[test]
    fn an_asset_batch_isolates_failures_and_reports_each_target() {
        let mut fixture = fixture();
        let one = import_with(
            &mut fixture.catalog,
            &write_png(&fixture.source, "a.png", [255, 0, 0, 255]),
            &[],
            &[],
        );
        let trashed = import_with(
            &mut fixture.catalog,
            &write_png(&fixture.source, "c.png", [0, 0, 255, 255]),
            &[],
            &[],
        );
        fixture
            .catalog
            .delete_asset(&trashed.hash)
            .expect("移入回收站");
        let unknown = ContentHash::of_bytes(b"unknown-batch-hash");
        let folder = fixture
            .catalog
            .create_folder(None, &FolderName::parse("风景").expect("合法文件夹名"))
            .expect("建立文件夹");

        let mut progress = RecordingProgress::default();
        let report = fixture.catalog.batch_add_asset_folder(
            &[one.hash.clone(), unknown.clone(), trashed.hash.clone()],
            &folder,
            &mut progress,
        );

        // 一张成功、一张从未入库、一张在回收站：逐项隔离，互不影响。
        assert_eq!(report.succeeded, 1);
        assert_eq!(report.failures.len(), 2);
        assert_eq!(report.failures[0].id, unknown.as_str());
        assert_eq!(report.failures[0].display_name, unknown.as_str());
        assert_eq!(report.failures[0].error.code, Code::LibraryNotFound);
        assert_eq!(report.failures[1].id, trashed.hash.as_str());
        assert_eq!(report.failures[1].display_name, "c.png");
        assert_eq!(
            report.failures[1].error.code,
            Code::LibraryAssetMetadataWriteFailed
        );
        // 每处理完一项报一次进度，含失败项。
        assert_eq!(progress.calls, vec![(1, 3), (2, 3), (3, 3)]);

        // 成功项真实生效。
        let row = fixture
            .catalog
            .index()
            .expect("索引")
            .asset_row(one.hash.as_str())
            .expect("索引行");
        assert_eq!(row.folders, vec![folder.as_str().to_owned()]);
    }

    #[test]
    fn a_batch_never_rolls_back_earlier_successes() {
        let mut fixture = fixture();
        let owner = prompt(&mut fixture.catalog, "批量回滚测试提示词");
        let one = import_with(
            &mut fixture.catalog,
            &write_png(&fixture.source, "one.png", [255, 0, 0, 255]),
            &[],
            &[],
        );
        let two = import_with(
            &mut fixture.catalog,
            &write_png(&fixture.source, "two.png", [0, 255, 0, 255]),
            &[],
            &[],
        );
        let three = import_with(
            &mut fixture.catalog,
            &write_png(&fixture.source, "three.png", [0, 0, 255, 255]),
            &[],
            &[],
        );

        // 第二个目标的权威写入失败（link_images 写盘前的统一观察点）：
        // 第一个保持已关联，第三个照常关联。
        fixture.catalog.inject_metadata_failure_at(1);
        let report = fixture.catalog.batch_link_to_prompt(
            &owner.id,
            &[one.hash.clone(), two.hash.clone(), three.hash.clone()],
            &mut SilentProgress,
        );

        assert_eq!(report.succeeded, 2);
        assert_eq!(report.failures.len(), 1);
        assert_eq!(report.failures[0].id, two.hash.as_str());
        assert_eq!(
            report.failures[0].error.code,
            Code::LibraryAssetMetadataWriteFailed
        );

        // 权威文件里一、三在列而二不在：批量没有整体回滚。
        let path = fixture.catalog.library().prompt_path(&owner.id);
        let prompt = PromptAsset::read(&path).expect("读取权威文件");
        assert!(prompt.linked_image_hashes.contains(&one.hash));
        assert!(!prompt.linked_image_hashes.contains(&two.hash));
        assert!(prompt.linked_image_hashes.contains(&three.hash));
    }

    #[test]
    fn a_batch_skips_targets_already_in_the_requested_state() {
        let mut fixture = fixture();
        let folder = fixture
            .catalog
            .create_folder(None, &FolderName::parse("人物").expect("合法文件夹名"))
            .expect("建立文件夹");
        let sidecar = import_with(
            &mut fixture.catalog,
            &write_png(&fixture.source, "hero.png", [255, 200, 0, 255]),
            &["人物"],
            &["主视觉"],
        );
        fixture
            .catalog
            .set_asset_favorite(&sidecar.hash, true)
            .expect("设为收藏");
        let path = fixture.catalog.library().sidecar_path(&sidecar.hash);
        let before = std::fs::read(&path).expect("读取侧车字节");

        let folder_path = FolderPath::parse("人物").expect("合法路径");
        let tag = Tag::parse("主视觉").expect("合法标签");

        // 三种请求都命中"已处于请求状态"：计成功但不触碰权威文件。
        let folders_report = fixture.catalog.batch_add_asset_folder(
            std::slice::from_ref(&sidecar.hash),
            &folder_path,
            &mut SilentProgress,
        );
        let tags_report = fixture.catalog.batch_add_asset_tag(
            std::slice::from_ref(&sidecar.hash),
            &tag,
            &mut SilentProgress,
        );
        let favorite_report = fixture.catalog.batch_set_asset_favorite(
            std::slice::from_ref(&sidecar.hash),
            true,
            &mut SilentProgress,
        );

        assert_eq!(folders_report.succeeded, 1);
        assert!(folders_report.failures.is_empty());
        assert_eq!(tags_report.succeeded, 1);
        assert!(tags_report.failures.is_empty());
        assert_eq!(favorite_report.succeeded, 1);
        assert!(favorite_report.failures.is_empty());
        assert_eq!(
            std::fs::read(&path).expect("重读侧车字节"),
            before,
            "幂等跳过不得改写权威文件"
        );
        let _ = folder;
    }

    #[test]
    fn a_prompt_batch_reports_display_names_and_isolates_failures() {
        let mut fixture = fixture();
        let titled = fixture
            .catalog
            .create_prompt(&NewPrompt {
                body: "霓虹雨夜，湿滑路面反光".to_owned(),
                title: Some("霓虹城市".to_owned()),
                model: None,
                parameters: None,
                folders: vec![],
                tags: vec![],
            })
            .expect("创建带标题提示词");
        let untitled = prompt(&mut fixture.catalog, "第一行正文\n第二行正文");
        let trashed = prompt(&mut fixture.catalog, "被删掉的提示词正文");
        fixture
            .catalog
            .delete_prompt(&trashed.id)
            .expect("移入回收站");
        let unknown = PromptId::parse("018f3c9e-6c00-7000-8000-0000000000ff").expect("合法 ID");
        let tag = Tag::parse("场景").expect("合法标签");

        let mut progress = RecordingProgress::default();
        let report = fixture.catalog.batch_add_prompt_tag(
            &[
                titled.id.clone(),
                untitled.id.clone(),
                trashed.id.clone(),
                unknown.clone(),
            ],
            &tag,
            &mut progress,
        );

        assert_eq!(report.succeeded, 2);
        assert_eq!(report.failures.len(), 2);
        // 回收站提示词以标题缺省时的正文首行作为显示名。
        assert_eq!(report.failures[0].id, trashed.id.as_str());
        assert_eq!(report.failures[0].display_name, "被删掉的提示词正文");
        assert_eq!(report.failures[0].error.code, Code::PromptWriteFailed);
        // 从未存在的 ID 以 ID 字面值兜底显示。
        assert_eq!(report.failures[1].id, unknown.as_str());
        assert_eq!(report.failures[1].display_name, unknown.as_str());
        assert_eq!(report.failures[1].error.code, Code::PromptNotFound);
        assert_eq!(
            progress.calls,
            vec![(1, 4), (2, 4), (3, 4), (4, 4)]
        );

        // 成功的两条真实持有标签；显示名只出现在失败报告里。
        let index = fixture.catalog.index().expect("索引");
        for id in [&titled.id, &untitled.id] {
            let row = index.prompt_row(id.as_str()).expect("索引行");
            assert_eq!(row.tags, vec![tag.as_str().to_owned()]);
        }
    }

    #[test]
    fn a_delete_batch_moves_each_target_into_its_own_trash() {
        let mut fixture = fixture();
        let one = import_with(
            &mut fixture.catalog,
            &write_png(&fixture.source, "del-a.png", [255, 0, 0, 255]),
            &[],
            &[],
        );
        let two = import_with(
            &mut fixture.catalog,
            &write_png(&fixture.source, "del-b.png", [0, 255, 0, 255]),
            &[],
            &[],
        );
        let first = prompt(&mut fixture.catalog, "要删除的第一条提示词");
        let second = prompt(&mut fixture.catalog, "要删除的第二条提示词");

        let assets_report = fixture.catalog.batch_delete_assets(
            &[one.hash.clone(), two.hash.clone()],
            &mut SilentProgress,
        );
        let prompts_report = fixture.catalog.batch_delete_prompts(
            &[first.id.clone(), second.id.clone()],
            &mut SilentProgress,
        );

        assert_eq!(assets_report.succeeded, 2);
        assert!(assets_report.failures.is_empty());
        assert_eq!(prompts_report.succeeded, 2);
        assert!(prompts_report.failures.is_empty());

        let index = fixture.catalog.index().expect("索引");
        assert!(index.asset_is_deleted(one.hash.as_str()).expect("查询"));
        assert!(index.asset_is_deleted(two.hash.as_str()).expect("查询"));
        assert!(fixture
            .catalog
            .library()
            .prompt_trash_path(&first.id)
            .exists());
        assert!(fixture
            .catalog
            .library()
            .prompt_trash_path(&second.id)
            .exists());

        // 已在回收站的目标由单项语义拒绝并逐项报告，不拖垮同批其他目标。
        let repeat_assets =
            fixture
                .catalog
                .batch_delete_assets(std::slice::from_ref(&one.hash), &mut SilentProgress);
        assert_eq!(repeat_assets.succeeded, 0);
        assert_eq!(repeat_assets.failures.len(), 1);
        assert_eq!(repeat_assets.failures[0].id, one.hash.as_str());

        let repeat_prompts =
            fixture
                .catalog
                .batch_delete_prompts(std::slice::from_ref(&first.id), &mut SilentProgress);
        assert_eq!(repeat_prompts.succeeded, 0);
        assert_eq!(repeat_prompts.failures.len(), 1);
        assert_eq!(repeat_prompts.failures[0].id, first.id.as_str());
    }

    #[test]
    fn a_link_batch_reports_each_image_individually() {
        let mut fixture = fixture();
        let linked = prompt(&mut fixture.catalog, "关联测试提示词");
        let one = import_with(
            &mut fixture.catalog,
            &write_png(&fixture.source, "link-a.png", [255, 0, 0, 255]),
            &[],
            &[],
        );
        let two = import_with(
            &mut fixture.catalog,
            &write_png(&fixture.source, "link-b.png", [0, 255, 0, 255]),
            &[],
            &[],
        );
        let unknown = ContentHash::of_bytes(b"unknown-link-hash");

        let report = fixture.catalog.batch_link_to_prompt(
            &linked.id,
            &[one.hash.clone(), unknown.clone(), two.hash.clone()],
            &mut SilentProgress,
        );

        assert_eq!(report.succeeded, 2);
        assert_eq!(report.failures.len(), 1);
        assert_eq!(report.failures[0].id, unknown.as_str());
        assert_eq!(report.failures[0].display_name, unknown.as_str());
        assert_eq!(
            report.failures[0].error.code,
            Code::PromptLinkedImageNotFound
        );

        // 有效关联按传入顺序落盘，未知哈希不打断顺序。
        let path = fixture.catalog.library().prompt_path(&linked.id);
        let prompt = PromptAsset::read(&path).expect("读取权威文件");
        assert_eq!(
            prompt.linked_image_hashes,
            vec![one.hash.clone(), two.hash.clone()]
        );

        // 重放同一批有效目标全部幂等成功，且不再触碰权威文件。
        let before = std::fs::read(&path).expect("读取关联后字节");
        let replay = fixture.catalog.batch_link_to_prompt(
            &linked.id,
            &[one.hash.clone(), two.hash.clone()],
            &mut SilentProgress,
        );
        assert_eq!(replay.succeeded, 2);
        assert!(replay.failures.is_empty());
        assert_eq!(
            std::fs::read(&path).expect("重放后读取"),
            before,
            "重复关联不得改写权威文件"
        );
    }
}
