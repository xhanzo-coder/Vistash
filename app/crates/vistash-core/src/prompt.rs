//! 提示词素材：库内可独立组织的文本素材及其权威文件。
//!
//! 提示词与图片是两类一等素材（设计第一条），因此它有自己的权威文件、自己的文件夹
//! 清单和自己的格式版本，而不是挂在图片侧车上的一个字段——挂成字段的提示词无法拥有
//! 独立的收藏、组织与检索语义。
//!
//! 正文只保存一份"当前值"（设计第二条）：第一版不保留版本历史，因此本模块不存在任何
//! 形如 `versions` 的集合，编辑就是覆盖。普通关联的唯一权威方也在这里（设计第三条）：
//! `linked_image_hashes` 有序保存关联图片，图片侧车不写反向列表，使一次关联只改一份
//! 权威文件。

use crate::error::{AppError, Code, Result};
use crate::hashing::ContentHash;
use crate::ids::{generate_canonical_uuid_v7, parse_canonical_uuid};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// 提示词权威文件与提示词文件夹清单的格式版本。
///
/// 两者共用一个版本号：它们都随库格式 v2 一次性引入，任何一方的结构演进都会改变
/// "读一个 v2 库"的含义，拆成两个版本号只会让兼容矩阵多一维而不多一分信息。
pub const PROMPT_FORMAT_VERSION: u32 = 1;

/// 稳定的提示词标识：时间可排序的 UUIDv7 字面值。
///
/// 用独立类型而不是裸 `String`，理由与 [`ContentHash`] 相同：未校验的字符串不能直接
/// 参与库内路径拼接，否则库目录结构就对调用方输入开放了。
///
/// ID 在编辑时不变（设计第二条），因此它绝不能由正文内容派生——内容派生的 ID 会让
/// 一次改写变成一次身份更替，连带丢掉该素材的收藏、文件夹与全部普通关联。
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PromptId(String);

impl PromptId {
    /// 校验并接管一个 UUIDv7 字面值。
    pub fn parse(s: &str) -> Result<Self> {
        let parsed = parse_canonical_uuid(s, Code::PromptIdInvalid)?;
        if parsed.get_version_num() != 7 {
            // 版本位必须校验而不是只看格式像不像 UUID：v4 会让"按 ID 排序等于按创建
            // 时间排序"这条前提失效，而提示词列表的默认排序正建立在它上面。
            return Err(AppError::detailed(
                Code::PromptIdInvalid,
                format!(
                    "提示词标识必须是 UUIDv7，实际是 v{}：{s}",
                    parsed.get_version_num()
                ),
            ));
        }
        Ok(Self(s.to_owned()))
    }

    /// 生成一个新的提示词标识。
    ///
    /// 刻意不叫 `new`：`new` 会让人以为它是纯构造器，而这里每次调用都产生不同的值。
    pub fn generate() -> Self {
        Self(generate_canonical_uuid_v7())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for PromptId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl Serialize for PromptId {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for PromptId {
    /// 反序列化经过 [`PromptId::parse`]，使"文件里的非法 ID"与"调用方传入的非法 ID"
    /// 走同一条拒绝路径，而不是只在其中一处把关。
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        Self::parse(&s).map_err(|e| serde::de::Error::custom(e.to_string()))
    }
}

/// 一条提示词素材的全部权威元数据。
///
/// 与图片侧车不同，提示词没有"本体文件"：正文就是本体，因此这个 JSON 是该素材唯一的
/// 权威文件，SQLite 中的提示词行全部是它的派生物。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PromptAsset {
    pub format_version: u32,
    pub id: PromptId,
    /// 当前正文。去除首尾空白后必须非空，且是这条素材唯一的正文——不存在第二份主
    /// 提示词、负向提示词或隐藏版本。
    pub body: String,
    /// 可选标题。缺省时由查询层用正文首行作为可识别标题，因此这里不写入派生出的标题：
    /// 写入派生值会让"用户是否真的填过标题"变得无法区分。
    pub title: Option<String>,
    /// 可选的模型或平台说明。它是使用者自己填写的文本，不是受控词表。
    pub model: Option<String>,
    /// 可选的参数说明，同样是自由文本。
    pub parameters: Option<String>,
    /// 多行纯文本备注。不解析 Markdown 或富文本，因此换行必须逐字保留。
    ///
    /// 用 `String` 而不是 `Option<String>`：备注的"没有内容"与"空字符串"对使用者
    /// 没有区别，两种表示同时存在只会让写入端需要决定该用哪一种。
    pub note: String,
    pub favorite: bool,
    /// 所属提示词文件夹。与图片文件夹是两棵彼此独立的树，同路径字面值可以各自存在。
    pub folders: Vec<String>,
    /// 共享标签。词表与图片共用，但计数与筛选在提示词库内单独计算。
    pub tags: Vec<String>,
    /// 有序的普通关联图片。顺序是使用者可见的：默认封面取第一张正常关联图片，
    /// 因此顺序属于权威数据而不是展示细节。
    pub linked_image_hashes: Vec<ContentHash>,
    /// 显式指定的封面。必须是 `linked_image_hashes` 中的一项；缺省表示"用默认封面"。
    pub cover_image_hash: Option<ContentHash>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// 进入提示词回收站的时刻。`None` 表示素材在正常库中。
    pub deleted_at: Option<DateTime<Utc>>,
    /// 删除前所属的提示词文件夹。还原时据此回到原位置而不是一律落到根位置。
    pub deleted_from_folders: Option<Vec<String>>,
}

impl PromptAsset {
    /// 是否处于提示词回收站中。与图片侧车一致，以 `deleted_at` 为准而不是以所在目录
    /// 为准，使单个文件脱离上下文后仍能自证状态。
    pub fn is_deleted(&self) -> bool {
        self.deleted_at.is_some()
    }

    /// 校验格式级不变量。
    ///
    /// 读与写共用同一份校验，是因为库文件可以被外部程序改写：只在写入端把关，一份被
    /// 手工改坏的文件就会以"正常素材"的身份进入索引与界面。
    pub fn validate(&self) -> Result<()> {
        if self.body.trim().is_empty() {
            return Err(AppError::detailed(
                Code::PromptBodyEmpty,
                "提示词正文去除首尾空白后为空",
            ));
        }
        // 关联按集合语义存放：重复值会让"+N 张"计数和一次解除关联的结果都变得不确定。
        let mut seen = std::collections::BTreeSet::new();
        for hash in &self.linked_image_hashes {
            if !seen.insert(hash) {
                return Err(AppError::detailed(
                    Code::PromptLinkedImageDuplicated,
                    format!("同一张图片重复关联：{hash}"),
                ));
            }
        }
        if let Some(cover) = &self.cover_image_hash {
            if !self.linked_image_hashes.contains(cover) {
                return Err(AppError::detailed(
                    Code::PromptCoverNotLinked,
                    format!("封面不在关联图片列表中：{cover}"),
                ));
            }
        }
        Ok(())
    }

    pub fn read(path: &Path) -> Result<Self> {
        let bytes = std::fs::read(path).map_err(|e| {
            AppError::detailed(
                Code::LibraryIoFailed,
                format!("读取提示词文件失败 {}: {e}", path.display()),
            )
        })?;
        let prompt: Self = serde_json::from_slice(&bytes).map_err(|e| {
            AppError::detailed(
                Code::PromptMetadataCorrupt,
                format!("提示词文件无法解析 {}: {e}", path.display()),
            )
        })?;
        if prompt.format_version > PROMPT_FORMAT_VERSION {
            return Err(AppError::detailed(
                Code::PromptFormatTooNew,
                format!(
                    "提示词格式版本 {} 高于程序支持的 {}：{}",
                    prompt.format_version,
                    PROMPT_FORMAT_VERSION,
                    path.display()
                ),
            ));
        }
        prompt.validate()?;
        Ok(prompt)
    }

    /// 写入提示词文件。先写临时文件再改名，理由与图片侧车相同：半个 JSON 比没有文件
    /// 更糟，索引重建会把它当成损坏的素材而不是不存在的素材。
    pub fn write_atomic(&self, path: &Path) -> Result<()> {
        // 校验先于任何文件系统写入：非法数据必须在权威文件被创建之前就被拒绝，
        // 否则一次失败的保存会留下一个半合法的素材文件。
        self.validate()?;
        write_json_atomic(path, self, Code::PromptWriteFailed)
    }
}

/// 提示词文件夹清单。
///
/// 与图片的 `folders.json` 是两份彼此独立的文件（设计第二条），因此这里刻意不复用
/// `FolderList`：同一个类型服务两棵树时，"这份清单属于哪一侧"就只能靠调用点的路径
/// 参数区分，而那正是把图片文件夹写进提示词清单的那类缺陷的入口。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PromptFolderList {
    pub format_version: u32,
    pub folders: Vec<String>,
}

impl Default for PromptFolderList {
    fn default() -> Self {
        Self {
            format_version: PROMPT_FORMAT_VERSION,
            folders: Vec::new(),
        }
    }
}

impl PromptFolderList {
    pub fn read(path: &Path) -> Result<Self> {
        let bytes = std::fs::read(path).map_err(|e| {
            AppError::detailed(
                Code::LibraryIoFailed,
                format!("读取提示词文件夹清单失败 {}: {e}", path.display()),
            )
        })?;
        let list: Self = serde_json::from_slice(&bytes).map_err(|e| {
            AppError::detailed(
                Code::PromptMetadataCorrupt,
                format!("提示词文件夹清单无法解析 {}: {e}", path.display()),
            )
        })?;
        if list.format_version > PROMPT_FORMAT_VERSION {
            return Err(AppError::detailed(
                Code::PromptFormatTooNew,
                format!(
                    "提示词文件夹清单格式版本 {} 高于程序支持的 {}：{}",
                    list.format_version,
                    PROMPT_FORMAT_VERSION,
                    path.display()
                ),
            ));
        }
        Ok(list)
    }

    pub fn write_atomic(&self, path: &Path) -> Result<()> {
        write_json_atomic(path, self, Code::PromptWriteFailed)
    }
}

/// 提示词侧的原子 JSON 写入。
///
/// 与 `library.rs` 中的同名辅助函数分开而不是提取到公共模块：两者的失败错误码不同，
/// 合并后调用方就必须把错误码当参数传进来，而那会让"提示词写失败报什么码"这件事
/// 分散到每个调用点。
fn write_json_atomic(path: &Path, value: &impl Serialize, code: Code) -> Result<()> {
    let io_err = |e: std::io::Error, what: &str| {
        AppError::detailed(code, format!("{what} {}: {e}", path.display()))
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| io_err(e, "建立提示词目录失败"))?;
    }
    let json = serde_json::to_vec_pretty(value)
        .map_err(|e| AppError::detailed(code, format!("序列化提示词数据失败: {e}")))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &json).map_err(|e| io_err(e, "写入临时提示词文件失败"))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        io_err(e, "提交提示词文件失败")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 固定的 UUIDv7 字面值。测试不生成 ID：生成值会让失败信息随机变化，
    /// 而这些测试要断言的是格式契约而不是生成器。
    const SAMPLE_ID: &str = "018f3c9e-6c00-7000-8000-00000000abcd";

    fn ts(secs: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(secs, 0).expect("固定时间戳")
    }

    fn img(n: &[u8]) -> ContentHash {
        ContentHash::of_bytes(n)
    }

    /// 每个可选字段都填满的样例。
    fn full() -> PromptAsset {
        PromptAsset {
            format_version: PROMPT_FORMAT_VERSION,
            id: PromptId::parse(SAMPLE_ID).expect("合法 ID"),
            body: "逆光人像，胶片颗粒，暖色高光".to_owned(),
            title: Some("逆光人像".to_owned()),
            model: Some("某生图模型 v3".to_owned()),
            parameters: Some("steps=30, cfg=6".to_owned()),
            note: "第一行备注\n第二行备注".to_owned(),
            favorite: true,
            folders: vec!["人物/室内".to_owned()],
            tags: vec!["逆光".to_owned(), "人物".to_owned()],
            linked_image_hashes: vec![img(b"a"), img(b"b"), img(b"c")],
            cover_image_hash: Some(img(b"b")),
            created_at: ts(0),
            updated_at: ts(60),
            deleted_at: None,
            deleted_from_folders: None,
        }
    }

    /// 只有必填字段的样例。规格允许标题、模型、参数与关联图片全部缺省。
    fn minimal() -> PromptAsset {
        PromptAsset {
            format_version: PROMPT_FORMAT_VERSION,
            id: PromptId::parse(SAMPLE_ID).expect("合法 ID"),
            body: "只有正文".to_owned(),
            title: None,
            model: None,
            parameters: None,
            note: String::new(),
            favorite: false,
            folders: vec![],
            tags: vec![],
            linked_image_hashes: vec![],
            cover_image_hash: None,
            created_at: ts(0),
            updated_at: ts(0),
            deleted_at: None,
            deleted_from_folders: None,
        }
    }

    fn tmp_file(name: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("建立临时目录");
        let p = dir.path().join(name);
        (dir, p)
    }

    #[test]
    fn round_trips_through_json_with_every_field_present() {
        let (_d, p) = tmp_file("prompt.json");
        let a = full();
        a.write_atomic(&p).expect("写入提示词");
        assert_eq!(PromptAsset::read(&p).expect("读回提示词"), a);
    }

    #[test]
    fn round_trips_with_every_optional_field_absent() {
        // 规格明确：标题、模型/平台、参数说明与关联图片都可以缺省，且缺省不等于失败。
        let (_d, p) = tmp_file("prompt.json");
        let a = minimal();
        a.write_atomic(&p).expect("写入提示词");
        let back = PromptAsset::read(&p).expect("读回提示词");
        assert_eq!(back, a);
        assert!(back.title.is_none());
        assert!(back.linked_image_hashes.is_empty());
        assert!(back.cover_image_hash.is_none());
    }

    #[test]
    fn a_note_keeps_its_line_breaks_verbatim() {
        // 备注是纯文本：换行必须逐字保留，不得在写入或读回时被规范化或解析成富文本。
        let (_d, p) = tmp_file("prompt.json");
        let mut a = minimal();
        a.note = "第一行\n\n第三行  末尾两个空格  ".to_owned();
        a.write_atomic(&p).expect("写入提示词");
        assert_eq!(PromptAsset::read(&p).expect("读回").note, a.note);
    }

    #[test]
    fn linked_image_order_is_preserved() {
        // 默认封面取第一张关联图片，因此顺序是权威数据而不是展示细节。
        let (_d, p) = tmp_file("prompt.json");
        let mut a = minimal();
        a.linked_image_hashes = vec![img(b"c"), img(b"a"), img(b"b")];
        a.write_atomic(&p).expect("写入提示词");
        assert_eq!(
            PromptAsset::read(&p).expect("读回").linked_image_hashes,
            vec![img(b"c"), img(b"a"), img(b"b")]
        );
    }

    #[test]
    fn deleted_state_is_derived_from_the_file_itself() {
        let mut a = minimal();
        assert!(!a.is_deleted());
        a.deleted_at = Some(ts(120));
        a.deleted_from_folders = Some(vec!["人物/室内".to_owned()]);
        assert!(a.is_deleted());
    }

    #[test]
    fn atomic_write_leaves_no_temp_file_behind() {
        let dir = tempfile::tempdir().expect("建立临时目录");
        let p = dir.path().join("prompt.json");
        full().write_atomic(&p).expect("写入提示词");
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .expect("读取目录")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "残留临时文件：{leftovers:?}");
    }

    #[test]
    fn overwriting_an_existing_prompt_file_succeeds() {
        // 编辑就是覆盖（设计第二条），因此覆盖写必须是常态路径而不是例外。
        let (_d, p) = tmp_file("prompt.json");
        let mut a = minimal();
        a.write_atomic(&p).expect("首次写入");
        a.body = "改过的正文".to_owned();
        a.updated_at = ts(600);
        a.write_atomic(&p).expect("覆盖写入");
        let back = PromptAsset::read(&p).expect("读回");
        assert_eq!(back.body, "改过的正文");
        assert_eq!(back.id, a.id, "覆盖写入不得改变提示词身份");
    }

    #[test]
    fn a_newer_prompt_format_version_is_refused() {
        let (_d, p) = tmp_file("prompt.json");
        let mut a = minimal();
        a.format_version = PROMPT_FORMAT_VERSION + 1;
        a.write_atomic(&p).expect("写入更高版本");
        let err = PromptAsset::read(&p).expect_err("本应拒绝更高的格式版本");
        assert_eq!(err.code, Code::PromptFormatTooNew);
    }

    #[test]
    fn unparseable_prompt_file_reports_corruption() {
        let (_d, p) = tmp_file("prompt.json");
        std::fs::write(&p, "{ 这不是合法 JSON".as_bytes()).expect("写入损坏内容");
        let err = PromptAsset::read(&p).expect_err("本应报告损坏");
        assert_eq!(err.code, Code::PromptMetadataCorrupt);
    }

    #[test]
    fn a_missing_required_field_is_refused_instead_of_defaulted() {
        // 设计第四条：不以 serde 默认值猜测缺失字段。少了 note 与 favorite 的文件
        // 是损坏的 v2 文件，而不是"备注为空、未收藏"的正常文件。
        let (_d, p) = tmp_file("prompt.json");
        let json = format!(
            r#"{{
  "format_version": {PROMPT_FORMAT_VERSION},
  "id": "{SAMPLE_ID}",
  "body": "只有正文",
  "title": null,
  "model": null,
  "parameters": null,
  "folders": [],
  "tags": [],
  "linked_image_hashes": [],
  "cover_image_hash": null,
  "created_at": "1970-01-01T00:00:00Z",
  "updated_at": "1970-01-01T00:00:00Z",
  "deleted_at": null,
  "deleted_from_folders": null
}}"#
        );
        std::fs::write(&p, json.as_bytes()).expect("写入缺字段的文件");
        let err = PromptAsset::read(&p).expect_err("本应拒绝缺少 note/favorite 的文件");
        assert_eq!(err.code, Code::PromptMetadataCorrupt);
    }

    #[test]
    fn an_unwritable_target_reports_prompt_write_failed() {
        // 写失败必须有明确错误码，不得静默成功或退化成通用 IO 失败。
        let dir = tempfile::tempdir().expect("建立临时目录");
        let blocker = dir.path().join("被占用");
        std::fs::write(&blocker, b"x").expect("写入占位文件");
        let p = blocker.join("prompt.json");
        let err = full()
            .write_atomic(&p)
            .expect_err("父路径是文件时本应写入失败");
        assert_eq!(err.code, Code::PromptWriteFailed);
    }

    #[test]
    fn a_body_that_is_blank_after_trimming_is_refused() {
        // 唯一非空正文是提示词素材的身份底线：没有正文的提示词在任何视图里都不可识别。
        let (_d, p) = tmp_file("prompt.json");
        let mut a = minimal();
        a.body = "   \n\t ".to_owned();
        let err = a.write_atomic(&p).expect_err("本应拒绝空白正文");
        assert_eq!(err.code, Code::PromptBodyEmpty);
        assert!(!p.exists(), "拒绝后不应留下任何权威文件");
    }

    #[test]
    fn a_blank_body_is_also_refused_when_reading() {
        // 写入端与读取端使用同一条不变量：手工改坏的文件不能被当成正常素材载入。
        let (_d, p) = tmp_file("prompt.json");
        let mut a = minimal();
        a.body = "有正文".to_owned();
        a.write_atomic(&p).expect("先写入合法文件");
        let raw = std::fs::read_to_string(&p).expect("读取原始 JSON");
        std::fs::write(&p, raw.replace("有正文", "   ")).expect("改坏正文");
        let err = PromptAsset::read(&p).expect_err("本应拒绝空白正文");
        assert_eq!(err.code, Code::PromptBodyEmpty);
    }

    #[test]
    fn an_invalid_prompt_id_is_refused() {
        // ID 决定权威文件名与全部关联的落点，非法 ID 必须在进入库之前被拒绝。
        for bad in ["", "   ", "not-a-uuid", "018f3c9e6c0070008000000000abcd"] {
            let err = PromptId::parse(bad).expect_err("本应拒绝非法 ID");
            assert_eq!(err.code, Code::PromptIdInvalid, "被接受的非法 ID：{bad:?}");
        }
        PromptId::parse(SAMPLE_ID).expect("合法 UUIDv7 应被接受");
    }

    #[test]
    fn a_uuid_that_is_not_version_7_is_refused() {
        // 提示词列表默认按时间排序，UUIDv4 会让"按 ID 排序等于按创建时间排序"这条
        // 前提失效，因此版本位必须校验而不是只看格式像不像 UUID。
        let v4 = "9f1b8c2e-4a7d-4b1e-8f3a-1c2d3e4f5a6b";
        let err = PromptId::parse(v4).expect_err("本应拒绝非 v7 的 UUID");
        assert_eq!(err.code, Code::PromptIdInvalid);
    }

    #[test]
    fn a_cover_outside_the_linked_images_is_refused() {
        // 封面是关联图片的引用而不是独立字段；指向未关联图片的封面在界面上无法解释。
        let (_d, p) = tmp_file("prompt.json");
        let mut a = full();
        a.cover_image_hash = Some(img("未关联的图片".as_bytes()));
        let err = a.write_atomic(&p).expect_err("本应拒绝不在关联列表中的封面");
        assert_eq!(err.code, Code::PromptCoverNotLinked);
    }

    #[test]
    fn duplicate_linked_images_are_refused() {
        // 关联是集合语义、重复建立必须幂等成功，因此权威文件里不能出现两条同一哈希：
        // 允许重复会让"+N 张"计数和解除关联的结果都变成不确定的。
        let (_d, p) = tmp_file("prompt.json");
        let mut a = minimal();
        a.linked_image_hashes = vec![img(b"a"), img(b"b"), img(b"a")];
        let err = a.write_atomic(&p).expect_err("本应拒绝重复关联");
        assert_eq!(err.code, Code::PromptLinkedImageDuplicated);
    }

    #[test]
    fn the_prompt_folder_list_starts_empty_and_round_trips() {
        let (_d, p) = tmp_file("prompt-folders.json");
        assert!(PromptFolderList::default().folders.is_empty());
        let list = PromptFolderList {
            format_version: PROMPT_FORMAT_VERSION,
            folders: vec!["人物/室内".to_owned(), "构图".to_owned()],
        };
        list.write_atomic(&p).expect("写入清单");
        assert_eq!(PromptFolderList::read(&p).expect("读回清单"), list);
    }

    #[test]
    fn a_newer_prompt_folder_list_version_is_refused() {
        let (_d, p) = tmp_file("prompt-folders.json");
        let list = PromptFolderList {
            format_version: PROMPT_FORMAT_VERSION + 1,
            folders: vec![],
        };
        list.write_atomic(&p).expect("写入更高版本清单");
        let err = PromptFolderList::read(&p).expect_err("本应拒绝更高的格式版本");
        assert_eq!(err.code, Code::PromptFormatTooNew);
    }

    #[test]
    fn an_unparseable_prompt_folder_list_reports_corruption() {
        let (_d, p) = tmp_file("prompt-folders.json");
        std::fs::write(&p, "[]".as_bytes()).expect("写入结构不符的 JSON");
        let err = PromptFolderList::read(&p).expect_err("本应报告损坏");
        assert_eq!(err.code, Code::PromptMetadataCorrupt);
    }
}
