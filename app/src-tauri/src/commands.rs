//! Tauri command 薄层。
//!
//! 本模块的职责边界见约束：**只做参数转换与错误码映射，不含业务判断**。凡是
//! "什么情况下算重复""缩略图缺失该怎么办"一类的判断都在 `vistash-core` 里，因为那些
//! 判断需要被 `cargo test` 直接验证，而本模块的每个函数都要求先有一个 WebView 才能跑。
//!
//! 本层还承担两个适配职责：把核心导入观察点转为 Tauri typed `Channel`，以及在导入完成
//! 后更新 SQLite 索引。`import` 与 `index` 在约束里是同一层的两个模块，彼此没有
//! 依赖箭头，因此只能由它们上面的命令层编排；重复判定、回滚和媒体处理仍全部留在核心。
//!
//! IPC 边界上的字段名一律用 Rust 侧的 snake_case，不做 camelCase 改写：核心类型与
//! 这里的 DTO 混用两种命名，前端就得记住哪个类型用哪种。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use vistash_core::catalog::{
    AssetLocation, AssetQuery, BatchProgress, BatchReport, Catalog, CatalogSnapshot, FolderFilter,
    FolderMutationProgress, FolderName, FolderPath, FolderReorder, GlobalSearchResult, ImageDetail,
    ImportAndLinkReport, LinkedImageState, NewPrompt, PromptEdit, PromptLocation, PromptQuery,
    PromptPurgeReport, PromptRestoreOutcome, PromptSnapshot, PurgeReport, RestoreOutcome, Tag,
};
use vistash_core::clipboard::{self, ClipboardPayload};
use vistash_core::error::{AppError, Code, Result};
use vistash_core::external_open::ExternalOpenManager;
use vistash_core::hashing::ContentHash;
use vistash_core::import::{self, ImportFailure, TransferObserver, TransferRuns};
use vistash_core::index::{AssetRow, Index};
use vistash_core::library::{Library, LibraryId};
use vistash_core::media::MediaType;
use vistash_core::migration::{
    detect_library_format, recover_interrupted_v3_commit, LibraryFormatState, Migration,
    MigrationProgress as MigrationProgressCore, ResolvedV3MigrationPlan, V3CommitProgress,
    V3FolderPlan, V3FolderResolution, V3MigrationCommit, V3MigrationPlan,
};
use vistash_core::prompt::{PromptAsset, PromptId};
use vistash_core::settings::{AppSettings, LayoutStore};

/// Tauri Builder 与全部传输命令共享的精确 managed-state 类型。
pub type ManagedTransferRuns = Arc<TransferRuns>;

pub fn managed_transfer_runs() -> ManagedTransferRuns {
    Arc::new(TransferRuns::new())
}

/// 一个已打开的库及其索引。
struct Opened {
    catalog: Mutex<Catalog>,
    /// 同一个库一次只允许一个批量写入任务，避免两个拖入事件竞争去重与落盘。
    import_gate: Mutex<()>,
}

/// 应用运行期状态。
pub struct AppState {
    settings_path: PathBuf,
    /// 分库布局偏好目录。与设置文件同理放在应用配置侧、以库 ID 为键（见
    /// [`LayoutStore`]），库目录整体移动后布局仍然跟随库的身份而不是路径。
    layouts_dir: PathBuf,
    opened: Option<Arc<Opened>>,
    /// 设置里记录的库路径，即使打不开也报告：待迁移的旧库需要前端直接给出迁移入口，
    /// 而不是让使用者重新在目录树里找一遍这个位置。首次运行时为 `None`。
    recorded_path: Option<String>,
    /// 启动时恢复上次的库失败的原因。首次运行时为 `None`。
    restore_problem: Option<AppError>,
    /// 默认程序打开的只读副本管理器。会话 ID 每次运行生成一次，
    /// 由装配层构造后传入；清理逻辑凭它识别"当前会话"并永不自删。
    external_open: ExternalOpenManager,
}

impl AppState {
    /// 按设置里记录的路径尝试恢复上次的库。
    ///
    /// 恢复走的是 [`Library::open`] 而不是 `open_or_create`：记录的路径若已被移走或改名，
    /// 必须报告并回到选择界面，**绝不能建出一个新的空库**——那会让使用者面对空库却以为
    /// 素材全丢了。该路径明确报告错误，不会创建空库掩盖问题。
    pub fn restore(
        settings_path: PathBuf,
        layouts_dir: PathBuf,
        external_open: ExternalOpenManager,
    ) -> Self {
        let mut state = Self {
            settings_path,
            layouts_dir,
            opened: None,
            recorded_path: None,
            restore_problem: None,
            external_open,
        };
        let recorded = match AppSettings::read(&state.settings_path) {
            Ok(s) => s.last_library_path,
            Err(e) => {
                state.restore_problem = Some(e);
                return state;
            }
        };
        let Some(path) = recorded else {
            // 首次运行：没有记录不是失败，界面直接进选择流程。
            return state;
        };
        state.recorded_path = Some(path.clone());
        match with_migration_signal(&PathBuf::from(&path), open_at) {
            Ok(opened) => state.opened = Some(opened),
            Err(e) => state.restore_problem = Some(e),
        }
        state
    }
}

/// 打开一个已存在的库及其派生数据。不创建库。
fn open_at(root: &Path) -> Result<Arc<Opened>> {
    // 约束：v2→v3 提交期间进程被结束时，下次开库必须先经恢复入口整体回滚，
    // 不能带着"半迁移"现场继续。对没有未完成提交的库它是零写入的快速探测；
    // 恢复与提交共用同一份索引重建注入，保证回滚出的旧元数据配上一致的索引。
    let mut rebuild = |index_root: &Path| Index::rebuild_at(index_root).map(|_| ());
    recover_interrupted_v3_commit(root, &mut rebuild)?;
    open_derived(Library::open(root)?)
}

/// 打开库的两份派生数据：索引与缩略图树。
///
/// 两者都可以被删掉重建，因此这里做的都是自愈动作而不是校验：索引的 `user_version`
/// 不匹配即重扫重建，缩略图的格式版本不匹配即清空待重算。选库与启动恢复两条路径都必须
/// 走这里，否则换了缩略图编码参数之后，其中一条路径会继续读回旧格式的字节。
fn open_derived(lib: Library) -> Result<Arc<Opened>> {
    import::ensure_thumbnail_format(&lib)?;
    let catalog = Catalog::open(lib)?;
    Ok(Arc::new(Opened {
        catalog: Mutex::new(catalog),
        import_gate: Mutex::new(()),
    }))
}

pub type Shared = Mutex<AppState>;

/// 库的当前状态。
#[derive(Debug, Clone, Serialize)]
pub struct LibraryStatus {
    /// 已打开的库根路径。`None` 表示需要使用者选择。
    pub path: Option<String>,
    /// 打开库的稳定标识。分库布局偏好以它为键：键是库身份而不是
    /// 路径，目录改名或搬到另一个盘后偏好仍然跟随，不会表现为"设置自己复位"。
    pub library_id: Option<LibraryId>,
    /// 设置里记录的库路径。`path` 为 `None` 而它有值时，前端可以直接对它发起迁移，
    /// 不需要使用者重新寻找目录。
    pub recorded_path: Option<String>,
    /// 恢复上次的库失败时的原因。界面必须连同错误码一起呈现，而不是只说"请选择库"。
    pub problem: Option<AppError>,
}

/// 一次导入的结果。
///
/// 数量四桶互斥齐全（asset-transfer 停止规格）：已成功、重复、失败逐项与未处理。
#[derive(Debug, Clone, Serialize)]
pub struct ImportOutcome {
    /// 没有创建任务的剪贴板空操作为 `None`；真实导入始终为 `Some`。
    pub task_id: Option<String>,
    pub imported: usize,
    /// 目录中被跳过的非图片文件数。
    pub skipped_non_images: usize,
    /// 内容已在库内（或回收站）而未再次复制的来源数；既有素材保持原归属。
    pub duplicates: usize,
    /// 观察到停止后尚未处理的来源数；不是失败。
    pub pending_count: usize,
    /// 逐条失败。批量操作的失败可逐条查看，不得只报总数。
    pub failures: Vec<ImportFailure>,
}

/// 导出命令的 IPC 结果：核心逐项报告加上传输任务身份。
#[derive(Debug, Clone, Serialize)]
pub struct ExportOutcome {
    pub task_id: String,
    pub exported: Vec<String>,
    pub skipped_existing: usize,
    pub failed: Vec<vistash_core::export::ExportFailure>,
    pub pending_count: usize,
}

fn lock_poisoned() -> AppError {
    AppError::detailed(
        Code::LibraryIoFailed,
        "应用状态锁已损坏：此前有一次操作在持锁时崩溃",
    )
}

fn lock<T>(mutex: &Mutex<T>) -> Result<MutexGuard<'_, T>> {
    mutex.lock().map_err(|_| lock_poisoned())
}

fn not_selected() -> AppError {
    AppError::detailed(Code::LibraryNotFound, "尚未选择库")
}

/// 执行一次开库尝试，把"待迁移的旧库"与"真损坏"区分开。
///
/// `Library::open` 按 v2 必填字段解析，遇到 v1 只能报"元数据损坏"；但对使用者而言
/// 两者完全不同：前者是正常旧库，应当给出迁移入口，后者才需要担心数据。因此开库
/// 失败后再问一次 `detect_library_format`，把前者换成一个稳定的"需要迁移"错误码，
/// 让界面能据此启动明确的一次性迁移，而不是让使用者对着损坏文案发懵。
fn with_migration_signal<T>(root: &Path, attempt: impl FnOnce(&Path) -> Result<T>) -> Result<T> {
    attempt(root).map_err(|open_error| {
        let needs_migration = matches!(
            detect_library_format(root),
            Ok(
                LibraryFormatState::NeedsMigration { .. }
                    | LibraryFormatState::NeedsV3Migration(_)
                    | LibraryFormatState::MigrationIncomplete(_)
            )
        );
        if needs_migration {
            AppError::detailed(
                Code::LibraryFormatTooOld,
                format!("库是旧版本格式，需要一次性迁移后才能打开：{}", root.display()),
            )
        } else {
            open_error
        }
    })
}

fn status_of(state: &AppState) -> Result<LibraryStatus> {
    let (path, library_id) = match state.opened.as_ref() {
        Some(opened) => {
            let catalog = lock(&opened.catalog)?;
            let library = catalog.library();
            (
                Some(library.root().to_string_lossy().into_owned()),
                Some(library.meta().library_id.clone()),
            )
        }
        None => (None, None),
    };
    Ok(LibraryStatus {
        path,
        library_id,
        recorded_path: state.recorded_path.clone(),
        problem: state.restore_problem.clone(),
    })
}

fn current_opened(state: &tauri::State<'_, Shared>) -> Result<Arc<Opened>> {
    let guard = lock(state)?;
    guard.opened.as_ref().cloned().ok_or_else(not_selected)
}

async fn with_catalog<T>(
    state: tauri::State<'_, Shared>,
    operation: impl FnOnce(&mut Catalog) -> Result<T> + Send + 'static,
) -> Result<T>
where
    T: Send + 'static,
{
    let opened = current_opened(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut catalog = lock(&opened.catalog)?;
        operation(&mut catalog)
    })
    .await
    .map_err(|error| {
        AppError::detailed(
            Code::LibraryIoFailed,
            format!("后台目录任务异常终止：{error}"),
        )
    })?
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FolderFilterInput {
    All,
    Root,
    Path { path: String },
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssetLocationInput {
    Active,
    Trash,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AssetQueryInput {
    pub text: String,
    pub tags: Vec<String>,
    pub folder: FolderFilterInput,
    /// 收藏筛选。缺省表示不限，与提示词查询的同一字段语义一致。
    #[serde(default)]
    pub favorite: Option<bool>,
    pub location: AssetLocationInput,
}

/// 文件夹过滤的共享转换。图片与提示词是两棵独立的树，但过滤形状完全一致。
fn folder_filter_of(folder: FolderFilterInput) -> Result<FolderFilter> {
    Ok(match folder {
        FolderFilterInput::All => FolderFilter::All,
        FolderFilterInput::Root => FolderFilter::Root,
        FolderFilterInput::Path { path } => FolderFilter::Path(FolderPath::parse(&path)?),
    })
}

/// 共享标签词面的解析。图片与提示词共用同一套标签词法。
fn parse_tags(raw: &[String]) -> Result<Vec<Tag>> {
    raw.iter().map(|tag| Tag::parse(tag)).collect()
}

impl AssetQueryInput {
    fn into_core(self) -> Result<AssetQuery> {
        Ok(AssetQuery {
            text: self.text,
            tags: parse_tags(&self.tags)?,
            folder: folder_filter_of(self.folder)?,
            favorite: self.favorite,
            location: match self.location {
                AssetLocationInput::Active => AssetLocation::Active,
                AssetLocationInput::Trash => AssetLocation::Trash,
            },
        })
    }
}

/// 提示词工作区的组合查询入参。
///
/// 位置枚举与图片侧共用 [`AssetLocationInput`]：两类回收站的"正常/回收站"语义
/// 完全一致，分叉只会让前端多记一套字面量。
#[derive(Debug, Clone, Deserialize)]
pub struct PromptQueryInput {
    pub text: String,
    pub tags: Vec<String>,
    pub folder: FolderFilterInput,
    /// 收藏筛选。缺省表示不限。
    #[serde(default)]
    pub favorite: Option<bool>,
    pub location: AssetLocationInput,
}

impl PromptQueryInput {
    fn into_core(self) -> Result<PromptQuery> {
        Ok(PromptQuery {
            text: self.text,
            tags: parse_tags(&self.tags)?,
            folder: folder_filter_of(self.folder)?,
            favorite: self.favorite,
            location: match self.location {
                AssetLocationInput::Active => PromptLocation::Active,
                AssetLocationInput::Trash => PromptLocation::Trash,
            },
        })
    }
}

#[tauri::command]
pub fn library_status(state: tauri::State<'_, Shared>) -> Result<LibraryStatus> {
    let guard = lock(&state)?;
    status_of(&guard)
}

/// 打开使用者选择的目录；该目录还不是库时创建一个。
#[tauri::command]
pub fn open_library(path: String, state: tauri::State<'_, Shared>) -> Result<LibraryStatus> {
    let root = PathBuf::from(&path);
    let opened = with_migration_signal(&root, |r| open_derived(Library::open_or_create(r)?))?;
    adopt_library(opened, &state)
}

/// 把已打开的库接管为当前库：持久化记录并更新应用状态。
///
/// 只在成功打开之后才落盘记住。若在选择时就写入，一个打不开的目录会被记住，
/// 于是下次启动仍然撞在同一个错误上。
fn adopt_library(opened: Arc<Opened>, state: &Shared) -> Result<LibraryStatus> {
    let opened_path = lock(&opened.catalog)?
        .library()
        .root()
        .to_string_lossy()
        .into_owned();
    let mut guard = lock(state)?;
    let settings = AppSettings {
        format_version: vistash_core::settings::SETTINGS_FORMAT_VERSION,
        last_library_path: Some(opened_path.clone()),
    };
    settings.write_atomic(&guard.settings_path)?;
    guard.opened = Some(opened);
    guard.recorded_path = Some(opened_path);
    guard.restore_problem = None;
    status_of(&guard)
}

/// 一次迁移的进度。字段与导入、文件夹批量重命名的进度保持同一形状，
/// 使前端只需要一种进度呈现。
#[derive(Debug, Clone, Serialize)]
pub struct MigrationProgress {
    /// 正在进行的阶段，取核心 `MigrationStage::as_str` 的稳定字面量。
    pub stage: String,
    pub done: usize,
    pub total: usize,
    /// 当前处理的侧车文件名，不含路径。
    pub current_filename: String,
}

/// 执行 v1→v2 一次性迁移，成功后把路径记为待 v3 迁移。
///
/// 迁移可能面对上万个侧车，因此放 blocking worker。进度经
/// typed `Channel` 呈现，与文件夹批量重命名同一模式。进度发送失败不中止迁移：
/// 迁移的完整性由独占锁、journal 与备份树保证，不依赖有没有人在观察；中止语义
/// 属于将来显式的取消入口，而不是通道断开的副作用。
#[tauri::command]
pub async fn migrate_library(
    path: String,
    on_progress: Channel<MigrationProgress>,
    state: tauri::State<'_, Shared>,
) -> Result<LibraryStatus> {
    let root = PathBuf::from(&path);
    let migration_root = root.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<()> {
        let mut migration = Migration::new(&migration_root);
        // 索引重建由迁移以回调注入：迁移只负责权威文件，
        // 派生索引属于 Catalog 一侧。`rebuild_at` 以库根路径为入口，正是迁移
        // "版本最后提交"顺序所需要的——此刻 v2 library.json 还不在磁盘上。
        let mut rebuild = |root: &Path| Index::rebuild_at(root).map(|_| ());
        let mut forward = |progress: MigrationProgressCore| {
            let _ = on_progress.send(MigrationProgress {
                stage: progress.stage.as_str().to_owned(),
                done: progress.done,
                total: progress.total,
                current_filename: progress.current_filename,
            });
        };
        migration.run(&mut rebuild, &mut forward)?;
        Ok(())
    })
    .await
    .map_err(|error| {
        AppError::detailed(
            Code::LibraryIoFailed,
            format!("后台迁移任务异常终止：{error}"),
        )
    })??;

    let recorded_path = root.to_string_lossy().into_owned();
    let mut guard = lock(&state)?;
    AppSettings {
        format_version: vistash_core::settings::SETTINGS_FORMAT_VERSION,
        last_library_path: Some(recorded_path.clone()),
    }
    .write_atomic(&guard.settings_path)?;
    guard.opened = None;
    guard.recorded_path = Some(recorded_path.clone());
    guard.restore_problem = Some(AppError::detailed(
        Code::LibraryFormatTooOld,
        format!("v1→v2 已完成，仍需提交 v2→v3 迁移：{recorded_path}"),
    ));
    status_of(&guard)
}

/// v2→v3 迁移计划中一个素材的文件夹归属规划。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum V3FolderPlanDto {
    /// 零归属映射为未分类、单归属原样保留：无需使用者参与即可确定。
    Automatic { folder: Option<String> },
    /// 多归属冲突：必须由使用者在候选中为该素材选择唯一目标，提交前不得跳过。
    Conflict { candidates: Vec<String> },
}

/// v2→v3 迁移计划中的单个素材。刻意不暴露侧车相对路径：那是库内布局，
/// 界面只需要素材身份与冲突候选。
#[derive(Debug, Clone, Serialize)]
pub struct V3MigrationPlanEntryDto {
    pub hash: String,
    pub original_filename: String,
    #[serde(flatten)]
    pub folder: V3FolderPlanDto,
}

/// 一次 v2→v3 只读迁移计划。
#[derive(Debug, Clone, Serialize)]
pub struct V3MigrationPlanDto {
    pub entries: Vec<V3MigrationPlanEntryDto>,
}

fn to_v3_plan_dto(plan: V3MigrationPlan) -> V3MigrationPlanDto {
    V3MigrationPlanDto {
        entries: plan
            .entries
            .into_iter()
            .map(|entry| V3MigrationPlanEntryDto {
                hash: entry.hash.as_str().to_owned(),
                original_filename: entry.original_filename,
                folder: match entry.folder {
                    V3FolderPlan::Automatic(folder) => V3FolderPlanDto::Automatic { folder },
                    V3FolderPlan::Conflict(candidates) => V3FolderPlanDto::Conflict { candidates },
                },
            })
            .collect(),
    }
}

/// 为一个 v2 库生成只读的 v2→v3 迁移计划。
///
    /// 计划阶段不写任何权威字节；多归属素材以 `conflict` 呈现候选，由使用者在界面上
/// 完成唯一目标选择后调用 [`commit_v3_migration`]。上万侧车的扫描放 blocking worker。
#[tauri::command]
pub async fn plan_v3_migration(path: String) -> Result<V3MigrationPlanDto> {
    let root = PathBuf::from(&path);
    let plan = tauri::async_runtime::spawn_blocking(move || V3MigrationPlan::inspect(&root))
        .await
        .map_err(|error| {
            AppError::detailed(
                Code::LibraryIoFailed,
                format!("后台迁移规划任务异常终止：{error}"),
            )
        })??;
    Ok(to_v3_plan_dto(plan))
}

/// 使用者对一个多归属素材选择的唯一保留文件夹。
#[derive(Debug, Clone, Deserialize)]
pub struct V3FolderResolutionInput {
    pub hash: String,
    pub folder: String,
}

/// 提交一次已完成全部冲突选择的 v2→v3 迁移，成功后把该库接管为当前库。
///
/// 冲突选择在这里与最新扫描的计划合并：`hash` 不在计划中或选择不属于原归属时返回
/// 稳定的 `migration.resolution_invalid`，提交阶段还会再校验侧车摘要未被外部改动。
/// 提交进入替换阶段后不可取消；进程中断由下一次开库经 [`open_at`] 的恢复入口回滚。
#[tauri::command]
pub async fn commit_v3_migration(
    path: String,
    resolutions: Vec<V3FolderResolutionInput>,
    on_progress: Channel<MigrationProgress>,
    state: tauri::State<'_, Shared>,
) -> Result<LibraryStatus> {
    let root = PathBuf::from(&path);
    let mut parsed = Vec::with_capacity(resolutions.len());
    for resolution in &resolutions {
        parsed.push(V3FolderResolution {
            hash: ContentHash::parse(&resolution.hash)?,
            folder: resolution.folder.clone(),
        });
    }
    let opened = tauri::async_runtime::spawn_blocking(move || -> Result<Arc<Opened>> {
        // 以此刻的磁盘内容重新规划，而不是信任前端回传的整份计划：相对路径与
        // 字节摘要必须来自权威扫描，前端只负责提供使用者的冲突选择。
        let plan = V3MigrationPlan::inspect(&root)?;
        let resolved: ResolvedV3MigrationPlan = plan.resolve(&parsed)?;
        let mut rebuild = |index_root: &Path| Index::rebuild_at(index_root).map(|_| ());
        let mut forward = |progress: V3CommitProgress| {
            let _ = on_progress.send(MigrationProgress {
                stage: progress.stage.as_str().to_owned(),
                done: progress.done,
                total: progress.total,
                current_filename: progress.current_filename,
            });
        };
        V3MigrationCommit::new(&resolved, &root).run(&mut rebuild, &mut forward)?;
        // 提交完成后该库必然是 v3，按普通开库路径接管。
        open_at(&root)
    })
    .await
    .map_err(|error| {
        AppError::detailed(
            Code::LibraryIoFailed,
            format!("后台迁移提交任务异常终止：{error}"),
        )
    })??;
    adopt_library(opened, state.inner())
}

/// 网格用的素材列表，不含回收站中的素材。
#[tauri::command]
pub fn list_assets(state: tauri::State<'_, Shared>) -> Result<Vec<AssetRow>> {
    let opened = current_opened(&state)?;
    let catalog = lock(&opened.catalog)?;
    Ok(catalog
        .snapshot(&AssetQuery {
            text: String::new(),
            tags: Vec::new(),
            folder: FolderFilter::All,
            favorite: None,
            location: AssetLocation::Active,
        })?
        .assets)
}

#[tauri::command]
pub async fn catalog_snapshot(
    query: AssetQueryInput,
    state: tauri::State<'_, Shared>,
) -> Result<CatalogSnapshot> {
    let query = query.into_core()?;
    with_catalog(state, move |catalog| catalog.snapshot(&query)).await
}

#[tauri::command]
pub async fn create_folder(
    parent: Option<String>,
    name: String,
    state: tauri::State<'_, Shared>,
) -> Result<String> {
    let parent = parent.as_deref().map(FolderPath::parse).transpose()?;
    let name = FolderName::parse(&name)?;
    with_catalog(state, move |catalog| {
        Ok(catalog
            .create_folder(parent.as_ref(), &name)?
            .as_str()
            .to_owned())
    })
    .await
}

#[tauri::command]
pub async fn rename_folder(
    path: String,
    new_name: String,
    on_progress: Channel<FolderMutationProgress>,
    state: tauri::State<'_, Shared>,
) -> Result<String> {
    let path = FolderPath::parse(&path)?;
    let new_name = FolderName::parse(&new_name)?;
    with_catalog(state, move |catalog| {
        Ok(catalog
            .rename_folder(&path, &new_name, |progress| {
                on_progress.send(progress).map_err(|error| {
                    AppError::detailed(
                        Code::LibraryAssetMetadataWriteFailed,
                        format!("发送文件夹重命名进度失败：{error}"),
                    )
                })
            })?
            .as_str()
            .to_owned())
    })
    .await
}

#[tauri::command]
pub async fn move_folder(
    path: String,
    destination_parent: Option<String>,
    on_progress: Channel<FolderMutationProgress>,
    state: tauri::State<'_, Shared>,
) -> Result<String> {
    let path = FolderPath::parse(&path)?;
    let destination_parent = destination_parent
        .as_deref()
        .map(FolderPath::parse)
        .transpose()?;
    with_catalog(state, move |catalog| {
        Ok(catalog
            .move_folder(&path, destination_parent.as_ref(), |progress| {
                on_progress.send(progress).map_err(|error| {
                    AppError::detailed(
                        Code::LibraryAssetMetadataWriteFailed,
                        format!("发送文件夹移动进度失败：{error}"),
                    )
                })
            })?
            .as_str()
            .to_owned())
    })
    .await
}

#[tauri::command]
pub async fn delete_folder(path: String, state: tauri::State<'_, Shared>) -> Result<()> {
    let path = FolderPath::parse(&path)?;
    with_catalog(state, move |catalog| catalog.delete_folder(&path)).await
}

#[tauri::command]
pub async fn reorder_folder(
    path: String,
    direction: FolderReorder,
    state: tauri::State<'_, Shared>,
) -> Result<()> {
    let path = FolderPath::parse(&path)?;
    with_catalog(state, move |catalog| {
        catalog.reorder_folder(&path, direction)
    })
    .await
}

#[tauri::command]
pub async fn move_asset_to_folder(
    hash: String,
    folder: Option<String>,
    state: tauri::State<'_, Shared>,
) -> Result<()> {
    let hash = ContentHash::parse(&hash)?;
    let folder = folder.map(|folder| FolderPath::parse(&folder)).transpose()?;
    with_catalog(state, move |catalog| {
        catalog.move_asset_to_folder(&hash, folder.as_ref())
    })
    .await
}

#[tauri::command]
pub async fn rename_asset_display_filename(
    hash: String,
    stem: String,
    state: tauri::State<'_, Shared>,
) -> Result<()> {
    let hash = ContentHash::parse(&hash)?;
    with_catalog(state, move |catalog| {
        catalog.rename_asset_display_filename(&hash, &stem)
    })
    .await
}

#[tauri::command]
pub async fn set_asset_tags(
    hash: String,
    tags: Vec<String>,
    state: tauri::State<'_, Shared>,
) -> Result<()> {
    let hash = ContentHash::parse(&hash)?;
    let tags = tags
        .iter()
        .map(|tag| Tag::parse(tag))
        .collect::<Result<Vec<_>>>()?;
    with_catalog(state, move |catalog| catalog.set_asset_tags(&hash, &tags)).await
}

#[tauri::command]
pub async fn regenerate_color_card(
    hash: String,
    state: tauri::State<'_, Shared>,
) -> Result<()> {
    let hash = ContentHash::parse(&hash)?;
    with_catalog(state, move |catalog| {
        catalog.regenerate_color_card(&hash).map(|_| ())
    })
    .await
}

#[tauri::command]
pub async fn delete_asset(hash: String, state: tauri::State<'_, Shared>) -> Result<()> {
    let hash = ContentHash::parse(&hash)?;
    with_catalog(state, move |catalog| catalog.delete_asset(&hash)).await
}

#[tauri::command]
pub async fn restore_asset(
    hash: String,
    state: tauri::State<'_, Shared>,
) -> Result<RestoreOutcome> {
    let hash = ContentHash::parse(&hash)?;
    with_catalog(state, move |catalog| catalog.restore_asset(&hash)).await
}

#[tauri::command]
pub async fn purge_trash(state: tauri::State<'_, Shared>) -> Result<PurgeReport> {
    with_catalog(state, Catalog::purge_trash).await
}

/// 一次批量导入的进度。
#[derive(Debug, Clone, Serialize)]
pub struct TransferProgress {
    pub task_id: String,
    /// 已结束处理的素材数。
    pub done: usize,
    /// 本批次展开后的素材总数。
    pub total: usize,
    /// 当前即将处理的文件；全部结束时为 `None`。
    pub current_filename: Option<String>,
}

struct ChannelObserver {
    task_id: String,
    channel: Channel<TransferProgress>,
    disconnected: bool,
}

impl TransferObserver for ChannelObserver {
    fn should_cancel(&self) -> bool {
        self.disconnected
    }

    fn on_progress(&mut self, done: usize, total: usize, current_filename: &str) {
        // 协调器的约定：空串表示全部结束，转成 None 让前端不再显示文件名。
        let current_filename =
            (!current_filename.is_empty()).then(|| current_filename.to_owned());
        if self
            .channel
            .send(TransferProgress {
                task_id: self.task_id.clone(),
                done,
                total,
                current_filename,
            })
            .is_err()
        {
            self.disconnected = true;
        }
    }
}

/// 统一导入入口：按钮、拖放与目录选择都汇入同一条命令。
///
/// 前端只交来路径与当前工作区位置；来源分类由后端按磁盘事实裁决——拖放事件拿不到
/// "这是目录还是文件"，而层级语义取决于它。目录扫描、查重、层级映射与停止观察全部
/// 在核心协调器内完成。目录扫描与媒体处理全部在 blocking worker 中执行。
#[tauri::command]
pub async fn import_sources(
    paths: Vec<String>,
    current_folder: Option<String>,
    on_progress: Channel<TransferProgress>,
    runs: tauri::State<'_, std::sync::Arc<TransferRuns>>,
    state: tauri::State<'_, Shared>,
) -> Result<ImportOutcome> {
    let opened = current_opened(&state)?;
    let runs = std::sync::Arc::clone(runs.inner());
    tauri::async_runtime::spawn_blocking(move || {
        import_sources_blocking(paths, current_folder, on_progress, &runs, &opened)
    })
    .await
    .map_err(|error| {
        AppError::detailed(
            Code::LibraryIoFailed,
            format!("后台导入任务异常终止：{error}"),
        )
    })?
}

fn import_sources_blocking(
    paths: Vec<String>,
    current_folder: Option<String>,
    on_progress: Channel<TransferProgress>,
    runs: &TransferRuns,
    opened: &Opened,
) -> Result<ImportOutcome> {
    let _import_guard = lock(&opened.import_gate)?;
    // 来源分类复用核心的同一函数：拖放/选择与剪贴板粘贴的文件路径
    // 走完全相同的"按磁盘事实分类"，不允许两条入口各写一套判断。
    let sources = import::classify_paths(
        paths
            .into_iter()
            .map(PathBuf::from)
            .collect::<Vec<_>>(),
    );
    run_import(sources, current_folder, on_progress, runs, opened)
}

/// 把已构造好的来源集合交给统一协调器并回填索引。
///
/// [`import_sources_blocking`]（文件/目录）与 [`paste_import_blocking`]（剪贴板）
/// 的公共后半程：占库级槽位、经 `Channel` 报告进度、导入完成后更新 SQLite 索引。
fn run_import(
    sources: Vec<import::ImportSource>,
    current_folder: Option<String>,
    on_progress: Channel<TransferProgress>,
    runs: &TransferRuns,
    opened: &Opened,
) -> Result<ImportOutcome> {
    let request = import::ImportRequest {
        sources,
        current_folder,
    };

    let library = lock(&opened.catalog)?.library().clone();
    let run = runs.begin(&library)?;
    let task_id = run.id().as_str().to_owned();
    // 导入不自动推测标签；导入后由使用者在素材详情中归类。
    let disconnected = on_progress
        .send(TransferProgress {
            task_id: task_id.clone(),
            done: 0,
            total: 0,
            current_filename: None,
        })
        .is_err();
    let mut observer = ChannelObserver {
        task_id: task_id.clone(),
        channel: on_progress,
        disconnected,
    };
    let report = import::import_sources(&library, &request, &[], &run, &mut observer)?;

    // 见模块头：命令层只把核心产出的侧车送入同层索引，不重新判断导入结果。
    let mut catalog = lock(&opened.catalog)?;
    catalog.index_imported(&report.imported)?;
    Ok(ImportOutcome {
        task_id: Some(task_id),
        imported: report.imported.len(),
        skipped_non_images: report.skipped_non_images,
        duplicates: report.duplicates.len(),
        pending_count: report.pending_count,
        failures: report.failed,
    })
}

/// 剪贴板里没有可导入内容时的全零报告。
///
/// 文本、网址与空剪贴板不是错误，前端据此提示
/// "剪贴板里没有可导入的图片"而不是弹错误。
const EMPTY_PASTE_OUTCOME: ImportOutcome = ImportOutcome {
    task_id: None,
    imported: 0,
    skipped_non_images: 0,
    duplicates: 0,
    pending_count: 0,
    failures: Vec::new(),
};

#[cfg(target_os = "windows")]
fn paste_import_blocking(
    current_folder: Option<String>,
    on_progress: Channel<TransferProgress>,
    runs: &TransferRuns,
    opened: &Opened,
) -> Result<ImportOutcome> {
    use vistash_core::clipboard::ClipboardPort;

    let _import_guard = lock(&opened.import_gate)?;

    // 剪贴板是全局单例且 trait 要求独占借用：在 blocking worker 内串行读取，
    // 并在关闭系统剪贴板之后才做 PNG 编码等耗时工作（adapter 内部保证）。
    let payload = {
        let mut clipboard = crate::windows_clipboard::WindowsClipboard::new();
        clipboard.snapshot()?
    };
    match payload {
        ClipboardPayload::Files(paths) => {
            run_import(import::classify_paths(paths), current_folder, on_progress, runs, opened)
        }
        ClipboardPayload::Bitmap(bitmap) => {
            // 一次只有一个位图载荷：显示名带本地时间，来源身份记 Clipboard。
            let sources = vec![import::ImportSource::PngBytes {
                bytes: clipboard::bitmap_to_png(&bitmap)?,
                filename: clipboard::clipboard_image_display_name(chrono::Local::now()),
                captured_at: chrono::Utc::now(),
            }];
            run_import(sources, current_folder, on_progress, runs, opened)
        }
        ClipboardPayload::Text(_) | ClipboardPayload::Empty => Ok(EMPTY_PASTE_OUTCOME),
    }
}

/// 窗口级 Ctrl+V 的统一入口：前端只决定"这个按键由谁认领"，
/// 剪贴板上有什么、按什么顺序分流全部由后端裁决。WebView 没有任何通用剪贴板
/// 权限——位图像素从系统剪贴板到库内本体全程不经过前端。
///
/// 非 Windows 目标没有生产 adapter（本项目 Windows 优先），返回稳定的读取失败：
/// 该平台上的窗口级粘贴本就不该到达这里。
#[tauri::command]
pub async fn paste_import(
    current_folder: Option<String>,
    on_progress: Channel<TransferProgress>,
    app: tauri::AppHandle,
    runs: tauri::State<'_, std::sync::Arc<TransferRuns>>,
    state: tauri::State<'_, Shared>,
) -> Result<ImportOutcome> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (current_folder, on_progress, app, runs, state);
        Err(AppError::detailed(
            Code::ClipboardReadFailed,
            "当前平台尚未实现剪贴板导入",
        ))
    }

    #[cfg(target_os = "windows")]
    {
        drop(app);
        let opened = current_opened(&state)?;
        let runs = std::sync::Arc::clone(runs.inner());
        tauri::async_runtime::spawn_blocking(move || {
            paste_import_blocking(current_folder, on_progress, &runs, &opened)
        })
        .await
        .map_err(|error| {
            AppError::detailed(
                Code::LibraryIoFailed,
                format!("后台粘贴导入任务异常终止：{error}"),
            )
        })?
    }
}

/// 只读生成导出冲突计划，确认 policy 前不写目标目录。
#[tauri::command]
pub async fn plan_export(
    hashes: Vec<String>,
    target_dir: String,
    state: tauri::State<'_, Shared>,
) -> Result<Vec<vistash_core::export::PlannedExport>> {
    let opened = current_opened(&state)?;
    let library = lock(&opened.catalog)?.library().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let hashes = parse_hashes(&hashes)?;
        vistash_core::export::plan_export(&library, &hashes, Path::new(&target_dir))
    })
    .await
    .map_err(|error| {
        AppError::detailed(
            Code::LibraryIoFailed,
            format!("后台生成导出冲突计划异常终止：{error}"),
        )
    })?
}

/// 原图导出。
///
/// 只读库的出站操作：核心协调器按"侧车显示文件名 + 真实扩展名"复制原始字节到
/// 使用者明确选择的目标目录，库内本体与侧车一个字节都不改。`policy` 是类型化枚举，
/// 前端传 `"skip" / "overwrite" / "auto_number"`；覆盖属破坏性操作，前端必须先取得
/// 使用者的明确确认才允许传 `overwrite` 进来。停止复用 [`import_stop`]——导入与
/// 导出共用同一把库级并发键，同一时刻只有一种任务在跑。
#[tauri::command]
pub async fn export_assets(
    hashes: Vec<String>,
    target_dir: String,
    policy: vistash_core::export::ConflictPolicy,
    on_progress: Channel<TransferProgress>,
    runs: tauri::State<'_, std::sync::Arc<TransferRuns>>,
    state: tauri::State<'_, Shared>,
) -> Result<ExportOutcome> {
    let opened = current_opened(&state)?;
    let runs = std::sync::Arc::clone(runs.inner());
    tauri::async_runtime::spawn_blocking(move || {
        export_assets_blocking(hashes, target_dir, policy, on_progress, &runs, &opened)
    })
    .await
    .map_err(|error| {
        AppError::detailed(
            Code::LibraryIoFailed,
            format!("后台导出任务异常终止：{error}"),
        )
    })?
}

fn export_assets_blocking(
    hashes: Vec<String>,
    target_dir: String,
    policy: vistash_core::export::ConflictPolicy,
    on_progress: Channel<TransferProgress>,
    runs: &TransferRuns,
    opened: &Opened,
) -> Result<ExportOutcome> {
    // 哈希字符串先解析成领域类型：非法值在这里变成稳定错误，
    // 不占用槽位、也不溜进协调器。
    let parsed = hashes
        .iter()
        .map(|raw| ContentHash::parse(raw))
        .collect::<Result<Vec<_>>>()?;
    let library = lock(&opened.catalog)?.library().clone();
    let run = runs.begin_export(&library)?;
    let task_id = run.id().as_str().to_owned();
    let disconnected = on_progress
        .send(TransferProgress {
            task_id: task_id.clone(),
            done: 0,
            total: parsed.len(),
            current_filename: None,
        })
        .is_err();
    let mut observer = ChannelObserver {
        task_id: task_id.clone(),
        channel: on_progress,
        disconnected,
    };
    let request = vistash_core::export::ExportRequest {
        target_dir: PathBuf::from(target_dir),
        policy,
    };
    let report = vistash_core::export::export_assets(&library, &parsed, &request, &run, &mut observer)?;
    Ok(ExportOutcome {
        task_id,
        exported: report.exported,
        skipped_existing: report.skipped_existing,
        failed: report.failed,
        pending_count: report.pending_count,
    })
}

/// 单图复制位图到系统剪贴板。
///
/// 参数是单个哈希：复制图像只允许单张，多选不合成、多选出站一律走批量导出——
/// 这条规则由 API 形状保证，本命令在结构上就不存在一次喂进多张图的入口。
/// 像素全程留在 Rust 侧：核心解码原图为 RGBA 位图后经官方插件写入系统剪贴板，
/// 前端只见成功或错误码，与导入方向同一纪律。
#[tauri::command]
pub async fn copy_asset_to_clipboard(
    hash: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, Shared>,
) -> Result<()> {
    let hash = ContentHash::parse(&hash)?;
    let opened = current_opened(&state)?;
    // 解码面对的是原图本体（可能上万像素）：放 blocking worker。
    let bitmap = tauri::async_runtime::spawn_blocking(
        move || -> Result<vistash_core::clipboard::BitmapImage> {
            let library = lock(&opened.catalog)?.library().clone();
            vistash_core::export::asset_bitmap(&library, &hash)
        },
    )
    .await
    .map_err(|error| {
        AppError::detailed(
            Code::LibraryIoFailed,
            format!("后台解码任务异常终止：{error}"),
        )
    })??;
    write_bitmap_to_clipboard(&app, bitmap)
}

/// 把已解码位图写入系统剪贴板。Windows 经官方插件的设备无关位图写入；
/// 非 Windows 目标没有 Windows 优先之外的生产承诺，返回稳定的写入失败。
#[cfg(target_os = "windows")]
fn write_bitmap_to_clipboard(
    app: &tauri::AppHandle,
    bitmap: vistash_core::clipboard::BitmapImage,
) -> Result<()> {
    use tauri_plugin_clipboard_manager::ClipboardExt;

    let (width, height) = (bitmap.width() as u32, bitmap.height() as u32);
    let image = tauri::image::Image::new_owned(bitmap.into_rgba(), width, height);
    app.clipboard().write_image(&image).map_err(|e| {
        AppError::detailed(
            Code::ClipboardWriteFailed,
            format!("写入系统剪贴板失败：{e}"),
        )
    })
}

#[cfg(not(target_os = "windows"))]
fn write_bitmap_to_clipboard(
    _app: &tauri::AppHandle,
    _bitmap: vistash_core::clipboard::BitmapImage,
) -> Result<()> {
    Err(AppError::detailed(
        Code::ClipboardWriteFailed,
        "当前平台尚未实现剪贴板图像复制",
    ))
}

/// 用系统默认程序打开素材原图。
///
/// 绝不把库内本体路径交给外部程序：外部写入与删除不可控，而本体是权威对象。
/// 流程是把原始字节复制为应用缓存侧的只读临时副本，**只把副本路径**交给系统打开；
/// 同一素材复用同一份不可变副本，重复打开不产生副本堆积。参数同样是单哈希，
/// 多选打开不在规格内。
#[tauri::command]
pub async fn open_with_default_app(
    hash: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, Shared>,
) -> Result<()> {
    let hash = ContentHash::parse(&hash)?;
    let opened = current_opened(&state)?;
    let manager = {
        let guard = lock(&state)?;
        guard.external_open.clone()
    };
    // 复制本体字节属于磁盘 IO：放 blocking worker。
    let path = tauri::async_runtime::spawn_blocking(move || -> Result<PathBuf> {
        let library = lock(&opened.catalog)?.library().clone();
        manager.prepare(&library, &hash)
    })
    .await
    .map_err(|error| {
        AppError::detailed(
            Code::LibraryIoFailed,
            format!("后台副本准备任务异常终止：{error}"),
        )
    })??;

    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| {
            AppError::detailed(
                Code::ExternalOpenFailed,
                format!("用默认程序打开 {} 失败：{e}", path.display()),
            )
        })
}

/// 导入任务的可见状态。只有后端确认后才是 `stopped`——前端仅停止等待或隐藏进度
    /// MUST NOT 冒充任务已停止。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TransferRunStateDto {
    Running,
    Stopping,
    Stopped,
}

impl From<import::TransferRunState> for TransferRunStateDto {
    fn from(state: import::TransferRunState) -> Self {
        match state {
            import::TransferRunState::Running => Self::Running,
            import::TransferRunState::Stopping => Self::Stopping,
            import::TransferRunState::Stopped => Self::Stopped,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct TransferRunStatusDto {
    pub task_id: String,
    pub state: TransferRunStateDto,
}

/// 提交导入停止请求：真实的后端命令。返回提交后的任务状态；
/// 没有进行中的导入时报告 `stopped`——无事可停即已停。
#[tauri::command]
pub fn import_stop(
    task_id: String,
    runs: tauri::State<'_, ManagedTransferRuns>,
    state: tauri::State<'_, Shared>,
) -> Result<TransferRunStatusDto> {
    let opened = current_opened(&state)?;
    let library = lock(&opened.catalog)?.library().clone();
    let run_state = runs.request_stop(&library, &task_id)?;
    Ok(TransferRunStatusDto {
        task_id,
        state: run_state.into(),
    })
}

/// 把库内记录的扩展名收敛为清单内的字面量。
///
/// 库内路径由 `<hash>.<ext>` 拼成，而 `PathBuf::push` 不会拒绝含分隔符或 `..` 的片段——
/// 那样的 `ext` 能把路径指到库外，而 `asset_original` 会把读到的字节交给前端。
///
/// 因此扩展名**不作为命令入参**，改由索引回答（见 `Index::asset_ext`），再经本函数过一遍
/// 清单。索引文件本身在磁盘上是可改的，所以这一步不是多余的：它把任意字符串换成五个
/// 字面量之一，路径拼接便不再依赖任何外部输入的善意。
fn safe_ext(recorded: &str) -> Result<&'static str> {
    MediaType::from_extension(recorded)
        .map(MediaType::library_ext)
        .ok_or_else(|| {
            AppError::detailed(
                Code::ImportUnsupportedMediaType,
                format!("索引中记录的扩展名不在支持清单内：{recorded}"),
            )
        })
}

/// 取出素材在库内的扩展名，路径拼接只用它的返回值。
fn ext_of(catalog: &Catalog, hash: &ContentHash) -> Result<&'static str> {
    safe_ext(&catalog.asset_ext(hash.as_str())?)
}

/// 素材的缩略图字节。缺失时按需重新生成。
///
/// 返回原始字节而不是 base64：base64 会把体积放大三分之一，而网格一次要取上百张。
/// 前端把它包成 `Blob` 再取 URL，CSP 已允许 `blob:` 作为图片来源。
#[tauri::command]
pub fn asset_thumbnail(
    hash: String,
    state: tauri::State<'_, Shared>,
) -> Result<tauri::ipc::Response> {
    // 先校验再用。ContentHash 存在的意义就是让未校验的字符串无法参与库内路径拼接。
    let hash = ContentHash::parse(&hash)?;
    let opened = current_opened(&state)?;
    let (library, ext, source) = {
        let catalog = lock(&opened.catalog)?;
        let source = if catalog.asset_is_deleted(&hash)? {
            import::ThumbnailSource::Trash
        } else {
            import::ThumbnailSource::Active
        };
        (catalog.library().clone(), ext_of(&catalog, &hash)?, source)
    };
    let bytes = import::ensure_thumbnail(&library, &hash, ext, source)?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// 素材原图的字节。
#[tauri::command]
pub fn asset_original(
    hash: String,
    state: tauri::State<'_, Shared>,
) -> Result<tauri::ipc::Response> {
    let hash = ContentHash::parse(&hash)?;
    let opened = current_opened(&state)?;
    let bytes = lock(&opened.catalog)?.read_asset_body(&hash)?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// 全部错误码及其域。前端的文案表以它为准，使新增错误码时"漏掉映射"能被测出来。
#[derive(Debug, Clone, Serialize)]
pub struct CodeInfo {
    pub code: String,
    pub domain: String,
}

#[tauri::command]
pub fn all_error_codes() -> Vec<CodeInfo> {
    vistash_core::error::ALL_CODES
        .iter()
        .map(|c| CodeInfo {
            code: c.as_str().to_owned(),
            domain: c.domain().as_str().to_owned(),
        })
        .collect()
}

// ---------------------------------------------------------------------------
// 提示词素材：CRUD、组织、回收站。
// ---------------------------------------------------------------------------

/// 创建提示词的入参。正文是唯一必填项；文件夹与标签先以字符串过边界，
/// 归属校验在核心 `create_prompt` 内部完成（先于任何文件写入）。
#[derive(Debug, Clone, Deserialize)]
pub struct NewPromptInput {
    pub body: String,
    pub title: Option<String>,
    pub model: Option<String>,
    pub parameters: Option<String>,
    pub folders: Vec<String>,
    pub tags: Vec<String>,
}

impl NewPromptInput {
    fn into_core(self) -> NewPrompt {
        NewPrompt {
            body: self.body,
            title: self.title,
            model: self.model,
            parameters: self.parameters,
            folders: self.folders,
            tags: self.tags,
        }
    }
}

/// 显式保存的主字段编辑。刻意不含 note/favorite/folders/tags：它们各有自己的
/// 入口与保存时机，混进同一次保存会让"自动保存备注"误推进更新时间。
#[derive(Debug, Clone, Deserialize)]
pub struct PromptEditInput {
    pub body: String,
    pub title: Option<String>,
    pub model: Option<String>,
    pub parameters: Option<String>,
}

impl PromptEditInput {
    fn into_core(self) -> PromptEdit {
        PromptEdit {
            body: self.body,
            title: self.title,
            model: self.model,
            parameters: self.parameters,
        }
    }
}

fn parse_prompt_ids(raw: &[String]) -> Result<Vec<PromptId>> {
    raw.iter().map(|id| PromptId::parse(id)).collect()
}

#[tauri::command]
pub async fn create_prompt(
    prompt: NewPromptInput,
    state: tauri::State<'_, Shared>,
) -> Result<PromptAsset> {
    let draft = prompt.into_core();
    with_catalog(state, move |catalog| catalog.create_prompt(&draft)).await
}

#[tauri::command]
pub async fn update_prompt(
    id: String,
    edit: PromptEditInput,
    state: tauri::State<'_, Shared>,
) -> Result<PromptAsset> {
    let id = PromptId::parse(&id)?;
    let edit = edit.into_core();
    with_catalog(state, move |catalog| catalog.update_prompt(&id, &edit)).await
}

#[tauri::command]
pub async fn prompt_detail(id: String, state: tauri::State<'_, Shared>) -> Result<PromptAsset> {
    let id = PromptId::parse(&id)?;
    with_catalog(state, move |catalog| catalog.prompt_detail(&id)).await
}

#[tauri::command]
pub async fn prompt_snapshot(
    query: PromptQueryInput,
    state: tauri::State<'_, Shared>,
) -> Result<PromptSnapshot> {
    let query = query.into_core()?;
    with_catalog(state, move |catalog| catalog.prompt_snapshot(&query)).await
}

#[tauri::command]
pub async fn create_prompt_folder(
    parent: Option<String>,
    name: String,
    state: tauri::State<'_, Shared>,
) -> Result<String> {
    let parent = parent.as_deref().map(FolderPath::parse).transpose()?;
    let name = FolderName::parse(&name)?;
    with_catalog(state, move |catalog| {
        Ok(catalog
            .create_prompt_folder(parent.as_ref(), &name)?
            .as_str()
            .to_owned())
    })
    .await
}

#[tauri::command]
pub async fn rename_prompt_folder(
    path: String,
    new_name: String,
    state: tauri::State<'_, Shared>,
) -> Result<String> {
    let path = FolderPath::parse(&path)?;
    let new_name = FolderName::parse(&new_name)?;
    with_catalog(state, move |catalog| {
        Ok(catalog
            .rename_prompt_folder(&path, &new_name)?
            .as_str()
            .to_owned())
    })
    .await
}

#[tauri::command]
pub async fn move_prompt_folder(
    path: String,
    destination_parent: Option<String>,
    state: tauri::State<'_, Shared>,
) -> Result<String> {
    let path = FolderPath::parse(&path)?;
    let destination_parent = destination_parent
        .as_deref()
        .map(FolderPath::parse)
        .transpose()?;
    with_catalog(state, move |catalog| {
        Ok(catalog
            .move_prompt_folder(&path, destination_parent.as_ref())?
            .as_str()
            .to_owned())
    })
    .await
}

#[tauri::command]
pub async fn delete_prompt_folder(
    path: String,
    state: tauri::State<'_, Shared>,
) -> Result<()> {
    let path = FolderPath::parse(&path)?;
    with_catalog(state, move |catalog| catalog.delete_prompt_folder(&path)).await
}

#[tauri::command]
pub async fn set_prompt_note(
    id: String,
    note: String,
    state: tauri::State<'_, Shared>,
) -> Result<()> {
    let id = PromptId::parse(&id)?;
    with_catalog(state, move |catalog| catalog.set_prompt_note(&id, &note)).await
}

#[tauri::command]
pub async fn set_prompt_favorite(
    id: String,
    favorite: bool,
    state: tauri::State<'_, Shared>,
) -> Result<()> {
    let id = PromptId::parse(&id)?;
    with_catalog(state, move |catalog| catalog.set_prompt_favorite(&id, favorite)).await
}

#[tauri::command]
pub async fn set_prompt_folders(
    id: String,
    folders: Vec<String>,
    state: tauri::State<'_, Shared>,
) -> Result<()> {
    let id = PromptId::parse(&id)?;
    let folders = folders
        .iter()
        .map(|folder| FolderPath::parse(folder))
        .collect::<Result<Vec<_>>>()?;
    with_catalog(state, move |catalog| {
        catalog.set_prompt_folders(&id, &folders)
    })
    .await
}

#[tauri::command]
pub async fn set_prompt_tags(
    id: String,
    tags: Vec<String>,
    state: tauri::State<'_, Shared>,
) -> Result<()> {
    let id = PromptId::parse(&id)?;
    let tags = parse_tags(&tags)?;
    with_catalog(state, move |catalog| catalog.set_prompt_tags(&id, &tags)).await
}

#[tauri::command]
pub async fn delete_prompt(id: String, state: tauri::State<'_, Shared>) -> Result<()> {
    let id = PromptId::parse(&id)?;
    with_catalog(state, move |catalog| catalog.delete_prompt(&id)).await
}

#[tauri::command]
pub async fn restore_prompt(
    id: String,
    state: tauri::State<'_, Shared>,
) -> Result<PromptRestoreOutcome> {
    let id = PromptId::parse(&id)?;
    with_catalog(state, move |catalog| catalog.restore_prompt(&id)).await
}

#[tauri::command]
pub async fn purge_prompt_trash(state: tauri::State<'_, Shared>) -> Result<PromptPurgeReport> {
    with_catalog(state, Catalog::purge_prompt_trash).await
}

// ---------------------------------------------------------------------------
// 普通关联、封面与图片 note/favorite。
// ---------------------------------------------------------------------------

fn parse_hashes(raw: &[String]) -> Result<Vec<ContentHash>> {
    raw.iter().map(|hash| ContentHash::parse(hash)).collect()
}

#[tauri::command]
pub async fn link_images(
    prompt_id: String,
    hashes: Vec<String>,
    state: tauri::State<'_, Shared>,
) -> Result<()> {
    let prompt_id = PromptId::parse(&prompt_id)?;
    let hashes = parse_hashes(&hashes)?;
    with_catalog(state, move |catalog| {
        catalog.link_images(&prompt_id, &hashes)
    })
    .await
}

#[tauri::command]
pub async fn unlink_image(
    prompt_id: String,
    hash: String,
    state: tauri::State<'_, Shared>,
) -> Result<()> {
    let prompt_id = PromptId::parse(&prompt_id)?;
    let hash = ContentHash::parse(&hash)?;
    with_catalog(state, move |catalog| {
        catalog.unlink_image(&prompt_id, &hash)
    })
    .await
}

#[tauri::command]
pub async fn set_prompt_cover(
    prompt_id: String,
    cover: Option<String>,
    state: tauri::State<'_, Shared>,
) -> Result<()> {
    let prompt_id = PromptId::parse(&prompt_id)?;
    let cover = cover.as_deref().map(ContentHash::parse).transpose()?;
    with_catalog(state, move |catalog| {
        catalog.set_prompt_cover(&prompt_id, cover.as_ref())
    })
    .await
}

/// 本地导入后关联。源路径的展开与校验在核心编排内逐项进行，坏文件逐项报告。
#[tauri::command]
pub async fn import_and_link(
    prompt_id: String,
    sources: Vec<String>,
    state: tauri::State<'_, Shared>,
) -> Result<ImportAndLinkReport> {
    let prompt_id = PromptId::parse(&prompt_id)?;
    let sources = sources.into_iter().map(PathBuf::from).collect::<Vec<_>>();
    with_catalog(state, move |catalog| {
        catalog.import_and_link(&prompt_id, &sources)
    })
    .await
}

#[tauri::command]
pub async fn image_detail(
    hash: String,
    state: tauri::State<'_, Shared>,
) -> Result<ImageDetail> {
    let hash = ContentHash::parse(&hash)?;
    with_catalog(state, move |catalog| catalog.image_detail(&hash)).await
}

/// 提示词检查器的按需关联状态：与权威文件同序的哈希加各自回收站标记。
#[tauri::command]
pub async fn linked_image_states(
    prompt_id: String,
    state: tauri::State<'_, Shared>,
) -> Result<Vec<LinkedImageState>> {
    let prompt_id = PromptId::parse(&prompt_id)?;
    with_catalog(state, move |catalog| {
        catalog.linked_image_states(&prompt_id)
    })
    .await
}

#[tauri::command]
pub async fn set_asset_note(
    hash: String,
    note: String,
    state: tauri::State<'_, Shared>,
) -> Result<()> {
    let hash = ContentHash::parse(&hash)?;
    with_catalog(state, move |catalog| catalog.set_asset_note(&hash, &note)).await
}

#[tauri::command]
pub async fn set_asset_favorite(
    hash: String,
    favorite: bool,
    state: tauri::State<'_, Shared>,
) -> Result<()> {
    let hash = ContentHash::parse(&hash)?;
    with_catalog(state, move |catalog| catalog.set_asset_favorite(&hash, favorite)).await
}

// ---------------------------------------------------------------------------
// 批量组织：统一 BatchReport，进度经 typed Channel 逐项转交。
// ---------------------------------------------------------------------------

/// 一次批量的进度。与导入进度不同：批量没有"当前文件"，只有已处理数与总数。
#[derive(Debug, Clone, Serialize)]
pub struct BatchProgressDto {
    pub done: usize,
    pub total: usize,
}

/// 批量进度的 typed Channel 适配。
///
/// 批量报告本身已逐项隔离失败，进度只是观察：通道断开（窗口关闭等）不应把已部分
/// 成功的批量变成错误，因此发送失败只记下断开标记，后续进度静默丢弃。
struct ChannelProgress {
    channel: Channel<BatchProgressDto>,
    disconnected: bool,
}

impl BatchProgress for ChannelProgress {
    fn on_progress(&mut self, done: usize, total: usize) {
        if self.disconnected {
            return;
        }
        if self.channel.send(BatchProgressDto { done, total }).is_err() {
            self.disconnected = true;
        }
    }
}

/// 组装批量命令共用的进度适配器。类型标注只为可读性，行为与直接构造一致。
fn channel_progress(channel: Channel<BatchProgressDto>) -> ChannelProgress {
    ChannelProgress {
        channel,
        disconnected: false,
    }
}

#[tauri::command]
pub async fn batch_move_assets_to_folder(
    hashes: Vec<String>,
    folder: Option<String>,
    on_progress: Channel<BatchProgressDto>,
    state: tauri::State<'_, Shared>,
) -> Result<BatchReport> {
    let hashes = parse_hashes(&hashes)?;
    let folder = folder.map(|folder| FolderPath::parse(&folder)).transpose()?;
    with_catalog(state, move |catalog| {
        let mut progress = channel_progress(on_progress);
        Ok(catalog.batch_move_assets_to_folder(&hashes, folder.as_ref(), &mut progress))
    })
    .await
}

#[tauri::command]
pub async fn batch_add_asset_tag(
    hashes: Vec<String>,
    tag: String,
    on_progress: Channel<BatchProgressDto>,
    state: tauri::State<'_, Shared>,
) -> Result<BatchReport> {
    let hashes = parse_hashes(&hashes)?;
    let tag = Tag::parse(&tag)?;
    with_catalog(state, move |catalog| {
        let mut progress = channel_progress(on_progress);
        Ok(catalog.batch_add_asset_tag(&hashes, &tag, &mut progress))
    })
    .await
}

#[tauri::command]
pub async fn batch_remove_asset_tag(
    hashes: Vec<String>,
    tag: String,
    on_progress: Channel<BatchProgressDto>,
    state: tauri::State<'_, Shared>,
) -> Result<BatchReport> {
    let hashes = parse_hashes(&hashes)?;
    let tag = Tag::parse(&tag)?;
    with_catalog(state, move |catalog| {
        let mut progress = channel_progress(on_progress);
        Ok(catalog.batch_remove_asset_tag(&hashes, &tag, &mut progress))
    })
    .await
}

#[tauri::command]
pub async fn batch_set_asset_favorite(
    hashes: Vec<String>,
    favorite: bool,
    on_progress: Channel<BatchProgressDto>,
    state: tauri::State<'_, Shared>,
) -> Result<BatchReport> {
    let hashes = parse_hashes(&hashes)?;
    with_catalog(state, move |catalog| {
        let mut progress = channel_progress(on_progress);
        Ok(catalog.batch_set_asset_favorite(&hashes, favorite, &mut progress))
    })
    .await
}

#[tauri::command]
pub async fn batch_link_to_prompt(
    prompt_id: String,
    hashes: Vec<String>,
    on_progress: Channel<BatchProgressDto>,
    state: tauri::State<'_, Shared>,
) -> Result<BatchReport> {
    let prompt_id = PromptId::parse(&prompt_id)?;
    let hashes = parse_hashes(&hashes)?;
    with_catalog(state, move |catalog| {
        let mut progress = channel_progress(on_progress);
        Ok(catalog.batch_link_to_prompt(&prompt_id, &hashes, &mut progress))
    })
    .await
}

#[tauri::command]
pub async fn batch_delete_assets(
    hashes: Vec<String>,
    on_progress: Channel<BatchProgressDto>,
    state: tauri::State<'_, Shared>,
) -> Result<BatchReport> {
    let hashes = parse_hashes(&hashes)?;
    with_catalog(state, move |catalog| {
        let mut progress = channel_progress(on_progress);
        Ok(catalog.batch_delete_assets(&hashes, &mut progress))
    })
    .await
}

#[tauri::command]
pub async fn batch_add_prompt_folder(
    ids: Vec<String>,
    folder: String,
    on_progress: Channel<BatchProgressDto>,
    state: tauri::State<'_, Shared>,
) -> Result<BatchReport> {
    let ids = parse_prompt_ids(&ids)?;
    let folder = FolderPath::parse(&folder)?;
    with_catalog(state, move |catalog| {
        let mut progress = channel_progress(on_progress);
        Ok(catalog.batch_add_prompt_folder(&ids, &folder, &mut progress))
    })
    .await
}

#[tauri::command]
pub async fn batch_remove_prompt_folder(
    ids: Vec<String>,
    folder: String,
    on_progress: Channel<BatchProgressDto>,
    state: tauri::State<'_, Shared>,
) -> Result<BatchReport> {
    let ids = parse_prompt_ids(&ids)?;
    let folder = FolderPath::parse(&folder)?;
    with_catalog(state, move |catalog| {
        let mut progress = channel_progress(on_progress);
        Ok(catalog.batch_remove_prompt_folder(&ids, &folder, &mut progress))
    })
    .await
}

#[tauri::command]
pub async fn batch_add_prompt_tag(
    ids: Vec<String>,
    tag: String,
    on_progress: Channel<BatchProgressDto>,
    state: tauri::State<'_, Shared>,
) -> Result<BatchReport> {
    let ids = parse_prompt_ids(&ids)?;
    let tag = Tag::parse(&tag)?;
    with_catalog(state, move |catalog| {
        let mut progress = channel_progress(on_progress);
        Ok(catalog.batch_add_prompt_tag(&ids, &tag, &mut progress))
    })
    .await
}

#[tauri::command]
pub async fn batch_remove_prompt_tag(
    ids: Vec<String>,
    tag: String,
    on_progress: Channel<BatchProgressDto>,
    state: tauri::State<'_, Shared>,
) -> Result<BatchReport> {
    let ids = parse_prompt_ids(&ids)?;
    let tag = Tag::parse(&tag)?;
    with_catalog(state, move |catalog| {
        let mut progress = channel_progress(on_progress);
        Ok(catalog.batch_remove_prompt_tag(&ids, &tag, &mut progress))
    })
    .await
}

#[tauri::command]
pub async fn batch_set_prompt_favorite(
    ids: Vec<String>,
    favorite: bool,
    on_progress: Channel<BatchProgressDto>,
    state: tauri::State<'_, Shared>,
) -> Result<BatchReport> {
    let ids = parse_prompt_ids(&ids)?;
    with_catalog(state, move |catalog| {
        let mut progress = channel_progress(on_progress);
        Ok(catalog.batch_set_prompt_favorite(&ids, favorite, &mut progress))
    })
    .await
}

#[tauri::command]
pub async fn batch_delete_prompts(
    ids: Vec<String>,
    on_progress: Channel<BatchProgressDto>,
    state: tauri::State<'_, Shared>,
) -> Result<BatchReport> {
    let ids = parse_prompt_ids(&ids)?;
    with_catalog(state, move |catalog| {
        let mut progress = channel_progress(on_progress);
        Ok(catalog.batch_delete_prompts(&ids, &mut progress))
    })
    .await
}

// ---------------------------------------------------------------------------
// 全局搜索与布局偏好。
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn global_search(
    text: String,
    state: tauri::State<'_, Shared>,
) -> Result<GlobalSearchResult> {
    with_catalog(state, move |catalog| catalog.global_search(&text)).await
}

/// 读取一个库的布局偏好。从未保存过时返回 `None`。
///
/// 布局内容是前端领域的任意 JSON：后端只按键存储透传，不解释其结构，因此布局
/// 模型的演进不需要改动 IPC 合同。库 ID 在这里先经 [`LibraryId::parse`] 校验，
/// 未校验的字符串不能参与文件名拼接——与素材哈希同一纪律。
#[tauri::command]
pub async fn read_layout(
    library_id: String,
    state: tauri::State<'_, Shared>,
) -> Result<Option<serde_json::Value>> {
    let library_id = LibraryId::parse(&library_id)?;
    let layouts_dir = {
        let guard = lock(&state)?;
        guard.layouts_dir.clone()
    };
    tauri::async_runtime::spawn_blocking(move || LayoutStore::new(layouts_dir).read(&library_id))
        .await
        .map_err(|error| {
            AppError::detailed(
                Code::LibraryIoFailed,
                format!("后台读取布局任务异常终止：{error}"),
            )
        })?
}

/// 写入一个库的布局偏好（整体覆盖）。
#[tauri::command]
pub async fn write_layout(
    library_id: String,
    layout: serde_json::Value,
    state: tauri::State<'_, Shared>,
) -> Result<()> {
    let library_id = LibraryId::parse(&library_id)?;
    let layouts_dir = {
        let guard = lock(&state)?;
        guard.layouts_dir.clone()
    };
    tauri::async_runtime::spawn_blocking(move || {
        LayoutStore::new(layouts_dir).write(&library_id, &layout)
    })
    .await
    .map_err(|error| {
        AppError::detailed(
            Code::LibraryIoFailed,
            format!("后台写入布局任务异常终止：{error}"),
        )
    })?
}

#[cfg(test)]
mod tests {
    use super::{ImportOutcome, TransferProgress};
    use vistash_core::error::ALL_CODES;

    #[test]
    fn transfer_progress_and_outcomes_serialize_the_same_task_id() {
        let progress = TransferProgress {
            task_id: "task-001".to_owned(),
            done: 1,
            total: 2,
            current_filename: Some("甲.png".to_owned()),
        };
        let outcome = ImportOutcome {
            task_id: Some("task-001".to_owned()),
            imported: 1,
            skipped_non_images: 0,
            duplicates: 0,
            pending_count: 1,
            failures: Vec::new(),
        };

        assert_eq!(
            (
                serde_json::to_value(progress).expect("序列化进度")["task_id"].clone(),
                serde_json::to_value(outcome).expect("序列化结果")["task_id"].clone(),
            ),
            (
                serde_json::Value::String("task-001".to_owned()),
                serde_json::Value::String("task-001".to_owned()),
            ),
        );
    }

    /// 为测试构造一个指向临时目录的只读副本管理器。
    ///
    /// 会话 ID 用真实生成路径：状态恢复不关心它，但构造签名要求有一份。
    fn external_manager_for(
        workspace: &std::path::Path,
    ) -> vistash_core::external_open::ExternalOpenManager {
        vistash_core::external_open::ExternalOpenManager::new(
            workspace.join("cache").join("external-open").join("v1"),
            vistash_core::external_open::ExternalOpenManager::new_session_id(),
        )
    }

    /// 界面层不得读取像素。
    ///
    /// 前端禁止用 `Canvas`、`OffscreenCanvas` 或 `ImageData` 读取像素做缩放、
    /// 采样或聚类。约束的理由不是分层洁癖：浏览器的缩放行为会随内核版本变化，而 Rust 侧的
    /// 结果可以被测试锁定；色卡一旦有第二套实现，同一张图就会有两种颜色。
    ///
    /// 做成自动检查而不是一次性目视：目视只在写下这条时有效，而这条约束要长期成立。
    /// 渲染原图用的 `<img>` 不在禁止范围内，因为那属于渲染而非像素读取。
    #[test]
    fn the_ui_layer_never_reads_pixels() {
        // 匹配调用形式而不是裸标识符。裸标识符会把说明这条约束的注释本身当成违规——
        // 本测试第一版就是这么误报的。调用形式在散文里几乎不会出现。
        const FORBIDDEN: &[&str] = &[
            "getContext(",
            "getImageData(",
            "createImageBitmap(",
            "new OffscreenCanvas",
            "new ImageData",
        ];
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("src");
        let mut offenders: Vec<String> = Vec::new();
        let mut scanned = 0usize;
        walk_sources(&src, &mut |path, text| {
            scanned += 1;
            for needle in FORBIDDEN {
                if text.contains(needle) {
                    offenders.push(format!("{} 含 {needle}", path.display()));
                }
            }
        });
        // 防空跑：路径写错或前端目录被搬走时，上面的循环一次都不会执行，
        // 而"零个违规"看起来与"检查通过"完全一样。
        assert!(scanned >= 4, "只扫到 {scanned} 个前端源文件，检查形同空跑");
        assert!(
            offenders.is_empty(),
            "前端出现了像素读取手段：{offenders:?}"
        );
    }

    /// 遍历前端源码文件。刻意只认 .ts 与 .tsx：其余文件不构成前端逻辑。
    fn walk_sources(dir: &std::path::Path, visit: &mut impl FnMut(&std::path::Path, &str)) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            panic!("读取前端源码目录失败：{}", dir.display());
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk_sources(&path, visit);
            } else if path.extension().is_some_and(|e| e == "ts" || e == "tsx") {
                let text = std::fs::read_to_string(&path)
                    .unwrap_or_else(|e| panic!("读取 {} 失败: {e}", path.display()));
                visit(&path, &text);
            }
        }
    }

    /// 扩展名必须被收敛为清单内的字面量。
    ///
    /// 这条锁死的是一个真实存在过的缺口：扩展名曾经是 IPC 入参，而库内路径由
    /// `<hash>.<ext>` 拼成，带 `..` 的值能把读取指到库外。
    #[test]
    fn safe_ext_refuses_anything_outside_the_supported_list() {
        use super::safe_ext;
        assert_eq!(safe_ext("png").expect("png 受支持"), "png");
        assert_eq!(safe_ext("JPEG").expect("大小写不敏感"), "jpg");
        assert_eq!(safe_ext("jpg").expect("jpg 受支持"), "jpg");
        for bad in [
            "png/../../../secret",
            "..",
            "png.",
            "",
            "psd",
            "png ",
            "p/n/g",
        ] {
            let err = safe_ext(bad).expect_err(&format!("本应拒绝 {bad:?}"));
            assert_eq!(
                err.code,
                vistash_core::error::Code::ImportUnsupportedMediaType
            );
        }
    }

    /// 前端的文案表必须覆盖每一个错误码。
    ///
    /// 这条检查放在 Rust 侧而不是前端：错误码的唯一来源是 `ALL_CODES`，只有从这一侧出发
    /// 才能发现"新增了码却忘了加文案"。反方向的检查（从文案表出发）只能发现多余条目。
    ///
    /// 它不需要 WebView，也不需要构建前端——就是读一个文本文件做包含判断。
    #[test]
    fn error_text_covers_every_code() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("src")
            .join("shared")
            .join("errorText.ts");
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("读取文案表失败 {}: {e}", path.display()));
        let missing: Vec<&str> = ALL_CODES
            .iter()
            .map(|c| c.as_str())
            // 匹配 "<code>": 这一整段而不是裸的错误码：裸匹配会让注释里提到的码
            // 也算作已覆盖，检查就失效了。{code:?} 给出的正是带引号的形式。
            .filter(|code| !text.contains(&format!("{code:?}:")))
            .collect();
        assert!(
            missing.is_empty(),
            "errorText.ts 缺少这些错误码的中文文案：{missing:?}"
        );
    }

    /// 待迁移的旧库必须得到稳定的"需要迁移"信号，而不是"元数据损坏"。
    ///
    /// 约束要求开库发现 v1 时启动明确的一次性迁移。若这个状态被压进损坏文案，
    /// 使用者会对一个完全正常的旧库以为素材已经丢失。
    #[test]
    fn a_v1_library_is_signaled_as_needing_migration_not_corruption() {
        let dir = tempfile::tempdir().expect("建立临时目录");
        std::fs::write(
            dir.path().join("library.json"),
            r#"{"format_version":1}"#,
        )
        .expect("写 v1 库元数据");

        let err = super::with_migration_signal(dir.path(), |root| {
            vistash_core::library::Library::open(root).map(|_| ())
        })
        .expect_err("v1 库应被要求先迁移");
        assert_eq!(
            err.code,
            vistash_core::error::Code::LibraryFormatTooOld,
            "v1 库被误报为其他错误：{err:?}"
        );
    }

    #[test]
    fn a_truly_corrupt_library_keeps_the_corruption_error() {
        let dir = tempfile::tempdir().expect("建立临时目录");
        std::fs::write(dir.path().join("library.json"), "{ 这不是 JSON").expect("写损坏元数据");

        let err = super::with_migration_signal(dir.path(), |root| {
            vistash_core::library::Library::open(root).map(|_| ())
        })
        .expect_err("损坏的库不应被误报为待迁移");
        assert_eq!(
            err.code,
            vistash_core::error::Code::LibraryMetadataCorrupt,
            "真损坏被误判成别的错误：{err:?}"
        );
    }

    /// 库状态必须携带稳定的库 ID。
    ///
    /// 分库布局偏好以它为键：前端拿不到 ID 就只能退回路径键，而路径键
    /// 会在库目录改名或搬家时静默丢掉全部偏好——使用者看到的现象是"设置自己复位了"。
    /// 预期值从磁盘上的权威 `library.json` 独立读回，而不是经由同一份内存对象自证。
    #[test]
    fn status_reports_the_stable_id_of_the_opened_library() {
        let workspace = tempfile::tempdir().expect("建立临时目录");
        let lib_dir = workspace.path().join("素材库");
        let settings_path = workspace.path().join("settings.json");

        {
            let _lib = vistash_core::library::Library::open_or_create(&lib_dir)
                .expect("建立临时 v2 库");
        } // 先释放句柄：恢复流程要重新打开库与派生数据。

        let settings = vistash_core::settings::AppSettings {
            format_version: vistash_core::settings::SETTINGS_FORMAT_VERSION,
            last_library_path: Some(lib_dir.to_string_lossy().into_owned()),
        };
        settings.write_atomic(&settings_path).expect("写入设置");

        let state = super::AppState::restore(
            settings_path,
            workspace.path().join("layouts"),
            external_manager_for(workspace.path()),
        );
        let status = super::status_of(&state).expect("状态应可读");

        let meta_text =
            std::fs::read_to_string(lib_dir.join("library.json")).expect("读库元数据");
        let meta: serde_json::Value = serde_json::from_str(&meta_text).expect("解析库元数据");
        let expected = meta["library_id"]
            .as_str()
            .expect("v2 元数据含字符串 library_id")
            .to_owned();
        assert_eq!(
            status.library_id.as_ref().map(ToString::to_string),
            Some(expected),
            "状态未报告打开库的稳定 ID"
        );

        // 没有任何库被打开时自然没有 ID 可言：选择界面拿到的状态不得假装有键可存。
        let blank = super::AppState::restore(
            workspace.path().join("不存在的设置.json"),
            workspace.path().join("layouts"),
            external_manager_for(workspace.path()),
        );
        let none_status = super::status_of(&blank).expect("空状态应可读");
        assert!(
            none_status.library_id.is_none(),
            "未开库的状态不该带出库 ID"
        );
    }
}
