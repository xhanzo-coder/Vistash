//! 库骨架：目录布局、库级元数据与路径推导。
//!
//! 库是一个自包含的目录：把它整体复制到另一台机器上应当能直接打开。因此凡是无法
//! 从库内文件重建的信息（哈希算法、格式版本）都必须写进 `library.json`，而凡是能
//! 重建的（SQLite 索引、缩略图）都不进入元数据。

use crate::error::{AppError, Code, Result};
use crate::hashing::{ContentHash, HASH_ALGO_ID};
use crate::prompt::{PromptFolderList, PromptId};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// 库格式版本。寻址方式（fanout 层数与切片位置）属于库格式，改动必须提升此值。
pub const LIBRARY_FORMAT_VERSION: u32 = 1;

/// 库格式 v2 的版本号。
///
/// v2 相对 v1 只有两处差别（设计第四条）：`library.json` 增加稳定 `library_id`，
/// 图片侧车升级到 v2 并强制写入纯文本备注与收藏。它与 `LIBRARY_FORMAT_VERSION` 并存
/// 而不是直接把后者改成 2，因为迁移实现之前生产读写路径必须继续按 v1 处理既有库，
/// 否则一次普通启动就会把正常的 v1 库判成缺字段的损坏库。
pub const LIBRARY_FORMAT_VERSION_V2: u32 = 2;

/// 库格式 v3：图片侧车改为显式来源、必填显示名与单一文件夹归属，库级元数据字段与
/// v2 相同、仅版本号推进。由 v2→v3 迁移提交写入；打开门禁自任务 3.5 起识别它。
pub const LIBRARY_FORMAT_VERSION_V3: u32 = 3;

pub const META_FILE: &str = "library.json";
pub const FOLDERS_FILE: &str = "folders.json";
pub const INDEX_FILE: &str = "index.sqlite";
pub const OBJECTS_DIR: &str = "objects";
pub const TRASH_DIR: &str = "trash";
pub const THUMBNAILS_DIR: &str = "thumbnails";
pub const PROMPTS_DIR: &str = "prompts";
/// 提示词权威文件子目录，位于 `prompts/` 之下（设计第二条）。
pub const PROMPT_OBJECTS_DIR: &str = "objects";
/// 提示词回收站子目录。它与图片回收站分开，使两类素材各自呈现自己的可恢复删除区。
pub const PROMPT_TRASH_DIR: &str = "trash";
/// 提示词文件夹清单文件名。
///
/// 与图片的 `folders.json` 是两份彼此独立的文件：两棵文件夹树允许同路径字面值各自
/// 存在，合并成一份清单就无法表达这件事。
pub const PROMPT_FOLDERS_FILE: &str = "prompt-folders.json";

/// 库创建时会建立的全部子目录。
const SUBDIRS: &[&str] = &[OBJECTS_DIR, TRASH_DIR, THUMBNAILS_DIR, PROMPTS_DIR];

/// v1 库级元数据。
///
/// 生产路径已切到 [`LibraryMetaV2`]（任务 3.3），这个结构此后只服务迁移：迁移在提交
/// 新版本之前必须读出旧文件里的建库时间与建库版本，而那些字段只存在于 v1 文件里。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LibraryMeta {
    pub format_version: u32,
    /// 哈希算法标识符。它决定了库内既有素材的全部路径，无法从本体反推，
    /// 因此这个文件损坏后库不能自愈重建。
    pub hash_algo: String,
    pub created_at: DateTime<Utc>,
    /// 建库时的程序版本。仅用于诊断，不参与任何判断。
    pub created_by_app_version: String,
}

impl LibraryMeta {
    /// 按 v1 结构读出库级元数据。
    ///
    /// 只有迁移会调用它。刻意不做版本上限检查：调用方（迁移）已经通过
    /// `detect_library_format` 确认过这是一个待迁移的旧库，这里再判一次只会把
    /// "版本过新"这条判断分散到两处。
    pub fn read(path: &Path) -> Result<Self> {
        let bytes = std::fs::read(path).map_err(|e| {
            AppError::detailed(
                Code::LibraryPathUnreadable,
                format!("读取 {META_FILE} 失败 {}: {e}", path.display()),
            )
        })?;
        serde_json::from_slice(&bytes).map_err(|e| {
            AppError::detailed(
                Code::LibraryMetadataCorrupt,
                format!("{META_FILE} 无法按 v1 解析 {}: {e}", path.display()),
            )
        })
    }
}

/// 库的稳定标识。
///
/// 前端按库分别记住布局、视图、筛选与滚动上下文（设计第一条），这些偏好的键必须是
/// 这个 ID 而不是库路径：使用者把库目录改名或搬到另一个盘之后，路径键会静默丢掉全部
/// 偏好，而使用者看到的现象是"设置自己复位了"。
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct LibraryId(String);

impl LibraryId {
    /// 校验并接管一个库 ID 字面值。
    ///
    /// 只要求规范形式的 UUID，不限制版本：库 ID 从不参与排序，因此没有理由把它绑定在
    /// UUIDv7 上；生成端仍用 v7，使两类标识出自同一个生成器。
    pub fn parse(s: &str) -> Result<Self> {
        crate::ids::parse_canonical_uuid(s, Code::LibraryMetadataCorrupt)?;
        Ok(Self(s.to_owned()))
    }

    /// 生成一个新的库标识。
    pub fn generate() -> Self {
        Self(crate::ids::generate_canonical_uuid_v7())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for LibraryId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl Serialize for LibraryId {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for LibraryId {
    /// 反序列化经过 [`LibraryId::parse`]，使"文件里的非法 ID"与"调用方传入的非法 ID"
    /// 走同一条拒绝路径，而不是只在其中一处把关。
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        Self::parse(&s).map_err(|e| serde::de::Error::custom(e.to_string()))
    }
}

/// 库格式 v2 的库级元数据。
///
/// 与 [`LibraryMeta`] 并存而不是给它加一个可选字段：可选的 `library_id` 会让"这个库
/// 迁移过没有"变成一次运行时判断，而迁移恰恰要求这件事在打开库之前就确定。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LibraryMetaV2 {
    pub format_version: u32,
    pub library_id: LibraryId,
    pub hash_algo: String,
    pub created_at: DateTime<Utc>,
    pub created_by_app_version: String,
}

impl LibraryMetaV2 {
    pub fn read(path: &Path) -> Result<Self> {
        let bytes = std::fs::read(path).map_err(|e| {
            AppError::detailed(
                Code::LibraryPathUnreadable,
                format!("读取 {META_FILE} 失败 {}: {e}", path.display()),
            )
        })?;
        Self::from_bytes(path, &bytes)
    }

    pub fn write_atomic(&self, path: &Path) -> Result<()> {
        write_json_atomic(path, self, Code::LibraryIoFailed)
    }

    /// 从字节解析并校验。[`Library::open`] 已经整读了一次 `library.json`，按版本
    /// 分派时直接复用这份字节，避免同一文件读两遍。
    fn from_bytes(path: &Path, bytes: &[u8]) -> Result<Self> {
        let meta: Self = serde_json::from_slice(bytes).map_err(|e| {
            AppError::detailed(
                Code::LibraryMetadataCorrupt,
                format!("{META_FILE} 无法按 v2 解析 {}: {e}", path.display()),
            )
        })?;
        if meta.format_version > LIBRARY_FORMAT_VERSION_V2 {
            return Err(AppError::detailed(
                Code::LibraryFormatTooNew,
                format!(
                    "库格式版本 {} 高于程序支持的 {}：{}",
                    meta.format_version,
                    LIBRARY_FORMAT_VERSION_V2,
                    path.display()
                ),
            ));
        }
        Self::ensure_supported_hash_algo(&meta.hash_algo)?;
        Ok(meta)
    }

    fn ensure_supported_hash_algo(hash_algo: &str) -> Result<()> {
        if hash_algo != HASH_ALGO_ID {
            return Err(AppError::detailed(
                Code::LibraryFormatTooNew,
                format!(
                    "库使用的哈希算法 {hash_algo} 不被本次构建支持（本构建为 {HASH_ALGO_ID}）"
                ),
            ));
        }
        Ok(())
    }
}

/// 库格式 v3 的库级元数据。
///
/// 与 [`LibraryMetaV2`] 字段完全同构、仅版本号推进：单归属改写只发生在图片侧车，
/// 库级身份、哈希算法与建库信息沿用 v2 的含义。单独建类型而不是放宽 v2 的版本上限，
/// 是因为"这是哪一代库"必须在打开门禁处显式判定（迁移提交只接受 v2 输入），不能靠
/// 解析器顺带接受两种版本。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LibraryMetaV3 {
    pub format_version: u32,
    pub library_id: LibraryId,
    pub hash_algo: String,
    pub created_at: DateTime<Utc>,
    pub created_by_app_version: String,
}

impl LibraryMetaV3 {
    pub fn read(path: &Path) -> Result<Self> {
        let bytes = std::fs::read(path).map_err(|e| {
            AppError::detailed(
                Code::LibraryPathUnreadable,
                format!("读取 {META_FILE} 失败 {}: {e}", path.display()),
            )
        })?;
        Self::from_bytes(path, &bytes)
    }

    fn from_bytes(path: &Path, bytes: &[u8]) -> Result<Self> {
        let meta: Self = serde_json::from_slice(bytes).map_err(|e| {
            AppError::detailed(
                Code::LibraryMetadataCorrupt,
                format!("{META_FILE} 无法按 v3 解析 {}: {e}", path.display()),
            )
        })?;
        if meta.format_version != LIBRARY_FORMAT_VERSION_V3 {
            return Err(AppError::detailed(
                Code::LibraryMetadataCorrupt,
                format!(
                    "{META_FILE} 声称的版本 {} 不是 v{LIBRARY_FORMAT_VERSION_V3}：{}",
                    meta.format_version,
                    path.display()
                ),
            ));
        }
        LibraryMetaV2::ensure_supported_hash_algo(&meta.hash_algo)?;
        Ok(meta)
    }
}

/// 库格式探测保留的版本化元数据。
///
/// v2 只供迁移规划与旧迁移器短路使用，生产 [`Library::open`] 只放行 v3。
#[derive(Debug, Clone, PartialEq)]
pub enum CurrentLibraryMeta {
    V2(LibraryMetaV2),
    V3(LibraryMetaV3),
}

impl CurrentLibraryMeta {
    pub fn library_id(&self) -> &LibraryId {
        match self {
            Self::V2(meta) => &meta.library_id,
            Self::V3(meta) => &meta.library_id,
        }
    }

    pub fn format_version(&self) -> u32 {
        match self {
            Self::V2(meta) => meta.format_version,
            Self::V3(meta) => meta.format_version,
        }
    }
}

impl From<LibraryMetaV3> for LibraryMetaV2 {
    /// 打开后的运行期不再区分 v2/v3 代际——字段同构，所有下游模块统一按 [`LibraryMetaV2`]
    /// 的形状消费（`format_version` 字段保留真实代际）；代际判定只发生在打开门禁的
    /// 版本分派与 [`crate::migration::detect_library_format`] 里。
    fn from(meta: LibraryMetaV3) -> Self {
        Self {
            format_version: meta.format_version,
            library_id: meta.library_id,
            hash_algo: meta.hash_algo,
            created_at: meta.created_at,
            created_by_app_version: meta.created_by_app_version,
        }
    }
}

/// 文件夹清单。
///
/// 本变更只负责建立并读写这个文件，文件夹的增删改与界面属于后续变更。用斜杠分隔的
/// 路径字符串而不是带 id 的树结构，是为了与 `AssetSidecar::folders` 保持同一种表示——
/// 两处若用不同表示，同步逻辑就会成为一个必须存在的模块。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FolderList {
    pub format_version: u32,
    pub folders: Vec<String>,
}

impl Default for FolderList {
    fn default() -> Self {
        Self {
            format_version: LIBRARY_FORMAT_VERSION,
            folders: Vec::new(),
        }
    }
}

impl FolderList {
    /// 从路径读取图片文件夹清单。
    ///
    /// 独立于 [`Library::read_folders` 存在的理由与 `Index::rebuild_at` 相同：迁移在
    /// 能构造 `Library` 之前就要按路径读这份清单。错误语义必须与经由 `Library` 的
    /// 读取完全一致，因此后者直接委托到这里——两处各写一遍迟早出现一处接受、
    /// 另一处拒绝的组合。
    pub fn read(path: &Path) -> Result<Self> {
        let bytes = std::fs::read(path).map_err(|e| io_failed("读取文件夹清单失败", path, e))?;
        serde_json::from_slice(&bytes).map_err(|e| {
            AppError::detailed(
                Code::LibraryMetadataCorrupt,
                format!("{FOLDERS_FILE} 无法解析 {}: {e}", path.display()),
            )
        })
    }
}

/// 一个已打开的库。
///
/// 持有它即代表"根目录存在且 `library.json` 已校验通过"，因此下游模块不需要重复
/// 检查库是否有效——这是把校验集中在一处的目的。
#[derive(Debug, Clone)]
pub struct Library {
    root: PathBuf,
    meta: LibraryMetaV2,
}

fn io_failed(what: &str, path: &Path, e: std::io::Error) -> AppError {
    AppError::detailed(Code::LibraryIoFailed, format!("{what} {}: {e}", path.display()))
}

fn write_json_atomic(path: &Path, value: &impl Serialize, code: Code) -> Result<()> {
    let json = serde_json::to_vec_pretty(value)
        .map_err(|e| AppError::detailed(code, format!("序列化失败 {}: {e}", path.display())))?;
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, &json)
        .map_err(|e| AppError::detailed(code, format!("写入临时文件失败 {}: {e}", tmp.display())))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        AppError::detailed(code, format!("提交失败 {}: {e}", path.display()))
    })
}

impl Library {
    /// 在指定目录建立新库。目录必须不存在，或者存在且为空。
    ///
    /// 拒绝非空目录不是保守，而是因为建库会在其中写入 `library.json` 并声称整个
    /// 目录是一个库；若目录里原有别的文件，之后的索引重建会去扫描它们。
    pub fn create(root: &Path) -> Result<Self> {
        if root.exists() {
            if !root.is_dir() {
                return Err(AppError::detailed(
                    Code::LibraryCreateFailed,
                    format!("目标不是目录：{}", root.display()),
                ));
            }
            let mut entries = std::fs::read_dir(root)
                .map_err(|e| io_failed("读取目标目录失败", root, e))?;
            if entries.next().is_some() {
                return Err(AppError::detailed(
                    Code::LibraryDirectoryNotEmpty,
                    format!("目录非空：{}", root.display()),
                ));
            }
        } else {
            std::fs::create_dir_all(root).map_err(|e| {
                AppError::detailed(
                    Code::LibraryCreateFailed,
                    format!("建立库目录失败 {}: {e}", root.display()),
                )
            })?;
        }

        for d in SUBDIRS {
            let p = root.join(d);
            std::fs::create_dir_all(&p).map_err(|e| {
                AppError::detailed(
                    Code::LibraryCreateFailed,
                    format!("建立子目录失败 {}: {e}", p.display()),
                )
            })?;
        }

        // 提示词两个子目录与图片子目录一起建立：新建的库必须与迁移产出的库结构一致，
        // 否则"库里有没有 prompts/objects"就成了区分新建库与迁移库的隐性差异，而两者
        // 之后要走完全相同的读写路径。
        let prompts = root.join(PROMPTS_DIR);
        for d in [prompts.join(PROMPT_OBJECTS_DIR), prompts.join(PROMPT_TRASH_DIR)] {
            std::fs::create_dir_all(&d).map_err(|e| {
                AppError::detailed(
                    Code::LibraryCreateFailed,
                    format!("建立提示词子目录失败 {}: {e}", d.display()),
                )
            })?;
        }

        let meta = LibraryMetaV2 {
            // 任务 3.5 起新库直接以当前代（v3）建立。结构体名仍是 V2：打开后的运行期
            // 统一按这一份同构字段消费（见 From<LibraryMetaV3> 的文档），代际只是
            // `format_version` 字段与打开门禁的事。
            format_version: LIBRARY_FORMAT_VERSION_V3,
            library_id: LibraryId::generate(),
            hash_algo: HASH_ALGO_ID.to_owned(),
            created_at: Utc::now(),
            created_by_app_version: env!("CARGO_PKG_VERSION").to_owned(),
        };
        write_json_atomic(&root.join(META_FILE), &meta, Code::LibraryCreateFailed)?;
        write_json_atomic(
            &root.join(FOLDERS_FILE),
            &FolderList::default(),
            Code::LibraryCreateFailed,
        )?;
        write_json_atomic(
            &root.join(PROMPT_FOLDERS_FILE),
            &PromptFolderList::default(),
            Code::LibraryCreateFailed,
        )?;

        Ok(Self {
            root: root.to_path_buf(),
            meta,
        })
    }

    /// 打开门禁读取当前代的库级元数据：v2 与 v3 都放行，统一按 [`LibraryMetaV2`]
    /// 的同构字段消费（见 [`From<LibraryMetaV3>`] 的文档），代际只保留在
    /// `format_version` 字段里。
    ///
    /// 版本分派必须发生在按代解析之前：v1 文件缺少 v2 必填字段、更高版本的文件
    /// 缺少 v3 必填字段，直接交给某个解析器都会得到"元数据损坏"，掩盖"待迁移"与
    /// "版本过新"这两个完全不同的真实含义。"这是哪一代库"由这里的显式判定回答，
    /// 不靠任何解析器顺带接受多种版本。
    fn read_current_meta(path: &Path) -> Result<LibraryMetaV2> {
        #[derive(serde::Deserialize)]
        struct Probe {
            format_version: u32,
        }
        let bytes = std::fs::read(path).map_err(|e| {
            AppError::detailed(
                Code::LibraryPathUnreadable,
                format!("读取 {META_FILE} 失败 {}: {e}", path.display()),
            )
        })?;
        let probe: Probe = serde_json::from_slice(&bytes).map_err(|e| {
            AppError::detailed(
                Code::LibraryMetadataCorrupt,
                format!("{META_FILE} 中读不出格式版本 {}: {e}", path.display()),
            )
        })?;
        match probe.format_version {
            LIBRARY_FORMAT_VERSION_V2 => Err(AppError::detailed(
                Code::LibraryFormatTooOld,
                format!("v2 库必须迁移到 v3 后才能打开：{}", path.display()),
            )),
            LIBRARY_FORMAT_VERSION_V3 => Ok(LibraryMetaV3::from_bytes(path, &bytes)?.into()),
            version if version > LIBRARY_FORMAT_VERSION_V3 => Err(AppError::detailed(
                Code::LibraryFormatTooNew,
                format!(
                    "库格式版本 {version} 高于程序支持的 {LIBRARY_FORMAT_VERSION_V3}：{}",
                    path.display()
                ),
            )),
            // v1 等旧版本缺当前代必填字段。真实含义是"需要迁移"，由调用方先问
            // `detect_library_format` 区分；这里保持与既有行为一致的损坏语义即可。
            _ => LibraryMetaV2::from_bytes(path, &bytes),
        }
    }

    /// 打开既有库。
    pub fn open(root: &Path) -> Result<Self> {
        let meta_path = root.join(META_FILE);
        if !meta_path.is_file() {
            return Err(AppError::detailed(
                Code::LibraryNotFound,
                format!("目录中没有 {META_FILE}：{}", root.display()),
            ));
        }
        // 版本分派、版本上限与哈希算法的校验都在 [`Self::read_current_meta`] 里，
        // 两处各写一遍迟早出现一处接受、另一处拒绝的组合。遇到 v1 库时它报
        // "元数据损坏"，而调用方要区分"待迁移"与"真损坏"就必须先问
        // `detect_library_format`——那是开库入口的职责，不是本函数的。
        let meta = Self::read_current_meta(&meta_path)?;

        // 补齐缺失的子目录。空目录不携带任何信息，因此重建它不会掩盖数据丢失——
        // 真正的数据丢失会在索引重建时表现为素材数量下降。
        let prompts = root.join(PROMPTS_DIR);
        for p in SUBDIRS
            .iter()
            .map(|d| root.join(d))
            .chain([prompts.join(PROMPT_OBJECTS_DIR), prompts.join(PROMPT_TRASH_DIR)])
        {
            if !p.is_dir() {
                std::fs::create_dir_all(&p).map_err(|e| io_failed("补齐子目录失败", &p, e))?;
            }
        }

        Ok(Self {
            root: root.to_path_buf(),
            meta,
        })
    }

    /// 打开指定目录的库；目录还不是库时创建一个。
    ///
    /// **只用于使用者显式选择目录的流程。**启动时恢复上次的库必须直接用 [`Library::open`]：
    /// 若那条路径也走这里，一个被移走或改名的库目录就会被当成"新目录"而建出一个空库，
    /// 使用者面对空库却以为素材全丢了。规格把这条列为明令禁止。
    ///
    /// 三种情形分别由下层保证：目录已是库则 `open` 校验格式版本；目录为空则 `create`
    /// 建骨架；目录非空且不是库则 `create` 报 `library.directory_not_empty`。
    pub fn open_or_create(root: &Path) -> Result<Self> {
        if root.join(META_FILE).exists() {
            Self::open(root)
        } else {
            Self::create(root)
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn meta(&self) -> &LibraryMetaV2 {
        &self.meta
    }

    pub fn objects_dir(&self) -> PathBuf {
        self.root.join(OBJECTS_DIR)
    }

    pub fn trash_dir(&self) -> PathBuf {
        self.root.join(TRASH_DIR)
    }

    /// 缩略图独立成树（设计第四条）：它是可重算的派生数据，与权威本体混在同一棵
    /// 树里会让"重建缩略图"这类操作写进权威目录。
    pub fn thumbnails_dir(&self) -> PathBuf {
        self.root.join(THUMBNAILS_DIR)
    }

    pub fn prompts_dir(&self) -> PathBuf {
        self.root.join(PROMPTS_DIR)
    }

    pub fn meta_path(&self) -> PathBuf {
        self.root.join(META_FILE)
    }

    pub fn folders_path(&self) -> PathBuf {
        self.root.join(FOLDERS_FILE)
    }

    pub fn index_path(&self) -> PathBuf {
        self.root.join(INDEX_FILE)
    }

    pub fn body_path(&self, hash: &ContentHash, ext: &str) -> PathBuf {
        hash.body_path_in(&self.objects_dir(), ext)
    }

    pub fn sidecar_path(&self, hash: &ContentHash) -> PathBuf {
        hash.sidecar_path_in(&self.objects_dir())
    }

    pub fn thumbnail_path(&self, hash: &ContentHash) -> PathBuf {
        hash.body_path_in(&self.thumbnails_dir(), "webp")
    }

    pub fn trash_body_path(&self, hash: &ContentHash, ext: &str) -> PathBuf {
        hash.body_path_in(&self.trash_dir(), ext)
    }

    pub fn trash_sidecar_path(&self, hash: &ContentHash) -> PathBuf {
        hash.sidecar_path_in(&self.trash_dir())
    }

    /// 读取素材本体的字节。
    ///
    /// 路径推导与库内 I/O 都是本模块的职责，因此这条读取不下放给调用方自己拼路径——
    /// 一旦调用方拼路径，fanout 的切片规则就有了第二个实现。
    pub fn read_body(&self, hash: &ContentHash, ext: &str) -> Result<Vec<u8>> {
        let p = self.body_path(hash, ext);
        std::fs::read(&p).map_err(|e| io_failed("读取素材本体失败", &p, e))
    }

    pub fn read_folders(&self) -> Result<FolderList> {
        FolderList::read(&self.folders_path())
    }

    pub fn write_folders(&self, list: &FolderList) -> Result<()> {
        write_json_atomic(&self.folders_path(), list, Code::LibraryIoFailed)
    }

    pub fn prompt_objects_dir(&self) -> PathBuf {
        self.root.join(PROMPTS_DIR).join(PROMPT_OBJECTS_DIR)
    }

    pub fn prompt_trash_dir(&self) -> PathBuf {
        self.root.join(PROMPTS_DIR).join(PROMPT_TRASH_DIR)
    }

    pub fn prompt_folders_path(&self) -> PathBuf {
        self.root.join(PROMPT_FOLDERS_FILE)
    }

    /// 一条正常提示词的权威文件路径。
    ///
    /// 提示词 ID 直接就是文件名，不做图片那样的两级 fanout：fanout 是为内容哈希的
    /// 均匀分布服务的，而提示词数量与图片不是一个量级，多两层目录只会让"按 ID 找文件"
    /// 多两步推导。
    pub fn prompt_path(&self, id: &PromptId) -> PathBuf {
        self.prompt_objects_dir().join(format!("{id}.json"))
    }

    /// 一条回收站提示词的权威文件路径。
    pub fn prompt_trash_path(&self, id: &PromptId) -> PathBuf {
        self.prompt_trash_dir().join(format!("{id}.json"))
    }

    pub fn read_prompt_folders(&self) -> Result<PromptFolderList> {
        PromptFolderList::read(&self.prompt_folders_path())
    }

    pub fn write_prompt_folders(&self, list: &PromptFolderList) -> Result<()> {
        list.write_atomic(&self.prompt_folders_path())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("建立临时目录");
        let root = dir.path().join("我的素材库");
        (dir, root)
    }

    /// 固定的库 ID 字面值。测试不生成 ID：生成值会让失败信息随机变化，
    /// 而这些测试断言的是格式契约而不是生成器。
    const SAMPLE_LIBRARY_ID: &str = "018f3c9e-6c00-7000-8000-0000000f0001";

    fn v2_meta() -> LibraryMetaV2 {
        LibraryMetaV2 {
            format_version: LIBRARY_FORMAT_VERSION_V2,
            library_id: LibraryId::parse(SAMPLE_LIBRARY_ID).expect("合法库 ID"),
            hash_algo: HASH_ALGO_ID.to_owned(),
            created_at: DateTime::from_timestamp(0, 0).expect("固定时间戳"),
            created_by_app_version: "0.1.0".to_owned(),
        }
    }

    #[test]
    fn v2_metadata_round_trips_with_a_stable_library_id() {
        let (_d, root) = fresh();
        std::fs::create_dir_all(&root).expect("建立目录");
        let p = root.join(META_FILE);
        let meta = v2_meta();
        meta.write_atomic(&p).expect("写入 v2 库级元数据");
        assert_eq!(LibraryMetaV2::read(&p).expect("读回 v2 库级元数据"), meta);
    }

    #[test]
    fn a_v1_metadata_file_is_refused_by_the_v2_reader_instead_of_defaulted() {
        // 设计第四条：发现 v1 时必须启动显式迁移，而不是用 serde 默认值补出 library_id。
        // 补出来的 ID 每次启动都可能不同，而它正是分库布局偏好的键。
        let (_d, root) = fresh();
        std::fs::create_dir_all(&root).expect("建立目录");
        let meta_path = root.join(META_FILE);
        // 建库已经只产出 v2，因此这里必须自己写一份 v1 文件：这条测试断言的正是
        // "v2 读取器面对真实的 v1 文件会拒绝"，用 v2 文件测不出它。
        write_json_atomic(
            &meta_path,
            &LibraryMeta {
                format_version: LIBRARY_FORMAT_VERSION,
                hash_algo: HASH_ALGO_ID.to_owned(),
                created_at: DateTime::from_timestamp(0, 0).expect("固定时间戳"),
                created_by_app_version: "0.1.0".to_owned(),
            },
            Code::LibraryIoFailed,
        )
        .expect("写入 v1 库级元数据");
        let err = LibraryMetaV2::read(&meta_path).expect_err("本应拒绝 v1 库级元数据");
        assert_eq!(err.code, Code::LibraryMetadataCorrupt);
    }

    #[test]
    fn a_newer_v2_library_format_is_refused_by_the_v2_reader() {
        let (_d, root) = fresh();
        std::fs::create_dir_all(&root).expect("建立目录");
        let p = root.join(META_FILE);
        let mut meta = v2_meta();
        meta.format_version = LIBRARY_FORMAT_VERSION_V2 + 1;
        meta.write_atomic(&p).expect("写入更高版本元数据");
        let err = LibraryMetaV2::read(&p).expect_err("本应拒绝更高的库格式版本");
        assert_eq!(err.code, Code::LibraryFormatTooNew);
    }

    #[test]
    fn an_unknown_hash_algorithm_is_refused_by_the_v2_reader() {
        let (_d, root) = fresh();
        std::fs::create_dir_all(&root).expect("建立目录");
        let p = root.join(META_FILE);
        let mut meta = v2_meta();
        meta.hash_algo = "blake3".to_owned();
        meta.write_atomic(&p).expect("写入未知算法元数据");
        let err = LibraryMetaV2::read(&p).expect_err("本应拒绝未知哈希算法");
        assert_eq!(err.code, Code::LibraryFormatTooNew);
    }

    #[test]
    fn an_invalid_library_id_is_refused() {
        // 库 ID 是分库偏好的键，非法值必须在写入权威元数据之前被拒绝。
        for bad in ["", "   ", "not-a-uuid"] {
            let err = LibraryId::parse(bad).expect_err("本应拒绝非法库 ID");
            assert_eq!(
                err.code,
                Code::LibraryMetadataCorrupt,
                "被接受的非法库 ID：{bad:?}"
            );
        }
        LibraryId::parse(SAMPLE_LIBRARY_ID).expect("合法库 ID 应被接受");
    }

    #[test]
    fn a_freshly_created_library_is_born_at_the_current_generation() {
        // 建库必须直接产出当前代的 `library.json`（v1→v2 时是任务 3.3 的教训，
        // v2→v3 起同理）：否则一个刚建好的空库会被翻转后的打开门禁判成"需要迁移"。
        let (_d, root) = fresh();
        let lib = Library::create(&root).expect("建库");
        assert!(matches!(
            crate::migration::detect_library_format(&root).expect("判定库格式"),
            crate::migration::LibraryFormatState::Current(_)
        ));
        assert_eq!(lib.meta().format_version, LIBRARY_FORMAT_VERSION_V3);
        // 新建库与迁移产出的库必须结构一致，否则两者之后的读写路径就有了隐性分叉。
        assert!(lib.prompt_objects_dir().is_dir(), "缺少提示词权威目录");
        assert!(lib.prompt_trash_dir().is_dir(), "缺少提示词回收站目录");
        assert!(
            lib.read_prompt_folders().expect("读提示词文件夹清单").folders.is_empty(),
            "新库不得预置提示词文件夹"
        );
    }

    #[test]
    fn the_prompt_layout_never_collides_with_the_image_layout() {
        // 两套文件夹树与两个回收站必须落在不同路径，否则"同名文件夹各自存在"这条
        // 规格要求会在磁盘上被合并成一处。
        let (_d, root) = fresh();
        assert_ne!(PROMPT_FOLDERS_FILE, FOLDERS_FILE);
        let prompts = root.join(PROMPTS_DIR);
        assert_ne!(prompts.join(PROMPT_OBJECTS_DIR), root.join(OBJECTS_DIR));
        assert_ne!(prompts.join(PROMPT_TRASH_DIR), root.join(TRASH_DIR));
    }

    #[test]
    fn a_new_library_has_every_documented_directory_and_file() {
        let (_d, root) = fresh();
        Library::create(&root).expect("建库");
        for d in SUBDIRS {
            assert!(root.join(d).is_dir(), "缺少子目录 {d}");
        }
        assert!(root.join(META_FILE).is_file());
        assert!(root.join(FOLDERS_FILE).is_file());
    }

    #[test]
    fn read_body_returns_the_exact_bytes_and_reports_a_missing_file() {
        // 单图预览的原图走这条路径。库内副本是唯一权威副本，因此必须逐字节一致。
        let (_d, root) = fresh();
        let lib = Library::create(&root).expect("建库");
        let content = "假装这是一张图的字节".as_bytes();
        let hash = ContentHash::of_bytes(content);
        let p = lib.body_path(&hash, "png");
        std::fs::create_dir_all(p.parent().expect("叶目录")).expect("建立叶目录");
        std::fs::write(&p, content).expect("写入本体");

        assert_eq!(lib.read_body(&hash, "png").expect("读取本体"), content);

        std::fs::remove_file(&p).expect("删除本体");
        let err = lib.read_body(&hash, "png").expect_err("本体缺失时本应报错");
        assert_eq!(err.code, Code::LibraryIoFailed);
    }

    #[test]
    fn open_or_create_creates_in_an_empty_directory() {
        let (_d, root) = fresh();
        let lib = Library::open_or_create(&root).expect("应创建新库");
        assert!(lib.meta_path().is_file());
    }

    #[test]
    fn open_or_create_opens_an_existing_library_without_overwriting_it() {
        let (_d, root) = fresh();
        let created = Library::create(&root).expect("建库");
        let mut list = FolderList::default();
        list.folders.push("参考".to_owned());
        created.write_folders(&list).expect("写入文件夹清单");

        let reopened = Library::open_or_create(&root).expect("应打开既有库");
        assert_eq!(reopened.meta(), created.meta(), "既有库级元数据被覆盖了");
        assert_eq!(
            reopened.read_folders().expect("读取文件夹清单").folders,
            vec!["参考".to_owned()],
            "既有文件夹清单被覆盖了"
        );
    }

    #[test]
    fn open_or_create_refuses_a_non_empty_non_library_directory() {
        let (_d, root) = fresh();
        std::fs::create_dir_all(&root).expect("建立目录");
        std::fs::write(root.join("别人的文件.txt"), b"x").expect("写入无关文件");
        let err = Library::open_or_create(&root).expect_err("本应拒绝非空的非库目录");
        assert_eq!(err.code, Code::LibraryDirectoryNotEmpty);
        assert!(!root.join(META_FILE).exists(), "拒绝后不应写入任何库骨架");
    }

    #[test]
    fn open_or_create_reports_corruption_rather_than_rebuilding() {
        let (_d, root) = fresh();
        Library::create(&root).expect("建库");
        std::fs::write(root.join(META_FILE), "{ 坏了".as_bytes()).expect("破坏库级元数据");
        let err = Library::open_or_create(&root).expect_err("本应报告损坏");
        assert_eq!(err.code, Code::LibraryMetadataCorrupt);
    }

    #[test]
    fn open_refuses_a_path_that_does_not_exist() {
        // 启动恢复走的是 open。这条锁死"记录的路径消失时不会悄悄建一个新库"。
        let (_d, root) = fresh();
        let err = Library::open(&root).expect_err("不存在的路径本应报错");
        assert_eq!(err.code, Code::LibraryNotFound);
        assert!(!root.exists(), "失败不应创建任何目录");
    }

    #[test]
    fn create_then_open_preserves_the_metadata() {
        let (_d, root) = fresh();
        let created = Library::create(&root).expect("建库");
        let opened = Library::open(&root).expect("打开库");
        assert_eq!(created.meta(), opened.meta());
        assert_eq!(opened.meta().hash_algo, HASH_ALGO_ID);
        // 任务 3.5 起新库直接以当前代（v3）建立：否则一个刚建好的库会被翻转后的
        // 打开门禁判成"需要迁移"，而迁移的输入本该是旧库——新库里一张都没有。
        assert_eq!(opened.meta().format_version, LIBRARY_FORMAT_VERSION_V3);
    }

    #[test]
    fn an_existing_empty_directory_is_acceptable() {
        let (_d, root) = fresh();
        std::fs::create_dir_all(&root).expect("预建空目录");
        Library::create(&root).expect("在空目录建库");
    }

    #[test]
    fn a_non_empty_directory_is_refused() {
        // 若接受非空目录，索引重建会去扫描原本不属于库的文件。
        let (_d, root) = fresh();
        std::fs::create_dir_all(&root).expect("预建目录");
        std::fs::write(root.join("已有文件.txt"), b"x").expect("放入既有文件");
        let err = Library::create(&root).expect_err("本应拒绝非空目录");
        assert_eq!(err.code, Code::LibraryDirectoryNotEmpty);
    }

    #[test]
    fn opening_a_directory_without_metadata_reports_not_found() {
        let (_d, root) = fresh();
        std::fs::create_dir_all(&root).expect("建目录");
        let err = Library::open(&root).expect_err("本应报告不是库");
        assert_eq!(err.code, Code::LibraryNotFound);
    }

    #[test]
    fn unparseable_metadata_reports_corruption() {
        let (_d, root) = fresh();
        Library::create(&root).expect("建库");
        std::fs::write(root.join(META_FILE), "{ 坏了".as_bytes()).expect("写入损坏元数据");
        let err = Library::open(&root).expect_err("本应报告损坏");
        assert_eq!(err.code, Code::LibraryMetadataCorrupt);
    }

    #[test]
    fn a_newer_library_format_is_refused_instead_of_guessed() {
        let (_d, root) = fresh();
        let lib = Library::create(&root).expect("建库");
        let mut meta = lib.meta().clone();
        meta.format_version = LIBRARY_FORMAT_VERSION_V3 + 1;
        write_json_atomic(&root.join(META_FILE), &meta, Code::LibraryIoFailed).expect("改写元数据");
        let err = Library::open(&root).expect_err("本应拒绝更高版本");
        assert_eq!(err.code, Code::LibraryFormatTooNew);
    }

    #[test]
    fn a_v3_metadata_library_opens_with_its_identity_preserved() {
        // v2→v3 迁移提交的真实产物：字段与 v2 同构、仅版本号推进的 library.json。
        // 打开门禁必须把它当当前代打开，而不是报"版本过新"或"元数据损坏"。
        let (_d, root) = fresh();
        let created = Library::create(&root).expect("建库");
        let v3 = LibraryMetaV3 {
            format_version: LIBRARY_FORMAT_VERSION_V3,
            library_id: created.meta().library_id.clone(),
            hash_algo: created.meta().hash_algo.clone(),
            created_at: created.meta().created_at,
            created_by_app_version: created.meta().created_by_app_version.clone(),
        };
        write_json_atomic(&root.join(META_FILE), &v3, Code::LibraryIoFailed)
            .expect("改写为 v3 元数据");

        let opened = Library::open(&root).expect("v3 库应可打开");
        assert_eq!(opened.meta().format_version, LIBRARY_FORMAT_VERSION_V3);
        assert_eq!(opened.meta().library_id, created.meta().library_id);
    }

    #[test]
    fn an_unknown_hash_algorithm_is_refused() {
        // 哈希算法决定库内全部路径。猜错的后果是所有素材都找不到，
        // 而报错的后果只是打不开——后者明显更好。
        let (_d, root) = fresh();
        let lib = Library::create(&root).expect("建库");
        let mut meta = lib.meta().clone();
        meta.hash_algo = "blake3".to_owned();
        write_json_atomic(&root.join(META_FILE), &meta, Code::LibraryIoFailed).expect("改写元数据");
        let err = Library::open(&root).expect_err("本应拒绝未知算法");
        assert_eq!(err.code, Code::LibraryFormatTooNew);
    }

    #[test]
    fn opening_recreates_a_missing_subdirectory() {
        let (_d, root) = fresh();
        Library::create(&root).expect("建库");
        std::fs::remove_dir(root.join(THUMBNAILS_DIR)).expect("删掉缩略图目录");
        let lib = Library::open(&root).expect("仍应能打开");
        assert!(lib.thumbnails_dir().is_dir(), "缺失的空目录未被补齐");
    }

    #[test]
    fn body_and_sidecar_share_a_leaf_directory_under_objects() {
        let (_d, root) = fresh();
        let lib = Library::create(&root).expect("建库");
        let h = ContentHash::of_bytes(b"abc");
        let body = lib.body_path(&h, "png");
        let side = lib.sidecar_path(&h);
        assert_eq!(body.parent(), side.parent());
        assert!(body.starts_with(lib.objects_dir()));
    }

    #[test]
    fn thumbnails_live_in_their_own_tree() {
        // 设计第四条：缩略图与权威本体分树，使重建缩略图不会写进 objects/。
        let (_d, root) = fresh();
        let lib = Library::create(&root).expect("建库");
        let h = ContentHash::of_bytes(b"abc");
        let thumb = lib.thumbnail_path(&h);
        assert!(thumb.starts_with(lib.thumbnails_dir()));
        assert!(!thumb.starts_with(lib.objects_dir()));
        assert_eq!(thumb.extension().and_then(|e| e.to_str()), Some("webp"));
        // fanout 与 objects 一致，便于同一套路径推导。
        assert_eq!(
            thumb.parent().unwrap().strip_prefix(lib.thumbnails_dir()),
            lib.body_path(&h, "png")
                .parent()
                .unwrap()
                .strip_prefix(lib.objects_dir())
        );
    }

    #[test]
    fn trash_is_a_separate_tree_from_objects() {
        let (_d, root) = fresh();
        let lib = Library::create(&root).expect("建库");
        let h = ContentHash::of_bytes(b"abc");
        assert!(lib.trash_body_path(&h, "png").starts_with(lib.trash_dir()));
        assert!(!lib.trash_body_path(&h, "png").starts_with(lib.objects_dir()));
        assert_eq!(
            lib.trash_body_path(&h, "png").parent(),
            lib.trash_sidecar_path(&h).parent()
        );
    }

    #[test]
    fn the_folder_list_starts_empty_and_round_trips() {
        let (_d, root) = fresh();
        let lib = Library::create(&root).expect("建库");
        assert!(lib.read_folders().expect("读取清单").folders.is_empty());
        let list = FolderList {
            format_version: LIBRARY_FORMAT_VERSION,
            folders: vec!["参考/构图".to_owned(), "配色".to_owned()],
        };
        lib.write_folders(&list).expect("写入清单");
        assert_eq!(lib.read_folders().expect("读回清单"), list);
    }

    #[test]
    fn writing_the_folder_list_leaves_no_temp_file() {
        let (_d, root) = fresh();
        let lib = Library::create(&root).expect("建库");
        lib.write_folders(&FolderList::default()).expect("写入清单");
        let leftovers: Vec<_> = std::fs::read_dir(&root)
            .expect("读取库根")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "残留临时文件：{leftovers:?}");
    }
}
