//! 素材编目：逻辑文件夹、标签、查询和回收站生命周期的一致性入口。
//!
//! `Catalog` 是命令层唯一的库一致性入口（设计第五条）。本模块只保留这个类型本身、
//! 它的构造、索引访问与跨领域共用的原子写入，各领域实现拆进兄弟模块：
//!
//! - [`image_metadata`]：图片的文件夹、标签与批量权威写入事务。
//! - [`lifecycle`]：图片的删除、还原与永久删除。
//! - [`query`]：派生索引查询与索引重建。
//!
//! 拆分的理由是 locality 与可导航性，不是分层：原先的单文件已经超过两千行，而图片
//! 组织、生命周期与查询这三类改动会反复在同一个文件里互相穿插。拆分之后公开面一个
//! 字节都没变——子模块里只放 `impl Catalog`，公开类型仍由本模块重新导出，因此命令层
//! 不需要知道内部分成了几个文件。
//!
//! 子模块能直接读写 `Catalog` 的私有字段：私有项对定义模块及其后代可见，而这正是
//! 这次拆分想要的边界——对外只有一个 `Catalog`，对内各领域仍共享同一份状态与同一个
//! 索引失效处理，不必为拆分而把字段公开出去。
//!
//! 提示词元数据与普通关联/封面按同一规则各自成为兄弟模块，由任务 4.x 与 6.x 在有实际
//! 内容时建立。现在就建立空模块只会留下一层没有内容的间接。

mod image_metadata;
mod lifecycle;
mod prompt_metadata;
mod query;
#[cfg(test)]
mod testing;

pub use image_metadata::{FolderMutationProgress, FolderName, FolderPath, Tag};
pub use lifecycle::{PurgeFailure, PurgeReport, RestoreOutcome};
pub use prompt_metadata::{NewPrompt, PromptEdit};
pub use query::{
    AssetLocation, AssetQuery, CatalogSnapshot, FolderFilter, PromptLocation, PromptQuery,
    PromptSnapshot, TagUsage,
};

#[cfg(test)]
use lifecycle::LifecycleStage;

use crate::error::{AppError, Code, Result};
use crate::hashing::ContentHash;
use crate::index::Index;
use crate::library::Library;
use crate::sidecar::AssetSidecar;
use std::path::Path;

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

    /// 每次权威元数据写入前调用。测试可注入第 n 次写入失败，验证批量事务的回滚。
    ///
    /// 图片与提示词两个领域模块共用这一个计数器：注入点是"第几次权威写入"，
    /// 与写入的是哪棵树无关。
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
