//! 库格式迁移的持久化 journal 与备份布局。
//!
//! 迁移要重写全库的图片侧车（设计第四条），因此它必然是一个可以被断电、被任务管理器
//! 结束、被杀毒软件打断的长操作。journal 存在的唯一理由是：进程下次启动时必须能判断
//! "上次迁移走到哪一步"，并据此继续或回滚，而 MUST NOT 把一个混合了 v1 与 v2 侧车的
//! 目录当成正常库打开。
//!
//! 因此 journal 本身也是权威数据：它损坏时不能猜测，只能如实报错。

use crate::error::{AppError, Code, Result};
use crate::library::{
    LibraryId, LibraryMeta, LibraryMetaV2, LIBRARY_FORMAT_VERSION_V2, META_FILE, OBJECTS_DIR,
    PROMPTS_DIR, PROMPT_FOLDERS_FILE, PROMPT_OBJECTS_DIR, PROMPT_TRASH_DIR, TRASH_DIR,
};
use crate::prompt::PromptFolderList;
use crate::sidecar::{AssetSidecarV1, AssetSidecarV2, SIDECAR_FORMAT_VERSION_V2};
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
    /// 已经是 v2，可以直接打开。
    Current(LibraryMetaV2),
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
    if format_version > LIBRARY_FORMAT_VERSION_V2 {
        return Err(AppError::detailed(
            Code::LibraryFormatTooNew,
            format!(
                "库格式版本 {format_version} 高于程序支持的 {LIBRARY_FORMAT_VERSION_V2}：{}",
                root.display()
            ),
        ));
    }
    if format_version == LIBRARY_FORMAT_VERSION_V2 {
        return Ok(LibraryFormatState::Current(LibraryMetaV2::read(&meta_path)?));
    }
    Ok(LibraryFormatState::NeedsMigration {
        from_version: format_version,
    })
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
            format!(
                "{META_FILE} 中读不出格式版本 {}: {e}",
                meta_path.display()
            ),
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
                // 已经是 v2 就没有工作要做。这里返回成功而不是报错，使"打开库"可以
                // 无条件先走一次迁移入口，而不必在每个调用方重复一遍版本判断。
                return Ok(MigrationOutcome {
                    library_id: meta.library_id,
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
        let rewrite_failed = |detail: String| {
            AppError::detailed(Code::MigrationSidecarRewriteFailed, detail)
        };
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
        std::fs::remove_dir_all(&dir).map_err(|e| {
            AppError::detailed(code, format!("删除备份树失败 {}: {e}", dir.display()))
        })
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
                parts.push(part.to_str().ok_or_else(|| corrupt("侧车路径不是合法 UTF-8"))?);
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
        let err = j.write_atomic(&p).expect_err("本应拒绝不推进版本的 journal");
        assert_eq!(err.code, Code::MigrationJournalCorrupt);
    }

    // ---------------------------------------------------------------- 迁移执行

    use crate::colorcard::ColorCard;
    use crate::hashing::ContentHash;
    use crate::library::{
        LibraryMetaV2, META_FILE, PROMPTS_DIR, PROMPT_FOLDERS_FILE, PROMPT_OBJECTS_DIR,
        PROMPT_TRASH_DIR,
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
            assert!(
                !f.root.join(name).exists(),
                "残留迁移文件：{name}"
            );
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
        assert_eq!(outcome.sidecars_rewritten, 4, "三张正常图片加一张回收站图片");
        assert!(!outcome.resumed);

        let meta = LibraryMetaV2::read(&f.root.join(META_FILE)).expect("读 v2 库级元数据");
        assert_eq!(meta.format_version, 2);
        assert_eq!(meta.library_id, outcome.library_id);
        assert_eq!(meta.hash_algo, crate::hashing::HASH_ALGO_ID);

        for path in f.original_sidecars.keys() {
            let v2 = AssetSidecarV2::read(path).expect("侧车应可按 v2 读出");
            assert_eq!(v2.note, "", "迁移不得凭空写入备注");
            assert!(!v2.favorite, "迁移不得凭空把素材标为收藏");
            assert_eq!(v2.folders, vec!["参考/构图".to_owned()], "组织信息必须原样保留");
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
}
