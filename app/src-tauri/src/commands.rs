//! Tauri command 薄层。
//!
//! 本模块的职责边界见设计第一条：**只做参数转换与错误码映射，不含业务判断**。凡是
//! "什么情况下算重复""缩略图缺失该怎么办"一类的判断都在 `vistash-core` 里，因为那些
//! 判断需要被 `cargo test` 直接验证，而本模块的每个函数都要求先有一个 WebView 才能跑。
//!
//! 本层还承担两个适配职责：把核心导入观察点转为 Tauri typed `Channel`，以及在导入完成
//! 后更新 SQLite 索引。`import` 与 `index` 在设计第一条里是同一层的两个模块，彼此没有
//! 依赖箭头，因此只能由它们上面的命令层编排；重复判定、回滚和媒体处理仍全部留在核心。
//!
//! IPC 边界上的字段名一律用 Rust 侧的 snake_case，不做 camelCase 改写：核心类型与
//! 这里的 DTO 混用两种命名，前端就得记住哪个类型用哪种。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use vistash_core::catalog::{
    AssetLocation, AssetQuery, Catalog, CatalogSnapshot, FolderFilter, FolderMutationProgress,
    FolderName, FolderPath, PurgeReport, RestoreOutcome, Tag,
};
use vistash_core::error::{AppError, Code, Result};
use vistash_core::hashing::ContentHash;
use vistash_core::import::{self, ImportFailure, ImportObserver, ImportOptions};
use vistash_core::index::{AssetRow, Index};
use vistash_core::library::Library;
use vistash_core::media::MediaType;
use vistash_core::migration::{
    detect_library_format, LibraryFormatState, Migration, MigrationProgress as MigrationProgressCore,
};
use vistash_core::settings::AppSettings;

/// 一个已打开的库及其索引。
struct Opened {
    catalog: Mutex<Catalog>,
    /// 同一个库一次只允许一个批量写入任务，避免两个拖入事件竞争去重与落盘。
    import_gate: Mutex<()>,
}

/// 应用运行期状态。
pub struct AppState {
    settings_path: PathBuf,
    opened: Option<Arc<Opened>>,
    /// 设置里记录的库路径，即使打不开也报告：待迁移的旧库需要前端直接给出迁移入口，
    /// 而不是让使用者重新在目录树里找一遍这个位置。首次运行时为 `None`。
    recorded_path: Option<String>,
    /// 启动时恢复上次的库失败的原因。首次运行时为 `None`。
    restore_problem: Option<AppError>,
}

impl AppState {
    /// 按设置里记录的路径尝试恢复上次的库。
    ///
    /// 恢复走的是 [`Library::open`] 而不是 `open_or_create`：记录的路径若已被移走或改名，
    /// 必须报告并回到选择界面，**绝不能建出一个新的空库**——那会让使用者面对空库却以为
    /// 素材全丢了。规格把这条列为明令禁止。
    pub fn restore(settings_path: PathBuf) -> Self {
        let mut state = Self {
            settings_path,
            opened: None,
            recorded_path: None,
            restore_problem: None,
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
    /// 设置里记录的库路径。`path` 为 `None` 而它有值时，前端可以直接对它发起迁移，
    /// 不需要使用者重新寻找目录。
    pub recorded_path: Option<String>,
    /// 恢复上次的库失败时的原因。界面必须连同错误码一起呈现，而不是只说"请选择库"。
    pub problem: Option<AppError>,
}

/// 一次导入的结果。
#[derive(Debug, Clone, Serialize)]
pub struct ImportOutcome {
    pub imported: usize,
    /// 目录中被跳过的非图片文件数。
    pub skipped_non_images: usize,
    /// 逐条失败。规格要求批量操作的失败可逐条查看，不得只报总数。
    pub failures: Vec<ImportFailure>,
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
/// 让界面能据此启动明确的一次性迁移（设计第四条），而不是让使用者对着损坏文案发懵。
fn with_migration_signal<T>(root: &Path, attempt: impl FnOnce(&Path) -> Result<T>) -> Result<T> {
    attempt(root).map_err(|open_error| {
        let needs_migration = matches!(
            detect_library_format(root),
            Ok(
                LibraryFormatState::NeedsMigration { .. }
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
    let path = match state.opened.as_ref() {
        Some(opened) => Some(
            lock(&opened.catalog)?
                .library()
                .root()
                .to_string_lossy()
                .into_owned(),
        ),
        None => None,
    };
    Ok(LibraryStatus {
        path,
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
    pub location: AssetLocationInput,
}

impl AssetQueryInput {
    fn into_core(self) -> Result<AssetQuery> {
        Ok(AssetQuery {
            text: self.text,
            tags: self
                .tags
                .iter()
                .map(|tag| Tag::parse(tag))
                .collect::<Result<Vec<_>>>()?,
            folder: match self.folder {
                FolderFilterInput::All => FolderFilter::All,
                FolderFilterInput::Root => FolderFilter::Root,
                FolderFilterInput::Path { path } => FolderFilter::Path(FolderPath::parse(&path)?),
            },
            location: match self.location {
                AssetLocationInput::Active => AssetLocation::Active,
                AssetLocationInput::Trash => AssetLocation::Trash,
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

/// 执行 v1→v2 一次性迁移，成功后把该库接管为当前库。
///
/// 迁移可能面对上万个侧车（任务 2.6 的量级），因此放 blocking worker。进度经
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
    let opened = tauri::async_runtime::spawn_blocking(move || -> Result<Arc<Opened>> {
        let mut migration = Migration::new(&root);
        // 索引重建由迁移以回调注入（设计第四条步骤 4）：迁移只负责权威文件，
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
        // 迁移完成后该库必然是 v2，按普通开库路径接管。
        open_at(&root)
    })
    .await
    .map_err(|error| {
        AppError::detailed(
            Code::LibraryIoFailed,
            format!("后台迁移任务异常终止：{error}"),
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
pub async fn delete_folder(path: String, state: tauri::State<'_, Shared>) -> Result<()> {
    let path = FolderPath::parse(&path)?;
    with_catalog(state, move |catalog| catalog.delete_folder(&path)).await
}

#[tauri::command]
pub async fn set_asset_folders(
    hash: String,
    folders: Vec<String>,
    state: tauri::State<'_, Shared>,
) -> Result<()> {
    let hash = ContentHash::parse(&hash)?;
    let folders = folders
        .iter()
        .map(|folder| FolderPath::parse(folder))
        .collect::<Result<Vec<_>>>()?;
    with_catalog(state, move |catalog| {
        catalog.set_asset_folders(&hash, &folders)
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
pub struct ImportProgress {
    /// 已结束处理的素材数。
    pub done: usize,
    /// 本批次展开后的素材总数。
    pub total: usize,
    /// 当前即将处理的文件；全部结束时为 `None`。
    pub current_filename: Option<String>,
}

struct ChannelObserver {
    channel: Channel<ImportProgress>,
    disconnected: bool,
}

impl ImportObserver for ChannelObserver {
    fn should_cancel(&self) -> bool {
        self.disconnected
    }

    fn on_progress(&mut self, done: usize, total: usize, source: &Path) {
        let current_filename = source
            .file_name()
            .map(|name| name.to_string_lossy().into_owned());
        if self
            .channel
            .send(ImportProgress {
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

/// 导入拖入或选中的路径。目录扫描与媒体处理全部在 blocking worker 中执行。
#[tauri::command]
pub async fn import_paths(
    paths: Vec<String>,
    on_progress: Channel<ImportProgress>,
    state: tauri::State<'_, Shared>,
) -> Result<ImportOutcome> {
    let opened = current_opened(&state)?;
    tauri::async_runtime::spawn_blocking(move || import_paths_blocking(paths, on_progress, &opened))
        .await
        .map_err(|error| {
            AppError::detailed(
                Code::LibraryIoFailed,
                format!("后台导入任务异常终止：{error}"),
            )
        })?
}

fn import_paths_blocking(
    paths: Vec<String>,
    on_progress: Channel<ImportProgress>,
    opened: &Opened,
) -> Result<ImportOutcome> {
    let _import_guard = lock(&opened.import_gate)?;
    let expanded =
        import::expand_sources(&paths.into_iter().map(PathBuf::from).collect::<Vec<_>>())?;

    // 拖入导入不自动推测文件夹或标签；导入后由使用者在素材详情中归类。
    let opts = ImportOptions::default();
    let mut observer = ChannelObserver {
        channel: on_progress,
        disconnected: false,
    };
    let library = lock(&opened.catalog)?.library().clone();
    let report = import::import_many(&library, &expanded.sources, &opts, &mut observer);

    // 见模块头：命令层只把核心产出的侧车送入同层索引，不重新判断导入结果。
    let mut catalog = lock(&opened.catalog)?;
    catalog.index_imported(&report.imported)?;

    Ok(ImportOutcome {
        imported: report.imported.len(),
        skipped_non_images: expanded.skipped_non_images,
        failures: report.failed,
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
    let (library, ext) = {
        let catalog = lock(&opened.catalog)?;
        (catalog.library().clone(), ext_of(&catalog, &hash)?)
    };
    let bytes = import::ensure_thumbnail(&library, &hash, ext)?;
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

#[cfg(test)]
mod tests {
    use vistash_core::error::ALL_CODES;

    /// 界面层不得读取像素。
    ///
    /// `app-shell` 规格禁止前端用 `Canvas`、`OffscreenCanvas` 或 `ImageData` 读取像素做缩放、
    /// 采样或聚类。约束的理由不是分层洁癖：浏览器的缩放行为会随内核版本变化，而 Rust 侧的
    /// 结果可以被测试锁定；色卡一旦有第二套实现，同一张图就会有两种颜色。
    ///
    /// 做成自动检查而不是一次性目视：目视只在写下这条时有效，而这条约束要长期成立。
    /// 渲染原图用的 `<img>` 不在禁止范围内——规格明确写了那属于渲染而非像素读取。
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
    /// 设计第四条要求开库发现 v1 时启动明确的一次性迁移。若这个状态被压进损坏文案，
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
}
