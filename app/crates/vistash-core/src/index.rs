//! SQLite 索引：素材元数据的查询加速表。
//!
//! 索引是**纯派生数据**。它的唯一权威来源是库目录内的元数据文件，因此可以在任何时候
//! 删掉重建——这条性质是 `asset-library` 已生效需求的核心承诺之一，也给出一个免费的
//! 诊断手段：任何"索引与磁盘不一致"的疑虑都可以用删除索引重建来排除。
//!
//! 结构变更时的策略见设计第二条：读取 `user_version`，与当前程序期望值不符即删除索引
//! 文件并全量重扫重建，不写增量迁移脚本。重建成本等于一次目录扫描；而迁移脚本要为每个
//! 版本对编写并测试，一旦写错会污染索引却不被发现——正因为索引可重建，写错迁移的代价
//! 反而比不写迁移更大。

use crate::colorcard::ColorCard;
use crate::error::{AppError, Code, Result};
use crate::library::{
    FolderList, Library, FOLDERS_FILE, INDEX_FILE, OBJECTS_DIR, PROMPT_FOLDERS_FILE,
    PROMPT_OBJECTS_DIR, PROMPTS_DIR, PROMPT_TRASH_DIR, TRASH_DIR,
};
use crate::prompt::{PromptAsset, PromptFolderList};
use crate::sidecar::AssetSidecar;
use rusqlite::{params_from_iter, Connection};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// 索引结构版本。表结构、列语义或写入口径的任何改动都必须提升此值——提升即触发全量重建。
///
/// v2：新增 prompts、prompt_folders、prompt_tags、prompt_images，并为 assets 增加
/// note/favorite 列（设计第五条）。
pub const INDEX_USER_VERSION: i32 = 2;

/// 表结构。
///
/// 素材、标签、文件夹与色卡各自成表而不是把标签塞进一个逗号分隔的字段：按标签筛选是
/// v1 承诺的能力，而字符串匹配无法正确处理"标签名本身含逗号"与"前缀相同的两个标签"。
const SCHEMA: &str = "
CREATE TABLE assets (
  hash                           TEXT PRIMARY KEY NOT NULL,
  hash_algo                      TEXT NOT NULL,
  media_type                     TEXT NOT NULL,
  ext                            TEXT NOT NULL,
  byte_size                      INTEGER NOT NULL,
  width                          INTEGER NOT NULL,
  height                         INTEGER NOT NULL,
  imported_at                    TEXT NOT NULL,
  original_filename              TEXT NOT NULL,
  source_path                    TEXT,
  deleted_at                     TEXT,
  color_card_status              TEXT NOT NULL,
  color_card_algo_version        INTEGER NOT NULL,
  color_card_failure_reason      TEXT,
  color_card_sampled_pixel_count INTEGER NOT NULL,
  note                           TEXT NOT NULL,
  favorite                       INTEGER NOT NULL
);

CREATE TABLE asset_tags (
  hash TEXT NOT NULL REFERENCES assets(hash) ON DELETE CASCADE,
  tag  TEXT NOT NULL,
  PRIMARY KEY (hash, tag)
);

CREATE TABLE asset_folders (
  hash   TEXT NOT NULL REFERENCES assets(hash) ON DELETE CASCADE,
  folder TEXT NOT NULL,
  PRIMARY KEY (hash, folder)
);

-- ordinal 而不是 rank：rank 在 SQLite 里是窗口函数名，用作列名容易踩到解析歧义。
CREATE TABLE asset_colors (
  hash    TEXT NOT NULL REFERENCES assets(hash) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  hex     TEXT NOT NULL,
  oklab_l REAL NOT NULL,
  oklab_a REAL NOT NULL,
  oklab_b REAL NOT NULL,
  share   REAL NOT NULL,
  role    TEXT NOT NULL,
  PRIMARY KEY (hash, ordinal)
);

-- 文件夹独立成表且来自 folders.json，不从素材元数据派生。规格明确要求这一点：
-- 派生会使不含任何素材的文件夹在索引重建后消失。
CREATE TABLE folders (
  path TEXT PRIMARY KEY NOT NULL
);

-- 提示词行是权威文件的派生物。正文整体入列：正文搜索与“标题缺省时取首行”
-- 都必须能在索引上回答，按需详情才读权威文件。cover_image_hash 存显式指定的
-- 封面；NULL 表示“用默认封面”，即第一张关联图片——那是查询时的派生规则，
-- 不是存储时的猜测，因此这里不把派生值写进列里。
CREATE TABLE prompts (
  id               TEXT PRIMARY KEY NOT NULL,
  body             TEXT NOT NULL,
  title            TEXT,
  model            TEXT,
  parameters       TEXT,
  note             TEXT NOT NULL,
  favorite         INTEGER NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  deleted_at       TEXT,
  cover_image_hash TEXT
);

CREATE TABLE prompt_folders (
  id     TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  folder TEXT NOT NULL,
  PRIMARY KEY (id, folder)
);

-- 提示词文件夹清单独立成表且来自 prompt-folders.json，与成员关系表分开：
-- 命名与图片侧对齐——清单表是 folders / prompt_folder_list，成员表是
-- asset_folders / prompt_folders。
CREATE TABLE prompt_folder_list (
  path TEXT PRIMARY KEY NOT NULL
);

CREATE TABLE prompt_tags (
  id  TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (id, tag)
);

-- 普通关联的反查表（设计第三条）：提示词文件是关联的唯一权威方，图片侧车不写
-- 反向列表，从图片找提示词全靠这张表。image_hash 刻意没有指向 assets 的外键：
-- 关联是跨领域的软引用，回收站中的图片其行仍在索引里，而“外部改写造成的悬空
-- 关联”应当被查询层标记为已删除，而不是让整次重建失败。
CREATE TABLE prompt_images (
  prompt_id  TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  image_hash TEXT NOT NULL,
  ordinal    INTEGER NOT NULL,
  PRIMARY KEY (prompt_id, image_hash)
);

CREATE INDEX idx_asset_tags_tag ON asset_tags(tag);
CREATE INDEX idx_asset_folders_folder ON asset_folders(folder);
CREATE INDEX idx_assets_deleted_at ON assets(deleted_at);
CREATE INDEX idx_prompts_deleted_at ON prompts(deleted_at);
CREATE INDEX idx_prompt_tags_tag ON prompt_tags(tag);
CREATE INDEX idx_prompt_folders_folder ON prompt_folders(folder);
CREATE INDEX idx_prompt_images_image ON prompt_images(image_hash);
";

/// 索引里的一条颜色。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ColorRow {
    pub hex: String,
    pub oklab_l: f64,
    pub oklab_a: f64,
    pub oklab_b: f64,
    pub share: f64,
    pub role: String,
}

/// 索引里的一个素材。
///
/// 枚举与时间戳都以字符串保存：索引是派生数据，它的职责是回答查询，而不是第二份权威
/// 元数据。需要强类型时读侧车。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AssetRow {
    pub hash: String,
    pub hash_algo: String,
    pub media_type: String,
    pub ext: String,
    pub byte_size: u64,
    pub width: u32,
    pub height: u32,
    pub imported_at: String,
    pub original_filename: String,
    pub source_path: Option<String>,
    pub deleted_at: Option<String>,
    pub color_card_status: String,
    pub color_card_algo_version: u32,
    pub color_card_failure_reason: Option<String>,
    pub color_card_sampled_pixel_count: u64,
    /// 多行纯文本备注，逐字保留。详情列表的备注摘要列从这里回答。
    pub note: String,
    /// 二值收藏状态。收藏筛选从这里回答。
    pub favorite: bool,
    /// 按字典序排序。排序是快照可比较的前提。
    pub tags: Vec<String>,
    /// 按字典序排序。
    pub folders: Vec<String>,
    /// 按 `ordinal` 升序，与侧车中的顺序一致（占比降序）。
    pub colors: Vec<ColorRow>,
}

/// 索引里的一条提示词。
///
/// 与 [`AssetRow`] 同一原则：时间戳以字符串保存，索引只负责回答查询，强类型读权威
/// 文件。这里刻意不含 `deleted_from_folders`——还原要回到删除前位置，那个信息只在
/// 权威文件里，图片侧的还原同样不经过索引。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PromptRow {
    pub id: String,
    /// 当前正文。正文搜索与"标题缺省时取首行"都从这里回答。
    pub body: String,
    pub title: Option<String>,
    pub model: Option<String>,
    pub parameters: Option<String>,
    /// 多行纯文本备注，逐字保留。
    pub note: String,
    pub favorite: bool,
    /// 按字典序排序。排序是快照可比较的前提。
    pub folders: Vec<String>,
    /// 按字典序排序。
    pub tags: Vec<String>,
    /// 按 `ordinal` 升序，与权威文件中的顺序一致：默认封面取第一张关联图片，
    /// 因此顺序属于查询语义而不是展示细节。
    pub linked_image_hashes: Vec<String>,
    pub cover_image_hash: Option<String>,
    /// 由派生索引解析出的有效封面：显式正常封面优先，否则取第一张正常关联图。
    pub resolved_cover_hash: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
}

impl PromptRow {
    /// 卡片封面的单一权威解析。删除状态只存在派生索引，因此调用方直接消费
    /// 查询阶段解析出的正常图片哈希，不在界面层重新猜测。
    pub fn resolved_cover(&self) -> Option<&str> {
        self.resolved_cover_hash.as_deref()
    }
}

/// 索引的全量快照。
///
/// 存在的理由是重建等价性测试：那条承诺要求"删掉索引重建后数据不丢失"，而验证它需要
/// 一个可逐字段比较的完整视图。它同时是诊断手段——两个快照的差异直接指出不一致在哪。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct IndexSnapshot {
    /// 按 `hash` 排序。
    pub assets: Vec<AssetRow>,
    /// 按路径排序，来自 `folders.json`。
    pub folders: Vec<String>,
    /// 按 `id` 排序。
    pub prompts: Vec<PromptRow>,
    /// 按路径排序，来自 `prompt-folders.json`。与图片文件夹清单是两份独立文件。
    pub prompt_folders: Vec<String>,
}

/// 索引查询的文件夹范围。根文件夹不是持久化节点，因此单独建模。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FolderSelection<'a> {
    All,
    Root,
    Exact(&'a str),
}

fn sql_err(what: &str, e: rusqlite::Error) -> AppError {
    AppError::detailed(Code::LibraryIndexRebuildFailed, format!("{what}: {e}"))
}

fn io_err(what: &str, path: &Path, e: std::io::Error) -> AppError {
    AppError::detailed(
        Code::LibraryIndexRebuildFailed,
        format!("{what} {}: {e}", path.display()),
    )
}

/// 一个已打开的索引。
#[derive(Debug)]
pub struct Index {
    conn: Connection,
}

fn upsert_asset_in_transaction(
    tx: &rusqlite::Transaction<'_>,
    sidecar: &AssetSidecar,
) -> Result<()> {
    let hash = sidecar.hash.as_str();

    // 先删子表再删主表：即便外键未生效也不会留下孤儿行。
    for table in ["asset_tags", "asset_folders", "asset_colors"] {
        tx.execute(&format!("DELETE FROM {table} WHERE hash = ?1"), [hash])
            .map_err(|error| sql_err(&format!("清理 {table} 失败"), error))?;
    }
    tx.execute("DELETE FROM assets WHERE hash = ?1", [hash])
        .map_err(|error| sql_err("清理 assets 失败", error))?;

    let card: &ColorCard = &sidecar.color_card;
    tx.execute(
        "INSERT INTO assets (
            hash, hash_algo, media_type, ext, byte_size, width, height,
            imported_at, original_filename, source_path, deleted_at,
            color_card_status, color_card_algo_version,
            color_card_failure_reason, color_card_sampled_pixel_count,
            note, favorite
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
        rusqlite::params![
            hash,
            sidecar.hash_algo,
            sidecar.media_type.as_str(),
            sidecar.ext,
            sidecar.byte_size,
            sidecar.width,
            sidecar.height,
            sidecar.imported_at.to_rfc3339(),
            sidecar.original_filename,
            sidecar.source_path,
            sidecar.deleted_at.map(|time| time.to_rfc3339()),
            card.status.as_str(),
            card.algo_version,
            card.failure_reason.map(|code| code.as_str()),
            card.sampled_pixel_count,
            sidecar.note,
            sidecar.favorite,
        ],
    )
    .map_err(|error| sql_err("写入素材失败", error))?;

    {
        let mut statement = tx
            .prepare("INSERT OR IGNORE INTO asset_tags (hash, tag) VALUES (?1, ?2)")
            .map_err(|error| sql_err("准备标签写入失败", error))?;
        for tag in &sidecar.tags {
            statement
                .execute(rusqlite::params![hash, tag])
                .map_err(|error| sql_err("写入标签失败", error))?;
        }
    }
    {
        let mut statement = tx
            .prepare("INSERT OR IGNORE INTO asset_folders (hash, folder) VALUES (?1, ?2)")
            .map_err(|error| sql_err("准备素材文件夹写入失败", error))?;
        for folder in &sidecar.folders {
            statement
                .execute(rusqlite::params![hash, folder])
                .map_err(|error| sql_err("写入素材文件夹失败", error))?;
        }
    }
    {
        let mut statement = tx
            .prepare(
                "INSERT INTO asset_colors
                   (hash, ordinal, hex, oklab_l, oklab_a, oklab_b, share, role)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )
            .map_err(|error| sql_err("准备色卡写入失败", error))?;
        for (ordinal, color) in card.colors.iter().enumerate() {
            statement
                .execute(rusqlite::params![
                    hash,
                    ordinal as i64,
                    color.hex,
                    color.oklab.l,
                    color.oklab.a,
                    color.oklab.b,
                    color.share,
                    color.role.as_str(),
                ])
                .map_err(|error| sql_err("写入色卡失败", error))?;
        }
    }
    Ok(())
}

/// 在事务内写入或覆盖一条提示词及其子表。
///
/// 覆盖语义与图片 upsert 相同（编辑就是覆盖，设计第二条）：先删子表再删主表，
/// 重复写入不得让标签、文件夹或关联累积。
fn upsert_prompt_in_transaction(
    tx: &rusqlite::Transaction<'_>,
    prompt: &PromptAsset,
) -> Result<()> {
    let id = prompt.id.as_str();

    // 先删子表再删主表：即便外键未生效也不会留下孤儿行。三张子表引用主表的
    // 列名不同，逐表写明而不做字符串拼接。
    for (table, column) in [
        ("prompt_folders", "id"),
        ("prompt_tags", "id"),
        ("prompt_images", "prompt_id"),
    ] {
        tx.execute(
            &format!("DELETE FROM {table} WHERE {column} = ?1"),
            [id],
        )
        .map_err(|error| sql_err(&format!("清理 {table} 失败"), error))?;
    }
    tx.execute("DELETE FROM prompts WHERE id = ?1", [id])
        .map_err(|error| sql_err("清理 prompts 失败", error))?;

    tx.execute(
        "INSERT INTO prompts (
            id, body, title, model, parameters, note, favorite,
            created_at, updated_at, deleted_at, cover_image_hash
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        rusqlite::params![
            id,
            prompt.body,
            prompt.title,
            prompt.model,
            prompt.parameters,
            prompt.note,
            prompt.favorite,
            prompt.created_at.to_rfc3339(),
            prompt.updated_at.to_rfc3339(),
            prompt.deleted_at.map(|time| time.to_rfc3339()),
            prompt.cover_image_hash.as_ref().map(|hash| hash.as_str()),
        ],
    )
    .map_err(|error| sql_err("写入提示词失败", error))?;

    {
        let mut statement = tx
            .prepare("INSERT OR IGNORE INTO prompt_folders (id, folder) VALUES (?1, ?2)")
            .map_err(|error| sql_err("准备提示词文件夹写入失败", error))?;
        for folder in &prompt.folders {
            statement
                .execute(rusqlite::params![id, folder])
                .map_err(|error| sql_err("写入提示词文件夹失败", error))?;
        }
    }
    {
        let mut statement = tx
            .prepare("INSERT OR IGNORE INTO prompt_tags (id, tag) VALUES (?1, ?2)")
            .map_err(|error| sql_err("准备提示词标签写入失败", error))?;
        for tag in &prompt.tags {
            statement
                .execute(rusqlite::params![id, tag])
                .map_err(|error| sql_err("写入提示词标签失败", error))?;
        }
    }
    {
        // 关联按 ordinal 原样落表，不用 INSERT OR IGNORE：权威文件已拒绝重复哈希，
        // 主键 (prompt_id, image_hash) 与之一致，这里若撞键说明上游违反了不变量，
        // 必须失败而不是吞掉一行。
        let mut statement = tx
            .prepare(
                "INSERT INTO prompt_images (prompt_id, image_hash, ordinal) VALUES (?1, ?2, ?3)",
            )
            .map_err(|error| sql_err("准备关联写入失败", error))?;
        for (ordinal, hash) in prompt.linked_image_hashes.iter().enumerate() {
            statement
                .execute(rusqlite::params![id, hash.as_str(), ordinal as i64])
                .map_err(|error| sql_err("写入关联失败", error))?;
        }
    }
    Ok(())
}

impl Index {
    /// 打开索引，版本不符或文件不存在时全量重建。
    pub fn open(lib: &Library) -> Result<Self> {
        let path = lib.index_path();
        if path.is_file() {
            let conn = Self::connect(&path)?;
            let version: i32 = conn
                .pragma_query_value(None, "user_version", |r| r.get(0))
                .map_err(|e| sql_err("读取索引版本失败", e))?;
            if version == INDEX_USER_VERSION {
                return Ok(Self { conn });
            }
            // 版本不符即弃旧重建。必须先断开连接再删文件：Windows 上文件被占用时
            // 删除会失败，而失败信息只会说"另一个程序正在使用"，指不到真正原因。
            drop(conn);
        }
        Self::rebuild(lib)
    }

    /// 全量重建：删除既有索引文件，重扫库目录内的元数据文件。
    pub fn rebuild(lib: &Library) -> Result<Self> {
        Self::rebuild_at(lib.root())
    }

    /// 以库根路径为入口的全量重建。
    ///
    /// 存在的理由是迁移（设计第四条）：迁移必须在提交 v2 `library.json` **之前**重建
    /// 索引，而那一刻构造不出 `Library`——`Library::open` 只认 v2 元数据。重建实际
    /// 只用到路径推导与两份文件夹清单，不需要库级元数据，因此以根路径为入口恰好
    /// 覆盖迁移的需要，也让 `rebuild` 与迁移回调共用同一条实现。
    pub fn rebuild_at(root: &Path) -> Result<Self> {
        let path = root.join(INDEX_FILE);
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| io_err("删除旧索引失败", &path, e))?;
        }
        let conn = Self::connect(&path)?;
        conn.execute_batch(SCHEMA)
            .map_err(|e| sql_err("建立索引表结构失败", e))?;
        conn.pragma_update(None, "user_version", INDEX_USER_VERSION)
            .map_err(|e| sql_err("写入索引版本失败", e))?;
        let mut index = Self { conn };

        // 两份文件夹清单都先于素材写入，且都来自各自的清单文件而不是素材元数据：
        // 派生会使不含任何素材的文件夹在索引重建后消失。
        let folders = FolderList::read(&root.join(FOLDERS_FILE))?;
        index.set_folders(&folders)?;
        let prompt_folders = PromptFolderList::read(&root.join(PROMPT_FOLDERS_FILE))?;
        index.set_prompt_folders(&prompt_folders)?;

        // objects 与 trash 都要扫：侧车与提示词文件都以 deleted_at 自证状态，两棵树
        // 的文件都是权威元数据。只扫 objects 会让回收站里的素材在重建后从索引中消失。
        for tree in [root.join(OBJECTS_DIR), root.join(TRASH_DIR)] {
            for sidecar_path in collect_json_files(&tree)? {
                // 单个文件损坏即整次重建失败，不跳过。跳过会静默丢掉一个素材，而使用者
                // 只会看到"素材少了一个"，无从归因。
                let sidecar = AssetSidecar::read(&sidecar_path)?;
                index.upsert_asset(&sidecar)?;
            }
        }
        for tree in [
            root.join(PROMPTS_DIR).join(PROMPT_OBJECTS_DIR),
            root.join(PROMPTS_DIR).join(PROMPT_TRASH_DIR),
        ] {
            for prompt_path in collect_json_files(&tree)? {
                let prompt = PromptAsset::read(&prompt_path)?;
                index.upsert_prompt(&prompt)?;
            }
        }
        Ok(index)
    }

    fn connect(path: &Path) -> Result<Connection> {
        let conn = Connection::open(path)
            .map_err(|e| sql_err(&format!("打开索引失败 {}", path.display()), e))?;
        // 外键默认关闭，不开启则 ON DELETE CASCADE 不生效。
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| sql_err("启用外键约束失败", e))?;
        Ok(conn)
    }

    /// 覆盖写入文件夹清单。
    pub fn set_folders(&mut self, list: &FolderList) -> Result<()> {
        let tx = self
            .conn
            .transaction()
            .map_err(|e| sql_err("开启事务失败", e))?;
        tx.execute("DELETE FROM folders", [])
            .map_err(|e| sql_err("清空文件夹表失败", e))?;
        {
            let mut stmt = tx
                .prepare("INSERT INTO folders (path) VALUES (?1)")
                .map_err(|e| sql_err("准备文件夹写入失败", e))?;
            for path in &list.folders {
                stmt.execute([path])
                    .map_err(|e| sql_err("写入文件夹失败", e))?;
            }
        }
        tx.commit().map_err(|e| sql_err("提交事务失败", e))
    }

    /// 写入或覆盖一个素材。整体在一个事务里，避免留下"有素材行但没有标签行"的中间态。
    pub fn upsert_asset(&mut self, sidecar: &AssetSidecar) -> Result<()> {
        self.upsert_assets(std::slice::from_ref(sidecar))
    }

    /// 在同一个事务里写入一批素材，避免批量导入时为每条索引反复同步磁盘。
    pub fn upsert_assets(&mut self, sidecars: &[AssetSidecar]) -> Result<()> {
        let tx = self
            .conn
            .transaction()
            .map_err(|error| sql_err("开启事务失败", error))?;
        for sidecar in sidecars {
            upsert_asset_in_transaction(&tx, sidecar)?;
        }
        tx.commit().map_err(|error| sql_err("提交事务失败", error))
    }

    // —— SQLite v2 提示词索引 ——

    /// 写入或覆盖一条提示词及其文件夹、标签与关联。整体在一个事务里，
    /// 避免留下"有提示词行但没有标签行"的中间态。
    pub fn upsert_prompt(&mut self, prompt: &PromptAsset) -> Result<()> {
        self.upsert_prompts(std::slice::from_ref(prompt))
    }

    /// 在同一个事务里写入一批提示词。
    pub fn upsert_prompts(&mut self, prompts: &[PromptAsset]) -> Result<()> {
        let tx = self
            .conn
            .transaction()
            .map_err(|error| sql_err("开启事务失败", error))?;
        for prompt in prompts {
            upsert_prompt_in_transaction(&tx, prompt)?;
        }
        tx.commit().map_err(|error| sql_err("提交事务失败", error))
    }

    /// 覆盖写入提示词文件夹清单。语义与 [`Index::set_folders`] 相同：
    /// 清单来自 `prompt-folders.json` 而不是提示词元数据。
    pub fn set_prompt_folders(&mut self, list: &PromptFolderList) -> Result<()> {
        let tx = self
            .conn
            .transaction()
            .map_err(|e| sql_err("开启事务失败", e))?;
        tx.execute("DELETE FROM prompt_folder_list", [])
            .map_err(|e| sql_err("清空提示词文件夹表失败", e))?;
        {
            let mut stmt = tx
                .prepare("INSERT INTO prompt_folder_list (path) VALUES (?1)")
                .map_err(|e| sql_err("准备提示词文件夹写入失败", e))?;
            for path in &list.folders {
                stmt.execute([path])
                    .map_err(|e| sql_err("写入提示词文件夹失败", e))?;
            }
        }
        tx.commit().map_err(|e| sql_err("提交事务失败", e))
    }

    /// 正常提示词使用的不同标签及其数量。回收站提示词不计入；
    /// 与图片侧的 [`Index::active_tag_counts`] 共享词表但分别计数（设计第二条）。
    pub fn active_prompt_tag_counts(&self) -> Result<Vec<(String, usize)>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT t.tag, COUNT(*)
                 FROM prompt_tags t
                 JOIN prompts p ON p.id = t.id
                 WHERE p.deleted_at IS NULL
                 GROUP BY t.tag
                 ORDER BY t.tag",
            )
            .map_err(|error| sql_err("准备提示词标签计数查询失败", error))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(|error| sql_err("查询提示词标签计数失败", error))?;
        let mut counts = Vec::new();
        for row in rows {
            let (tag, count) = row.map_err(|error| sql_err("读取标签计数失败", error))?;
            counts.push((
                tag,
                usize::try_from(count).map_err(|_| {
                    AppError::detailed(
                        Code::LibraryIndexRebuildFailed,
                        format!("标签计数不是有效非负整数：{count}"),
                    )
                })?,
            ));
        }
        Ok(counts)
    }

    /// 索引中的素材条数，含回收站中的素材。
    pub fn asset_count(&self) -> Result<usize> {
        let n: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM assets", [], |r| r.get(0))
            .map_err(|e| sql_err("统计素材数失败", e))?;
        Ok(n as usize)
    }

    /// 取全量快照。排序固定，使两个快照可以逐字段比较。
    pub fn snapshot(&self) -> Result<IndexSnapshot> {
        Ok(IndexSnapshot {
            assets: self.load_assets("ORDER BY hash")?,
            folders: self.string_column("SELECT path FROM folders ORDER BY path")?,
            prompts: self.load_prompts("ORDER BY id", &[])?,
            prompt_folders: self
                .string_column("SELECT path FROM prompt_folder_list ORDER BY path")?,
        })
    }

    /// 网格用的素材列表，按导入时间倒序。
    ///
    /// 默认排除回收站中的素材：它们在索引里，但正常浏览不该看到它们。
    pub fn list_assets(&self, include_deleted: bool) -> Result<Vec<AssetRow>> {
        // 两个分支都是字面量，不拼接任何调用方输入，因此不存在注入面。
        let tail = if include_deleted {
            "ORDER BY imported_at DESC, hash"
        } else {
            "WHERE deleted_at IS NULL ORDER BY imported_at DESC, hash"
        };
        self.load_assets(tail)
    }

    /// 全部正常提示词的轻量行，按 ID 排序。
    ///
    /// 文件夹重命名/删除需要遍历受影响的提示词权威文件；与图片侧一致，只遍历
    /// 正常库——回收站素材的原文件夹由还原语义处理，不随组织操作改写。
    pub fn list_prompts(&self) -> Result<Vec<PromptRow>> {
        self.load_prompts("WHERE deleted_at IS NULL ORDER BY id", &[])
    }

    /// 素材是否在索引中（含回收站）。
    ///
    /// 关联校验只关心"库里有这张图"：关联到回收站图片是合法状态（界面呈现为
    /// "已删除"），指向从未入库的哈希才是错误。
    pub fn asset_exists(&self, hash: &str) -> Result<bool> {
        let mut stmt = self
            .conn
            .prepare("SELECT 1 FROM assets WHERE hash = ?1")
            .map_err(|e| sql_err("准备素材存在性查询失败", e))?;
        stmt.exists([hash])
            .map_err(|e| sql_err("查询素材存在性失败", e))
    }

    /// 按哈希取单个素材行（含组织字段）。批量组织用它读当前值、计算新集合。
    pub fn asset_row(&self, hash: &str) -> Result<AssetRow> {
        let mut assets =
            self.load_assets_with_params("WHERE hash = ?1", &[hash.to_owned()], None)?;
        assets.pop().ok_or_else(|| {
            AppError::detailed(
                Code::LibraryNotFound,
                format!("索引中没有这个素材：{hash}"),
            )
        })
    }

    /// 按 ID 取单个提示词行（含回收站），供批量组织读当前值与显示名。
    pub fn prompt_row(&self, id: &str) -> Result<PromptRow> {
        let mut rows = self.load_prompts("WHERE p.id = ?1", &[id.to_owned()])?;
        rows.pop().ok_or_else(|| {
            AppError::detailed(Code::PromptNotFound, format!("索引中没有这条提示词：{id}"))
        })
    }

    /// 反查关联了某张图片的全部提示词（含回收站），按 ID 排序。
    ///
    /// 反查必须包含回收站提示词：设计第三条要求图片反查能显示"关联提示词已
    /// 删除"，过滤掉它们会让这个状态无从呈现。轻量行足够——反查用于列表与
    /// 计数，完整正文经按需详情读取。
    pub fn prompts_for_image(&self, hash: &str) -> Result<Vec<PromptRow>> {
        self.load_prompts(
            "JOIN prompt_images pi ON pi.prompt_id = p.id \
             WHERE pi.image_hash = ?1 ORDER BY p.id",
            &[hash.to_owned()],
        )
    }

    /// 按位置、文件夹、全部标签、收藏与 Unicode 文件名组合查询。
    pub fn query_assets(
        &self,
        deleted: bool,
        folder: FolderSelection<'_>,
        tags: &[String],
        favorite: Option<bool>,
        filename_text: &str,
    ) -> Result<Vec<AssetRow>> {
        let mut clauses = vec![if deleted {
            "a.deleted_at IS NOT NULL".to_owned()
        } else {
            "a.deleted_at IS NULL".to_owned()
        }];
        let mut values = Vec::<String>::new();
        if let Some(favorite) = favorite {
            clauses.push(format!("a.favorite = {}", if favorite { "1" } else { "0" }));
        }
        match folder {
            FolderSelection::All => {}
            FolderSelection::Root => clauses.push(
                "NOT EXISTS (SELECT 1 FROM asset_folders af WHERE af.hash = a.hash)".to_owned(),
            ),
            FolderSelection::Exact(path) => {
                values.push(path.to_owned());
                clauses.push(format!(
                    "EXISTS (SELECT 1 FROM asset_folders af WHERE af.hash = a.hash AND af.folder = ?{})",
                    values.len()
                ));
            }
        }
        for tag in tags {
            values.push(tag.clone());
            clauses.push(format!(
                "EXISTS (SELECT 1 FROM asset_tags at WHERE at.hash = a.hash AND at.tag = ?{})",
                values.len()
            ));
        }
        let tail = format!(
            "a WHERE {} ORDER BY a.imported_at DESC, a.hash",
            clauses.join(" AND ")
        );
        self.load_assets_with_params(&tail, &values, Some(filename_text))
    }

    /// 按位置、提示词文件夹、全部标签、收藏与标题/正文子串组合查询提示词。
    ///
    /// 文本匹配在 Rust 侧做大小写折叠子串比较：SQL 的 LIKE 只对 ASCII 折叠大小写，
    /// 对中文与带变音符号的文本语义不对，而提示词的正文天然是多语言文本。
    pub fn query_prompts(
        &self,
        deleted: bool,
        folder: FolderSelection<'_>,
        tags: &[String],
        favorite: Option<bool>,
        text: &str,
    ) -> Result<Vec<PromptRow>> {
        let mut clauses = vec![if deleted {
            "p.deleted_at IS NOT NULL".to_owned()
        } else {
            "p.deleted_at IS NULL".to_owned()
        }];
        let mut values = Vec::<String>::new();
        match folder {
            FolderSelection::All => {}
            FolderSelection::Root => clauses.push(
                "NOT EXISTS (SELECT 1 FROM prompt_folders pf WHERE pf.id = p.id)".to_owned(),
            ),
            FolderSelection::Exact(path) => {
                values.push(path.to_owned());
                clauses.push(format!(
                    "EXISTS (SELECT 1 FROM prompt_folders pf WHERE pf.id = p.id AND pf.folder = ?{})",
                    values.len()
                ));
            }
        }
        for tag in tags {
            values.push(tag.clone());
            clauses.push(format!(
                "EXISTS (SELECT 1 FROM prompt_tags pt WHERE pt.id = p.id AND pt.tag = ?{})",
                values.len()
            ));
        }
        if let Some(favorite) = favorite {
            clauses.push(format!("p.favorite = {}", if favorite { "1" } else { "0" }));
        }
        let tail = format!(
            "WHERE {} ORDER BY p.created_at DESC, p.id DESC",
            clauses.join(" AND ")
        );
        let mut prompts = self.load_prompts(&tail, &values)?;
        let needle = text.to_lowercase();
        if !needle.is_empty() {
            // 标题缺省不是特殊情形：匹配只看标题与正文两份文本，缺省标题自然落到正文。
            prompts.retain(|prompt| {
                let title_hit = prompt
                    .title
                    .as_deref()
                    .is_some_and(|title| title.to_lowercase().contains(&needle));
                let body_hit = prompt.body.to_lowercase().contains(&needle);
                title_hit || body_hit
            });
        }
        Ok(prompts)
    }

    /// 正常素材使用的不同标签及其素材数量。
    pub fn active_tag_counts(&self) -> Result<Vec<(String, usize)>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT t.tag, COUNT(*)
                 FROM asset_tags t
                 JOIN assets a ON a.hash = t.hash
                 WHERE a.deleted_at IS NULL
                 GROUP BY t.tag
                 ORDER BY t.tag",
            )
            .map_err(|error| sql_err("准备标签计数查询失败", error))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })
            .map_err(|error| sql_err("查询标签计数失败", error))?;
        let mut counts = Vec::new();
        for row in rows {
            let (tag, count) = row.map_err(|error| sql_err("读取标签计数失败", error))?;
            counts.push((
                tag,
                usize::try_from(count).map_err(|_| {
                    AppError::detailed(
                        Code::LibraryIndexRebuildFailed,
                        format!("标签计数不是有效非负整数：{count}"),
                    )
                })?,
            ));
        }
        Ok(counts)
    }

    pub fn deleted_count(&self) -> Result<usize> {
        let count: i64 = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM assets WHERE deleted_at IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .map_err(|error| sql_err("统计回收站素材失败", error))?;
        usize::try_from(count).map_err(|_| {
            AppError::detailed(
                Code::LibraryIndexRebuildFailed,
                format!("回收站计数不是有效非负整数：{count}"),
            )
        })
    }

    /// 提示词回收站中的素材数量。与图片回收站计数是两个独立的数字。
    pub fn deleted_prompt_count(&self) -> Result<usize> {
        let count: i64 = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM prompts WHERE deleted_at IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .map_err(|error| sql_err("统计提示词回收站失败", error))?;
        usize::try_from(count).map_err(|_| {
            AppError::detailed(
                Code::LibraryIndexRebuildFailed,
                format!("提示词回收站计数不是有效非负整数：{count}"),
            )
        })
    }

    /// 某个素材在库内的扩展名。
    ///
    /// 存在的理由是安全边界：库内路径由 `<hash>.<ext>` 拼成，而 `ext` 若来自 IPC 入参，
    /// 带 `..` 的值就能把路径指到库外。索引里的值出自本程序自己的写入，因此由这里回答
    /// 比让调用方传进来可信——调用方传参这件事本身就是那道边界的缺口。
    pub fn asset_ext(&self, hash: &str) -> Result<String> {
        self.conn
            .query_row("SELECT ext FROM assets WHERE hash = ?1", [hash], |r| {
                r.get(0)
            })
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    AppError::detailed(Code::LibraryNotFound, format!("索引中没有这个素材：{hash}"))
                }
                other => sql_err("查询素材扩展名失败", other),
            })
    }

    pub fn asset_is_deleted(&self, hash: &str) -> Result<bool> {
        self.conn
            .query_row(
                "SELECT deleted_at IS NOT NULL FROM assets WHERE hash = ?1",
                [hash],
                |row| row.get(0),
            )
            .map_err(|error| match error {
                rusqlite::Error::QueryReturnedNoRows => {
                    AppError::detailed(Code::LibraryNotFound, format!("索引中没有这个素材：{hash}"))
                }
                other => sql_err("查询素材删除状态失败", other),
            })
    }

    /// 按给定的 WHERE/ORDER 尾句加载素材，并填充标签、文件夹与色卡。
    fn load_assets(&self, tail: &str) -> Result<Vec<AssetRow>> {
        self.load_assets_with_params(tail, &[], None)
    }

    fn load_assets_with_params(
        &self,
        tail: &str,
        values: &[String],
        filename_text: Option<&str>,
    ) -> Result<Vec<AssetRow>> {
        let sql = format!(
            "SELECT hash, hash_algo, media_type, ext, byte_size, width, height,
                    imported_at, original_filename, source_path, deleted_at,
                    color_card_status, color_card_algo_version,
                    color_card_failure_reason, color_card_sampled_pixel_count,
                    note, favorite
             FROM assets {tail}"
        );
        let mut stmt = self
            .conn
            .prepare(&sql)
            .map_err(|e| sql_err("准备素材查询失败", e))?;
        let rows = stmt
            .query_map(params_from_iter(values.iter()), |r| {
                Ok(AssetRow {
                    hash: r.get(0)?,
                    hash_algo: r.get(1)?,
                    media_type: r.get(2)?,
                    ext: r.get(3)?,
                    byte_size: r.get(4)?,
                    width: r.get(5)?,
                    height: r.get(6)?,
                    imported_at: r.get(7)?,
                    original_filename: r.get(8)?,
                    source_path: r.get(9)?,
                    deleted_at: r.get(10)?,
                    color_card_status: r.get(11)?,
                    color_card_algo_version: r.get(12)?,
                    color_card_failure_reason: r.get(13)?,
                    color_card_sampled_pixel_count: r.get(14)?,
                    note: r.get(15)?,
                    favorite: r.get(16)?,
                    tags: Vec::new(),
                    folders: Vec::new(),
                    colors: Vec::new(),
                })
            })
            .map_err(|e| sql_err("查询素材失败", e))?;
        let mut assets: Vec<AssetRow> = Vec::new();
        for row in rows {
            assets.push(row.map_err(|e| sql_err("读取素材行失败", e))?);
        }
        if let Some(filename_text) = filename_text {
            let needle = filename_text.to_lowercase();
            if !needle.is_empty() {
                assets.retain(|asset| asset.original_filename.to_lowercase().contains(&needle));
            }
        }
        for a in &mut assets {
            a.tags = self.strings_for(
                "SELECT tag FROM asset_tags WHERE hash = ?1 ORDER BY tag",
                &a.hash,
            )?;
            a.folders = self.strings_for(
                "SELECT folder FROM asset_folders WHERE hash = ?1 ORDER BY folder",
                &a.hash,
            )?;
            a.colors = self.colors_for(&a.hash)?;
        }
        Ok(assets)
    }

    /// 按给定的 ORDER 尾句与绑定参数加载提示词，并填充文件夹、标签与关联。
    fn load_prompts(&self, tail: &str, values: &[String]) -> Result<Vec<PromptRow>> {
        let sql = format!(
            "SELECT p.id, p.body, p.title, p.model, p.parameters, p.note, p.favorite,
                    p.created_at, p.updated_at, p.deleted_at, p.cover_image_hash,
                    CASE
                      WHEN p.cover_image_hash IS NOT NULL
                       AND EXISTS (
                         SELECT 1 FROM assets cover
                         WHERE cover.hash = p.cover_image_hash AND cover.deleted_at IS NULL
                       )
                      THEN p.cover_image_hash
                      ELSE (
                        SELECT pi.image_hash
                        FROM prompt_images pi
                        JOIN assets a ON a.hash = pi.image_hash
                        WHERE pi.prompt_id = p.id AND a.deleted_at IS NULL
                        ORDER BY pi.ordinal
                        LIMIT 1
                      )
                    END
             FROM prompts p {tail}"
        );
        let mut stmt = self
            .conn
            .prepare(&sql)
            .map_err(|e| sql_err("准备提示词查询失败", e))?;
        let rows = stmt
            .query_map(params_from_iter(values.iter()), |r| {
                Ok(PromptRow {
                    id: r.get(0)?,
                    body: r.get(1)?,
                    title: r.get(2)?,
                    model: r.get(3)?,
                    parameters: r.get(4)?,
                    note: r.get(5)?,
                    favorite: r.get(6)?,
                    created_at: r.get(7)?,
                    updated_at: r.get(8)?,
                    deleted_at: r.get(9)?,
                    cover_image_hash: r.get(10)?,
                    resolved_cover_hash: r.get(11)?,
                    folders: Vec::new(),
                    tags: Vec::new(),
                    linked_image_hashes: Vec::new(),
                })
            })
            .map_err(|e| sql_err("查询提示词失败", e))?;
        let mut prompts: Vec<PromptRow> = Vec::new();
        for row in rows {
            prompts.push(row.map_err(|e| sql_err("读取提示词行失败", e))?);
        }
        for p in &mut prompts {
            p.folders = self.strings_for(
                "SELECT folder FROM prompt_folders WHERE id = ?1 ORDER BY folder",
                &p.id,
            )?;
            p.tags = self.strings_for(
                "SELECT tag FROM prompt_tags WHERE id = ?1 ORDER BY tag",
                &p.id,
            )?;
            p.linked_image_hashes = self.strings_for(
                "SELECT image_hash FROM prompt_images WHERE prompt_id = ?1 ORDER BY ordinal",
                &p.id,
            )?;
        }
        Ok(prompts)
    }

    fn string_column(&self, sql: &str) -> Result<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare(sql)
            .map_err(|e| sql_err("准备查询失败", e))?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| sql_err("执行查询失败", e))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| sql_err("读取行失败", e))?);
        }
        Ok(out)
    }

    fn strings_for(&self, sql: &str, hash: &str) -> Result<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare(sql)
            .map_err(|e| sql_err("准备查询失败", e))?;
        let rows = stmt
            .query_map([hash], |r| r.get::<_, String>(0))
            .map_err(|e| sql_err("执行查询失败", e))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| sql_err("读取行失败", e))?);
        }
        Ok(out)
    }

    fn colors_for(&self, hash: &str) -> Result<Vec<ColorRow>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT hex, oklab_l, oklab_a, oklab_b, share, role
                 FROM asset_colors WHERE hash = ?1 ORDER BY ordinal",
            )
            .map_err(|e| sql_err("准备色卡查询失败", e))?;
        let rows = stmt
            .query_map([hash], |r| {
                Ok(ColorRow {
                    hex: r.get(0)?,
                    oklab_l: r.get(1)?,
                    oklab_a: r.get(2)?,
                    oklab_b: r.get(3)?,
                    share: r.get(4)?,
                    role: r.get(5)?,
                })
            })
            .map_err(|e| sql_err("查询色卡失败", e))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| sql_err("读取色卡行失败", e))?);
        }
        Ok(out)
    }
}

/// 收集一棵树下的全部元数据 JSON 路径（图片侧车或提示词文件），按路径排序。
///
/// 排序使重建顺序确定：顺序影响不了内容，但影响失败时先撞上哪个损坏文件，
/// 而"同一个库每次报同一个错"是可诊断的前提。
fn collect_json_files(tree: &Path) -> Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    walk(tree, &mut out)?;
    out.sort();
    Ok(out)
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) -> Result<()> {
    if !dir.is_dir() {
        return Ok(());
    }
    let entries = std::fs::read_dir(dir).map_err(|e| io_err("读取目录失败", dir, e))?;
    for entry in entries {
        let entry = entry.map_err(|e| io_err("读取目录项失败", dir, e))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|e| io_err("读取目录项类型失败", &path, e))?;
        if file_type.is_dir() {
            walk(&path, out)?;
        } else if path.extension().is_some_and(|e| e == "json") {
            // 只认 .json。写入中途留下的 .json.tmp 不是侧车，扫进来会当成损坏素材。
            out.push(path);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hashing::ContentHash;
    use crate::import::{self, ImportOptions, NoopObserver};
    use crate::prompt::{PromptId, PROMPT_FORMAT_VERSION};
    use image::{DynamicImage, ImageFormat, Rgba, RgbaImage};

    #[test]
    fn a_card_resolves_its_cover_with_explicit_value_first_then_order() {
        let row = |cover: Option<&str>, links: &[&str]| PromptRow {
            id: "018f3c9e-6c00-7000-8000-0000000000a1".to_owned(),
            body: "正文".to_owned(),
            title: None,
            model: None,
            parameters: None,
            note: String::new(),
            favorite: false,
            folders: Vec::new(),
            tags: Vec::new(),
            linked_image_hashes: links.iter().map(|s| (*s).to_owned()).collect(),
            cover_image_hash: cover.map(str::to_owned),
            resolved_cover_hash: cover
                .or_else(|| links.first().copied())
                .map(str::to_owned),
            created_at: String::new(),
            updated_at: String::new(),
            deleted_at: None,
        };
        assert_eq!(
            row(None, &[]).resolved_cover(),
            None,
            "无关联的提示词是纯文本卡片"
        );
        assert_eq!(
            row(None, &["乙", "甲"]).resolved_cover(),
            Some("乙"),
            "缺省封面取第一张关联图片"
        );
        assert_eq!(
            row(Some("甲"), &["乙", "甲"]).resolved_cover(),
            Some("甲"),
            "显式封面优先于列表顺序"
        );
    }

    /// 固定的 UUIDv7 字面值。与 prompt.rs 测试同一原则：不生成 ID，失败信息必须可复现。
    const PROMPT_FULL: &str = "018f3c9e-6c00-7000-8000-0000000000a1";
    const PROMPT_MINIMAL: &str = "018f3c9e-6c00-7000-8000-0000000000b2";
    const PROMPT_TRASHED: &str = "018f3c9e-6c00-7000-8000-0000000000c3";

    struct Fixture {
        _dir: tempfile::TempDir,
        lib: Library,
        src: PathBuf,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().expect("建立临时目录");
        let lib = Library::create(&dir.path().join("库")).expect("建库");
        let src = dir.path().join("来源");
        std::fs::create_dir_all(&src).expect("建立来源目录");
        Fixture {
            _dir: dir,
            lib,
            src,
        }
    }

    /// 逐行填色写一张 PNG。多色是为了让色卡表里有多行，从而覆盖 ordinal 的顺序。
    fn write_bands(dir: &Path, name: &str, width: u32, bands: &[(u32, [u8; 4])]) -> PathBuf {
        let height: u32 = bands.iter().map(|(h, _)| h).sum();
        let mut img = RgbaImage::new(width, height);
        let mut y = 0;
        for (h, c) in bands {
            for _ in 0..*h {
                for x in 0..width {
                    img.put_pixel(x, y, Rgba(*c));
                }
                y += 1;
            }
        }
        let p = dir.join(name);
        DynamicImage::ImageRgba8(img)
            .save_with_format(&p, ImageFormat::Png)
            .expect("写入 PNG");
        p
    }

    /// 导入三张内容不同、色卡不同的素材，并按应用的实际做法增量维护索引。
    fn seed(f: &Fixture) -> (Index, Vec<crate::sidecar::AssetSidecar>) {
        let sources = vec![
            write_bands(
                &f.src,
                "红蓝.png",
                40,
                &[(24, [255, 0, 0, 255]), (8, [0, 0, 255, 255])],
            ),
            write_bands(&f.src, "纯青.png", 32, &[(32, [0, 180, 180, 255])]),
            write_bands(
                &f.src,
                "三色.png",
                60,
                &[
                    (30, [32, 32, 32, 255]),
                    (10, [255, 200, 0, 255]),
                    (20, [224, 224, 224, 255]),
                ],
            ),
        ];
        let opts = ImportOptions {
            folders: vec!["参考/构图".to_owned()],
            tags: vec!["黄".to_owned(), "参考".to_owned()],
        };
        // 索引必须在导入之前打开。若先导入再 open，open 会因索引文件不存在而走全量重建，
        // 于是"增量攒出来的索引"根本没被构造过，等价性测试就退化成了重建与重建自比。
        let mut index = Index::open(&f.lib).expect("打开索引");
        assert_eq!(
            index.asset_count().expect("统计素材"),
            0,
            "起点必须是空索引"
        );

        let report = import::import_many(&f.lib, &sources, &opts, &mut NoopObserver);
        assert!(
            report.failed.is_empty(),
            "导入不应失败：{:?}",
            report.failed
        );
        assert_eq!(report.imported.len(), 3);
        for s in &report.imported {
            index.upsert_asset(s).expect("写入素材");
        }

        // 文件夹清单独立持久化。空文件夹刻意也写进去：规格要求它在重建后仍然存在。
        let folders = FolderList {
            format_version: crate::library::LIBRARY_FORMAT_VERSION,
            folders: vec!["参考/构图".to_owned(), "空文件夹".to_owned()],
        };
        f.lib.write_folders(&folders).expect("写入文件夹清单");
        index.set_folders(&folders).expect("写入文件夹");

        (index, report.imported)
    }

    /// 构造一条只有必填字段的提示词。
    fn sample_prompt(id_literal: &str) -> PromptAsset {
        PromptAsset {
            format_version: PROMPT_FORMAT_VERSION,
            id: PromptId::parse(id_literal).expect("合法 ID"),
            body: "样例正文".to_owned(),
            title: None,
            model: None,
            parameters: None,
            note: String::new(),
            favorite: false,
            folders: vec![],
            tags: vec![],
            linked_image_hashes: vec![],
            cover_image_hash: None,
            created_at: chrono::DateTime::from_timestamp(0, 0).expect("固定时间戳"),
            updated_at: chrono::DateTime::from_timestamp(0, 0).expect("固定时间戳"),
            deleted_at: None,
            deleted_from_folders: None,
        }
    }

    /// 把提示词权威文件写到它当前状态对应的树上：回收站中的写 trash 树。
    fn write_prompt_file(lib: &Library, prompt: &PromptAsset) {
        let path = if prompt.is_deleted() {
            lib.prompt_trash_path(&prompt.id)
        } else {
            lib.prompt_path(&prompt.id)
        };
        prompt.write_atomic(&path).expect("写入提示词权威文件");
    }

    /// 在 [`seed`] 的基础上追加 v2 内容，全部走增量路径，使"增量攒出来的索引"成为
    /// 等价性测试的一侧：
    ///
    /// - 第一张图片带多行备注与收藏（改侧车、重写文件、upsert）；
    /// - 三条提示词：全字段、仅必填字段、回收站中带关联；
    /// - 两份彼此独立的文件夹清单，各含一个空文件夹与一个两树同名的路径。
    ///
    /// 标签布局服务于分库计数断言：字面值 `人物` 同时出现在图片侧与提示词侧，
    /// 若计数被合并，任何一侧都会数出 2。
    fn seed_v2(f: &Fixture) -> (Index, Vec<AssetSidecar>, Vec<PromptAsset>) {
        let (mut index, imported) = seed(f);

        let mut noted = imported[0].clone();
        noted.note = "第一行\n\n第三行  末尾两个空格  ".to_owned();
        noted.favorite = true;
        noted.tags = vec!["参考".to_owned(), "人物".to_owned()];
        noted
            .write_atomic(&f.lib.sidecar_path(&noted.hash))
            .expect("重写侧车");
        index.upsert_asset(&noted).expect("写入带备注素材");

        let mut full = sample_prompt(PROMPT_FULL);
        full.body = "逆光人像，胶片颗粒，暖色高光".to_owned();
        full.title = Some("逆光人像".to_owned());
        full.model = Some("某生图模型 v3".to_owned());
        full.parameters = Some("steps=30, cfg=6".to_owned());
        full.note = "提示词备注".to_owned();
        full.favorite = true;
        full.folders = vec!["人物/室内".to_owned()];
        full.tags = vec!["人物".to_owned(), "逆光".to_owned()];
        full.linked_image_hashes = vec![imported[2].hash.clone(), imported[0].hash.clone()];
        full.cover_image_hash = Some(imported[0].hash.clone());

        let minimal = sample_prompt(PROMPT_MINIMAL);

        let mut trashed = sample_prompt(PROMPT_TRASHED);
        trashed.body = "已删除的正文".to_owned();
        trashed.folders = vec!["人物/室内".to_owned()];
        trashed.tags = vec!["人物".to_owned()];
        trashed.linked_image_hashes = vec![imported[1].hash.clone()];
        trashed.deleted_at = Some(chrono::Utc::now());
        trashed.deleted_from_folders = Some(vec!["人物/室内".to_owned()]);

        for prompt in [&full, &minimal, &trashed] {
            write_prompt_file(&f.lib, prompt);
        }
        index
            .upsert_prompts(&[full.clone(), minimal.clone(), trashed.clone()])
            .expect("批量写入提示词");

        // 两份清单独立持久化。空文件夹与两树同名路径刻意都写进去：
        // 前者验证"不含素材的文件夹重建后仍在"，后者验证两棵树互不混合。
        let folders = FolderList {
            format_version: crate::library::LIBRARY_FORMAT_VERSION,
            folders: vec![
                "参考/构图".to_owned(),
                "人物/室内".to_owned(),
                "空文件夹".to_owned(),
            ],
        };
        f.lib.write_folders(&folders).expect("写入图片文件夹清单");
        index.set_folders(&folders).expect("写入图片文件夹");

        let prompt_folders = PromptFolderList {
            format_version: PROMPT_FORMAT_VERSION,
            folders: vec![
                "构图参考".to_owned(),
                "人物/室内".to_owned(),
                "空提示词文件夹".to_owned(),
            ],
        };
        f.lib
            .write_prompt_folders(&prompt_folders)
            .expect("写入提示词文件夹清单");
        index
            .set_prompt_folders(&prompt_folders)
            .expect("写入提示词文件夹");

        (index, imported, vec![full, minimal, trashed])
    }

    #[test]
    fn rebuilding_from_disk_reproduces_the_incrementally_built_index() {
        // 这是本项目最核心的承诺：索引可仅依据库目录内的元数据文件完整重建。
        //
        // 比较的两侧刻意不同源：一侧是导入时逐个 upsert 攒出来的，另一侧是删掉索引后
        // 从磁盘重扫的。若只比较两次重建，增量写入路径与重建路径的分歧就测不出来。
        //
        // 本次没有"不可重建字段"：索引里的每一列都来自侧车或 folders.json。
        let f = fixture();
        let (index, _) = seed(&f);
        let before = index.snapshot().expect("取快照");
        assert_eq!(before.assets.len(), 3);
        assert_eq!(before.folders.len(), 2);
        drop(index);

        let index_path = f.lib.index_path();
        std::fs::remove_file(&index_path).expect("删除索引文件");
        assert!(!index_path.exists());

        let rebuilt = Index::open(&f.lib).expect("重建索引");
        let after = rebuilt.snapshot().expect("取重建后的快照");
        assert_eq!(before, after, "重建后的索引与重建前不一致");
    }

    #[test]
    fn the_rebuilt_index_keeps_tags_folders_and_colour_cards() {
        // 上一条断言两侧相等，但若两侧都丢了同样的东西也会相等。这条断言内容真的在。
        let f = fixture();
        let (index, _) = seed(&f);
        drop(index);
        std::fs::remove_file(f.lib.index_path()).expect("删除索引文件");
        let rebuilt = Index::open(&f.lib).expect("重建索引");
        let snap = rebuilt.snapshot().expect("取快照");

        for a in &snap.assets {
            assert_eq!(a.tags, vec!["参考".to_owned(), "黄".to_owned()], "标签丢失");
            assert_eq!(a.folders, vec!["参考/构图".to_owned()], "素材文件夹丢失");
            assert_eq!(a.color_card_status, "ok", "色卡状态不对：{a:?}");
            assert!(!a.colors.is_empty(), "色卡颜色丢失：{a:?}");
            for c in &a.colors {
                assert!(c.hex.starts_with('#'), "色值格式不对：{}", c.hex);
                assert!(c.share > 0.0, "占比应为正：{}", c.share);
                assert!(!c.role.is_empty(), "角色缺失");
            }
        }
        let multi = snap
            .assets
            .iter()
            .find(|a| a.original_filename == "三色.png")
            .expect("应能找到三色素材");
        assert!(
            multi.colors.len() >= 2,
            "三色素材应有多条颜色：{:?}",
            multi.colors
        );
        // ordinal 顺序即占比降序，重建后必须保持。
        for pair in multi.colors.windows(2) {
            assert!(
                pair[0].share >= pair[1].share,
                "颜色未按占比降序：{:?}",
                multi.colors
            );
        }
    }

    #[test]
    fn an_empty_folder_survives_a_rebuild() {
        // 规格明确要求：文件夹树独立持久化，不得仅从素材元数据派生，
        // 否则不含任何素材的文件夹会在索引重建后消失。
        let f = fixture();
        let (index, _) = seed(&f);
        drop(index);
        std::fs::remove_file(f.lib.index_path()).expect("删除索引文件");
        let rebuilt = Index::open(&f.lib).expect("重建索引");
        let snap = rebuilt.snapshot().expect("取快照");
        assert!(
            snap.folders.contains(&"空文件夹".to_owned()),
            "不含素材的文件夹在重建后消失了：{:?}",
            snap.folders
        );
    }

    #[test]
    fn a_version_mismatch_discards_the_index_and_rebuilds() {
        let f = fixture();
        let (index, _) = seed(&f);
        drop(index);

        // 篡改版本号，同时清空素材表。若打开时只是改回版本号而不重扫，
        // 素材数就会是 0——这使"真的重建了"可被断言。
        let path = f.lib.index_path();
        {
            let conn = Connection::open(&path).expect("直连索引");
            conn.execute("DELETE FROM assets", []).expect("清空素材表");
            conn.pragma_update(None, "user_version", INDEX_USER_VERSION + 7)
                .expect("篡改版本号");
        }

        let reopened = Index::open(&f.lib).expect("打开索引");
        assert_eq!(
            reopened.asset_count().expect("统计素材"),
            3,
            "版本不匹配时应全量重扫重建"
        );
        let version: i32 = reopened
            .conn
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .expect("读取版本号");
        assert_eq!(version, INDEX_USER_VERSION);
    }

    #[test]
    fn a_trashed_asset_stays_in_the_index_after_a_rebuild() {
        // 回收站里的素材其侧车同样是权威元数据。只扫 objects 会让它们在重建后消失，
        // 而使用者会看到回收站突然空了。
        let f = fixture();
        let (index, imported) = seed(&f);
        drop(index);

        let victim = &imported[0];
        let hash = &victim.hash;
        let mut moved = victim.clone();
        moved.deleted_at = Some(chrono::Utc::now());
        moved.deleted_from_folders = Some(victim.folders.clone());

        let trash_body = f.lib.trash_body_path(hash, &victim.ext);
        std::fs::create_dir_all(trash_body.parent().expect("回收站叶目录"))
            .expect("建立回收站叶目录");
        std::fs::rename(f.lib.body_path(hash, &victim.ext), &trash_body).expect("移动本体");
        std::fs::remove_file(f.lib.sidecar_path(hash)).expect("删除原侧车");
        moved
            .write_atomic(&f.lib.trash_sidecar_path(hash))
            .expect("写入回收站侧车");

        std::fs::remove_file(f.lib.index_path()).expect("删除索引文件");
        let rebuilt = Index::open(&f.lib).expect("重建索引");
        let snap = rebuilt.snapshot().expect("取快照");
        assert_eq!(snap.assets.len(), 3, "回收站中的素材应仍在索引中");
        let row = snap
            .assets
            .iter()
            .find(|a| a.hash == hash.as_str())
            .expect("应能找到被移入回收站的素材");
        assert!(row.deleted_at.is_some(), "回收站素材应带 deleted_at");
    }

    #[test]
    fn a_corrupt_sidecar_fails_the_rebuild_instead_of_being_skipped() {
        // 跳过会静默丢掉一个素材，使用者只会看到"素材少了一个"，无从归因。
        let f = fixture();
        let (index, _) = seed(&f);
        drop(index);

        let bogus = ContentHash::of_bytes("损坏的侧车".as_bytes());
        let path = f.lib.sidecar_path(&bogus);
        std::fs::create_dir_all(path.parent().expect("叶目录")).expect("建立叶目录");
        std::fs::write(&path, "{ 这不是合法 JSON".as_bytes()).expect("写入损坏侧车");

        std::fs::remove_file(f.lib.index_path()).expect("删除索引文件");
        let err = Index::open(&f.lib).expect_err("重建本应因侧车损坏而失败");
        assert_eq!(err.code, Code::LibraryMetadataCorrupt);
    }

    #[test]
    fn a_leftover_temp_file_is_not_mistaken_for_a_sidecar() {
        // 侧车用先写临时文件再改名的方式落盘。进程在中途终止会留下 .json.tmp，
        // 它不是侧车，扫进来会被当成损坏素材而使整个库打不开。
        let f = fixture();
        let (index, imported) = seed(&f);
        drop(index);

        let leaf = f
            .lib
            .sidecar_path(&imported[0].hash)
            .parent()
            .expect("叶目录")
            .to_path_buf();
        std::fs::write(leaf.join("半个侧车.json.tmp"), "{ 未写完".as_bytes())
            .expect("写入临时文件");

        std::fs::remove_file(f.lib.index_path()).expect("删除索引文件");
        let rebuilt = Index::open(&f.lib).expect("重建不应被临时文件破坏");
        assert_eq!(rebuilt.asset_count().expect("统计素材"), 3);
    }

    #[test]
    fn asset_ext_answers_from_the_index_and_refuses_unknown_hashes() {
        let f = fixture();
        let (index, imported) = seed(&f);
        let one = &imported[0];
        assert_eq!(
            index.asset_ext(one.hash.as_str()).expect("查询扩展名"),
            one.ext
        );
        let err = index
            .asset_ext("0".repeat(64).as_str())
            .expect_err("未知摘要本应报错");
        assert_eq!(err.code, Code::LibraryNotFound);
    }

    #[test]
    fn listing_assets_excludes_the_trash_by_default() {
        let f = fixture();
        let (mut index, imported) = seed(&f);
        assert_eq!(index.list_assets(false).expect("列出素材").len(), 3);

        let mut trashed = imported[0].clone();
        trashed.deleted_at = Some(chrono::Utc::now());
        index.upsert_asset(&trashed).expect("写入回收站素材");

        assert_eq!(
            index.list_assets(false).expect("列出素材").len(),
            2,
            "回收站素材不应出现在默认列表中"
        );
        assert_eq!(
            index.list_assets(true).expect("列出全部素材").len(),
            3,
            "显式要求时应包含回收站素材"
        );
    }

    #[test]
    fn opening_a_fresh_library_yields_an_empty_index() {
        let f = fixture();
        let index = Index::open(&f.lib).expect("打开索引");
        assert_eq!(index.asset_count().expect("统计素材"), 0);
        let snap = index.snapshot().expect("取快照");
        assert!(snap.assets.is_empty());
        assert!(snap.folders.is_empty());
        assert!(snap.prompts.is_empty(), "新库不应有任何提示词行");
        assert!(snap.prompt_folders.is_empty(), "新库不应有任何提示词文件夹");
        assert!(f.lib.index_path().is_file(), "索引文件应被建立");
    }

    #[test]
    fn upserting_the_same_asset_twice_does_not_duplicate_rows() {
        // 重算色卡或改标签都会重写同一个素材。若 upsert 不是覆盖语义，
        // 标签与颜色会一轮一轮地累积。
        let f = fixture();
        let (mut index, imported) = seed(&f);
        let before = index.snapshot().expect("取快照");
        for s in &imported {
            index.upsert_asset(s).expect("重复写入素材");
        }
        let after = index.snapshot().expect("取快照");
        assert_eq!(before, after, "重复写入改变了索引内容");
    }

    #[test]
    fn rebuilding_from_disk_reproduces_the_incrementally_built_v2_index() {
        // v2 版的核心承诺：图片 note/favorite、提示词全字段、两份文件夹清单，
        // 全部能仅依据库目录内的元数据文件重建。比较的两侧刻意不同源：
        // 一侧是导入/编辑时逐个 upsert 攒出来的，另一侧是删掉索引后从磁盘重扫的。
        let f = fixture();
        let (index, _, _prompts) = seed_v2(&f);
        let before = index.snapshot().expect("取快照");
        assert_eq!(before.assets.len(), 3);
        assert_eq!(before.prompts.len(), 3, "三条提示词都应被索引");
        assert_eq!(before.prompt_folders.len(), 3, "提示词文件夹清单应完整入索引");
        drop(index);

        std::fs::remove_file(f.lib.index_path()).expect("删除索引文件");
        let rebuilt = Index::open(&f.lib).expect("重建索引");
        let after = rebuilt.snapshot().expect("取重建后的快照");
        assert_eq!(before, after, "重建后的索引与重建前不一致");
    }

    #[test]
    fn the_rebuilt_index_keeps_notes_favorites_and_full_prompt_fields() {
        // 等价断言两侧相等，但若两侧丢掉同样的东西也会相等。这条断言内容真的在：
        // 备注逐字保留、收藏布尔保真、提示词可选字段与关联顺序在重建后可查。
        let f = fixture();
        let (index, imported, prompts) = seed_v2(&f);
        drop(index);
        std::fs::remove_file(f.lib.index_path()).expect("删除索引文件");
        let rebuilt = Index::open(&f.lib).expect("重建索引");
        let snap = rebuilt.snapshot().expect("取快照");

        let noted = snap
            .assets
            .iter()
            .find(|a| a.original_filename == "红蓝.png")
            .expect("应能找到带备注的图片");
        assert_eq!(
            noted.note, "第一行\n\n第三行  末尾两个空格  ",
            "图片备注未逐字保留"
        );
        assert!(noted.favorite, "图片收藏状态丢失");
        let plain = snap
            .assets
            .iter()
            .find(|a| a.original_filename == "纯青.png")
            .expect("应能找到无备注图片");
        assert_eq!(plain.note, "", "无备注图片的备注应为空字符串");
        assert!(!plain.favorite, "未收藏图片的收藏应为假");

        let full = &prompts[0];
        let full_row = snap
            .prompts
            .iter()
            .find(|p| p.id == full.id.as_str())
            .expect("完整提示词应在索引中");
        assert_eq!(full_row.body, full.body, "正文丢失");
        assert_eq!(full_row.title.as_deref(), Some("逆光人像"), "标题丢失");
        assert_eq!(full_row.model.as_deref(), Some("某生图模型 v3"), "模型丢失");
        assert_eq!(
            full_row.parameters.as_deref(),
            Some("steps=30, cfg=6"),
            "参数说明丢失"
        );
        assert_eq!(full_row.note, "提示词备注", "提示词备注丢失");
        assert!(full_row.favorite, "提示词收藏丢失");
        assert_eq!(full_row.folders, vec!["人物/室内".to_owned()], "文件夹丢失");
        assert_eq!(
            full_row.tags,
            vec!["人物".to_owned(), "逆光".to_owned()],
            "标签丢失"
        );
        // 关联顺序是权威数据：ordinal 必须原样保留，默认封面据此取第一张。
        assert_eq!(
            full_row.linked_image_hashes,
            vec![
                imported[2].hash.as_str().to_owned(),
                imported[0].hash.as_str().to_owned(),
            ],
            "关联图片顺序未保留"
        );
        assert_eq!(
            full_row.cover_image_hash.as_deref(),
            Some(imported[0].hash.as_str()),
            "显式封面丢失"
        );

        let minimal_row = snap
            .prompts
            .iter()
            .find(|p| p.id == prompts[1].id.as_str())
            .expect("最小提示词应在索引中");
        assert_eq!(minimal_row.title, None, "缺省标题不得被猜出值");
        assert!(minimal_row.linked_image_hashes.is_empty());
        assert_eq!(minimal_row.cover_image_hash, None);
        assert!(!minimal_row.favorite);

        let trashed_row = snap
            .prompts
            .iter()
            .find(|p| p.id == prompts[2].id.as_str())
            .expect("回收站提示词应在索引中");
        assert!(trashed_row.deleted_at.is_some(), "回收站提示词应带删除时刻");
        // 关联规格：一方进入回收站时关联保留，反查数据不得因删除而消失。
        assert_eq!(
            trashed_row.linked_image_hashes,
            vec![imported[1].hash.as_str().to_owned()],
            "回收站提示词的关联丢失"
        );
    }

    #[test]
    fn an_empty_prompt_folder_survives_a_rebuild() {
        // 提示词文件夹清单独立持久化（设计第二条），不从提示词元数据派生，
        // 否则不含任何提示词的文件夹会在重建后消失。
        let f = fixture();
        let (index, _, _) = seed_v2(&f);
        drop(index);
        std::fs::remove_file(f.lib.index_path()).expect("删除索引文件");
        let rebuilt = Index::open(&f.lib).expect("重建索引");
        let snap = rebuilt.snapshot().expect("取快照");
        assert!(
            snap.prompt_folders.contains(&"空提示词文件夹".to_owned()),
            "不含提示词的文件夹在重建后消失了：{:?}",
            snap.prompt_folders
        );
        assert!(
            snap.folders.contains(&"空文件夹".to_owned()),
            "图片侧空文件夹被提示词清单覆盖了：{:?}",
            snap.folders
        );
    }

    #[test]
    fn the_same_folder_path_stays_separate_between_the_two_folder_trees() {
        // 规格场景"两库存在同名文件夹"：同一路径字面值在两棵树各自存在，
        // 成员关系各归各——图片行的来自图片侧车，提示词行的来自提示词文件。
        let f = fixture();
        let (index, _, prompts) = seed_v2(&f);
        let snap = index.snapshot().expect("取快照");

        assert!(
            snap.folders.contains(&"人物/室内".to_owned()),
            "图片文件夹清单缺少同名路径：{:?}",
            snap.folders
        );
        assert!(
            snap.prompt_folders.contains(&"人物/室内".to_owned()),
            "提示词文件夹清单缺少同名路径：{:?}",
            snap.prompt_folders
        );
        let noted = snap
            .assets
            .iter()
            .find(|a| a.original_filename == "红蓝.png")
            .expect("应能找到图片行");
        assert_eq!(
            noted.folders,
            vec!["参考/构图".to_owned()],
            "图片获得了提示词文件夹的成员关系"
        );
        let full_row = snap
            .prompts
            .iter()
            .find(|p| p.id == prompts[0].id.as_str())
            .expect("应能找到提示词行");
        assert_eq!(
            full_row.folders,
            vec!["人物/室内".to_owned()],
            "提示词获得了图片文件夹的成员关系"
        );
    }

    #[test]
    fn prompt_tag_counts_exclude_trash_and_stay_separate_from_image_counts() {
        // 共享词表、分库计数（规格）：同一字面值 `人物` 在两侧各计 1——
        // 若计数被合并，任何一侧都会数出 2；回收站提示词的标签不计入提示词侧。
        let f = fixture();
        let (index, _, _) = seed_v2(&f);
        assert_eq!(
            index.active_prompt_tag_counts().expect("提示词标签计数"),
            vec![("人物".to_owned(), 1), ("逆光".to_owned(), 1)],
            "提示词侧计数错误：回收站提示词不应计入，图片侧不应混入"
        );
        assert_eq!(
            index.active_tag_counts().expect("图片标签计数"),
            vec![
                // ORDER BY tag 按码点排序：人 < 参 < 黄。`黄` 只剩两张——
                // 带备注素材的标签被 seed_v2 重写为 `参考`+`人物`。
                ("人物".to_owned(), 1),
                ("参考".to_owned(), 3),
                ("黄".to_owned(), 2),
            ],
            "图片侧计数错误：提示词的标签使用不应混入"
        );
    }

    #[test]
    fn upserting_the_same_prompt_twice_does_not_duplicate_rows() {
        // 编辑就是覆盖（设计第二条）。若提示词 upsert 不是覆盖语义，
        // 标签、文件夹与关联会一轮一轮地累积。
        let f = fixture();
        let (mut index, _, prompts) = seed_v2(&f);
        let before = index.snapshot().expect("取快照");
        index.upsert_prompts(&prompts).expect("重复写入提示词");
        let after = index.snapshot().expect("取快照");
        assert_eq!(before, after, "重复写入改变了索引内容");
    }

    #[test]
    fn a_corrupt_prompt_file_fails_the_rebuild_instead_of_being_skipped() {
        // 与损坏侧车同一原则：跳过会静默丢掉一条提示词，使用者只会看到
        // "素材少了一条"，无从归因。
        let f = fixture();
        let (index, _, _) = seed_v2(&f);
        drop(index);

        let bogus = f.lib.prompt_objects_dir().join("不是提示词.json");
        std::fs::write(&bogus, "{ 这不是合法 JSON".as_bytes()).expect("写入损坏提示词");

        std::fs::remove_file(f.lib.index_path()).expect("删除索引文件");
        let err = Index::open(&f.lib).expect_err("重建本应因提示词损坏而失败");
        assert_eq!(err.code, Code::PromptMetadataCorrupt);
    }
}
