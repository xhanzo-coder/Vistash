//! 普通关联与封面：唯一权威方是提示词文件（设计第三条）。
//!
//! 一次关联只改动一份权威文件——提示词的有序 `linked_image_hashes`；图片侧车
//! 不写反向列表，从图片反查提示词走 SQLite 的 `prompt_images` 派生表。双写两侧
//! 只会把一个关系变成两份会分叉的事实。关联没有类型（生成/参考/反推都被设计
//! 明确排除），也不根据文件名或内容猜测。
//!
//! 封面是关联的引用而不是独立数据：`cover_image_hash` 必须指向已关联的一张，
//! 缺省表示"用第一张正常关联图片"。解除关联或图片被 purge 时按顺序回落。

use super::write_raw_atomic;
use super::Catalog;
use crate::error::{AppError, Code, Result};
use crate::hashing::ContentHash;
use crate::prompt::PromptId;

impl Catalog {
    /// 把图片追加到提示词的有序关联列表末尾。
    ///
    /// 已关联的哈希跳过（幂等），新哈希按给定顺序追加——已有顺序属于使用者
    /// （默认封面取第一张），不得因重新关联而重排。目标哈希必须真实入库
    /// （含回收站）：指向从未入库的引用会被界面呈现成"已删除"，那是撒谎。
    pub fn link_images(&mut self, prompt_id: &PromptId, hashes: &[ContentHash]) -> Result<()> {
        for hash in hashes {
            if !self.index()?.asset_exists(hash.as_str())? {
                return Err(AppError::detailed(
                    Code::PromptLinkedImageNotFound,
                    format!("要关联的图片不在库中：{hash}"),
                ));
            }
        }
        let (path, mut prompt) = self.load_editable_prompt(prompt_id, "关联")?;
        let mut added = Vec::new();
        for hash in hashes {
            if !prompt.linked_image_hashes.contains(hash) && !added.contains(hash) {
                added.push(hash.clone());
            }
        }
        // 全部已关联时无事可做：不触碰文件，让幂等性落在字节层面。
        if added.is_empty() {
            return Ok(());
        }
        prompt.linked_image_hashes.extend(added);
        prompt.write_atomic(&path)?;
        if let Err(error) = self.index_mut()?.upsert_prompt(&prompt) {
            return self.rebuild_after_index_failure(error);
        }
        Ok(())
    }

    /// 解除提示词与一张图片的关联。
    ///
    /// 解除未关联的哈希是幂等空操作。若解除的是显式封面，封面回落为缺省
    /// （第一张剩余关联图片），以维持"封面必须在关联列表中"的不变量。
    pub fn unlink_image(&mut self, prompt_id: &PromptId, hash: &ContentHash) -> Result<()> {
        let (path, mut prompt) = self.load_editable_prompt(prompt_id, "关联")?;
        let Some(position) = prompt.linked_image_hashes.iter().position(|h| h == hash) else {
            return Ok(());
        };
        prompt.linked_image_hashes.remove(position);
        if prompt.cover_image_hash.as_ref() == Some(hash) {
            prompt.cover_image_hash = None;
        }
        prompt.write_atomic(&path)?;
        if let Err(error) = self.index_mut()?.upsert_prompt(&prompt) {
            return self.rebuild_after_index_failure(error);
        }
        Ok(())
    }

    /// 图片永久删除前，从所有关联它的提示词（含回收站）移除该哈希并重选封面。
    ///
    /// 设计第三条：这是唯一被允许批量改写提示词权威文件的跨文件事务——图片一旦
    /// 物理消失，指向它的关联就成了永远无法解析的悬空引用。任一提示词写入失败都
    /// 让整个清理失败，已写回的文件逆序恢复原字节；调用方（图片生命周期）据此让
    /// 这张图的 purge 整体失败，图片对保持完整。
    pub(super) fn remove_linked_image_everywhere(&mut self, hash: &ContentHash) -> Result<()> {
        let linked = self.index()?.prompts_for_image(hash.as_str())?;
        // 先把每个受影响文件读入内存并算出修改后的内容：任何读取或解析失败都发生
        // 在第一个字节落盘之前。文件已不存在的过期行直接跳过——purge 结束时的索引
        // 重建按磁盘实况清掉这些行，不能让一行陈旧数据永久卡死这张图的 purge。
        let mut pending: Vec<PendingLinkRemoval> = Vec::new();
        for row in linked {
            let id = PromptId::parse(&row.id)?;
            let normal = self.library.prompt_path(&id);
            let trash = self.library.prompt_trash_path(&id);
            let path = if normal.exists() {
                normal
            } else if trash.exists() {
                trash
            } else {
                continue;
            };
            let original = std::fs::read(&path).map_err(|error| {
                AppError::detailed(
                    Code::LibraryIoFailed,
                    format!("读取待清理关联的提示词失败 {}: {error}", path.display()),
                )
            })?;
            let mut prompt = crate::prompt::PromptAsset::read(&path)?;
            let Some(position) = prompt.linked_image_hashes.iter().position(|h| h == hash)
            else {
                continue;
            };
            prompt.linked_image_hashes.remove(position);
            if prompt.cover_image_hash.as_ref() == Some(hash) {
                // 重选封面与解除关联同语义：清空显式值，缺省回落到第一张剩余关联。
                prompt.cover_image_hash = None;
            }
            pending.push(PendingLinkRemoval {
                path,
                original,
                prompt,
            });
        }
        if pending.is_empty() {
            return Ok(());
        }
        // 逐个写盘；中途失败则把已写回的文件逆序恢复原字节。注入观察点与真实
        // 写入合并成同一个可失败步骤——否则观察点自己的失败会绕过回滚路径。
        let mut written: Vec<(std::path::PathBuf, Vec<u8>)> = Vec::new();
        for item in &pending {
            let write_result = self
                .before_metadata_write()
                .and_then(|()| item.prompt.write_atomic(&item.path));
            if let Err(error) = write_result {
                for (path, bytes) in written.iter().rev() {
                    write_raw_atomic(path, bytes, Code::PromptWriteFailed)?;
                }
                return Err(error);
            }
            written.push((item.path.clone(), item.original.clone()));
        }
        for item in &pending {
            if let Err(error) = self.index_mut()?.upsert_prompt(&item.prompt) {
                return self.rebuild_after_index_failure(error);
            }
        }
        Ok(())
    }
}

/// 一次图片 purge 关联清理中单个提示词的待写状态。
struct PendingLinkRemoval {
    path: std::path::PathBuf,
    original: Vec<u8>,
    prompt: crate::prompt::PromptAsset,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::testing::{fixture, import_with, write_png};
    use crate::prompt::PromptAsset;

    fn prompt(catalog: &mut Catalog, body: &str) -> PromptAsset {
        catalog
            .create_prompt(&crate::catalog::NewPrompt {
                body: body.to_owned(),
                title: None,
                model: None,
                parameters: None,
                folders: Vec::new(),
                tags: Vec::new(),
            })
            .expect("创建提示词")
    }

    #[test]
    fn linking_supports_many_to_many_from_both_sides() {
        let mut fixture = fixture();
        let first = write_png(&fixture.source, "一.png", [255, 0, 0, 255]);
        let second = write_png(&fixture.source, "二.png", [0, 255, 0, 255]);
        let image_a = import_with(&mut fixture.catalog, &first, &[], &[]);
        let image_b = import_with(&mut fixture.catalog, &second, &[], &[]);
        let left = prompt(&mut fixture.catalog, "左侧提示词");
        let right = prompt(&mut fixture.catalog, "右侧提示词");

        fixture
            .catalog
            .link_images(&left.id, &[image_a.hash.clone(), image_b.hash.clone()])
            .expect("关联左侧");
        fixture
            .catalog
            .link_images(&right.id, std::slice::from_ref(&image_a.hash))
            .expect("关联右侧");

        // 提示词侧：权威文件里的有序列表。
        let left_detail = fixture
            .catalog
            .prompt_detail(&left.id)
            .expect("读取左侧详情");
        assert_eq!(
            left_detail.linked_image_hashes,
            vec![image_a.hash.clone(), image_b.hash.clone()]
        );
        // 图片侧：派生索引反查，多对多两个方向都成立。
        let a_prompts = fixture
            .catalog
            .index()
            .expect("索引")
            .prompts_for_image(image_a.hash.as_str())
            .expect("反查一");
        assert_eq!(
            a_prompts.iter().map(|p| p.id.clone()).collect::<Vec<_>>(),
            vec![left.id.as_str().to_owned(), right.id.as_str().to_owned()]
        );
        let b_prompts = fixture
            .catalog
            .index()
            .expect("索引")
            .prompts_for_image(image_b.hash.as_str())
            .expect("反查二");
        assert_eq!(b_prompts.len(), 1);
        assert_eq!(b_prompts[0].id, left.id.as_str());
    }

    #[test]
    fn relinking_is_idempotent_and_keeps_existing_order() {
        let mut fixture = fixture();
        let first = write_png(&fixture.source, "一.png", [255, 0, 0, 255]);
        let second = write_png(&fixture.source, "二.png", [0, 255, 0, 255]);
        let image_a = import_with(&mut fixture.catalog, &first, &[], &[]);
        let image_b = import_with(&mut fixture.catalog, &second, &[], &[]);
        let owner = prompt(&mut fixture.catalog, "关联幂等");
        fixture
            .catalog
            .link_images(&owner.id, std::slice::from_ref(&image_a.hash))
            .expect("首次关联");
        let path = fixture.catalog.library().prompt_path(&owner.id);
        let before = std::fs::read(&path).expect("读取权威文件字节");

        // 重复关联同一张：字节不变。混合新旧哈希：只有新的追加到末尾，已有顺序不动。
        fixture
            .catalog
            .link_images(&owner.id, std::slice::from_ref(&image_a.hash))
            .expect("重复关联");
        assert_eq!(
            std::fs::read(&path).expect("读回权威文件字节"),
            before,
            "重复关联不得改动权威文件"
        );
        fixture
            .catalog
            .link_images(&owner.id, &[image_b.hash.clone(), image_a.hash.clone()])
            .expect("混合关联");
        let detail = fixture
            .catalog
            .prompt_detail(&owner.id)
            .expect("读取详情");
        assert_eq!(
            detail.linked_image_hashes,
            vec![image_a.hash.clone(), image_b.hash.clone()],
            "新哈希追加到末尾，已有顺序不重排"
        );
    }

    #[test]
    fn unlinking_removes_the_link_without_touching_the_image_sidecar() {
        let mut fixture = fixture();
        let first = write_png(&fixture.source, "一.png", [255, 0, 0, 255]);
        let second = write_png(&fixture.source, "二.png", [0, 255, 0, 255]);
        let image_a = import_with(&mut fixture.catalog, &first, &[], &[]);
        let image_b = import_with(&mut fixture.catalog, &second, &[], &[]);
        let owner = prompt(&mut fixture.catalog, "解除关联");
        fixture
            .catalog
            .link_images(&owner.id, &[image_a.hash.clone(), image_b.hash.clone()])
            .expect("建立关联");
        let sidecar_path = fixture.catalog.library().sidecar_path(&image_a.hash);
        let sidecar_before = std::fs::read(&sidecar_path).expect("读取图片侧车字节");

        fixture
            .catalog
            .unlink_image(&owner.id, &image_a.hash)
            .expect("解除关联");
        // 解除未关联的哈希是幂等空操作。
        fixture
            .catalog
            .unlink_image(&owner.id, &image_a.hash)
            .expect("重复解除");

        let detail = fixture
            .catalog
            .prompt_detail(&owner.id)
            .expect("读取详情");
        assert_eq!(detail.linked_image_hashes, vec![image_b.hash.clone()]);
        assert_eq!(
            std::fs::read(&sidecar_path).expect("读回图片侧车字节"),
            sidecar_before,
            "解除关联不得改动图片侧车"
        );
        let remaining = fixture
            .catalog
            .index()
            .expect("索引")
            .prompts_for_image(image_a.hash.as_str())
            .expect("反查");
        assert!(remaining.is_empty());
    }

    #[test]
    fn linking_refuses_unknown_images_and_trashed_prompts() {
        let mut fixture = fixture();
        let first = write_png(&fixture.source, "一.png", [255, 0, 0, 255]);
        let image_a = import_with(&mut fixture.catalog, &first, &[], &[]);
        let owner = prompt(&mut fixture.catalog, "校验样例");
        let unknown = ContentHash::of_bytes(b"never-imported-bytes");

        let error = fixture
            .catalog
            .link_images(&owner.id, &[unknown])
            .expect_err("本应拒绝未入库的哈希");
        assert_eq!(error.code, Code::PromptLinkedImageNotFound);

        fixture.catalog.delete_prompt(&owner.id).expect("删除");
        let error = fixture
            .catalog
            .link_images(&owner.id, std::slice::from_ref(&image_a.hash))
            .expect_err("本应拒绝回收站提示词");
        assert_eq!(error.code, Code::PromptWriteFailed);
    }

    #[test]
    fn associations_stay_visible_in_both_trashes_and_survive_restore() {
        let mut fixture = fixture();
        let first = write_png(&fixture.source, "一.png", [255, 0, 0, 255]);
        let second = write_png(&fixture.source, "二.png", [0, 255, 0, 255]);
        let image_a = import_with(&mut fixture.catalog, &first, &[], &[]);
        let image_b = import_with(&mut fixture.catalog, &second, &[], &[]);
        let owner = prompt(&mut fixture.catalog, "可见性");
        let other = prompt(&mut fixture.catalog, "另一位");
        fixture
            .catalog
            .link_images(&owner.id, &[image_a.hash.clone(), image_b.hash.clone()])
            .expect("关联");
        fixture
            .catalog
            .link_images(&other.id, std::slice::from_ref(&image_a.hash))
            .expect("关联");

        // 图片进回收站不改提示词文件：列表原样保留，界面据此呈现"关联图片已删除"。
        fixture.catalog.delete_asset(&image_a.hash).expect("删除图片");
        let detail = fixture.catalog.prompt_detail(&owner.id).expect("读取详情");
        assert_eq!(
            detail.linked_image_hashes,
            vec![image_a.hash.clone(), image_b.hash.clone()]
        );
        let seen = fixture
            .catalog
            .index()
            .expect("索引")
            .prompts_for_image(image_a.hash.as_str())
            .expect("反查");
        assert_eq!(seen.len(), 2);

        // 提示词进回收站后反查同样可见："关联提示词已删除"需要这个状态。
        fixture.catalog.delete_prompt(&other.id).expect("删除提示词");
        let seen = fixture
            .catalog
            .index()
            .expect("索引")
            .prompts_for_image(image_a.hash.as_str())
            .expect("反查");
        assert_eq!(seen.len(), 2);

        // 双向还原后一切照旧，不需要任何修复步骤。
        fixture.catalog.restore_asset(&image_a.hash).expect("还原图片");
        fixture.catalog.restore_prompt(&other.id).expect("还原提示词");
        let restored = fixture.catalog.prompt_detail(&other.id).expect("读取详情");
        assert_eq!(restored.linked_image_hashes, vec![image_a.hash.clone()]);
        let seen = fixture
            .catalog
            .index()
            .expect("索引")
            .prompts_for_image(image_a.hash.as_str())
            .expect("反查");
        assert_eq!(seen.len(), 2);
    }

    #[test]
    fn purging_a_prompt_leaves_every_image_byte_and_other_links_alone() {
        let mut fixture = fixture();
        let first = write_png(&fixture.source, "一.png", [255, 0, 0, 255]);
        let second = write_png(&fixture.source, "二.png", [0, 255, 0, 255]);
        let image_a = import_with(&mut fixture.catalog, &first, &[], &[]);
        let image_b = import_with(&mut fixture.catalog, &second, &[], &[]);
        let owner = prompt(&mut fixture.catalog, "留下的一方");
        let other = prompt(&mut fixture.catalog, "被清理的一方");
        fixture
            .catalog
            .link_images(&owner.id, std::slice::from_ref(&image_a.hash))
            .expect("关联");
        fixture
            .catalog
            .link_images(&other.id, &[image_a.hash.clone(), image_b.hash.clone()])
            .expect("关联");
        let library = fixture.catalog.library();
        let sidecar_a = library.sidecar_path(&image_a.hash);
        let sidecar_b = library.sidecar_path(&image_b.hash);
        let body_a = library.body_path(&image_a.hash, &image_a.ext);
        let owner_path = library.prompt_path(&owner.id);
        let sidecar_before = std::fs::read(&sidecar_a).expect("读侧车一");
        let other_sidecar_before = std::fs::read(&sidecar_b).expect("读侧车二");
        let body_before = std::fs::read(&body_a).expect("读本体");
        let owner_before = std::fs::read(&owner_path).expect("读提示词");

        fixture.catalog.delete_prompt(&other.id).expect("删除提示词");
        let report = fixture.catalog.purge_prompt_trash().expect("清空提示词回收站");
        assert_eq!(report.purged, 1);

        // purge 只删提示词自己的文件与派生关联：图片本体、侧车与其他提示词逐字节不变。
        assert_eq!(
            std::fs::read(&sidecar_a).expect("读回侧车一"),
            sidecar_before,
            "purge 提示词不得改动图片侧车"
        );
        assert_eq!(
            std::fs::read(&sidecar_b).expect("读回侧车二"),
            other_sidecar_before
        );
        assert_eq!(std::fs::read(&body_a).expect("读回本体"), body_before);
        assert_eq!(
            std::fs::read(&owner_path).expect("读回提示词"),
            owner_before,
            "其他提示词不受牵连"
        );
        let index = fixture.catalog.index().expect("索引");
        let seen_a = index
            .prompts_for_image(image_a.hash.as_str())
            .expect("反查一");
        assert_eq!(seen_a.len(), 1);
        assert_eq!(seen_a[0].id, owner.id.as_str());
        let seen_b = index
            .prompts_for_image(image_b.hash.as_str())
            .expect("反查二");
        assert!(seen_b.is_empty(), "被 purge 提示词的关联随重建清除");
    }

    #[test]
    fn purging_an_image_cleans_every_prompt_and_failure_keeps_the_pair_intact() {
        // 注入第 0 与第 1 个提示词写入失败：前者一个文件都没碰，后者要求逆序回滚。
        for inject_at in [0usize, 1] {
            let mut fixture = fixture();
            let first = write_png(&fixture.source, "甲.png", [255, 0, 0, 255]);
            let second = write_png(&fixture.source, "乙.png", [0, 255, 0, 255]);
            let image_a = import_with(&mut fixture.catalog, &first, &[], &[]);
            let image_b = import_with(&mut fixture.catalog, &second, &[], &[]);
            let owner = prompt(&mut fixture.catalog, "封面回落");
            fixture
                .catalog
                .link_images(&owner.id, &[image_a.hash.clone(), image_b.hash.clone()])
                .expect("关联");
            // 显式封面指向甲图：设为封面的公开接口在 6.7 落地，这里直接改写权威文件。
            let owner_path = fixture.catalog.library().prompt_path(&owner.id);
            let mut crafted = fixture.catalog.prompt_detail(&owner.id).expect("读取详情");
            crafted.cover_image_hash = Some(image_a.hash.clone());
            crafted.write_atomic(&owner_path).expect("设置显式封面");
            let linked = prompt(&mut fixture.catalog, "回收站关联者");
            fixture
                .catalog
                .link_images(&linked.id, std::slice::from_ref(&image_a.hash))
                .expect("关联");
            fixture.catalog.delete_prompt(&linked.id).expect("删除提示词");
            fixture.catalog.delete_asset(&image_a.hash).expect("删除图片");

            let trash_body = fixture
                .catalog
                .library()
                .trash_body_path(&image_a.hash, &image_a.ext);
            let trash_sidecar = fixture.catalog.library().trash_sidecar_path(&image_a.hash);
            let linked_trash = fixture.catalog.library().prompt_trash_path(&linked.id);
            let owner_before = std::fs::read(&owner_path).expect("读提示词字节");
            let linked_before = std::fs::read(&linked_trash).expect("读回收站提示词字节");
            let body_before = std::fs::read(&trash_body).expect("读回收站本体字节");
            let sidecar_before = std::fs::read(&trash_sidecar).expect("读回收站侧车字节");

            fixture.catalog.inject_metadata_failure_at(inject_at);
            let report = fixture.catalog.purge_trash().expect("清空图片回收站");
            assert_eq!(
                report.failures.len(),
                1,
                "注入第 {inject_at} 个写入失败应让这张图的 purge 整体失败"
            );
            assert_eq!(report.failures[0].hash, image_a.hash.as_str());
            assert_eq!(
                report.failures[0].error.code,
                Code::LibraryAssetMetadataWriteFailed
            );
            // 图片对保持完整，已写回的提示词文件被逆序恢复原字节。
            assert_eq!(
                std::fs::read(&trash_body).expect("读回本体"),
                body_before,
                "清理失败时图片对必须保持完整"
            );
            assert_eq!(std::fs::read(&trash_sidecar).expect("读回侧车"), sidecar_before);
            assert_eq!(
                std::fs::read(&owner_path).expect("读回提示词"),
                owner_before,
                "失败的清理必须恢复已写回的提示词"
            );
            assert_eq!(
                std::fs::read(&linked_trash).expect("读回收站提示词"),
                linked_before
            );

            // 注入只生效一次：再次 purge 成功，所有关联与显式封面被清理。
            let report = fixture.catalog.purge_trash().expect("再次清空图片回收站");
            assert_eq!(report.purged, 1);
            assert!(report.failures.is_empty());
            assert!(!trash_body.exists());
            assert!(!trash_sidecar.exists());
            let detail = fixture.catalog.prompt_detail(&owner.id).expect("读取详情");
            assert_eq!(detail.linked_image_hashes, vec![image_b.hash.clone()]);
            assert_eq!(
                detail.cover_image_hash, None,
                "显式封面指向被 purge 的图时清空，缺省回落到第一张剩余关联"
            );
            let remaining = PromptAsset::read(&linked_trash).expect("读回收站提示词");
            assert!(
                remaining.linked_image_hashes.is_empty(),
                "回收站提示词里的悬空引用同样要清理"
            );
            let seen = fixture
                .catalog
                .index()
                .expect("索引")
                .prompts_for_image(image_a.hash.as_str())
                .expect("反查");
            assert!(seen.is_empty());
        }
    }
}
