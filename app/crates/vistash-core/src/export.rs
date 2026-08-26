//! 原图导出协调器（任务 5.5，设计第十二条）。
//!
//! 导出是纯出站操作：Rust 读权威索引定位库内本体，按"显示文件名主体 + 真实扩展名"
//! 复制原始字节到使用者明确选择的目标目录。全程只读库——本体与侧车一个字节都不改，
//! 这是规格的硬性要求，也是本模块所有测试的第一断言。
//!
//! 同名冲突的处理顺序是冻结的：先生成冲突计划（[`plan_export`]，不写任何目标），
//! 使用者明确选择跳过、覆盖或自动编号后才写入（[`export_assets`]）。覆盖是破坏性
//! 操作，core 层收到的 [`ConflictPolicy::Overwrite`] 即代表界面上的明确确认已经发生。
//!
//! 任务语义与导入完全共享（设计第十条）：同一把库级并发闸、同一个运行句柄的
//! 停止协议、同样的"协调器返回即确认退出"。停止只在单文件边界观察——每个文件
//! 要么完整出现在目标目录，要么完全不出现，绝不留下半成品。

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;

use crate::error::{AppError, Code, Result};
use crate::hashing::ContentHash;
use crate::import::{ImportObserver, ImportRun, ImportRuns};
use crate::library::Library;
use crate::sidecar::AssetSidecarV3;

/// 同名冲突的使用者决议。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConflictPolicy {
    /// 跳过已存在的同名目标，单独计数报告。
    Skip,
    /// 覆盖已存在的同名目标。破坏性：调用方必须先取得使用者的明确确认。
    Overwrite,
    /// 自动编号让开："名字 (2).png"、"名字 (3).png"，取首个空位。
    AutoNumber,
}

impl ConflictPolicy {
    /// 由前端传来的字符串构造。未知值返回 `None`，由命令层转成稳定错误。
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "skip" => Some(Self::Skip),
            "overwrite" => Some(Self::Overwrite),
            "auto_number" => Some(Self::AutoNumber),
            _ => None,
        }
    }
}

/// 一次导出的请求。
#[derive(Debug, Clone)]
pub struct ExportRequest {
    /// 使用者明确选择的既有目录。
    pub target_dir: PathBuf,
    /// 冲突决议。计划阶段发现的冲突以它落地。
    pub policy: ConflictPolicy,
}

/// 冲突计划的条目：对每个待导素材回答"会写到哪、是否撞车"。
///
/// 计划是纯粹的询问——生成它的过程不得改动目标目录里的任何文件，
/// 这样使用者看到的冲突状态才与他确认时的状态一致。
#[derive(Debug, Clone, Serialize)]
pub struct PlannedExport {
    pub hash: ContentHash,
    /// 完整导出名：显示文件名主体加真实扩展名。
    pub display_filename: String,
    /// 目标目录已有同名文件，或同批更早的素材已经占用了这个名字。
    pub existing: bool,
}

/// 一项导出的失败。逐项隔离（asset-transfer 规格）：批量中的一项失败
/// 不阻止其余项继续，也不把整体变成 `Err`。
#[derive(Debug, Clone, Serialize)]
pub struct ExportFailure {
    /// 调用方交来的哈希——失败项的唯一可靠定位符。
    pub hash: ContentHash,
    /// 能从侧车读出的显示名；侧车本身缺失时为 `None`。
    pub display_filename: Option<String>,
    pub error: AppError,
}

/// 一次导出的结果。部分成功是常态，因此这不是 `Result`。
///
/// 四个桶互相独立、数量齐全（与导入的停止规格同构）：成功看
/// [`Self::exported`]，冲突跳过看 [`Self::skipped_existing`]，失败看
/// [`Self::failed`]，停止后尚未处理看 [`Self::pending_count`]。
#[derive(Debug, Clone, Serialize)]
pub struct ExportReport {
    /// 成功写出的文件名（相对目标目录）。
    pub exported: Vec<String>,
    /// 因跳过策略而未写入的同名冲突数。
    pub skipped_existing: usize,
    pub failed: Vec<ExportFailure>,
    /// 观察到停止后尚未处理的项数。它们不算失败。
    pub pending_count: usize,
}

/// 校验导出目标是既有的目录。导出不代建目录树。
fn ensure_target_dir(target: &Path) -> Result<()> {
    if !target.is_dir() {
        return Err(AppError::detailed(
            Code::ExportTargetInvalid,
            format!("导出目标不是可用目录：{}", target.display()),
        ));
    }
    Ok(())
}

/// 从权威侧车读取素材身份：完整导出名与本体路径。
///
/// 回收站中的素材在正式区没有侧车，同样落到这里报 `export.asset_missing`——
/// 回收站素材不可导出是保守且正确的：它们正等待使用者决定去留。
pub(crate) fn resolve_asset(
    lib: &Library,
    hash: &ContentHash,
) -> Result<(AssetSidecarV3, PathBuf)> {
    let sidecar_path = lib.sidecar_path(hash);
    let sidecar = AssetSidecarV3::read(&sidecar_path).map_err(|e| {
        AppError::detailed(
            Code::ExportAssetMissing,
            format!("{}：{e}", sidecar_path.display()),
        )
    })?;
    let body = lib.body_path(hash, &sidecar.ext);
    if !body.is_file() {
        return Err(AppError::detailed(
            Code::ExportAssetMissing,
            format!("库内本体缺失：{}", body.display()),
        ));
    }
    Ok((sidecar, body))
}

/// 完整导出名。侧车的 `display_filename` 本身就是含真实扩展名的完整文件名
/// （任务 2.2 的领域不变量），直接使用即可，不得再拼一次扩展名。
pub(crate) fn composed_name(sidecar: &AssetSidecarV3) -> String {
    sidecar.display_filename.as_str().to_owned()
}

/// 生成冲突计划：每个素材会以什么名字落盘、目标处是否已有占用。
///
/// 只读操作。除校验目标目录外不改任何文件系统状态。
pub fn plan_export(
    lib: &Library,
    hashes: &[ContentHash],
    target_dir: &Path,
) -> Result<Vec<PlannedExport>> {
    ensure_target_dir(target_dir)?;
    let mut planned = Vec::with_capacity(hashes.len());
    // 同批占位：两个素材显示名相同时，后者必须被预告为冲突，
    // 否则使用者批准的计划与执行结果会分叉。
    let mut claimed: HashSet<String> = HashSet::new();
    for hash in hashes {
        let (sidecar, _) = resolve_asset(lib, hash)?;
        let name = composed_name(&sidecar);
        let existing = claimed.contains(&name) || target_dir.join(&name).exists();
        claimed.insert(name.clone());
        planned.push(PlannedExport {
            hash: hash.clone(),
            display_filename: name,
            existing,
        });
    }
    Ok(planned)
}

/// 执行一次导出。`run` 是生产通路的停止信号——只在单文件边界观察；
/// 已完成项保留在目标目录，未处理项计入 [`ExportReport::pending_count`]。
///
/// 无论正常结束还是整体出错（例如目标目录非法），协调器返回即后端确认：
/// 槽位必须释放，状态不得永远悬在 running/stopping。
pub fn export_assets(
    lib: &Library,
    hashes: &[ContentHash],
    request: &ExportRequest,
    run: &ImportRun,
    observer: &mut dyn ImportObserver,
) -> Result<ExportReport> {
    let result = export_assets_inner(lib, hashes, request, run, observer);
    run.confirm_stopped();
    result
}

fn export_assets_inner(
    lib: &Library,
    hashes: &[ContentHash],
    request: &ExportRequest,
    run: &ImportRun,
    observer: &mut dyn ImportObserver,
) -> Result<ExportReport> {
    ensure_target_dir(&request.target_dir)?;
    let target = &request.target_dir;
    let total = hashes.len();
    let mut report = ExportReport {
        exported: Vec::new(),
        skipped_existing: 0,
        failed: Vec::new(),
        pending_count: 0,
    };
    // 本批已占用的名字。自动编号要避开它们，跳过要把批内撞名算进去。
    let mut claimed: HashSet<String> = HashSet::new();
    let mut stopping = false;

    for (i, hash) in hashes.iter().enumerate() {
        if stopping || run.should_cancel() || observer.should_cancel() {
            stopping = true;
            report.pending_count += 1;
            continue;
        }

        // 先解析身份再报进度：孤儿哈希连可读的名字都没有。
        let (sidecar, body) = match resolve_asset(lib, hash) {
            Ok(found) => found,
            Err(error) => {
                report.failed.push(ExportFailure {
                    hash: hash.clone(),
                    display_filename: None,
                    error,
                });
                continue;
            }
        };
        let name = composed_name(&sidecar);
        observer.on_progress(i, total, &name);

        let final_name = match decide_target(&name, request.policy, target, &mut claimed) {
            TargetDecision::SkipConflict => {
                report.skipped_existing += 1;
                continue;
            }
            TargetDecision::Write(name) => name,
        };

        // 原子落盘：先写临时文件再改名提交。任何一步失败都清掉临时文件，
        // 目标目录里不会残留 .part 半成品。
        let tmp = target.join(format!("{final_name}.part"));
        let copied = std::fs::copy(&body, &tmp).map_err(|e| {
            AppError::detailed(
                Code::ExportWriteFailed,
                format!("复制到 {} 失败：{e}", tmp.display()),
            )
        });
        if let Err(e) = copied {
            let _ = std::fs::remove_file(&tmp);
            report.failed.push(ExportFailure {
                hash: hash.clone(),
                display_filename: Some(name),
                error: e,
            });
            continue;
        }
        if let Err(e) = std::fs::rename(&tmp, target.join(&final_name)) {
            let _ = std::fs::remove_file(&tmp);
            report.failed.push(ExportFailure {
                hash: hash.clone(),
                display_filename: Some(name),
                error: AppError::detailed(
                    Code::ExportWriteFailed,
                    format!("提交 {} 失败：{e}", final_name),
                ),
            });
            continue;
        }
        report.exported.push(final_name);
    }
    observer.on_progress(total, total, "");
    Ok(report)
}

enum TargetDecision {
    SkipConflict,
    Write(String),
}

/// 按策略为当前项决定最终落盘名字。`claimed` 会随决策更新：
/// 批内撞名与磁盘撞名在本批内同等对待。
fn decide_target(
    name: &str,
    policy: ConflictPolicy,
    target: &Path,
    claimed: &mut HashSet<String>,
) -> TargetDecision {
    let taken_on_disk = |candidate: &str| target.join(candidate).is_file();
    match policy {
        ConflictPolicy::Overwrite => {
            // 覆盖不需要探测：直接写。批内占位仍要登记，
            // 否则后续同名的编号判断会被这次覆盖骗过去。
            claimed.insert(name.to_owned());
            TargetDecision::Write(name.to_owned())
        }
        ConflictPolicy::Skip => {
            if claimed.contains(name) || taken_on_disk(name) {
                claimed.insert(name.to_owned());
                return TargetDecision::SkipConflict;
            }
            claimed.insert(name.to_owned());
            TargetDecision::Write(name.to_owned())
        }
        ConflictPolicy::AutoNumber => {
            if !claimed.contains(name) && !taken_on_disk(name) {
                claimed.insert(name.to_owned());
                return TargetDecision::Write(name.to_owned());
            }
            // 名字被占用：向后找第一个空位。"风景.png" → "风景 (2).png"。
            let path = Path::new(name);
            let stem = path
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| name.to_owned());
            let ext = path
                .extension()
                .map(|e| e.to_string_lossy().into_owned())
                .map(|e| format!(".{e}"))
                .unwrap_or_default();
            let mut number = 2u32;
            loop {
                let candidate = format!("{stem} ({number}){ext}");
                if !claimed.contains(&candidate) && !taken_on_disk(&candidate) {
                    claimed.insert(candidate.clone());
                    return TargetDecision::Write(candidate);
                }
                number = number.wrapping_add(1);
                if number == 0 {
                    // u32 用尽仍无空位：这不是现实场景，但必须有确定行为——
                    // 按跳过处理并保留已有文件。
                    return TargetDecision::SkipConflict;
                }
            }
        }
    }
}

impl ImportRuns {
    /// 占用该库的导出槽位。
    ///
    /// 与导入共用同一把库级闸（设计第十条）：导入与导出都依赖"运行期间库内
    /// 对象集合稳定"，互斥是最便宜的保证。
    pub fn begin_export(&self, library: &Library) -> Result<Arc<ImportRun>> {
        self.begin(library)
    }
}

/// 单图复制位图（任务 5.6）：把库内本体解码为 RGBA 位图，交由调用方写入系统
/// 剪贴板（Windows 上是设备无关位图格式）。
///
/// 参数是单个哈希——规格冻结的"复制图像只允许单张，多选不合成、多选出站走
/// 批量导出"由 API 形状保证：这里在结构上就不存在一次喂进多张图的入口。
/// 解码错误沿用媒体域的错误码，如实反映失败原因而不是笼统的"复制失败"。
pub fn asset_bitmap(lib: &Library, hash: &ContentHash) -> Result<crate::clipboard::BitmapImage> {
    let (_, body) = resolve_asset(lib, hash)?;
    let decoded = crate::media::decode(&body)?;
    let rgba = decoded.image.to_rgba8();
    crate::clipboard::BitmapImage::new(
        rgba.width() as usize,
        rgba.height() as usize,
        rgba.into_raw(),
    )
}
