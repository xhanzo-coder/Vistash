//! 普通关联与封面：唯一权威方是提示词文件（设计第三条）。
//!
//! 一次关联只改动一份权威文件——提示词的有序 `linked_image_hashes`；图片侧车
//! 不写反向列表，从图片反查提示词走 SQLite 的 `prompt_images` 派生表。双写两侧
//! 只会把一个关系变成两份会分叉的事实。关联没有类型（生成/参考/反推都被设计
//! 明确排除），也不根据文件名或内容猜测。
//!
//! 封面是关联的引用而不是独立数据：`cover_image_hash` 必须指向已关联的一张，
//! 缺省表示"用第一张正常关联图片"。解除关联或图片被 purge 时按顺序回落。

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
}
