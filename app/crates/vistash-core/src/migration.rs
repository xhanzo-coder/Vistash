//! 库格式迁移的持久化 journal 与备份布局。
//!
//! 迁移要重写全库的图片侧车（设计第四条），因此它必然是一个可以被断电、被任务管理器
//! 结束、被杀毒软件打断的长操作。journal 存在的唯一理由是：进程下次启动时必须能判断
//! "上次迁移走到哪一步"，并据此继续或回滚，而 MUST NOT 把一个混合了 v1 与 v2 侧车的
//! 目录当成正常库打开。
//!
//! 因此 journal 本身也是权威数据：它损坏时不能猜测，只能如实报错。

use crate::error::{AppError, Code, Result};
use crate::hashing::ContentHash;
use crate::library::{
    CurrentLibraryMeta, LibraryId, LibraryMeta, LibraryMetaV2, LibraryMetaV3, FOLDERS_FILE,
    INDEX_FILE, LIBRARY_FORMAT_VERSION_V2, LIBRARY_FORMAT_VERSION_V3, META_FILE, OBJECTS_DIR,
    PROMPTS_DIR, PROMPT_FOLDERS_FILE, PROMPT_OBJECTS_DIR, PROMPT_TRASH_DIR, TRASH_DIR,
};
use crate::prompt::PromptFolderList;
use crate::sidecar::{
    AssetSidecarV1, AssetSidecarV2, AssetSidecarV3, AssetSource, DisplayFilename,
    SIDECAR_FORMAT_VERSION_V2, SIDECAR_FORMAT_VERSION_V3,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// journal 自身的格式版本。它与库格式版本分开：journal 是迁移过程的记录，
/// 其结构演进节奏与库内素材格式无关。
pub const MIGRATION_JOURNAL_FORMAT_VERSION: u32 = 1;

/// journal 文件名。放在库根而不是子目录，使"库里有没有未完成的迁移"只需一次
/// `is_file` 就能回答，不必先决定去哪个子树里找。
pub const JOURNAL_FILE: &str = "migration-journal.json";

/// 原字节备份树的目录名。回滚要恢复的是原始字节，因此备份不做任何格式转换。
pub const BACKUP_DIR: &str = "migration-backup";

/// 迁移的阶段。
///
/// 阶段是粗粒度的，逐个文件的进度由 `entries` 承载：两者混在一起会让"当前阶段"
/// 在每写一个侧车时都要更新，而 journal 每次更新都是一次磁盘写。
///
/// 变体声明顺序就是阶段先后顺序，`Ord` 由此派生：迁移与恢复反复要问"这一步做完了吗"，
/// 写成 `journal.stage < MigrationStage::X` 比逐个列举 match 分支更不容易在将来
/// 新增阶段时漏掉一处判断。因此新阶段必须插在它真正发生的位置，而不是追加到末尾。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MigrationStage {
    /// 已取得迁移锁、已写下 journal 与备份树，尚未改动任何权威文件。
    Started,
    /// 提示词目录、提示词文件夹清单与 `library_id` 已就绪，但库版本尚未提升。
    SkeletonReady,
    /// 全部图片侧车已重写为 v2。
    SidecarsRewritten,
    /// v2 派生索引已重建并通过迁移前后快照比较。
    IndexRebuilt,
    /// v2 `library.json` 已原子提交，只剩清理 journal 与备份。
    ///
    /// 这个阶段看似多余（提交后就该删 journal），但它正是"提交成功、清理前崩溃"
    /// 这一情形的唯一区分依据：没有它，下次开库会看到一个 v2 库加一份未完成
    /// journal，从而把一次已经成功的迁移回滚掉。
    Committed,
}

impl MigrationStage {
    /// 稳定的字符串标识，与序列化形式一致。日志与进度事件都用它。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Started => "started",
            Self::SkeletonReady => "skeleton_ready",
            Self::SidecarsRewritten => "sidecars_rewritten",
            Self::IndexRebuilt => "index_rebuilt",
            Self::Committed => "committed",
        }
    }
}

/// 单个待迁移侧车的状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JournalEntryState {
    /// 已登记，尚未备份。
    Pending,
    /// 原字节已进入备份树，可以安全改写。
    BackedUp,
    /// 已写出 v2 侧车。
    Rewritten,
    /// 已用备份恢复为原字节。
    RolledBack,
}

impl JournalEntryState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::BackedUp => "backed_up",
            Self::Rewritten => "rewritten",
            Self::RolledBack => "rolled_back",
        }
    }
}

/// journal 中的一条侧车记录。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JournalEntry {
    /// 相对库根的侧车路径，例如 `objects/3f/a9/3fa9….json`。
    ///
    /// 刻意不存绝对路径：库整体复制或移动到另一台机器后，绝对路径全部失效，而迁移
    /// 恢复恰恰要在"库被移动过"之后仍然可用。
    pub sidecar_relative_path: String,
    pub state: JournalEntryState,
}

/// 一次 v1→v2 迁移的完整记录。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MigrationJournal {
    pub format_version: u32,
    /// 本次迁移为库分配的稳定 ID。
    ///
    /// 它在提交 `library.json` 之前就被写进 journal：若只在提交时才生成，一次中断
    /// 恢复就会分配出第二个 ID，而前端的分库布局偏好正是以它为键。
    pub library_id: LibraryId,
    pub from_version: u32,
    pub to_version: u32,
    pub started_at: DateTime<Utc>,
    pub stage: MigrationStage,
    pub entries: Vec<JournalEntry>,
}

impl MigrationJournal {
    /// 校验格式级不变量。
    ///
    /// 与提示词文件同理：journal 可能被外部程序改写或被上一次崩溃写坏，而恢复逻辑
    /// 完全依赖它。读与写共用同一份校验，才能保证"能读出来的 journal 一定可用"。
    pub fn validate(&self) -> Result<()> {
        if self.to_version <= self.from_version {
            return Err(AppError::detailed(
                Code::MigrationJournalCorrupt,
                format!(
                    "迁移没有推进库格式版本：from {} to {}",
                    self.from_version, self.to_version
                ),
            ));
        }
        let mut seen = std::collections::BTreeSet::new();
        for entry in &self.entries {
            if !seen.insert(entry.sidecar_relative_path.as_str()) {
                return Err(AppError::detailed(
                    Code::MigrationJournalCorrupt,
                    format!(
                        "journal 中同一个侧车出现多条记录：{}",
                        entry.sidecar_relative_path
                    ),
                ));
            }
        }
        Ok(())
    }

    pub fn read(path: &Path) -> Result<Self> {
        let bytes = std::fs::read(path).map_err(|e| {
            AppError::detailed(
                Code::LibraryIoFailed,
                format!("读取迁移 journal 失败 {}: {e}", path.display()),
            )
        })?;
        let journal: Self = serde_json::from_slice(&bytes).map_err(|e| {
            AppError::detailed(
                Code::MigrationJournalCorrupt,
                format!("迁移 journal 无法解析 {}: {e}", path.display()),
            )
        })?;
        if journal.format_version > MIGRATION_JOURNAL_FORMAT_VERSION {
            return Err(AppError::detailed(
                Code::MigrationJournalFormatTooNew,
                format!(
                    "迁移 journal 格式版本 {} 高于程序支持的 {}：{}",
                    journal.format_version,
                    MIGRATION_JOURNAL_FORMAT_VERSION,
                    path.display()
                ),
            ));
        }
        journal.validate()?;
        Ok(journal)
    }

    /// 写入 journal。每次状态推进都要落盘，因此这里同样是先写临时文件再改名——
    /// 一份写到一半的 journal 会让恢复逻辑既不能继续也不能回滚。
    pub fn write_atomic(&self, path: &Path) -> Result<()> {
        self.validate()?;
        let code = Code::MigrationJournalWriteFailed;
        let io_err = |e: std::io::Error, what: &str| {
            AppError::detailed(code, format!("{what} {}: {e}", path.display()))
        };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| io_err(e, "建立 journal 目录失败"))?;
        }
        let json = serde_json::to_vec_pretty(self)
            .map_err(|e| AppError::detailed(code, format!("序列化迁移 journal 失败: {e}")))?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, &json).map_err(|e| io_err(e, "写入临时 journal 失败"))?;
        std::fs::rename(&tmp, path).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            io_err(e, "提交 journal 失败")
        })
    }
}

/// 迁移锁文件名。
///
/// 用"文件存在即持有"而不是操作系统级文件锁：迁移可能跨越数分钟，而进程被强制结束时
/// 操作系统锁会立刻释放，留下一个没人负责的半迁移库；文件锁留在磁盘上，反而能让下一次
/// 开库看到"上次有人在迁移"。
pub const LOCK_FILE: &str = "migration.lock";

/// 库目录当前处于哪种格式状态。
///
/// 开库入口必须先问这个，而不是直接 `Library::open`：v1 库缺少 v2 的必填字段，直接按
/// v2 解析只会得到"元数据损坏"，而真实情况是"这个库还没迁移"——两者的处理方式完全不同。
#[derive(Debug, Clone, PartialEq)]
pub enum LibraryFormatState {
    /// 已经是当前程序支持的某一代（v2 或 v3），可以直接打开。
    Current(CurrentLibraryMeta),
    /// 旧格式，需要一次一次性迁移。
    NeedsMigration { from_version: u32 },
    /// 上次迁移没有走完。必须先继续或回滚，MUST NOT 当成正常库打开。
    MigrationIncomplete(MigrationJournal),
}

/// 判定库目录当前的格式状态。
pub fn detect_library_format(root: &Path) -> Result<LibraryFormatState> {
    let meta_path = root.join(META_FILE);
    if !meta_path.is_file() {
        return Err(AppError::detailed(
            Code::LibraryNotFound,
            format!("目录中没有 {META_FILE}：{}", root.display()),
        ));
    }
    // journal 的判断必须先于版本号：被中断的迁移里 `library.json` 仍然是旧版本，
    // 只看版本号会把一个半迁移的库判成"还没开始迁移"，于是第二次迁移会以已经重写成
    // v2 的侧车为输入从头再来，而那正是设计第四条禁止的情形。
    let journal_path = root.join(JOURNAL_FILE);
    if journal_path.is_file() {
        return Ok(LibraryFormatState::MigrationIncomplete(
            MigrationJournal::read(&journal_path)?,
        ));
    }
    let format_version = read_format_version(&meta_path)?;
    if format_version > LIBRARY_FORMAT_VERSION_V3 {
        return Err(AppError::detailed(
            Code::LibraryFormatTooNew,
            format!(
                "库格式版本 {format_version} 高于程序支持的 {LIBRARY_FORMAT_VERSION_V3}：{}",
                root.display()
            ),
        ));
    }
    match format_version {
        LIBRARY_FORMAT_VERSION_V3 => Ok(LibraryFormatState::Current(
            CurrentLibraryMeta::V3(LibraryMetaV3::read(&meta_path)?),
        )),
        LIBRARY_FORMAT_VERSION_V2 => Ok(LibraryFormatState::Current(
            CurrentLibraryMeta::V2(LibraryMetaV2::read(&meta_path)?),
        )),
        _ => Ok(LibraryFormatState::NeedsMigration {
            from_version: format_version,
        }),
    }
}

/// 只读出 `library.json` 的格式版本。
///
/// 不能借 [`LibraryMetaV2::read`] 顺带回答这件事：v1 文件与更高版本的文件都缺少 v2 的
/// 必填字段，serde 会先以"元数据损坏"失败，而两者的真实含义分别是"需要迁移"和"版本过新"。
/// 把三种情况压成一种错误，等于让使用者对一个完全正常的旧库看到"库已损坏"。
fn read_format_version(meta_path: &Path) -> Result<u32> {
    #[derive(Deserialize)]
    struct Probe {
        format_version: u32,
    }
    let bytes = std::fs::read(meta_path).map_err(|e| {
        AppError::detailed(
            Code::LibraryPathUnreadable,
            format!("读取 {META_FILE} 失败 {}: {e}", meta_path.display()),
        )
    })?;
    let probe: Probe = serde_json::from_slice(&bytes).map_err(|e| {
        AppError::detailed(
            Code::LibraryMetadataCorrupt,
            format!("{META_FILE} 中读不出格式版本 {}: {e}", meta_path.display()),
        )
    })?;
    Ok(probe.format_version)
}

/// 迁移进度。字段与文件夹批量改名的进度保持同一形状，使前端只需要一种进度呈现。
#[derive(Debug, Clone, PartialEq)]
pub struct MigrationProgress {
    /// 这批计数属于哪个阶段。
    ///
    /// 与 [`MigrationJournal::stage`] 的含义刻意不同：journal 记的是"已经做完的阶段"，
    /// 因为恢复要据此决定从哪一步接着做；进度记的是"正在做的阶段"，因为进度条要在
    /// 事情发生时就说明自己在做什么。两者同名不同义，混用会让恢复少做或多做一步。
    pub stage: MigrationStage,
    pub done: usize,
    pub total: usize,
    /// 当前处理的侧车文件名，不含路径。进度界面要显示"正在处理哪一个"。
    pub current_filename: String,
}

/// 迁移结果。
#[derive(Debug, Clone, PartialEq)]
pub struct MigrationOutcome {
    pub library_id: LibraryId,
    pub sidecars_rewritten: usize,
    /// 本次是否是从上一次未完成的迁移继续的。
    pub resumed: bool,
}

/// v2→v3 迁移中一个图片文件夹归属的规划结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum V3FolderPlan {
    /// 零归属映射为 `None`，单归属原样保留。
    Automatic(Option<String>),
    /// 多归属不能猜测，必须由使用者选择唯一目标。
    Conflict(Vec<String>),
}

/// v2→v3 迁移计划中的单个侧车。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3MigrationPlanEntry {
    pub sidecar_relative_path: String,
    pub source_sidecar_sha256: ContentHash,
    pub hash: ContentHash,
    pub original_filename: String,
    pub folder: V3FolderPlan,
}

/// v2→v3 的只读迁移计划。
///
/// 规划只读取权威侧车并记录字节摘要，不创建 journal、备份或临时文件。冲突仍以
/// [`V3FolderPlan::Conflict`] 保留，后续提交阶段必须拿到使用者明确选择。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3MigrationPlan {
    pub entries: Vec<V3MigrationPlanEntry>,
}

/// 使用者对一个多归属素材选择的唯一保留文件夹。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3FolderResolution {
    pub hash: ContentHash,
    pub folder: String,
}

/// 已经解决全部冲突、可以交给提交阶段的单个 v3 计划项。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedV3MigrationPlanEntry {
    pub sidecar_relative_path: String,
    pub source_sidecar_sha256: ContentHash,
    pub hash: ContentHash,
    pub original_filename: String,
    pub folder: Option<String>,
}

/// 已经解决全部冲突的 v3 迁移计划。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedV3MigrationPlan {
    pub entries: Vec<ResolvedV3MigrationPlanEntry>,
}

impl ResolvedV3MigrationPlan {
    /// 提交前的最后校验：规划时读取的每个侧车仍与记录的 SHA-256 完全相同。
    ///
    /// 与 [`V3MigrationPlan::verify_source_unchanged`] 校验同一件事——解决冲突不改变
    /// 输入侧车的身份，两处共用一份实现，避免一处检查集合、另一处漏掉。
    ///
    /// # Errors
    ///
    /// 路径越界、侧车丢失或摘要变化返回 `migration.plan_stale`。
    pub fn verify_source_unchanged(&self, root: &Path) -> Result<()> {
        let planned: Vec<(&str, &ContentHash)> = self
            .entries
            .iter()
            .map(|entry| {
                (
                    entry.sidecar_relative_path.as_str(),
                    &entry.source_sidecar_sha256,
                )
            })
            .collect();
        verify_plan_inputs_unchanged(root, &planned)
    }
}

impl V3MigrationPlan {
    /// 扫描一个完整 v2 库，生成不会修改权威字节的 v3 计划。
    ///
    /// # Errors
    ///
    /// 库不是完整 v2 状态、目录不可读或任一 v2 侧车损坏时返回稳定错误。
    pub fn inspect(root: &Path) -> Result<Self> {
        match detect_library_format(root)? {
            // 只接受 v2 输入。对已是 v3 的库再规划一次，提交阶段会把 v3 侧车当 v2
            // 解析并用垃圾字段顶替权威字节——门禁必须在读第一个侧车之前就拒绝。
            LibraryFormatState::Current(CurrentLibraryMeta::V2(_)) => {}
            LibraryFormatState::Current(CurrentLibraryMeta::V3(_)) => {
                return Err(AppError::detailed(
                    Code::MigrationPlanStale,
                    "库已经是 v3 格式，v2→v3 迁移没有可做的工作",
                ));
            }
            LibraryFormatState::NeedsMigration { from_version } => {
                return Err(AppError::detailed(
                    Code::LibraryFormatTooOld,
                    format!("库格式版本 {from_version} 尚未迁移到 v2"),
                ));
            }
            LibraryFormatState::MigrationIncomplete(_) => {
                return Err(AppError::new(Code::MigrationInterrupted));
            }
        }

        let mut entries = Vec::new();
        for path in collect_sidecars(root)? {
            let bytes = std::fs::read(&path).map_err(|error| {
                AppError::detailed(
                    Code::LibraryIoFailed,
                    format!("读取 v3 迁移输入失败 {}: {error}", path.display()),
                )
            })?;
            let sidecar: AssetSidecarV2 = serde_json::from_slice(&bytes).map_err(|error| {
                AppError::detailed(
                    Code::LibraryMetadataCorrupt,
                    format!("v3 迁移输入无法按 v2 解析 {}: {error}", path.display()),
                )
            })?;
            if sidecar.format_version != SIDECAR_FORMAT_VERSION_V2 {
                return Err(AppError::detailed(
                    Code::LibraryMetadataCorrupt,
                    format!(
                        "v3 迁移输入侧车版本不是 {}：{}",
                        SIDECAR_FORMAT_VERSION_V2,
                        path.display()
                    ),
                ));
            }
            let folder = match sidecar.folders.as_slice() {
                [] => V3FolderPlan::Automatic(None),
                [folder] => V3FolderPlan::Automatic(Some(folder.clone())),
                folders => V3FolderPlan::Conflict(folders.to_vec()),
            };
            entries.push(V3MigrationPlanEntry {
                sidecar_relative_path: relative_key(root, &path)?,
                source_sidecar_sha256: ContentHash::of_bytes(&bytes),
                hash: sidecar.hash,
                original_filename: sidecar.original_filename,
                folder,
            });
        }
        Ok(Self { entries })
    }

    /// 检查规划时读取的每个侧车仍与记录的 SHA-256 完全相同。
    ///
    /// # Errors
    ///
    /// 路径越界、侧车丢失或摘要变化返回 `migration.plan_stale`。
    pub fn verify_source_unchanged(&self, root: &Path) -> Result<()> {
        let planned: Vec<(&str, &ContentHash)> = self
            .entries
            .iter()
            .map(|entry| {
                (
                    entry.sidecar_relative_path.as_str(),
                    &entry.source_sidecar_sha256,
                )
            })
            .collect();
        verify_plan_inputs_unchanged(root, &planned)
    }

    /// 应用使用者对全部多归属冲突的唯一选择。
    ///
    /// # Errors
    ///
    /// 选择缺失、重复、指向无冲突素材或不是原归属时，返回
    /// `migration.resolution_invalid`。
    pub fn resolve(&self, resolutions: &[V3FolderResolution]) -> Result<ResolvedV3MigrationPlan> {
        let mut choices = std::collections::BTreeMap::new();
        for resolution in resolutions {
            if choices
                .insert(resolution.hash.clone(), resolution.folder.as_str())
                .is_some()
            {
                return Err(invalid_v3_resolution(format!(
                    "素材 {} 出现重复选择",
                    resolution.hash.as_str()
                )));
            }
        }

        let mut entries = Vec::with_capacity(self.entries.len());
        for entry in &self.entries {
            let folder = match &entry.folder {
                V3FolderPlan::Automatic(folder) => {
                    if choices.remove(&entry.hash).is_some() {
                        return Err(invalid_v3_resolution(format!(
                            "无冲突素材 {} 不接受人工选择",
                            entry.hash.as_str()
                        )));
                    }
                    folder.clone()
                }
                V3FolderPlan::Conflict(folders) => {
                    let choice = choices.remove(&entry.hash).ok_or_else(|| {
                        invalid_v3_resolution(format!(
                            "素材 {} 缺少唯一文件夹选择",
                            entry.hash.as_str()
                        ))
                    })?;
                    if !folders.iter().any(|folder| folder == choice) {
                        return Err(invalid_v3_resolution(format!(
                            "素材 {} 的选择 {choice:?} 不是原归属",
                            entry.hash.as_str()
                        )));
                    }
                    Some(choice.to_owned())
                }
            };
            entries.push(ResolvedV3MigrationPlanEntry {
                sidecar_relative_path: entry.sidecar_relative_path.clone(),
                source_sidecar_sha256: entry.source_sidecar_sha256.clone(),
                hash: entry.hash.clone(),
                original_filename: entry.original_filename.clone(),
                folder,
            });
        }
        if let Some((hash, _)) = choices.first_key_value() {
            return Err(invalid_v3_resolution(format!(
                "选择指向计划外素材 {}",
                hash.as_str()
            )));
        }
        Ok(ResolvedV3MigrationPlan { entries })
    }
}

// ---------------------------------------------------------------------------
// v2→v3 迁移提交
//
// 设计第九条的提交流程：校验计划 → 把新侧车与新库级元数据写入库内同卷暂存区 →
// 写恢复日志并把旧权威元数据备份进同一工作目录 → 逐项原子替换 → 删除并重建派生
// 索引 → 校验不变量 → 删除恢复日志并清理。任一步失败按恢复日志整体回滚；进程在
// 提交期间被结束时，下次开库必须先经 [`recover_interrupted_v3_commit`] 回滚。
//
// 恢复方向刻意是回滚而不是续跑：替换一旦开始就不存在安全的中间继续点，而回滚后
// 的库与迁移前逐字节相同，重新规划的成本只是重做冲突选择。
//
// 收尾顺序刻意把“删恢复日志”放在清理的最前面：日志一消失，“上次已经完成”就有了
// 唯一判据，不存在把成功的迁移误判成需要回滚的窗口；其后的残留都只是垃圾。

/// v2→v3 迁移工作目录的父目录名，位于库根下。
///
/// “同卷暂存”不是一句注释而是这个常量：暂存放在库内，随后的替换才能用同卷改名
/// 完成原子顶替；放到系统临时目录就可能在另一个卷上，Windows 的跨卷改名退化为
/// 复制，中途断电会留下两份半成品。
pub const MIGRATION_WORK_DIR: &str = "migration-work";

/// 恢复日志文件名，位于一次提交的唯一会话子目录内。
pub const RECOVERY_LOG_FILE: &str = "recovery-log.json";

/// v2→v3 提交的阶段。变体声明顺序即发生顺序，`Ord` 由此派生：恢复与故障注入都用
/// “这一步做完了吗”的形式比较，新增阶段必须插在它真正发生的位置而不是追加到末尾。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum V3CommitStage {
    /// 全部新侧车与新库级元数据已写入会话暂存区；权威字节尚未改动。
    Staged,
    /// 恢复日志已落盘，旧权威元数据已备份进会话目录。此后进入替换阶段。
    Journaled,
    /// 全部权威侧车与库级元数据已逐项原子替换为 v3。
    Replaced,
    /// SQLite 派生索引已删除并按新元数据重建。
    IndexRebuilt,
    /// 迁移前后不变量校验通过。此后只剩删除日志与清理备份。
    Validated,
}

impl V3CommitStage {
    /// 稳定字符串标识，与将来的序列化形式一致。日志与进度事件共用它。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Staged => "staged",
            Self::Journaled => "journaled",
            Self::Replaced => "replaced",
            Self::IndexRebuilt => "index_rebuilt",
            Self::Validated => "validated",
        }
    }
}

/// v2→v3 提交进度。字段与 [`MigrationProgress`] 保持同一形状，前端只需要一种进度呈现。
#[derive(Debug, Clone, PartialEq)]
pub struct V3CommitProgress {
    pub stage: V3CommitStage,
    pub done: usize,
    pub total: usize,
    pub current_filename: String,
}

/// 对未完成 v2→v3 提交执行恢复的结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3Recovery {
    /// 库内没有未完成的迁移。
    NothingToDo,
    /// 库回到提交前的 v2 状态，可以重新规划迁移。既包括按恢复日志把旧元数据放回，
    /// 也包括把从未触碰权威文件的垃圾暂存直接丢弃。
    RolledBack,
    /// 上次提交其实已经全部完成，只在删除日志之后、清理目录之前被结束；
    /// 库保持 v3，本次只移除了残留的工作目录与锁。
    CompletedResidueCleaned,
}

/// 开库门禁调用的恢复入口：检测未完成的 v2→v3 提交并整体回滚。
///
/// 替换阶段开始过的崩溃可能留下按新元数据重建的派生索引，因此恢复与提交共用同一个
/// `rebuild_index` 注入，保证恢复出的旧元数据始终配得上一份一致的索引。
///
/// # Errors
///
/// 恢复日志损坏时返回 `migration.journal_corrupt` 并原样保留现场，不做猜测式修复。
pub fn recover_interrupted_v3_commit(
    root: &Path,
    rebuild_index: &mut dyn FnMut(&Path) -> Result<()>,
) -> Result<V3Recovery> {
    let session = match sole_v3_session_dir(root)? {
        Some(session) => session,
        None => {
            // 工作目录不存在，或只剩没有任何会话信息的空壳：后者没有可回滚依据，
            // 直接清掉即可。锁同样按垃圾处理——没有会话就辨认不出持锁者。
            // 反过来，工作目录整个不存在时绝不动锁：那把锁可能属于一次仍在进行的
            // v1→v2 迁移，它有自己的恢复入口。
            remove_work_dir(root)?;
            release_migration_lock(root)?;
            return Ok(V3Recovery::NothingToDo);
        }
    };
    let log_path = session.join(RECOVERY_LOG_FILE);
    if !log_path.is_file() {
        // 没有日志的会话只有两种可能，用库版本区分：v2 说明中断发生在写日志之前，
        // 权威字节从未被改动，暂存只是垃圾；v3 说明上次提交其实已经全部完成，只在
        // “删日志之后、清目录之前”被打断——这正是收尾顺序把删日志放在最前面的理由，
        // 它一消失，“已完成”就有了唯一判据，不存在把成功误判成需要回滚的窗口。
        let version = read_format_version(&root.join(META_FILE))?;
        let recovered = match version {
            LIBRARY_FORMAT_VERSION_V3 => V3Recovery::CompletedResidueCleaned,
            LIBRARY_FORMAT_VERSION_V2 => V3Recovery::RolledBack,
            other => {
                return Err(AppError::detailed(
                    Code::LibraryMetadataCorrupt,
                    format!("无恢复日志的迁移工作目录对应异常库格式版本 {other}"),
                ));
            }
        };
        remove_work_dir(root)?;
        release_migration_lock(root)?;
        return Ok(recovered);
    }

    // 日志存在就必须能读懂，否则不动手：损坏的日志既不能证明该回滚、也不能证明
    // 该继续，猜测任何一种都可能写坏权威数据。
    let log = V3RecoveryLog::read(&log_path)?;
    // 身份核对：日志声称属于另一个库时不能动手。此刻元数据读不出来不阻塞——
    // 回滚本来就要用备份把它原样放回。
    #[derive(Deserialize)]
    struct LibraryIdProbe {
        library_id: LibraryId,
    }
    if let Ok(bytes) = std::fs::read(root.join(META_FILE)) {
        if let Ok(probe) = serde_json::from_slice::<LibraryIdProbe>(&bytes) {
            if probe.library_id != log.library_id {
                return Err(AppError::detailed(
                    Code::MigrationJournalCorrupt,
                    format!(
                        "恢复日志声称的库身份 {} 与当前库不一致",
                        log.library_id.as_str()
                    ),
                ));
            }
        }
    }

    // 整体回滚：备份树盖回权威位置，再重建派生索引。索引必须重建而不是沿用：
    // 替换开始过的崩溃可能已经留下按新元数据建好的索引，恢复出的旧元数据配不上它。
    // 回滚中途的失败一律以 migration.rollback_failed 上报——那时库里可能同时存在
    // 新旧两种元数据，这比具体哪一步复制失败更优先需要被看到。
    (|| -> Result<()> {
        restore_backup_tree(root, &session.join(BACKUP_SUBDIR))?;
        rebuild_index(root).map_err(|e| {
            AppError::detailed(
                Code::MigrationRollbackFailed,
                format!("恢复期间重建索引失败：{e}"),
            )
        })?;
        remove_work_dir(root)?;
        release_migration_lock(root)
    })()
    .map_err(|step| {
        AppError::detailed(
            Code::MigrationRollbackFailed,
            format!("回滚未完成的 v2→v3 提交失败：{step}"),
        )
    })?;
    Ok(V3Recovery::RolledBack)
}

/// v2→v3 迁移提交执行器。输入是已完成全部冲突选择的 [`ResolvedV3MigrationPlan`]。
///
/// 与 v1→v2 的 [`Migration`] 相同，派生索引的重建由调用方以闭包注入：索引结构属于
/// `Catalog`，提交只负责权威文件，并让“索引重建失败”成为可测的输入。
pub struct V3MigrationCommit<'a> {
    plan: &'a ResolvedV3MigrationPlan,
    root: PathBuf,
    #[cfg(test)]
    fail_staging_write_at: Option<usize>,
    #[cfg(test)]
    fail_replacement_at: Option<usize>,
    #[cfg(test)]
    interrupt_after_stage: Option<V3CommitStage>,
}

impl<'a> V3MigrationCommit<'a> {
    pub fn new(plan: &'a ResolvedV3MigrationPlan, root: &Path) -> Self {
        Self {
            plan,
            root: root.to_path_buf(),
            #[cfg(test)]
            fail_staging_write_at: None,
            #[cfg(test)]
            fail_replacement_at: None,
            #[cfg(test)]
            interrupt_after_stage: None,
        }
    }

    /// 执行整次提交。任一步失败都在整体回滚完成后才返回错误。
    ///
    /// # Errors
    ///
    /// 计划过期、任一写入步骤失败或索引重建失败时返回稳定错误码。进程中断由测试注入
    /// 模拟为返回 `migration.interrupted`；生产中的真实中断没有任何代码在运行，
    /// 由下一次开库的 [`recover_interrupted_v3_commit`] 处理。
    pub fn run(
        &self,
        rebuild_index: &mut dyn FnMut(&Path) -> Result<()>,
        progress: &mut dyn FnMut(V3CommitProgress),
    ) -> Result<()> {
        // 门禁一：只接受完整的 v2 库。已是 v3 的库没有可提交的工作，继续提交会用
        // 垃圾字段顶替权威字节；被中断的迁移必须先走各自的恢复入口，否则“半迁移”
        // 的输入会把两种格式的侧车混在一起提交。
        let meta = match detect_library_format(&self.root)? {
            LibraryFormatState::Current(CurrentLibraryMeta::V2(meta)) => meta,
            LibraryFormatState::Current(CurrentLibraryMeta::V3(_)) => {
                return Err(AppError::detailed(
                    Code::MigrationPlanStale,
                    "库已经是 v3 格式，v2→v3 迁移提交没有可做的工作",
                ));
            }
            LibraryFormatState::NeedsMigration { from_version } => {
                return Err(AppError::detailed(
                    Code::LibraryFormatTooOld,
                    format!("库格式版本 {from_version} 尚未迁移到 v2"),
                ));
            }
            LibraryFormatState::MigrationIncomplete(_) => {
                return Err(AppError::new(Code::MigrationInterrupted));
            }
        };
        // 门禁二：规划读取的每个侧车仍与字节摘要一致，集合也不增不减。
        self.plan.verify_source_unchanged(&self.root)?;

        acquire_migration_lock(&self.root)?;
        match self.advance(&meta, rebuild_index, progress) {
            Ok(()) => Ok(()),
            // 中断刻意既不回滚也不清理：进程真的被结束时不会有任何代码运行，留下的
            // 会话目录正是下一次开库恢复的依据（见 recover_interrupted_v3_commit）。
            Err(e) if e.code == Code::MigrationInterrupted => Err(e),
            Err(cause) => Err(self.roll_back(cause)),
        }
    }

    /// 提交主体。阶段顺序即设计第九条的流程，每段之间以 [`Self::checkpoint`] 划界。
    fn advance(
        &self,
        meta: &LibraryMetaV2,
        rebuild_index: &mut dyn FnMut(&Path) -> Result<()>,
        progress: &mut dyn FnMut(V3CommitProgress),
    ) -> Result<()> {
        let session = self.create_session()?;
        // 暂存与替换共用同一份单元清单：计划顺序由 inspect 按路径排序产出，是确定的；
        // 库级元数据固定最后——版本号最后落地，替换中途的磁盘看起来始终像旧库。
        let total_units = self.plan.entries.len() + 1;
        let meta_nth = self.plan.entries.len();

        // —— 暂存：全部新字节进入会话目录，权威字节尚未改动。——
        for (nth, entry) in self.plan.entries.iter().enumerate() {
            if self.staging_should_fail(nth) {
                return Err(staging_failed(format!(
                    "写入第 {nth} 个暂存单元失败：{}",
                    file_name_of(&entry.sidecar_relative_path)
                )));
            }
            let source_path = plan_sidecar_path(&self.root, &entry.sidecar_relative_path)?;
            let bytes = std::fs::read(&source_path).map_err(|e| {
                staging_failed(format!("读取 v2 侧车失败 {}: {e}", source_path.display()))
            })?;
            let v2: AssetSidecarV2 = serde_json::from_slice(&bytes).map_err(|e| {
                staging_failed(format!("v2 侧车无法解析 {}: {e}", source_path.display()))
            })?;
            let v3 = convert_sidecar_v2_to_v3(&v2, entry.folder.as_deref())?;
            let staged = session.join(STAGING_SUBDIR).join(&entry.sidecar_relative_path);
            v3.write_atomic(&staged).map_err(|e| {
                staging_failed(format!("写入暂存侧车失败 {}: {e}", staged.display()))
            })?;
            emit_progress(progress, V3CommitStage::Staged, nth + 1, total_units, file_name_of(&entry.sidecar_relative_path));
        }
        if self.staging_should_fail(meta_nth) {
            return Err(staging_failed(format!(
                "写入第 {meta_nth} 个暂存单元失败：{META_FILE}"
            )));
        }
        let staged_meta = staged_meta_json(meta)?;
        let staged_meta_path = session.join(STAGING_SUBDIR).join(META_FILE);
        write_atomic_bytes(&staged_meta_path, &staged_meta).map_err(|e| {
            staging_failed(format!(
                "写入暂存库元数据失败 {}: {e}",
                staged_meta_path.display()
            ))
        })?;
        emit_progress(progress, V3CommitStage::Staged, total_units, total_units, META_FILE.to_owned());
        self.checkpoint(&session, V3CommitStage::Staged)?;

        // —— 备份 + 日志。备份全部完成后日志才落盘：日志的存在因此就等价于
        // “备份树完整”，回滚的唯一判据由此而来。——
        self.back_up_authority(&session)?;
        let log = V3RecoveryLog {
            format_version: V3_RECOVERY_LOG_FORMAT_VERSION,
            library_id: meta.library_id.clone(),
            from_version: LIBRARY_FORMAT_VERSION_V2,
            to_version: LIBRARY_FORMAT_VERSION_V3,
            started_at: Utc::now(),
            stage: V3CommitStage::Journaled,
        };
        let log_path = session.join(RECOVERY_LOG_FILE);
        log.write_atomic(&log_path)?;
        emit_progress(progress, V3CommitStage::Journaled, total_units, total_units, RECOVERY_LOG_FILE.to_owned());
        self.checkpoint(&session, V3CommitStage::Journaled)?;

        // —— 替换：逐个同卷改名原子顶替权威文件。——
        for (nth, entry) in self.plan.entries.iter().enumerate() {
            if self.replacement_should_fail(nth) {
                return Err(commit_failed(format!(
                    "替换第 {nth} 个权威文件失败：{}",
                    entry.sidecar_relative_path
                )));
            }
            let staged = session.join(STAGING_SUBDIR).join(&entry.sidecar_relative_path);
            let target = plan_sidecar_path(&self.root, &entry.sidecar_relative_path)?;
            atomic_copy(&staged, &target)
                .map_err(|e| commit_failed(format!("替换侧车失败 {}: {e}", target.display())))?;
            emit_progress(progress, V3CommitStage::Replaced, nth + 1, total_units, file_name_of(&entry.sidecar_relative_path));
        }
        if self.replacement_should_fail(meta_nth) {
            return Err(commit_failed(format!(
                "替换第 {meta_nth} 个权威文件失败：{META_FILE}"
            )));
        }
        atomic_copy(&staged_meta_path, &self.root.join(META_FILE)).map_err(|e| {
            commit_failed(format!("替换库元数据失败 {META_FILE}: {e}"))
        })?;
        emit_progress(progress, V3CommitStage::Replaced, total_units, total_units, META_FILE.to_owned());
        self.checkpoint(&session, V3CommitStage::Replaced)?;

        // —— 索引：派生数据由调用方闭包重建；失败按原错误码上抛，让前端看到
        // “索引没建成”而不是被裹成一个笼统的迁移错误。——
        rebuild_index(&self.root)?;
        emit_progress(progress, V3CommitStage::IndexRebuilt, total_units, total_units, INDEX_FILE.to_owned());
        self.checkpoint(&session, V3CommitStage::IndexRebuilt)?;

        // —— 校验：替换后的权威文件必须真的是 v3 且身份未变。——
        self.verify_v3_invariants(meta)?;
        emit_progress(progress, V3CommitStage::Validated, total_units, total_units, META_FILE.to_owned());
        self.checkpoint(&session, V3CommitStage::Validated)?;

        // —— 收尾：先删日志再清理（见本节横幅注释）。此后任何失败都不回滚：
        // 迁移已经完整成立，残留由下次开库按“已完成残留”直接扫掉。
        std::fs::remove_file(&log_path).map_err(|e| {
            AppError::detailed(
                Code::LibraryIoFailed,
                format!("删除恢复日志失败 {}: {e}", log_path.display()),
            )
        })?;
        remove_work_dir(&self.root)?;
        release_migration_lock(&self.root)
    }

    /// 建立一次提交的唯一会话目录。UUIDv7 名字让多次提交的残迹互不覆盖。
    fn create_session(&self) -> Result<PathBuf> {
        let session = self
            .root
            .join(MIGRATION_WORK_DIR)
            .join(crate::ids::generate_canonical_uuid_v7());
        std::fs::create_dir_all(&session)
            .map_err(|e| staging_failed(format!("建立迁移会话目录失败 {}: {e}", session.display())))?;
        Ok(session)
    }

    /// 阶段检查点：把已落盘的日志推进到该阶段，然后注入模拟中断。
    ///
    /// Staged 阶段日志尚不存在——暂存垃圾不需要回滚依据，因此那里只有注入生效。
    fn checkpoint(&self, session: &Path, stage: V3CommitStage) -> Result<()> {
        let log_path = session.join(RECOVERY_LOG_FILE);
        if log_path.is_file() {
            let mut log = V3RecoveryLog::read(&log_path)?;
            log.stage = stage;
            log.write_atomic(&log_path)?;
        }
        #[cfg(test)]
        if self.interrupt_after_stage == Some(stage) {
            return Err(AppError::new(Code::MigrationInterrupted));
        }
        #[cfg(not(test))]
        let _ = stage;
        Ok(())
    }

    /// 把全部权威元数据的原始字节复制进会话备份子树。
    ///
    /// 按字节复制而不是解析后重写，与 v1→v2 相同：回滚要恢复的是原始字节，
    /// 任何一次“解析再序列化”都会让回滚结果取决于当前程序的序列化实现。
    fn back_up_authority(&self, session: &Path) -> Result<()> {
        let backup_root = session.join(BACKUP_SUBDIR);
        for entry in &self.plan.entries {
            let from = plan_sidecar_path(&self.root, &entry.sidecar_relative_path)?;
            let to = backup_root.join(&entry.sidecar_relative_path);
            // fs::copy 不建父目录；备份树必须复刻侧车的扇形目录布局。
            if let Some(parent) = to.parent() {
                std::fs::create_dir_all(parent).map_err(|e| {
                    AppError::detailed(
                        Code::MigrationBackupFailed,
                        format!("建立备份目录失败 {}: {e}", parent.display()),
                    )
                })?;
            }
            std::fs::copy(&from, &to).map_err(|e| {
                AppError::detailed(
                    Code::MigrationBackupFailed,
                    format!("备份侧车失败 {}: {e}", from.display()),
                )
            })?;
        }
        for name in [META_FILE, FOLDERS_FILE] {
            std::fs::copy(self.root.join(name), backup_root.join(name)).map_err(|e| {
                AppError::detailed(
                    Code::MigrationBackupFailed,
                    format!("备份 {name} 失败: {e}"),
                )
            })?;
        }
        Ok(())
    }

    /// 校验不变量：每张权威侧车都能按 v3 完整读出且内容哈希未变，库级元数据确为
    /// v3 且身份未变。
    fn verify_v3_invariants(&self, meta: &LibraryMetaV2) -> Result<()> {
        for entry in &self.plan.entries {
            let path = plan_sidecar_path(&self.root, &entry.sidecar_relative_path)?;
            let v3 = AssetSidecarV3::read(&path)?;
            if v3.hash != entry.hash {
                return Err(AppError::detailed(
                    Code::LibraryMetadataCorrupt,
                    format!("替换后的侧车内容哈希不一致：{}", path.display()),
                ));
            }
        }
        #[derive(Deserialize)]
        struct MetaProbe {
            format_version: u32,
            library_id: LibraryId,
        }
        let bytes = std::fs::read(self.root.join(META_FILE)).map_err(|e| {
            AppError::detailed(
                Code::LibraryPathUnreadable,
                format!("校验时读取 {META_FILE} 失败: {e}"),
            )
        })?;
        let probe: MetaProbe = serde_json::from_slice(&bytes).map_err(|e| {
            AppError::detailed(
                Code::LibraryMetadataCorrupt,
                format!("{META_FILE} 无法在提交后解析: {e}"),
            )
        })?;
        if probe.format_version != LIBRARY_FORMAT_VERSION_V3 {
            return Err(AppError::detailed(
                Code::LibraryMetadataCorrupt,
                format!(
                    "提交后的库格式版本应为 {LIBRARY_FORMAT_VERSION_V3}，实际为 {}",
                    probe.format_version
                ),
            ));
        }
        if probe.library_id != meta.library_id {
            return Err(AppError::detailed(
                Code::LibraryMetadataCorrupt,
                "提交后的库 ID 与原库不一致",
            ));
        }
        Ok(())
    }

    /// 失败路径的整体回滚，返回应当上报的错误。
    ///
    /// 判断依据刻意只有一个——恢复日志是否存在：日志在备份完成后才落盘，因此它存在
    /// 就意味着备份树完整、可以整体盖回；它不存在则替换必然尚未开始，只需撤掉自己的
    /// 痕迹。这里不再调用 rebuild_index：索引要么没被动过（替换前失败），要么刚由调用
    /// 方的闭包自己报错（索引阶段失败），重跑一次都不会让结果更正确；索引与元数据的
    /// 一致性自愈属于开库流程（设计第九条），不属于失败回滚。
    ///
    /// 回滚自身失败时以 `migration.rollback_failed` 取代原始失败上报：那时库里可能同时
    /// 存在新旧两种元数据，“不要继续使用这个库”比原始失败原因更需要先被看到。
    fn roll_back(&self, cause: AppError) -> AppError {
        let rolled_back = (|| -> Result<()> {
            if let Some(session) = sole_v3_session_dir(&self.root)? {
                if session.join(RECOVERY_LOG_FILE).is_file() {
                    restore_backup_tree(&self.root, &session.join(BACKUP_SUBDIR))?;
                }
            }
            remove_work_dir(&self.root)?;
            release_migration_lock(&self.root)
        })();
        match rolled_back {
            Ok(()) => cause,
            Err(step) => AppError::detailed(
                Code::MigrationRollbackFailed,
                format!("回滚 v2→v3 提交失败：{step}；触发回滚的原始失败：{cause}"),
            ),
        }
    }

    fn staging_should_fail(&self, nth: usize) -> bool {
        #[cfg(test)]
        {
            self.fail_staging_write_at == Some(nth)
        }
        #[cfg(not(test))]
        {
            let _ = nth;
            false
        }
    }

    fn replacement_should_fail(&self, nth: usize) -> bool {
        #[cfg(test)]
        {
            self.fail_replacement_at == Some(nth)
        }
        #[cfg(not(test))]
        {
            let _ = nth;
            false
        }
    }

    /// 注入“第 n 个暂存写入失败”。n 从 0 起计，覆盖顺序由实现定义，
    /// 测试只要求首个、中间与最后一个位置都可命中。
    #[cfg(test)]
    fn inject_staging_write_failure_at(&mut self, nth: usize) {
        self.fail_staging_write_at = Some(nth);
    }

    /// 注入“第 n 个权威替换失败”。覆盖顺序与暂存一致。
    #[cfg(test)]
    fn inject_replacement_failure_at(&mut self, nth: usize) {
        self.fail_replacement_at = Some(nth);
    }

    /// 模拟进程在某阶段完成后被结束。
    ///
    /// 与“失败”刻意不同：进程被杀不会执行任何恢复，留下的 journal 与备份正是
    /// 下一次开库面对的真实崩溃现场。
    #[cfg(test)]
    fn simulate_interruption_after(&mut self, stage: V3CommitStage) {
        self.interrupt_after_stage = Some(stage);
    }
}

/// 恢复日志自身的格式版本。它与 v1→v2 journal 及库格式版本互不相干：三者的结构
/// 演进节奏不同。
const V3_RECOVERY_LOG_FORMAT_VERSION: u32 = 1;

/// 会话目录内的暂存子树名。替换阶段的每个新字节都从这里同卷改名出去。
const STAGING_SUBDIR: &str = "staging";

/// 会话目录内的备份子树名。回滚永远是整棵树按原始路径盖回去，不做任何格式转换。
const BACKUP_SUBDIR: &str = "backup";

/// 一次 v2→v3 提交的恢复日志。
///
/// 刻意不带 v1→v2 journal 的逐文件条目：v3 提交在触碰任何权威字节之前就把全部旧
/// 字节备份完毕，回滚因此永远是“整棵备份树盖回去”，无需记录每个文件各自走到哪一步。
/// 条目更少意味着崩溃窗口更小——每个要维护的状态都是一次出错的机会。
#[derive(Debug, Clone, Serialize, Deserialize)]
struct V3RecoveryLog {
    format_version: u32,
    /// 提交针对的库身份。恢复时与盘上元数据核对，防止把别的库的工作目录当成现场。
    library_id: LibraryId,
    from_version: u32,
    to_version: u32,
    started_at: DateTime<Utc>,
    /// 最后一个已完成的阶段。恢复逻辑不依赖它（一律整体回滚），但它让支持人员能直接
    /// 读出“上次停在哪一步”，而不必从文件系统残迹反推。
    stage: V3CommitStage,
}

impl V3RecoveryLog {
    /// 校验格式级不变量。与 v1→v2 journal 同理：journal 可能被改写或写坏，而恢复
    /// 完全依赖它，读与写共用同一份校验才能保证“能读出来的日志一定可用”。
    fn validate(&self) -> Result<()> {
        if self.from_version != LIBRARY_FORMAT_VERSION_V2
            || self.to_version != LIBRARY_FORMAT_VERSION_V3
        {
            return Err(AppError::detailed(
                Code::MigrationJournalCorrupt,
                format!(
                    "恢复日志声称的迁移方向 {}→{} 不是 v2→v3",
                    self.from_version, self.to_version
                ),
            ));
        }
        Ok(())
    }

    fn read(path: &Path) -> Result<Self> {
        let bytes = std::fs::read(path).map_err(|e| {
            AppError::detailed(
                Code::LibraryIoFailed,
                format!("读取恢复日志失败 {}: {e}", path.display()),
            )
        })?;
        let log: Self = serde_json::from_slice(&bytes).map_err(|e| {
            AppError::detailed(
                Code::MigrationJournalCorrupt,
                format!("恢复日志无法解析 {}: {e}", path.display()),
            )
        })?;
        if log.format_version > V3_RECOVERY_LOG_FORMAT_VERSION {
            return Err(AppError::detailed(
                Code::MigrationJournalFormatTooNew,
                format!(
                    "恢复日志格式版本 {} 高于程序支持的 {V3_RECOVERY_LOG_FORMAT_VERSION}：{}",
                    log.format_version,
                    path.display()
                ),
            ));
        }
        log.validate()?;
        Ok(log)
    }

    /// 写入日志。每次状态推进都要落盘，先写临时文件再改名——一份写到一半的日志
    /// 会让恢复既不能回滚也不能判“已完成”。
    fn write_atomic(&self, path: &Path) -> Result<()> {
        self.validate()?;
        let code = Code::MigrationJournalWriteFailed;
        let io_err = |e: std::io::Error, what: &str| {
            AppError::detailed(code, format!("{what} {}: {e}", path.display()))
        };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| io_err(e, "建立恢复日志目录失败"))?;
        }
        let json = serde_json::to_vec_pretty(self)
            .map_err(|e| AppError::detailed(code, format!("序列化恢复日志失败: {e}")))?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, &json).map_err(|e| io_err(e, "写入临时恢复日志失败"))?;
        std::fs::rename(&tmp, path).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            io_err(e, "提交恢复日志失败")
        })
    }
}

fn staging_failed(detail: impl std::fmt::Display) -> AppError {
    AppError::detailed(Code::MigrationStagingFailed, detail)
}

fn commit_failed(detail: impl std::fmt::Display) -> AppError {
    AppError::detailed(Code::MigrationCommitFailed, detail)
}

fn emit_progress(
    progress: &mut dyn FnMut(V3CommitProgress),
    stage: V3CommitStage,
    done: usize,
    total: usize,
    current_filename: String,
) {
    progress(V3CommitProgress {
        stage,
        done,
        total,
        current_filename,
    });
}

/// 构造暂存区里的 v3 库级元数据字节。
///
/// 打开门禁（任务 3.5）之前程序里还没有 LibraryMetaV3 类型；这里显式构造只携带既有
/// 字段的 JSON——v3 的库级元数据与 v2 字段相同、仅版本号推进到
/// [`LIBRARY_FORMAT_VERSION_V3`]，字段含义随 v2 定义走，不引入第二种解释。
fn staged_meta_json(meta: &LibraryMetaV2) -> Result<Vec<u8>> {
    serde_json::to_vec_pretty(&serde_json::json!({
        "format_version": LIBRARY_FORMAT_VERSION_V3,
        "library_id": meta.library_id,
        "hash_algo": meta.hash_algo,
        "created_at": meta.created_at,
        "created_by_app_version": meta.created_by_app_version,
    }))
    .map_err(|e| staging_failed(format!("序列化 v3 库级元数据失败: {e}")))
}

/// 把一张 v2 侧车映射为设计第八条的 v3 形状。
///
/// 归属取解决后的唯一文件夹：零归属与单归属自动继承，多归属来自使用者的明确选择。
/// 回收站素材的删除来源采用同一归属——“删除前的家”与“归属”在单归属模型里是同一个
/// 事实，两处各算一遍迟早出现互相矛盾的两个家。显示文件名取自旧原始文件名去掉扩展名，
/// 扩展名由真实媒体类型重新给出。
fn convert_sidecar_v2_to_v3(v2: &AssetSidecarV2, folder: Option<&str>) -> Result<AssetSidecarV3> {
    let original_filename = v2.original_filename.clone();
    // v2 的 ext 在导入时归一成小写（本体路径 `<hash>.<ext>` 依赖它），而原始文件名
    // 原样保留磁盘上的大小写——"IMG_0042.JPG" 配 ext "jpg" 是真实数据。剥离必须
    // 大小写不敏感，否则整段文件名会带着扩展名落进主体，被显示名校验拒绝，迁移
    // 直接失败。
    let stem =
        strip_suffix_case_insensitive(&original_filename, &format!(".{}", v2.ext));
    // 先于结构体字面量构造显示名：stem 借着 original_filename，而后者随后要整体
    // 移动进来源字段。
    let display_filename = DisplayFilename::new(stem, v2.media_type)?;
    Ok(AssetSidecarV3 {
        format_version: SIDECAR_FORMAT_VERSION_V3,
        hash: v2.hash.clone(),
        hash_algo: v2.hash_algo.clone(),
        media_type: v2.media_type,
        ext: v2.ext.clone(),
        byte_size: v2.byte_size,
        width: v2.width,
        height: v2.height,
        imported_at: v2.imported_at,
        source: AssetSource::Filesystem {
            path: v2.source_path.clone(),
            filename: original_filename,
        },
        display_filename,
        folder: folder.map(str::to_owned),
        tags: v2.tags.clone(),
        color_card: v2.color_card.clone(),
        note: v2.note.clone(),
        favorite: v2.favorite,
        deleted_at: v2.deleted_at,
        deleted_from_folder: if v2.deleted_at.is_some() {
            folder.map(str::to_owned)
        } else {
            None
        },
    })
}

/// 大小写不敏感地剥离后缀。
///
/// 扩展名是 ASCII，按 ASCII 折叠即可。切分点必须落在字符边界上——尾部若从多字节
/// 字符中间开始，不可能与 ASCII 后缀相等，自然回落到完整文件名，由显示名校验
/// 对真正的坏数据报错。
fn strip_suffix_case_insensitive<'a>(text: &'a str, suffix: &str) -> &'a str {
    match text.len().checked_sub(suffix.len()) {
        Some(split)
            if text.is_char_boundary(split) && text[split..].eq_ignore_ascii_case(suffix) =>
        {
            &text[..split]
        }
        _ => text,
    }
}

/// 返回工作目录下唯一的会话子目录；工作目录不存在或为空时返回 `None`。
///
/// 布局异常（多个会话、混入散文件）时报损坏而不是挑一个继续：会话目录里躺着的是
/// 回滚的全部依据，猜错一次就是数据丢失。
fn sole_v3_session_dir(root: &Path) -> Result<Option<PathBuf>> {
    let work = root.join(MIGRATION_WORK_DIR);
    if !work.is_dir() {
        return Ok(None);
    }
    let mut sessions = Vec::new();
    for entry in std::fs::read_dir(&work).map_err(|e| {
        AppError::detailed(
            Code::LibraryIoFailed,
            format!("读取迁移工作目录失败 {}: {e}", work.display()),
        )
    })? {
        let entry = entry.map_err(|e| {
            AppError::detailed(
                Code::LibraryIoFailed,
                format!("读取迁移工作目录条目失败 {}: {e}", work.display()),
            )
        })?;
        sessions.push(entry.path());
    }
    match sessions.as_slice() {
        [] => Ok(None),
        [only] if only.is_dir() => Ok(Some(only.clone())),
        _ => Err(AppError::detailed(
            Code::MigrationJournalCorrupt,
            format!(
                "迁移工作目录应恰好包含一个会话子目录：{}",
                work.display()
            ),
        )),
    }
}

/// 整体删除迁移工作目录及其下全部会话残留。
fn remove_work_dir(root: &Path) -> Result<()> {
    let work = root.join(MIGRATION_WORK_DIR);
    if !work.exists() {
        return Ok(());
    }
    std::fs::remove_dir_all(&work).map_err(|e| {
        AppError::detailed(
            Code::LibraryIoFailed,
            format!("删除迁移工作目录失败 {}: {e}", work.display()),
        )
    })
}

/// 取得 v2→v3 提交的迁移锁。“文件存在即持有”的语义与 v1→v2 相同（写进程 ID 留痕，
/// 让支持人员能回答“谁持有它”），但没有接管参数：提交没有续跑，盘上有锁就一律拒绝。
fn acquire_migration_lock(root: &Path) -> Result<()> {
    let path = root.join(LOCK_FILE);
    if path.exists() {
        return Err(AppError::detailed(
            Code::MigrationLockHeld,
            format!("库内已存在迁移锁：{}", path.display()),
        ));
    }
    std::fs::write(&path, std::process::id().to_string().as_bytes()).map_err(|e| {
        AppError::detailed(
            Code::MigrationJournalWriteFailed,
            format!("写入迁移锁失败 {}: {e}", path.display()),
        )
    })
}

/// 移除迁移锁。成功提交与成功回滚都以它收尾。
fn release_migration_lock(root: &Path) -> Result<()> {
    let path = root.join(LOCK_FILE);
    if !path.exists() {
        return Ok(());
    }
    std::fs::remove_file(&path).map_err(|e| {
        AppError::detailed(
            Code::LibraryIoFailed,
            format!("删除迁移锁失败 {}: {e}", path.display()),
        )
    })
}

/// 把备份子树按原始相对路径盖回权威位置。
///
/// # Errors
///
/// 备份子树缺失或任一复制失败时返回错误；调用方决定如何归因上报。
fn restore_backup_tree(root: &Path, backup_root: &Path) -> Result<()> {
    if !backup_root.is_dir() {
        return Err(AppError::detailed(
            Code::MigrationRollbackFailed,
            format!(
                "恢复日志存在但备份子树缺失：{}",
                backup_root.display()
            ),
        ));
    }
    copy_tree_over(backup_root, root)
}

/// 把 `src` 子树逐字节复制覆盖到 `dst` 下，保持相对布局。
fn copy_tree_over(src: &Path, dst: &Path) -> Result<()> {
    let io_err = |what: &str, path: &Path, e: std::io::Error| {
        AppError::detailed(
            Code::MigrationRollbackFailed,
            format!("{what} {}: {e}", path.display()),
        )
    };
    for entry in std::fs::read_dir(src).map_err(|e| io_err("读取备份目录失败", src, e))? {
        let entry = entry.map_err(|e| io_err("读取备份条目失败", src, e))?;
        let target = dst.join(entry.file_name());
        if entry
            .file_type()
            .map_err(|e| io_err("读取备份条目类型失败", src, e))?
            .is_dir()
        {
            std::fs::create_dir_all(&target).map_err(|e| io_err("建立恢复目录失败", &target, e))?;
            copy_tree_over(&entry.path(), &target)?;
        } else {
            atomic_copy(&entry.path(), &target)?;
        }
    }
    Ok(())
}

/// 同卷原子顶替：先写目标旁的临时文件再改名。同一卷上的改名是原子的，断电只会留下
/// 一个多余的临时文件，绝不会留下半个新文件顶替旧文件的局面。
fn atomic_copy(from: &Path, to: &Path) -> Result<()> {
    let bytes = std::fs::read(from).map_err(|e| {
        AppError::detailed(
            Code::LibraryIoFailed,
            format!("读取待顶替内容失败 {}: {e}", from.display()),
        )
    })?;
    write_atomic_bytes(to, &bytes)
}

/// 先写临时文件再改名的原子写字节工具。暂存区写入与替换顶替共用这一条路径。
fn write_atomic_bytes(path: &Path, bytes: &[u8]) -> Result<()> {
    let io_err = |what: &str, e: std::io::Error| {
        AppError::detailed(
            Code::LibraryIoFailed,
            format!("{what} {}: {e}", path.display()),
        )
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| io_err("建立目录失败", e))?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes).map_err(|e| io_err("写入临时文件失败", e))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        io_err("原子提交文件失败", e)
    })
}

/// 校验“规划时的侧车集合与逐个字节摘要”仍然成立。v2 计划与已解决冲突的 v3 计划
/// 共用这一份实现。
///
/// # Errors
///
/// 路径越界、侧车丢失或摘要变化返回 `migration.plan_stale`。
fn verify_plan_inputs_unchanged(root: &Path, planned: &[(&str, &ContentHash)]) -> Result<()> {
    let current_keys: std::collections::BTreeSet<String> = collect_sidecars(root)?
        .iter()
        .map(|path| relative_key(root, path))
        .collect::<Result<_>>()?;
    let planned_keys: std::collections::BTreeSet<String> =
        planned.iter().map(|(path, _)| (*path).to_owned()).collect();
    if current_keys != planned_keys {
        return Err(AppError::detailed(
            Code::MigrationPlanStale,
            "迁移规划后侧车集合发生变化",
        ));
    }
    for (relative, digest) in planned {
        let path = plan_sidecar_path(root, relative)?;
        let bytes = std::fs::read(&path).map_err(|error| {
            AppError::detailed(
                Code::MigrationPlanStale,
                format!("迁移输入已不可读 {}: {error}", path.display()),
            )
        })?;
        if &ContentHash::of_bytes(&bytes) != *digest {
            return Err(AppError::detailed(
                Code::MigrationPlanStale,
                format!("迁移输入在规划后被修改：{}", path.display()),
            ));
        }
    }
    Ok(())
}

fn plan_sidecar_path(root: &Path, relative_key: &str) -> Result<PathBuf> {
    let relative = Path::new(relative_key);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(AppError::detailed(
            Code::MigrationPlanStale,
            format!("迁移计划包含越界路径：{relative_key:?}"),
        ));
    }
    Ok(root.join(relative))
}

fn invalid_v3_resolution(detail: impl std::fmt::Display) -> AppError {
    AppError::detailed(Code::MigrationResolutionInvalid, detail)
}

/// 一次 v1→v2 迁移的执行器。
///
/// 派生索引的结构属于 `Catalog` 而不是迁移，因此重建索引由调用方以闭包注入：迁移只负责
/// 权威文件，并在索引重建失败时回滚。这条边界也让"索引重建失败"成为一个可测的输入，
/// 而不需要在迁移内部伪造 SQLite 故障。
pub struct Migration {
    root: PathBuf,
    #[cfg(test)]
    fail_sidecar_write_at: Option<usize>,
    #[cfg(test)]
    interrupt_after_stage: Option<MigrationStage>,
}

impl Migration {
    pub fn new(root: &Path) -> Self {
        Self {
            root: root.to_path_buf(),
            #[cfg(test)]
            fail_sidecar_write_at: None,
            #[cfg(test)]
            interrupt_after_stage: None,
        }
    }

    /// 执行或继续一次 v1→v2 迁移。
    ///
    /// `rebuild_index` 在全部侧车重写完成后被调用一次；它返回错误时迁移必须回滚。
    /// `progress` 在每个侧车处理后被调用，使前端能显示已处理数、总数与当前文件。
    pub fn run(
        &mut self,
        rebuild_index: &mut dyn FnMut(&Path) -> Result<()>,
        progress: &mut dyn FnMut(MigrationProgress),
    ) -> Result<MigrationOutcome> {
        // 先判定格式再取锁：格式过新之类的失败不该在库里留下一把没人负责的锁。
        let (mut journal, resumed) = match detect_library_format(&self.root)? {
            LibraryFormatState::Current(meta) => {
                // 已经是当前代（v2 或 v3）就没有工作要做。这里返回成功而不是报错，
                // 使"打开库"可以无条件先走一次迁移入口，而不必在每个调用方重复一遍
                // 版本判断；对 v3 库同样成立——它比本次迁移的目标还要新。
                return Ok(MigrationOutcome {
                    library_id: meta.library_id().clone(),
                    sidecars_rewritten: 0,
                    resumed: false,
                });
            }
            LibraryFormatState::NeedsMigration { from_version } => {
                self.acquire_lock(false)?;
                match self.begin(from_version) {
                    Ok(journal) => (journal, false),
                    Err(e) => {
                        // 还没动过任何权威文件，因此只需要撤掉自己刚留下的痕迹。
                        self.abandon_setup();
                        return Err(e);
                    }
                }
            }
            LibraryFormatState::MigrationIncomplete(journal) => {
                self.acquire_lock(true)?;
                (journal, true)
            }
        };

        match self.advance(&mut journal, resumed, rebuild_index, progress) {
            Ok(sidecars_rewritten) => Ok(MigrationOutcome {
                library_id: journal.library_id.clone(),
                sidecars_rewritten,
                resumed,
            }),
            // 中断刻意既不回滚也不清理：进程真的被结束时不会有任何代码运行，所以
            // 留下 journal 与备份才是忠实的崩溃现场，也正是下一次开库继续或回滚的依据。
            Err(e) if e.code == Code::MigrationInterrupted => Err(e),
            Err(e) => Err(self.roll_back(&mut journal, e)),
        }
    }

    /// 取得迁移锁。
    ///
    /// `taking_over` 为真时允许接管磁盘上已经存在的锁：能走到那里说明 journal 存在，
    /// 而 journal 精确记录了上次停在哪一步，接管之后可以继续或回滚。没有 journal 的锁
    /// 则相反——无从判断持锁者进行到哪里，只能拒绝。
    ///
    /// 代价是诚实的：两个进程同时对同一个库发起迁移时，后者可能在前者写下 journal 之后
    /// 才检查，于是把一次正在进行的迁移当成崩溃现场接管。本项目内不会发生（权威变更都
    /// 串行在同一个 Catalog 锁边界内，见设计第六、七条），跨进程的真正互斥需要心跳或
    /// 进程存活探测，属于独立需求。
    fn acquire_lock(&self, taking_over: bool) -> Result<()> {
        let path = self.root.join(LOCK_FILE);
        if path.exists() && !taking_over {
            return Err(AppError::detailed(
                Code::MigrationLockHeld,
                format!("库内已存在迁移锁：{}", path.display()),
            ));
        }
        // 写进程 ID 而不是空文件：支持人员看到一把锁时，第一个问题总是"谁持有它"。
        std::fs::write(&path, std::process::id().to_string().as_bytes()).map_err(|e| {
            AppError::detailed(
                Code::MigrationJournalWriteFailed,
                format!("写入迁移锁失败 {}: {e}", path.display()),
            )
        })
    }

    /// 为一次全新迁移登记 journal。
    fn begin(&self, from_version: u32) -> Result<MigrationJournal> {
        let entries = collect_sidecars(&self.root)?
            .into_iter()
            .map(|path| {
                Ok(JournalEntry {
                    sidecar_relative_path: relative_key(&self.root, &path)?,
                    state: JournalEntryState::Pending,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let journal = MigrationJournal {
            format_version: MIGRATION_JOURNAL_FORMAT_VERSION,
            // 库 ID 在这里就定下来并写进 journal，而不是等到提交 `library.json`：
            // 只在提交时生成的话，一次中断恢复就会分配出第二个 ID，而前端的分库布局
            // 偏好正以它为键，使用者看到的现象会是"设置自己复位了"。
            library_id: LibraryId::generate(),
            from_version,
            to_version: LIBRARY_FORMAT_VERSION_V2,
            started_at: Utc::now(),
            stage: MigrationStage::Started,
            entries,
        };
        journal.write_atomic(&self.journal_path())?;
        Ok(journal)
    }

    /// 从 journal 记录的阶段一直推进到提交与清理，返回已重写的侧车数量。
    fn advance(
        &self,
        journal: &mut MigrationJournal,
        resumed: bool,
        rebuild_index: &mut dyn FnMut(&Path) -> Result<()>,
        progress: &mut dyn FnMut(MigrationProgress),
    ) -> Result<usize> {
        if journal
            .entries
            .iter()
            .any(|e| e.state == JournalEntryState::Pending)
        {
            self.back_up_all(journal)?;
        }

        if journal.stage < MigrationStage::SkeletonReady {
            self.build_prompt_skeleton()?;
            self.checkpoint(journal, MigrationStage::SkeletonReady)?;
        }

        let rewriting = journal.stage < MigrationStage::SidecarsRewritten;
        if rewriting && resumed {
            // 上一次可能停在重写中途，磁盘上于是混着 v1 与 v2 侧车。重写的输入必须是
            // v1，因此先按备份把全部侧车恢复原状，再整批重来；逐个判断"这个是不是已经
            // 是 v2 了"要多一套版本嗅探，而嗅探错一次就会把使用者的备注覆盖成空串。
            self.restore_all_from_backup(journal, JournalEntryState::BackedUp)?;
        }
        // 已经是 Rewritten 的条目不再重写，但进度照样走完：否则恢复时进度条会从
        // 半途开始，使用者无从判断是卡住了还是本来就只剩这些。
        self.rewrite_sidecars(journal, progress)?;
        if rewriting {
            self.checkpoint(journal, MigrationStage::SidecarsRewritten)?;
        }

        if journal.stage < MigrationStage::IndexRebuilt {
            // 索引重建与迁移前后快照比较都由调用方在这个闭包里完成：派生索引的结构
            // 属于 `Catalog`，迁移只需要知道它成没成。失败按原错误码上抛，使前端看到
            // "索引重建失败"而不是被裹成一个笼统的迁移错误。
            rebuild_index(&self.root)?;
            self.checkpoint(journal, MigrationStage::IndexRebuilt)?;
        }

        if journal.stage < MigrationStage::Committed {
            self.commit(journal)?;
            self.checkpoint(journal, MigrationStage::Committed)?;
        }

        self.clean_up()?;
        Ok(journal
            .entries
            .iter()
            .filter(|e| e.state == JournalEntryState::Rewritten)
            .count())
    }

    /// 把全部侧车的原始字节复制进备份树。
    fn back_up_all(&self, journal: &mut MigrationJournal) -> Result<()> {
        // 上一次迁移可能在写下 journal 之前就被结束，留下一棵不完整的备份树。它此刻
        // 没有任何权威价值：没有 journal，就没人知道它对应哪些文件的哪个版本。
        self.remove_backup_tree(Code::MigrationBackupFailed)?;
        let backup_root = self.root.join(BACKUP_DIR);
        for entry in journal.entries.iter_mut() {
            let from = self.root.join(&entry.sidecar_relative_path);
            let to = backup_root.join(&entry.sidecar_relative_path);
            let failed = |e: std::io::Error, what: &str| {
                AppError::detailed(
                    Code::MigrationBackupFailed,
                    format!("{what} {}: {e}", from.display()),
                )
            };
            if let Some(parent) = to.parent() {
                std::fs::create_dir_all(parent).map_err(|e| failed(e, "建立备份目录失败"))?;
            }
            // 按字节复制而不是解析后重写：回滚要恢复的是原始字节，任何一次
            // "解析再序列化"都会让回滚结果取决于当前程序的序列化实现。
            std::fs::copy(&from, &to).map_err(|e| failed(e, "备份侧车失败"))?;
            entry.state = JournalEntryState::BackedUp;
        }
        // 全部备份完才落盘一次，而不是每个文件一次：10,000 个侧车会变成 10,000 次
        // journal 写，而"备份中途崩溃"根本不需要更细的记录——那时权威文件还一个字节
        // 都没改过，重做一遍备份即可。
        journal.write_atomic(&self.journal_path())
    }

    /// 建立提示词骨架：两个提示词子目录与一份空的提示词文件夹清单。
    fn build_prompt_skeleton(&self) -> Result<()> {
        let prompts = self.root.join(PROMPTS_DIR);
        for dir in [
            prompts.join(PROMPT_OBJECTS_DIR),
            prompts.join(PROMPT_TRASH_DIR),
        ] {
            std::fs::create_dir_all(&dir).map_err(|e| {
                AppError::detailed(
                    Code::PromptWriteFailed,
                    format!("建立提示词目录失败 {}: {e}", dir.display()),
                )
            })?;
        }
        // 显式写一份空清单，而不是让"文件不存在"表示空：提示词库必须能区分"还没有
        // 建过任何文件夹"与"清单文件丢了"，后者是损坏而不是空库。
        PromptFolderList::default().write_atomic(&self.root.join(PROMPT_FOLDERS_FILE))
    }

    /// 撤掉本次迁移建立的提示词骨架。
    fn remove_prompt_skeleton(&self) -> Result<()> {
        let list = self.root.join(PROMPT_FOLDERS_FILE);
        if list.exists() {
            std::fs::remove_file(&list).map_err(|e| {
                AppError::detailed(
                    Code::MigrationRollbackFailed,
                    format!("删除提示词文件夹清单失败 {}: {e}", list.display()),
                )
            })?;
        }
        // `prompts/` 本身在 v1 库里就存在，只撤掉本次新建的两个子目录。
        let prompts = self.root.join(PROMPTS_DIR);
        for dir in [
            prompts.join(PROMPT_OBJECTS_DIR),
            prompts.join(PROMPT_TRASH_DIR),
        ] {
            if dir.is_dir() {
                std::fs::remove_dir_all(&dir).map_err(|e| {
                    AppError::detailed(
                        Code::MigrationRollbackFailed,
                        format!("删除提示词目录失败 {}: {e}", dir.display()),
                    )
                })?;
            }
        }
        Ok(())
    }

    /// 按 journal 顺序把侧车逐个重写为 v2，并逐个报告进度。
    fn rewrite_sidecars(
        &self,
        journal: &mut MigrationJournal,
        progress: &mut dyn FnMut(MigrationProgress),
    ) -> Result<()> {
        let total = journal.entries.len();
        for nth in 0..total {
            let relative = journal.entries[nth].sidecar_relative_path.clone();
            if journal.entries[nth].state != JournalEntryState::Rewritten {
                self.rewrite_one(&self.root.join(&relative), nth)?;
                journal.entries[nth].state = JournalEntryState::Rewritten;
            }
            progress(MigrationProgress {
                stage: MigrationStage::SidecarsRewritten,
                done: nth + 1,
                total,
                current_filename: file_name_of(&relative),
            });
        }
        Ok(())
    }

    fn rewrite_one(&self, path: &Path, nth: usize) -> Result<()> {
        let rewrite_failed =
            |detail: String| AppError::detailed(Code::MigrationSidecarRewriteFailed, detail);
        // 显式按 v1 解析（设计第四条）。v1 的形状已经冻结，因此这次解析的含义不会
        // 随 v2 将来的字段变化而漂移。
        let v1 = AssetSidecarV1::read(path)
            .map_err(|e| rewrite_failed(format!("按 v1 解析侧车失败 {}：{e}", path.display())))?;
        let v2 = AssetSidecarV2 {
            format_version: SIDECAR_FORMAT_VERSION_V2,
            hash: v1.hash,
            hash_algo: v1.hash_algo,
            media_type: v1.media_type,
            ext: v1.ext,
            byte_size: v1.byte_size,
            width: v1.width,
            height: v1.height,
            imported_at: v1.imported_at,
            original_filename: v1.original_filename,
            source_path: v1.source_path,
            folders: v1.folders,
            tags: v1.tags,
            color_card: v1.color_card,
            // 迁移不发明数据：v1 库里既没有备注也没有收藏，因此只能是空串与 false。
            note: String::new(),
            favorite: false,
            deleted_at: v1.deleted_at,
            deleted_from_folders: v1.deleted_from_folders,
        };
        if self.should_fail_sidecar_write(nth) {
            return Err(rewrite_failed(format!(
                "注入的第 {nth} 个侧车写入失败：{}",
                path.display()
            )));
        }
        v2.write_atomic(path)
            .map_err(|e| rewrite_failed(format!("写入 v2 侧车失败 {}：{e}", path.display())))
    }

    /// 原子提交 v2 `library.json`。这是迁移的最后一次权威写入。
    fn commit(&self, journal: &MigrationJournal) -> Result<()> {
        let meta_path = self.root.join(META_FILE);
        let commit_failed =
            |detail: String| AppError::detailed(Code::MigrationCommitFailed, detail);
        // 提交成功但在写下 `Committed` 之前崩溃时会再走一遍这里。已经是 v2 就不重写：
        // 重写本身无害，但此刻 v1 读取器已经打不开这个文件，硬走一遍只会失败。
        if read_format_version(&meta_path)? >= LIBRARY_FORMAT_VERSION_V2 {
            let existing = LibraryMetaV2::read(&meta_path)?;
            if existing.library_id != journal.library_id {
                return Err(commit_failed(format!(
                    "库已提交为 v2，但库 ID {} 与本次迁移记录的 {} 不一致：{}",
                    existing.library_id,
                    journal.library_id,
                    meta_path.display()
                )));
            }
            return Ok(());
        }
        // 刻意不走 `Library::open`：它现在只认 v2，而此刻磁盘上正是那份待替换的 v1 文件。
        let v1 = LibraryMeta::read(&meta_path)
            .map_err(|e| commit_failed(format!("提交前读取 v1 库级元数据失败：{e}")))?;
        LibraryMetaV2 {
            format_version: LIBRARY_FORMAT_VERSION_V2,
            library_id: journal.library_id.clone(),
            hash_algo: v1.hash_algo.clone(),
            // 保留原始建库时间与建库版本：迁移改的是格式，不是"这个库是什么时候建的"。
            created_at: v1.created_at,
            created_by_app_version: v1.created_by_app_version.clone(),
        }
        .write_atomic(&meta_path)
        .map_err(|e| commit_failed(format!("提交 v2 {META_FILE} 失败：{e}")))
    }

    /// 推进阶段并落盘，随后检查注入的中断。
    fn checkpoint(&self, journal: &mut MigrationJournal, stage: MigrationStage) -> Result<()> {
        journal.stage = stage;
        journal.write_atomic(&self.journal_path())?;
        if self.should_interrupt_after(stage) {
            return Err(AppError::detailed(
                Code::MigrationInterrupted,
                format!("模拟进程在阶段 {} 之后被结束", stage.as_str()),
            ));
        }
        Ok(())
    }

    /// 按备份把权威侧车恢复为原始字节。
    fn restore_all_from_backup(
        &self,
        journal: &mut MigrationJournal,
        state_after: JournalEntryState,
    ) -> Result<()> {
        let backup_root = self.root.join(BACKUP_DIR);
        for entry in journal.entries.iter_mut() {
            let backup = backup_root.join(&entry.sidecar_relative_path);
            if !backup.is_file() {
                // 没有备份说明这个侧车还没被改过（状态仍是 Pending），无需恢复。
                continue;
            }
            let target = self.root.join(&entry.sidecar_relative_path);
            std::fs::copy(&backup, &target).map_err(|e| {
                AppError::detailed(
                    Code::MigrationRollbackFailed,
                    format!("按备份恢复侧车失败 {}: {e}", target.display()),
                )
            })?;
            entry.state = state_after;
        }
        Ok(())
    }

    /// 回滚整次迁移，返回应当上报的错误。
    ///
    /// 回滚自身失败时以 `MigrationRollbackFailed` 取代原始失败上报：那时库里可能同时
    /// 存在新旧两种元数据，"不要继续使用这个库"比原始失败原因更需要先被看到。
    fn roll_back(&self, journal: &mut MigrationJournal, cause: AppError) -> AppError {
        let rolled_back = self
            .restore_all_from_backup(journal, JournalEntryState::RolledBack)
            .and_then(|()| self.remove_prompt_skeleton())
            .and_then(|()| self.clean_up());
        match rolled_back {
            Ok(()) => cause,
            Err(step) => {
                // 把半回滚的状态留在 journal 里：这正是支持人员唯一能读到的现场。
                // 这一步再失败也不改变上报结论，因此不再层层上抛。
                let _ = journal.write_atomic(&self.journal_path());
                AppError::detailed(
                    Code::MigrationRollbackFailed,
                    format!("回滚迁移失败：{step}；触发回滚的原始失败：{cause}"),
                )
            }
        }
    }

    /// 删除 journal、备份树与锁。成功提交与成功回滚都以它收尾。
    fn clean_up(&self) -> Result<()> {
        // 先删 journal：journal 消失即"这个库没有未完成的迁移"，之后备份与锁只是垃圾。
        // 反过来先删备份，一次崩溃就会留下一份指向不存在备份的 journal，而恢复逻辑正要
        // 靠备份回滚。
        let journal = self.journal_path();
        std::fs::remove_file(&journal).map_err(|e| {
            AppError::detailed(
                Code::LibraryIoFailed,
                format!("删除迁移 journal 失败 {}: {e}", journal.display()),
            )
        })?;
        self.remove_backup_tree(Code::LibraryIoFailed)?;
        let lock = self.root.join(LOCK_FILE);
        if lock.exists() {
            std::fs::remove_file(&lock).map_err(|e| {
                AppError::detailed(
                    Code::LibraryIoFailed,
                    format!("删除迁移锁失败 {}: {e}", lock.display()),
                )
            })?;
        }
        Ok(())
    }

    /// 撤掉登记失败时留下的锁与备份树。此时权威文件一个字节都没改过。
    fn abandon_setup(&self) {
        // 这里的失败不改变上报结论（登记失败本身已经是要上报的错误），且残留只会让
        // 下一次开库看到一把没有 journal 的锁并如实拒绝，不会让数据变得不可恢复。
        let _ = std::fs::remove_file(self.root.join(LOCK_FILE));
        let _ = std::fs::remove_dir_all(self.root.join(BACKUP_DIR));
    }

    fn remove_backup_tree(&self, code: Code) -> Result<()> {
        let dir = self.root.join(BACKUP_DIR);
        if !dir.exists() {
            return Ok(());
        }
        std::fs::remove_dir_all(&dir)
            .map_err(|e| AppError::detailed(code, format!("删除备份树失败 {}: {e}", dir.display())))
    }

    fn journal_path(&self) -> PathBuf {
        self.root.join(JOURNAL_FILE)
    }

    fn should_fail_sidecar_write(&self, nth: usize) -> bool {
        #[cfg(test)]
        {
            self.fail_sidecar_write_at == Some(nth)
        }
        #[cfg(not(test))]
        {
            let _ = nth;
            false
        }
    }

    fn should_interrupt_after(&self, stage: MigrationStage) -> bool {
        #[cfg(test)]
        {
            self.interrupt_after_stage == Some(stage)
        }
        #[cfg(not(test))]
        {
            let _ = stage;
            false
        }
    }

    /// 注入"第 n 个侧车重写失败"。n 从 0 起计，顺序与 journal 中条目顺序一致。
    #[cfg(test)]
    fn inject_sidecar_write_failure_at(&mut self, nth: usize) {
        self.fail_sidecar_write_at = Some(nth);
    }

    /// 模拟进程在某个阶段完成后被结束。
    ///
    /// 与"失败"刻意不同：进程被杀不会执行回滚，因此这条注入必须留下 journal 与备份，
    /// 让下一次开库面对的正是真实崩溃后的磁盘状态。
    #[cfg(test)]
    fn simulate_interruption_after(&mut self, stage: MigrationStage) {
        self.interrupt_after_stage = Some(stage);
    }
}

/// 收集库内全部图片侧车的路径，按路径排序。
///
/// 只扫 `objects/` 与 `trash/`：库根还放着 `library.json`、`folders.json` 与 journal
/// 自身，把它们当成侧车会让迁移去改写自己的记录。
///
/// 排序使迁移顺序确定：顺序影响不了结果，但影响失败时先撞上哪个损坏文件，而"同一个库
/// 每次报同一个错"是可诊断的前提。
///
/// 与 `index.rs` 中同名的私有函数刻意分开而不是提取公用：那一份把 I/O 失败报成
/// `library.index_rebuild_failed`，对迁移是错的错误码——迁移读侧车时索引还没参与进来。
fn collect_sidecars(root: &Path) -> Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    for tree in [root.join(OBJECTS_DIR), root.join(TRASH_DIR)] {
        walk(&tree, &mut out)?;
    }
    out.sort();
    Ok(out)
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) -> Result<()> {
    if !dir.is_dir() {
        return Ok(());
    }
    let io_failed = |e: std::io::Error, what: &str| {
        AppError::detailed(
            Code::LibraryIoFailed,
            format!("{what} {}: {e}", dir.display()),
        )
    };
    for entry in std::fs::read_dir(dir).map_err(|e| io_failed(e, "读取目录失败"))? {
        let entry = entry.map_err(|e| io_failed(e, "读取目录项失败"))?;
        let path = entry.path();
        if entry
            .file_type()
            .map_err(|e| io_failed(e, "读取目录项类型失败"))?
            .is_dir()
        {
            walk(&path, out)?;
        } else if path.extension().is_some_and(|e| e == "json") {
            // 只认 `.json`。写入中途留下的 `.json.tmp` 不是侧车，扫进来会当成损坏素材。
            out.push(path);
        }
    }
    Ok(())
}

/// 把库内绝对路径转成 journal 里记的相对键，分隔符统一为 `/`。
///
/// 统一分隔符不是审美：journal 要在库被整体复制或移动到另一台机器之后仍然可用，而
/// 恢复逻辑正是拿这些键去 `join`。Windows 的 `join` 接受 `/`，反过来不成立。
fn relative_key(root: &Path, path: &Path) -> Result<String> {
    let corrupt = |what: &str| {
        AppError::detailed(
            Code::MigrationJournalCorrupt,
            format!("{what}：{}", path.display()),
        )
    };
    let relative = path
        .strip_prefix(root)
        .map_err(|_| corrupt("侧车不在库目录内"))?;
    let mut parts = Vec::new();
    for component in relative.components() {
        match component {
            std::path::Component::Normal(part) => {
                parts.push(
                    part.to_str()
                        .ok_or_else(|| corrupt("侧车路径不是合法 UTF-8"))?,
                );
            }
            // 只接受纯相对路径。盘符、`..` 与根成分都会让这个键在库被移动后指向别处。
            _ => return Err(corrupt("侧车路径含有不能记入 journal 的成分")),
        }
    }
    Ok(parts.join("/"))
}

fn file_name_of(relative_key: &str) -> String {
    relative_key
        .rsplit('/')
        .next()
        .unwrap_or(relative_key)
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_LIBRARY_ID: &str = "018f3c9e-6c00-7000-8000-0000000f0001";

    fn ts(secs: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(secs, 0).expect("固定时间戳")
    }

    fn entry(path: &str, state: JournalEntryState) -> JournalEntry {
        JournalEntry {
            sidecar_relative_path: path.to_owned(),
            state,
        }
    }

    fn sample() -> MigrationJournal {
        MigrationJournal {
            format_version: MIGRATION_JOURNAL_FORMAT_VERSION,
            library_id: LibraryId::parse(SAMPLE_LIBRARY_ID).expect("合法库 ID"),
            from_version: 1,
            to_version: 2,
            started_at: ts(0),
            stage: MigrationStage::Started,
            entries: vec![
                entry("objects/3f/a9/aaa.json", JournalEntryState::Rewritten),
                entry("objects/3f/a9/bbb.json", JournalEntryState::BackedUp),
                entry("trash/00/11/ccc.json", JournalEntryState::Pending),
            ],
        }
    }

    fn tmp_file() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("建立临时目录");
        let p = dir.path().join(JOURNAL_FILE);
        (dir, p)
    }

    #[test]
    fn round_trips_through_json() {
        let (_d, p) = tmp_file();
        let j = sample();
        j.write_atomic(&p).expect("写入 journal");
        assert_eq!(MigrationJournal::read(&p).expect("读回 journal"), j);
    }

    #[test]
    fn every_stage_and_entry_state_has_a_stable_string() {
        // 这些字符串会出现在 journal 文件、日志与迁移进度事件里，改动它们等于改动
        // 一份已经落盘的记录格式，因此在这里锁死。
        let stages = [
            (MigrationStage::Started, "started"),
            (MigrationStage::SkeletonReady, "skeleton_ready"),
            (MigrationStage::SidecarsRewritten, "sidecars_rewritten"),
            (MigrationStage::IndexRebuilt, "index_rebuilt"),
            (MigrationStage::Committed, "committed"),
        ];
        for (stage, text) in stages {
            assert_eq!(stage.as_str(), text);
            assert_eq!(
                serde_json::to_string(&stage).expect("序列化阶段"),
                format!("\"{text}\"")
            );
        }
        let states = [
            (JournalEntryState::Pending, "pending"),
            (JournalEntryState::BackedUp, "backed_up"),
            (JournalEntryState::Rewritten, "rewritten"),
            (JournalEntryState::RolledBack, "rolled_back"),
        ];
        for (state, text) in states {
            assert_eq!(state.as_str(), text);
            assert_eq!(
                serde_json::to_string(&state).expect("序列化条目状态"),
                format!("\"{text}\"")
            );
        }
    }

    #[test]
    fn an_unknown_entry_state_is_refused() {
        // 未知状态意味着这份 journal 来自一个本构建不认识的迁移实现。把它当成
        // pending 会重做已完成的工作，当成 rewritten 会跳过没做的工作，两者都更糟。
        let (_d, p) = tmp_file();
        sample().write_atomic(&p).expect("先写入合法 journal");
        let raw = std::fs::read_to_string(&p).expect("读取原始 JSON");
        std::fs::write(&p, raw.replace("\"pending\"", "\"半途而废\"")).expect("改坏条目状态");
        let err = MigrationJournal::read(&p).expect_err("本应拒绝未知条目状态");
        assert_eq!(err.code, Code::MigrationJournalCorrupt);
    }

    #[test]
    fn a_newer_journal_format_version_is_refused() {
        let (_d, p) = tmp_file();
        let mut j = sample();
        j.format_version = MIGRATION_JOURNAL_FORMAT_VERSION + 1;
        j.write_atomic(&p).expect("写入更高版本 journal");
        let err = MigrationJournal::read(&p).expect_err("本应拒绝更高的格式版本");
        assert_eq!(err.code, Code::MigrationJournalFormatTooNew);
    }

    #[test]
    fn an_unparseable_journal_reports_corruption() {
        let (_d, p) = tmp_file();
        std::fs::write(&p, "{ 坏了".as_bytes()).expect("写入损坏内容");
        let err = MigrationJournal::read(&p).expect_err("本应报告损坏");
        assert_eq!(err.code, Code::MigrationJournalCorrupt);
    }

    #[test]
    fn a_missing_field_is_refused_instead_of_defaulted() {
        // 缺 stage 的 journal 无法判断该继续还是该回滚；补一个默认阶段就是猜测。
        let (_d, p) = tmp_file();
        let json = format!(
            r#"{{
  "format_version": {MIGRATION_JOURNAL_FORMAT_VERSION},
  "library_id": "{SAMPLE_LIBRARY_ID}",
  "from_version": 1,
  "to_version": 2,
  "started_at": "1970-01-01T00:00:00Z",
  "entries": []
}}"#
        );
        std::fs::write(&p, json.as_bytes()).expect("写入缺 stage 的 journal");
        let err = MigrationJournal::read(&p).expect_err("本应拒绝缺少 stage 的 journal");
        assert_eq!(err.code, Code::MigrationJournalCorrupt);
    }

    #[test]
    fn atomic_write_leaves_no_temp_file_behind() {
        let dir = tempfile::tempdir().expect("建立临时目录");
        let p = dir.path().join(JOURNAL_FILE);
        sample().write_atomic(&p).expect("写入 journal");
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .expect("读取目录")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "残留临时文件：{leftovers:?}");
    }

    #[test]
    fn an_unwritable_target_reports_journal_write_failed() {
        let dir = tempfile::tempdir().expect("建立临时目录");
        let blocker = dir.path().join("被占用");
        std::fs::write(&blocker, b"x").expect("写入占位文件");
        let err = sample()
            .write_atomic(&blocker.join(JOURNAL_FILE))
            .expect_err("父路径是文件时本应写入失败");
        assert_eq!(err.code, Code::MigrationJournalWriteFailed);
    }

    #[test]
    fn duplicate_entries_are_refused() {
        // 同一个侧车出现两条记录时，两条记录的状态可以互相矛盾，恢复逻辑就没有
        // 确定的输入。这类 journal 只能判为损坏。
        let (_d, p) = tmp_file();
        let mut j = sample();
        j.entries = vec![
            entry("objects/3f/a9/aaa.json", JournalEntryState::BackedUp),
            entry("objects/3f/a9/aaa.json", JournalEntryState::Rewritten),
        ];
        let err = j.write_atomic(&p).expect_err("本应拒绝重复条目");
        assert_eq!(err.code, Code::MigrationJournalCorrupt);
    }

    #[test]
    fn a_journal_that_does_not_move_the_version_forward_is_refused() {
        // 迁移必须提升版本。from == to 的 journal 会让恢复逻辑进入一次没有终点的迁移。
        let (_d, p) = tmp_file();
        let mut j = sample();
        j.from_version = 2;
        j.to_version = 2;
        let err = j
            .write_atomic(&p)
            .expect_err("本应拒绝不推进版本的 journal");
        assert_eq!(err.code, Code::MigrationJournalCorrupt);
    }

    // ---------------------------------------------------------------- 迁移执行

    use crate::colorcard::ColorCard;
    use crate::hashing::ContentHash;
    use crate::library::{
        CurrentLibraryMeta, LibraryMetaV2, LIBRARY_FORMAT_VERSION_V2, LIBRARY_FORMAT_VERSION_V3,
        META_FILE, PROMPTS_DIR, PROMPT_FOLDERS_FILE, PROMPT_OBJECTS_DIR, PROMPT_TRASH_DIR,
    };
    use crate::media::MediaType;
    use crate::prompt::PromptFolderList;
    use crate::sidecar::{AssetSidecarV1, AssetSidecarV2, SIDECAR_FORMAT_VERSION};
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    /// 一个 v1 库，外加它全部权威文件与本体的原始字节。
    ///
    /// 迁移的正确性一半体现在"没被要求改的东西一个字节都没变"，因此这些原始字节是
    /// 回滚与本体不变两类断言的唯一依据。
    struct V1Fixture {
        _dir: tempfile::TempDir,
        root: PathBuf,
        original_sidecars: BTreeMap<PathBuf, Vec<u8>>,
        original_bodies: BTreeMap<PathBuf, Vec<u8>>,
        trashed_sidecar: PathBuf,
    }

    fn v1_sidecar(hash: &ContentHash, deleted: bool) -> AssetSidecarV1 {
        AssetSidecarV1 {
            format_version: SIDECAR_FORMAT_VERSION,
            hash: hash.clone(),
            hash_algo: crate::hashing::HASH_ALGO_ID.to_owned(),
            media_type: MediaType::Png,
            ext: "png".to_owned(),
            byte_size: 3,
            width: 4,
            height: 2,
            imported_at: ts(0),
            original_filename: "样例.png".to_owned(),
            source_path: Some("D:/素材/样例.png".to_owned()),
            folders: vec!["参考/构图".to_owned()],
            tags: vec!["逆光".to_owned()],
            color_card: ColorCard::failed(Code::ColorCardInsufficientOpaquePixels),
            deleted_at: if deleted { Some(ts(120)) } else { None },
            deleted_from_folders: if deleted {
                Some(vec!["参考/构图".to_owned()])
            } else {
                None
            },
        }
    }

    /// 建立一个 v1 库：`normal` 张正常图片，加固定一张回收站图片。
    fn v1_library(normal: usize) -> V1Fixture {
        let dir = tempfile::tempdir().expect("建立临时目录");
        let root = dir.path().join("我的素材库");
        // 自己写一份 v1 库，而不是用 `Library::create`：建库已经只产出 v2（任务 3.3），
        // 而这个夹具的全部意义就是提供一个真实的迁移输入。刻意不建 `prompts/objects`、
        // `prompts/trash` 与提示词文件夹清单——那三样正是迁移要建立的东西。
        for d in [OBJECTS_DIR, TRASH_DIR, "thumbnails", PROMPTS_DIR] {
            std::fs::create_dir_all(root.join(d)).expect("建立 v1 子目录");
        }
        // 直接用 serde_json 写：生产侧已经没有 v1 的写入器了，而这正是应有的状态——
        // 只有迁移的输入夹具需要造 v1 文件，为它在生产代码里留一个 v1 writer 反而会
        // 让"程序还会写 v1"这件事看起来仍然成立。
        let write_json = |path: PathBuf, value: serde_json::Value| {
            std::fs::write(&path, serde_json::to_vec_pretty(&value).expect("序列化"))
                .expect("写入 v1 权威文件");
        };
        write_json(
            root.join(META_FILE),
            serde_json::json!({
                "format_version": 1,
                "hash_algo": crate::hashing::HASH_ALGO_ID,
                "created_at": ts(0),
                "created_by_app_version": "0.1.0",
            }),
        );
        write_json(
            root.join(crate::library::FOLDERS_FILE),
            serde_json::json!({ "format_version": 1, "folders": [] }),
        );

        let mut original_sidecars = BTreeMap::new();
        let mut original_bodies = BTreeMap::new();

        let objects = root.join(OBJECTS_DIR);
        let trash = root.join(TRASH_DIR);
        let thumbnails = root.join("thumbnails");
        let mut place = |content: Vec<u8>, deleted: bool| -> PathBuf {
            let hash = ContentHash::of_bytes(&content);
            let (body, sidecar) = if deleted {
                (
                    hash.body_path_in(&trash, "png"),
                    hash.sidecar_path_in(&trash),
                )
            } else {
                (
                    hash.body_path_in(&objects, "png"),
                    hash.sidecar_path_in(&objects),
                )
            };
            std::fs::create_dir_all(body.parent().expect("叶目录")).expect("建立叶目录");
            std::fs::write(&body, &content).expect("写入本体");
            v1_sidecar(&hash, deleted)
                .write_atomic(&sidecar)
                .expect("写入 v1 侧车");
            let thumb = hash.body_path_in(&thumbnails, "webp");
            std::fs::create_dir_all(thumb.parent().expect("缩略图叶目录")).expect("建立叶目录");
            std::fs::write(&thumb, "缩略图字节".as_bytes()).expect("写入缩略图");
            original_bodies.insert(body, content);
            original_sidecars.insert(sidecar.clone(), std::fs::read(&sidecar).expect("读侧车"));
            sidecar
        };

        for i in 0..normal {
            place(format!("图片本体 {i}").into_bytes(), false);
        }
        let trashed_sidecar = place("回收站图片本体".as_bytes().to_vec(), true);

        V1Fixture {
            _dir: dir,
            root,
            original_sidecars,
            original_bodies,
            trashed_sidecar,
        }
    }

    fn ok_rebuild() -> impl FnMut(&Path) -> Result<()> {
        |_root: &Path| Ok(())
    }

    fn v1_format_version(root: &Path) -> u32 {
        LibraryMeta::read(&root.join(META_FILE))
            .expect("回滚后 library.json 仍应是一份可读的 v1 文件")
            .format_version
    }

    fn assert_sidecars_are_byte_identical(f: &V1Fixture, context: &str) {
        for (path, bytes) in &f.original_sidecars {
            assert_eq!(
                &std::fs::read(path).expect("读侧车"),
                bytes,
                "{context}：侧车未恢复原始字节 {}",
                path.display()
            );
        }
    }

    fn assert_no_migration_residue(f: &V1Fixture) {
        for name in [JOURNAL_FILE, LOCK_FILE] {
            assert!(!f.root.join(name).exists(), "残留迁移文件：{name}");
        }
        assert!(
            !f.root.join(BACKUP_DIR).exists(),
            "残留备份树：{BACKUP_DIR}"
        );
    }

    #[test]
    fn a_v1_library_migrates_to_v2() {
        let f = v1_library(3);
        let mut rebuilds = 0usize;
        let mut seen: Vec<MigrationProgress> = Vec::new();
        let outcome = Migration::new(&f.root)
            .run(
                &mut |_root| {
                    rebuilds += 1;
                    Ok(())
                },
                &mut |p| seen.push(p),
            )
            .expect("迁移应成功");

        assert_eq!(rebuilds, 1, "索引应恰好重建一次");
        assert_eq!(
            outcome.sidecars_rewritten, 4,
            "三张正常图片加一张回收站图片"
        );
        assert!(!outcome.resumed);

        let meta = LibraryMetaV2::read(&f.root.join(META_FILE)).expect("读 v2 库级元数据");
        assert_eq!(meta.format_version, 2);
        assert_eq!(meta.library_id, outcome.library_id);
        assert_eq!(meta.hash_algo, crate::hashing::HASH_ALGO_ID);

        for path in f.original_sidecars.keys() {
            let v2 = AssetSidecarV2::read(path).expect("侧车应可按 v2 读出");
            assert_eq!(v2.note, "", "迁移不得凭空写入备注");
            assert!(!v2.favorite, "迁移不得凭空把素材标为收藏");
            assert_eq!(
                v2.folders,
                vec!["参考/构图".to_owned()],
                "组织信息必须原样保留"
            );
            assert_eq!(v2.tags, vec!["逆光".to_owned()]);
        }
        let trashed = AssetSidecarV2::read(&f.trashed_sidecar).expect("回收站侧车应可读");
        assert!(trashed.is_deleted(), "回收站状态必须保留");
        assert_eq!(
            trashed.deleted_from_folders,
            Some(vec!["参考/构图".to_owned()]),
            "删除前文件夹必须保留，否则还原会落到根位置"
        );

        assert!(f.root.join(PROMPTS_DIR).join(PROMPT_OBJECTS_DIR).is_dir());
        assert!(f.root.join(PROMPTS_DIR).join(PROMPT_TRASH_DIR).is_dir());
        assert!(
            PromptFolderList::read(&f.root.join(PROMPT_FOLDERS_FILE))
                .expect("读提示词文件夹清单")
                .folders
                .is_empty(),
            "迁移不得预置任何提示词文件夹"
        );

        for (path, bytes) in &f.original_bodies {
            assert_eq!(
                &std::fs::read(path).expect("读本体"),
                bytes,
                "迁移改动了图片本体：{}",
                path.display()
            );
        }
        assert_no_migration_residue(&f);
        assert!(matches!(
            detect_library_format(&f.root).expect("判定格式"),
            LibraryFormatState::Current(_)
        ));
    }

    #[test]
    fn progress_covers_every_sidecar_with_a_stable_total() {
        let f = v1_library(4);
        let mut seen: Vec<MigrationProgress> = Vec::new();
        Migration::new(&f.root)
            .run(&mut ok_rebuild(), &mut |p| seen.push(p))
            .expect("迁移应成功");

        assert!(!seen.is_empty(), "迁移必须报告进度");
        let total = seen[0].total;
        assert_eq!(total, 5, "总数应为全部侧车数量");
        assert!(seen.iter().all(|p| p.total == total), "总数不得中途变化");
        let mut last = 0;
        for p in &seen {
            assert!(p.done >= last, "已处理数不得回退");
            assert!(p.done <= p.total);
            last = p.done;
            assert!(!p.current_filename.is_empty(), "进度必须携带当前文件名");
        }
        assert_eq!(last, total, "最后一次进度应报告全部完成");
    }

    #[test]
    fn the_library_version_is_committed_after_everything_else() {
        // 迁移计划把 library.json 放在最后一步：只要它还是 v1，一个被中断的迁移就还是
        // 一个"未迁移的库"，而不是一个半新半旧的库。
        let f = v1_library(2);
        let err = Migration::new(&f.root)
            .run(
                &mut |_root| Err(AppError::new(Code::LibraryIndexRebuildFailed)),
                &mut |_| {},
            )
            .expect_err("索引重建失败时迁移本应失败");
        assert_eq!(err.code, Code::LibraryIndexRebuildFailed);

        assert_eq!(v1_format_version(&f.root), 1, "库版本本应仍是 v1");
        assert_sidecars_are_byte_identical(&f, "索引重建失败");
        assert!(
            !f.root.join(PROMPT_FOLDERS_FILE).exists(),
            "回滚应移除迁移建立的提示词文件夹清单"
        );
        assert_no_migration_residue(&f);
        assert_eq!(
            detect_library_format(&f.root).expect("判定格式"),
            LibraryFormatState::NeedsMigration { from_version: 1 },
            "回滚后应仍可重新发起迁移"
        );
    }

    #[test]
    fn a_failing_sidecar_rewrite_rolls_back_every_processed_file() {
        // 分别在第一个、中间一个和最后一个侧车上失败：只测其中一个位置，会漏掉
        // "第一个就失败时误以为没有备份可恢复"和"最后一个失败时漏掉前面全部"这两类缺陷。
        for fail_at in [0usize, 1, 3] {
            let f = v1_library(3);
            let mut migration = Migration::new(&f.root);
            migration.inject_sidecar_write_failure_at(fail_at);
            let err = migration
                .run(&mut ok_rebuild(), &mut |_| {})
                .expect_err("注入的侧车写入失败本应使迁移失败");
            assert_eq!(
                err.code,
                Code::MigrationSidecarRewriteFailed,
                "fail_at={fail_at}"
            );
            assert_sidecars_are_byte_identical(&f, &format!("fail_at={fail_at}"));
            assert_eq!(v1_format_version(&f.root), 1, "fail_at={fail_at}");
            assert_no_migration_residue(&f);
        }
    }

    #[test]
    fn an_interrupted_migration_is_reported_and_then_resumed() {
        let f = v1_library(3);
        let mut migration = Migration::new(&f.root);
        migration.simulate_interruption_after(MigrationStage::SidecarsRewritten);
        let err = migration
            .run(&mut ok_rebuild(), &mut |_| {})
            .expect_err("注入的中断本应返回失败");
        assert_eq!(err.code, Code::MigrationInterrupted);

        // 中断不回滚：磁盘上必须留下 journal 与备份，交给下一次开库处理。
        assert!(f.root.join(JOURNAL_FILE).is_file(), "中断后应留下 journal");
        assert!(f.root.join(BACKUP_DIR).is_dir(), "中断后应留下备份树");

        let journal = match detect_library_format(&f.root).expect("判定格式") {
            LibraryFormatState::MigrationIncomplete(j) => j,
            other => panic!("未完成的迁移被判成了 {other:?}"),
        };
        assert_eq!(journal.stage, MigrationStage::SidecarsRewritten);

        // 真实崩溃会把锁文件留在磁盘上。恢复必须能接管它，否则库将永远打不开。
        std::fs::write(f.root.join(LOCK_FILE), "上次崩溃留下的锁".as_bytes())
            .expect("写入残留锁文件");

        let outcome = Migration::new(&f.root)
            .run(&mut ok_rebuild(), &mut |_| {})
            .expect("恢复应成功");
        assert!(outcome.resumed, "本次应被报告为恢复而不是全新迁移");
        assert_eq!(
            LibraryMetaV2::read(&f.root.join(META_FILE))
                .expect("读 v2 元数据")
                .library_id,
            journal.library_id,
            "恢复不得分配第二个库 ID：分库布局偏好正以它为键"
        );
        assert_no_migration_residue(&f);
    }

    #[test]
    fn a_held_lock_refuses_a_second_migration() {
        let f = v1_library(1);
        std::fs::write(f.root.join(LOCK_FILE), "另一次迁移".as_bytes()).expect("写入锁文件");
        let err = Migration::new(&f.root)
            .run(&mut ok_rebuild(), &mut |_| {})
            .expect_err("本应拒绝并发迁移");
        assert_eq!(err.code, Code::MigrationLockHeld);
        assert_sidecars_are_byte_identical(&f, "并发迁移被拒");
        assert_eq!(v1_format_version(&f.root), 1);
        assert!(
            !f.root.join(JOURNAL_FILE).exists(),
            "被拒绝的迁移不得写下 journal"
        );
    }

    #[test]
    fn detecting_a_directory_that_is_not_a_library_reports_not_found() {
        let dir = tempfile::tempdir().expect("建立临时目录");
        let err = detect_library_format(dir.path()).expect_err("空目录本应报告不是库");
        assert_eq!(err.code, Code::LibraryNotFound);
    }

    #[test]
    fn detecting_a_library_from_the_future_is_refused_rather_than_migrated() {
        let f = v1_library(1);
        let raw = std::fs::read_to_string(f.root.join(META_FILE)).expect("读 library.json");
        std::fs::write(
            f.root.join(META_FILE),
            raw.replace("\"format_version\": 1", "\"format_version\": 99"),
        )
        .expect("改写格式版本");
        let err = detect_library_format(&f.root).expect_err("更高版本本应被拒绝");
        assert_eq!(err.code, Code::LibraryFormatTooNew);
    }

    /// 把库级元数据的版本号改写成 v3，其余字段原样保留——正是迁移提交产出的形状。
    #[cfg(test)]
    fn promote_meta_to_v3(root: &Path) {
        let path = root.join(META_FILE);
        let mut meta: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).expect("读库级元数据"))
                .expect("解析库级元数据");
        meta["format_version"] = serde_json::json!(LIBRARY_FORMAT_VERSION_V3);
        std::fs::write(&path, serde_json::to_vec_pretty(&meta).expect("序列化元数据"))
            .expect("改写库级元数据");
    }

    /// 任务 3.5：v3 是当前代。检测必须把它判为 Current 并放行打开；而 v2→v3 的规划
    /// 与提交门禁必须拒绝已是 v3 的输入——否则第二次提交会把 v3 侧车当 v2 解析，
    /// 用垃圾字段顶替权威字节。
    #[test]
    fn a_v3_library_is_current_and_rejected_by_the_v2_to_v3_gates() {
        let f = v2_library(2);
        promote_meta_to_v3(&f.root);

        assert!(matches!(
            detect_library_format(&f.root).expect("判定格式"),
            LibraryFormatState::Current(CurrentLibraryMeta::V3(_))
        ));

        let err = V3MigrationPlan::inspect(&f.root)
            .expect_err("v3 库不应再生成 v2→v3 迁移计划");
        assert_eq!(err.code, Code::MigrationPlanStale);

        let resolved = ResolvedV3MigrationPlan { entries: Vec::new() };
        let err = V3MigrationCommit::new(&resolved, &f.root)
            .run(&mut ok_rebuild(), &mut |_| {})
            .expect_err("v3 库不应再被 v2→v3 提交接受");
        assert_eq!(err.code, Code::MigrationPlanStale);
    }

    /// 任务 2.6 的 release 基线：1,000 与 10,000 侧车下的迁移耗时、磁盘峰值、
    /// 中断恢复耗时与回滚结果。
    ///
    /// 数字只在 release 构建下有意义，因此与查询基线一样 cfg 掉 debug 构建、
    /// 以 `--ignored` 显式运行：
    /// `cargo test -p vistash-core --release --ignored migration_release_baseline -- --nocapture`。
    /// 产出的数字记录在 tasks.md 的 2.6 备注里；本测试只负责让它们可复现。
    #[test]
    #[cfg(not(debug_assertions))]
    #[ignore = "release 性能基线：显式运行 --release --ignored"]
    fn migration_release_baseline_on_thousand_and_ten_thousand_sidecars() {
        for count in [1_000usize, 10_000] {
            // —— 完整迁移：耗时与磁盘峰值 ——
            let f = v1_library(count);
            let peak = std::cell::Cell::new(0u64);
            let sampled_root = f.root.clone();
            let mut progress = |p: MigrationProgress| {
                // 每 256 个侧车采样一次库目录占用：逐个采样是 O(N²)，粗采样足够给出峰值量级。
                if p.done % 256 == 0 {
                    let size = directory_size(&sampled_root);
                    if size > peak.get() {
                        peak.set(size);
                    }
                }
            };
            let started = std::time::Instant::now();
            let outcome = Migration::new(&f.root)
                .run(&mut ok_rebuild(), &mut progress)
                .expect("完整迁移应成功");
            let elapsed = started.elapsed();
            let peak = peak.get().max(directory_size(&f.root));
            eprintln!(
                "[{count} 侧车] 完整迁移 {elapsed:?}，重写 {} 个侧车，磁盘峰值约 {} MiB",
                outcome.sidecars_rewritten,
                peak / (1024 * 1024),
            );

            // —— 中断恢复：在侧车重写完成后模拟崩溃，下次开库续跑 ——
            let f2 = v1_library(count);
            let mut interrupted = Migration::new(&f2.root);
            interrupted.simulate_interruption_after(MigrationStage::SidecarsRewritten);
            interrupted
                .run(&mut ok_rebuild(), &mut |_| {})
                .expect_err("注入的中断本应返回失败");
            let resumed_started = std::time::Instant::now();
            let resumed = Migration::new(&f2.root)
                .run(&mut ok_rebuild(), &mut |_| {})
                .expect("续跑应成功");
            eprintln!(
                "[{count} 侧车] 中断后续跑 {:?}（resumed={}）",
                resumed_started.elapsed(),
                resumed.resumed,
            );
            assert!(resumed.resumed, "续跑必须被报告为恢复");

            // —— 回滚：注入第 N 个侧车重写失败，验证回滚结果 ——
            let f3 = v1_library(count);
            let mut failing = Migration::new(&f3.root);
            failing.inject_sidecar_write_failure_at(count / 2);
            failing
                .run(&mut ok_rebuild(), &mut |_| {})
                .expect_err("注入的失败本应返回错误");
            assert_eq!(
                v1_format_version(&f3.root),
                1,
                "回滚后 library.json 必须仍是 v1"
            );
            assert_sidecars_are_byte_identical(&f3, "回滚后");
            eprintln!("[{count} 侧车] 注入失败后回滚成功：library.json 保持 v1，全部侧车字节复原");
        }
    }

    /// 递归统计目录字节数。只服务基线采样，不追求精确到分配粒度。
    #[cfg(not(debug_assertions))]
    fn directory_size(root: &Path) -> u64 {
        let mut total = 0u64;
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else if let Ok(meta) = entry.metadata() {
                    total += meta.len();
                }
            }
        }
        total
    }

    // ---------------------------------------------------- v2→v3 提交（任务 3.3）

    use crate::library::Library;
    use crate::sidecar::{AssetSidecarV3, AssetSource};

    /// 一个完整 v2 库，外加它全部权威文件与本体的原始字节。
    ///
    /// 组成固定：`normal` 张正常图片中第一张未分类、其余单归属“参考”，另有固定一张
    /// 同时归属“参考”与“配色”的冲突图片和一张回收站图片。角色化的 hash 让断言能
    /// 点名“那张冲突图片”，而不是按下标去猜位置。
    struct V2Fixture {
        _dir: tempfile::TempDir,
        root: PathBuf,
        library_id: LibraryId,
        unclassified_hash: ContentHash,
        single_folder_hash: ContentHash,
        conflict_hash: ContentHash,
        trashed_hash: ContentHash,
        original_meta: Vec<u8>,
        original_folders: Vec<u8>,
        original_sidecars: BTreeMap<PathBuf, Vec<u8>>,
        original_bodies: BTreeMap<PathBuf, Vec<u8>>,
    }

    fn v2_sidecar_fixture(hash: &ContentHash, folders: &[&str]) -> AssetSidecarV2 {
        AssetSidecarV2 {
            format_version: SIDECAR_FORMAT_VERSION_V2,
            hash: hash.clone(),
            hash_algo: crate::hashing::HASH_ALGO_ID.to_owned(),
            media_type: MediaType::Png,
            ext: "png".to_owned(),
            byte_size: 3,
            width: 16,
            height: 9,
            imported_at: ts(0),
            original_filename: "样例.png".to_owned(),
            source_path: Some("D:/素材/样例.png".to_owned()),
            folders: folders.iter().map(|folder| (*folder).to_owned()).collect(),
            tags: vec!["逆光".to_owned()],
            color_card: ColorCard::failed(Code::ColorCardInsufficientOpaquePixels),
            note: String::new(),
            favorite: false,
            deleted_at: None,
            deleted_from_folders: None,
        }
    }

    #[test]
    fn v3_conversion_strips_the_disk_extension_case_insensitively() {
        // 真实 v2 数据：ext 在导入时归一成小写，而原始文件名保留磁盘上的大小写。
        // 剥离必须折叠大小写——否则整段文件名带着扩展名落进主体，被显示名校验
        // 拒绝，迁移对这类库直接失败。
        let mut v2 = v2_sidecar_fixture(&ContentHash::of_bytes(b"uppercase-ext"), &[]);
        v2.original_filename = "IMG_0042.PNG".to_owned();
        v2.source_path = Some("D:/素材/IMG_0042.PNG".to_owned());

        let v3 = convert_sidecar_v2_to_v3(&v2, None).expect("大写扩展名不得让迁移失败");

        assert_eq!(
            v3.display_filename.as_str(),
            "IMG_0042.png",
            "显示名取主体加媒体类型规范扩展名"
        );
        match v3.source {
            AssetSource::Filesystem { filename, .. } => {
                assert_eq!(filename, "IMG_0042.PNG", "来源名原样保留磁盘上的大小写");
            }
            other => panic!("文件系统导入不应映射成其他来源：{other:?}"),
        }
    }

    fn v2_library(normal: usize) -> V2Fixture {
        assert!(normal >= 2, "夹具组成依赖至少两张正常图片的角色分工");
        let dir = tempfile::tempdir().expect("建立临时目录");
        let library = Library::create(&dir.path().join("我的素材库")).expect("建立 v2 库");
        let root = library.root().to_path_buf();
        let library_id = library.meta().library_id.clone();
        // 建库入口自任务 3.5 起直接产出 v3 库级元数据；v2→v3 迁移的输入必须是真
        // v2 库，夹具因此显式把 library.json 降写回 v2——这正是迁移提交前旧库的样子。
        // 侧车仍由下方 place() 按 v2 写出，与库级版本一致。
        LibraryMetaV2 {
            format_version: LIBRARY_FORMAT_VERSION_V2,
            library_id: library_id.clone(),
            hash_algo: library.meta().hash_algo.clone(),
            created_at: library.meta().created_at,
            created_by_app_version: library.meta().created_by_app_version.clone(),
        }
        .write_atomic(&root.join(META_FILE))
        .expect("降写 v2 库级元数据");

        let mut original_sidecars = BTreeMap::new();
        let mut original_bodies = BTreeMap::new();
        let objects = root.join(OBJECTS_DIR);
        let trash = root.join(TRASH_DIR);

        let mut place = |content: Vec<u8>, folders: &[&str], deleted: bool| -> ContentHash {
            let hash = ContentHash::of_bytes(&content);
            let (body, sidecar) = if deleted {
                (
                    hash.body_path_in(&trash, "png"),
                    hash.sidecar_path_in(&trash),
                )
            } else {
                (
                    hash.body_path_in(&objects, "png"),
                    hash.sidecar_path_in(&objects),
                )
            };
            std::fs::create_dir_all(body.parent().expect("叶目录")).expect("建立叶目录");
            std::fs::write(&body, &content).expect("写入本体");
            let mut sidecar_value = v2_sidecar_fixture(&hash, folders);
            if deleted {
                sidecar_value.deleted_at = Some(ts(120));
                sidecar_value.deleted_from_folders =
                    Some(folders.iter().map(|folder| (*folder).to_owned()).collect());
            }
            sidecar_value.write_atomic(&sidecar).expect("写入 v2 侧车");
            original_bodies.insert(body, content);
            original_sidecars.insert(sidecar.clone(), std::fs::read(&sidecar).expect("读侧车"));
            hash
        };

        let unclassified_hash = place("图片本体 0".as_bytes().to_vec(), &[], false);
        let single_folder_hash = place("图片本体 1".as_bytes().to_vec(), &["参考"], false);
        for i in 2..normal {
            place(format!("图片本体 {i}").into_bytes(), &["参考"], false);
        }
        let conflict_hash = place("冲突图片本体".as_bytes().to_vec(), &["参考", "配色"], false);
        let trashed_hash = place("回收站图片本体".as_bytes().to_vec(), &["参考"], true);

        let original_meta = std::fs::read(root.join(META_FILE)).expect("读库级元数据");
        let original_folders = std::fs::read(root.join(crate::library::FOLDERS_FILE))
            .expect("读文件夹清单");

        V2Fixture {
            _dir: dir,
            root,
            library_id,
            unclassified_hash,
            single_folder_hash,
            conflict_hash,
            trashed_hash,
            original_meta,
            original_folders,
            original_sidecars,
            original_bodies,
        }
    }

    /// 用“配色”解决夹具中的固定冲突，得到可提交的计划。
    fn resolved_plan(f: &V2Fixture) -> ResolvedV3MigrationPlan {
        let plan = V3MigrationPlan::inspect(&f.root).expect("生成 v3 迁移计划");
        plan.resolve(&[V3FolderResolution {
            hash: f.conflict_hash.clone(),
            folder: "配色".to_owned(),
        }])
        .expect("解决多归属冲突")
    }

    fn assert_authoritative_bytes_untouched(f: &V2Fixture, context: &str) {
        assert_eq!(
            std::fs::read(f.root.join(META_FILE)).expect("读 library.json"),
            f.original_meta,
            "{context}：library.json 被改动"
        );
        assert_eq!(
            std::fs::read(f.root.join(crate::library::FOLDERS_FILE))
                .expect("读文件夹清单"),
            f.original_folders,
            "{context}：folders.json 被改动"
        );
        for (path, bytes) in &f.original_sidecars {
            assert_eq!(
                &std::fs::read(path).expect("读侧车"),
                bytes,
                "{context}：侧车被改动 {}",
                path.display()
            );
        }
    }

    fn assert_no_v3_residue(f: &V2Fixture, context: &str) {
        assert!(
            !f.root.join(MIGRATION_WORK_DIR).exists(),
            "{context}：残留迁移工作目录"
        );
        assert!(!f.root.join(LOCK_FILE).exists(), "{context}：残留迁移锁");
    }

    /// 工作目录里的唯一会话子目录。多于或少于一个都说明布局契约被破坏。
    fn v3_session_dir(f: &V2Fixture) -> PathBuf {
        let work = f.root.join(MIGRATION_WORK_DIR);
        let sessions: Vec<_> = std::fs::read_dir(&work)
            .expect("读取迁移工作目录")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .collect();
        assert_eq!(sessions.len(), 1, "工作目录应恰好包含一个会话子目录");
        assert!(sessions[0].is_dir(), "会话条目应是目录");
        sessions[0].clone()
    }

    #[test]
    fn a_resolved_v3_plan_commits_the_whole_library_to_v3() {
        let f = v2_library(3);
        let mut seen: Vec<V3CommitStage> = Vec::new();
        V3MigrationCommit::new(&resolved_plan(&f), &f.root)
            .run(&mut ok_rebuild(), &mut |p| seen.push(p.stage))
            .expect("提交应成功");

        // 库级元数据升到 v3，库 ID 不变：分库布局偏好正以它为键。
        let meta: serde_json::Value = serde_json::from_slice(
            &std::fs::read(f.root.join(META_FILE)).expect("读 library.json"),
        )
        .expect("解析 library.json");
        assert_eq!(meta["format_version"], 3);
        assert_eq!(
            meta["library_id"],
            serde_json::to_value(&f.library_id).expect("序列化库 ID")
        );

        // 每张侧车都能按 v3 读出，映射符合设计第八条：来源显式、显示名取自旧原始名。
        let mut by_hash = BTreeMap::new();
        for path in f.original_sidecars.keys() {
            let v3 = AssetSidecarV3::read(path).expect("侧车应可按 v3 读出");
            assert_eq!(
                v3.source,
                AssetSource::Filesystem {
                    path: Some("D:/素材/样例.png".to_owned()),
                    filename: "样例.png".to_owned(),
                },
                "来源身份必须显式保留"
            );
            assert_eq!(v3.display_filename.as_str(), "样例.png");
            assert_eq!(v3.tags, vec!["逆光".to_owned()]);
            assert_eq!(v3.note, "", "迁移不得凭空写入备注");
            assert!(!v3.favorite, "迁移不得凭空把素材标为收藏");
            by_hash.insert(v3.hash.clone(), v3);
        }
        assert_eq!(by_hash[&f.unclassified_hash].folder, None, "零归属迁为未分类");
        assert_eq!(by_hash[&f.single_folder_hash].folder, Some("参考".to_owned()));
        assert_eq!(
            by_hash[&f.conflict_hash].folder,
            Some("配色".to_owned()),
            "使用者的唯一选择必须生效"
        );
        let trashed = &by_hash[&f.trashed_hash];
        assert!(trashed.is_deleted(), "回收站状态必须保留");
        assert_eq!(
            trashed.deleted_from_folder,
            Some("参考".to_owned()),
            "删除前唯一归属必须保留，否则还原会落到未分类"
        );

        for (path, bytes) in &f.original_bodies {
            assert_eq!(
                &std::fs::read(path).expect("读本体"),
                bytes,
                "提交改动了图片本体：{}",
                path.display()
            );
        }
        assert_no_v3_residue(&f, "成功提交");

        // 进度阶段必须按发生顺序单调出现，最后报告校验完成。
        assert_eq!(*seen.last().expect("必须报告进度"), V3CommitStage::Validated);
        let mut ranked = seen.clone();
        ranked.sort();
        assert_eq!(ranked, seen, "进度阶段必须单调推进");
    }

    #[test]
    fn staging_lands_inside_the_library_and_never_touches_authority_first() {
        let f = v2_library(2);
        let plan = resolved_plan(&f);
        let mut commit = V3MigrationCommit::new(&plan, &f.root);
        commit.simulate_interruption_after(V3CommitStage::Staged);
        let err = commit
            .run(&mut ok_rebuild(), &mut |_| {})
            .expect_err("注入的中断本应失败");
        assert_eq!(err.code, Code::MigrationInterrupted);

        // 权威字节原封不动；暂存只发生在库内的会话子目录里——“同卷”由此获得结构
        // 保证，后续同卷改名才能保持原子。恢复日志属于暂存之后的阶段，此刻不存在。
        assert_authoritative_bytes_untouched(&f, "暂存完成后");
        let session = v3_session_dir(&f);
        assert!(
            session.starts_with(f.root.join(MIGRATION_WORK_DIR)),
            "会话目录必须位于库内"
        );
        assert!(
            !session.join(RECOVERY_LOG_FILE).exists(),
            "暂存阶段尚不应有恢复日志"
        );
    }

    #[test]
    fn a_staging_failure_leaves_authority_untouched_and_removes_the_work_directory() {
        // 夹具共 5 张侧车加 1 份库级元数据共 6 个暂存单元：首、中、末各注入一次，
        // 覆盖“第一个就失败时没有已暂存内容可清理”与“最后一个失败时前面全部要撤”。
        for fail_at in [0usize, 3, 5] {
            let f = v2_library(3);
            let plan = resolved_plan(&f);
            let mut commit = V3MigrationCommit::new(&plan, &f.root);
            commit.inject_staging_write_failure_at(fail_at);
            let err = commit
                .run(&mut ok_rebuild(), &mut |_| {})
                .expect_err("注入的暂存失败本应使提交失败");
            assert_eq!(err.code, Code::MigrationStagingFailed, "fail_at={fail_at}");
            assert_authoritative_bytes_untouched(&f, &format!("fail_at={fail_at}"));
            assert_no_v3_residue(&f, &format!("fail_at={fail_at}"));
        }
    }

    #[test]
    fn a_replacement_failure_restores_every_authoritative_file_byte_for_byte() {
        // 替换单元与暂存一致（5 张侧车加 1 份库级元数据），首、中、末各注入一次：
        // 只测一个位置会漏掉“第一个就失败”和“最后一个失败时漏掉前面全部”两类缺陷。
        for fail_at in [0usize, 3, 5] {
            let f = v2_library(3);
            let plan = resolved_plan(&f);
            let mut commit = V3MigrationCommit::new(&plan, &f.root);
            commit.inject_replacement_failure_at(fail_at);
            let err = commit
                .run(&mut ok_rebuild(), &mut |_| {})
                .expect_err("注入的替换失败本应使提交失败");
            assert_eq!(err.code, Code::MigrationCommitFailed, "fail_at={fail_at}");
            assert_authoritative_bytes_untouched(&f, &format!("fail_at={fail_at}"));
            assert_no_v3_residue(&f, &format!("fail_at={fail_at}"));
        }
    }

    #[test]
    fn an_index_rebuild_failure_reports_the_original_error_and_restores_the_old_library() {
        let f = v2_library(2);
        let err = V3MigrationCommit::new(&resolved_plan(&f), &f.root)
            .run(
                &mut |_root| Err(AppError::new(Code::LibraryIndexRebuildFailed)),
                &mut |_| {},
            )
            .expect_err("索引重建失败本应使提交失败");
        // 原错误码上抛而不是裹成笼统的迁移错误：前端要能区分“索引没建成”。
        assert_eq!(err.code, Code::LibraryIndexRebuildFailed);
        assert_authoritative_bytes_untouched(&f, "索引重建失败");
        assert_no_v3_residue(&f, "索引重建失败");
        match detect_library_format(&f.root).expect("判定格式") {
            LibraryFormatState::Current(CurrentLibraryMeta::V2(meta)) => {
                assert_eq!(meta.library_id, f.library_id, "库仍应按原 v2 身份打开");
            }
            other => panic!("回滚后的库被判成了 {other:?}"),
        }
    }

    #[test]
    fn an_interrupted_commit_is_detected_then_recovered_by_a_full_rollback() {
        for stage in [
            V3CommitStage::Staged,
            V3CommitStage::Journaled,
            V3CommitStage::Replaced,
            V3CommitStage::IndexRebuilt,
            V3CommitStage::Validated,
        ] {
            let f = v2_library(2);
            let plan = resolved_plan(&f);
            let mut commit = V3MigrationCommit::new(&plan, &f.root);
            commit.simulate_interruption_after(stage);
            let err = commit
                .run(&mut ok_rebuild(), &mut |_| {})
                .expect_err("注入的中断本应失败");
            assert_eq!(err.code, Code::MigrationInterrupted);

            // 中断刻意不清理：磁盘上留下恢复日志与会话目录，正是真实崩溃的现场。
            let session = v3_session_dir(&f);
            if stage >= V3CommitStage::Journaled {
                assert!(
                    session.join(RECOVERY_LOG_FILE).is_file(),
                    "stage={}：日志之后的中断必须留下恢复日志",
                    stage.as_str()
                );
            }

            // 真实崩溃会把锁留在盘上；恢复必须接管它，否则库永远打不开。
            std::fs::write(f.root.join(LOCK_FILE), "上次崩溃留下的锁".as_bytes())
                .expect("写入残留锁文件");

            let mut rebuilds = 0usize;
            let recovered =
                recover_interrupted_v3_commit(&f.root, &mut |_root| {
                    rebuilds += 1;
                    Ok(())
                })
                .expect("恢复应成功");
            assert_eq!(recovered, V3Recovery::RolledBack, "stage={}", stage.as_str());

            assert_authoritative_bytes_untouched(&f, &format!("stage={}", stage.as_str()));
            assert_no_v3_residue(&f, &format!("stage={}", stage.as_str()));
            assert!(
                matches!(
                    detect_library_format(&f.root).expect("判定格式"),
                    LibraryFormatState::Current(_)
                ),
                "回滚后的库必须是可直接打开的纯 v2"
            );
            V3MigrationPlan::inspect(&f.root)
                .expect("回滚后应能重新生成迁移计划");

            // 替换开始过的崩溃可能留下按新元数据重建的派生索引；回滚必须重建索引，
            // 使派生数据与恢复出的旧元数据一致。
            if stage >= V3CommitStage::Replaced {
                assert!(
                    rebuilds >= 1,
                    "stage={}：替换后中断的回滚必须重建索引",
                    stage.as_str()
                );
            }
        }
    }

    #[test]
    fn a_corrupt_recovery_log_is_reported_rather_than_guessed_about() {
        let f = v2_library(2);
        let plan = resolved_plan(&f);
        let mut commit = V3MigrationCommit::new(&plan, &f.root);
        commit.simulate_interruption_after(V3CommitStage::Replaced);
        commit
            .run(&mut ok_rebuild(), &mut |_| {})
            .expect_err("注入的中断本应失败");

        // 中断发生在替换之后：现场此刻是“v3 权威 + 完好备份”，而不是迁移前的旧库。
        // 先拍下现场字节——拒绝猜测意味着也不动手，恢复被拒后必须与现场逐字节一致。
        let site_meta = std::fs::read(f.root.join(META_FILE)).expect("读现场 library.json");
        let site_sidecars: BTreeMap<PathBuf, Vec<u8>> = f
            .original_sidecars
            .keys()
            .map(|path| (path.clone(), std::fs::read(path).expect("读现场侧车")))
            .collect();

        let session = v3_session_dir(&f);
        let log = session.join(RECOVERY_LOG_FILE);
        std::fs::write(&log, "{ 已损坏".as_bytes()).expect("改坏恢复日志");

        let err = recover_interrupted_v3_commit(&f.root, &mut ok_rebuild())
            .expect_err("损坏的恢复日志本应被拒绝");
        assert_eq!(err.code, Code::MigrationJournalCorrupt);
        // 拒绝猜测意味着也不动手：现场原样保留给支持人员。
        assert_eq!(
            std::fs::read(f.root.join(META_FILE)).expect("读 library.json"),
            site_meta,
            "恢复日志损坏：library.json 被改动"
        );
        for (path, bytes) in &site_sidecars {
            assert_eq!(
                &std::fs::read(path).expect("读侧车"),
                bytes,
                "恢复日志损坏：侧车被改动 {}",
                path.display()
            );
        }
        assert!(log.is_file(), "损坏的日志本身必须保留");
        assert!(f.root.join(MIGRATION_WORK_DIR).is_dir());
    }

    #[test]
    fn recovering_a_library_without_an_unfinished_commit_is_a_no_op() {
        let f = v2_library(2);
        let recovered = recover_interrupted_v3_commit(&f.root, &mut ok_rebuild())
            .expect("没有未完成迁移时恢复应直接返回");
        assert_eq!(recovered, V3Recovery::NothingToDo);
        assert_no_v3_residue(&f, "无迁移的库");
    }

    #[test]
    fn a_completed_commit_interrupted_during_cleanup_keeps_the_library_at_v3() {
        let f = v2_library(2);
        let plan = resolved_plan(&f);
        let mut commit = V3MigrationCommit::new(&plan, &f.root);
        commit.simulate_interruption_after(V3CommitStage::Validated);
        commit
            .run(&mut ok_rebuild(), &mut |_| {})
            .expect_err("注入的中断本应失败");

        // 手工模拟“日志已删、目录未清”的收尾崩溃窗口：此刻库已经是纯 v3。
        let session = v3_session_dir(&f);
        std::fs::remove_file(session.join(RECOVERY_LOG_FILE)).expect("删除恢复日志");

        let mut rebuilds = 0usize;
        let recovered = recover_interrupted_v3_commit(&f.root, &mut |_root| {
            rebuilds += 1;
            Ok(())
        })
        .expect("恢复应成功");
        assert_eq!(recovered, V3Recovery::CompletedResidueCleaned);

        // 完成的迁移绝不能被回滚：库保持 v3，索引也不重建（Validated 之前已建好）。
        let meta: serde_json::Value = serde_json::from_slice(
            &std::fs::read(f.root.join(META_FILE)).expect("读 library.json"),
        )
        .expect("解析 library.json");
        assert_eq!(meta["format_version"], 3);
        AssetSidecarV3::read(f.original_sidecars.keys().next().expect("至少一张侧车"))
            .expect("侧车仍可按 v3 读出");
        assert_no_v3_residue(&f, "完成后的残留清理");
        assert_eq!(rebuilds, 0, "完成的迁移不得触发索引重建");
    }
}
