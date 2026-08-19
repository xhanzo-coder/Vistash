//! 色卡：从像素提取有限数量的代表色。
//!
//! 本模块的确定性来自算法本身而不是固定随机种子（设计第三条）。全部影响结果的量
//! 都是本文件与 `media` 里的常量：取样长边、重采样滤波器、初始簇数、迭代上限、
//! 收敛阈值、合并与强调阈值。任何一个常量改动都必须提升 `ALGO_VERSION`。
//!
//! 确定性的边界是"同平台同一次构建"：同一台机器上重复分析同一张图必然得到同一
//! 张色卡。跨平台的浮点行为不在承诺范围内——需求要防的是同机重复计算产生漂移，
//! 这条边界已覆盖该意图。

use crate::error::Code;
use crate::media;
use image::{DynamicImage, RgbaImage};
use serde::{Deserialize, Serialize};

/// 算法版本。写入侧车，使旧色卡可被识别为需要重算而不是被当作当前算法的输出。
pub const ALGO_VERSION: u32 = 1;

/// 色卡最多包含的颜色数。规格上限，超出即视为聚类失败而不是静默截断。
pub const MAX_COLORS: usize = 8;

/// 聚类的初始簇数。合并阶段只会减少簇数，因此它同时是上限。
pub const INITIAL_CLUSTERS: usize = 8;

/// 参与聚类所需的最少不透明像素数。低于此值的图无法给出有意义的代表色。
pub const MIN_OPAQUE_PIXELS: usize = 64;

/// 参与聚类的最低 alpha。半透明像素的颜色会与其背景混合，纳入会污染代表色。
pub const ALPHA_THRESHOLD: u8 = 128;

/// Lloyd 迭代上限。达到上限即接受当前结果——上限本身参与确定性，不是性能调节旋钮。
pub const MAX_ITERATIONS: usize = 24;

/// 收敛判据：一轮中质心的最大移动距离低于此值即停止。
pub const CONVERGENCE_EPSILON: f64 = 1e-4;

/// 合并阈值：OKLab 距离低于此值的两个簇视为同一个颜色。
pub const MERGE_DISTANCE: f64 = 0.045;

/// 中性色判据：OKLab 彩度低于此值视为中性色。
pub const NEUTRAL_CHROMA_MAX: f64 = 0.02;

/// 强调色判据：占比低于此值且彩度足够高，视为强调色。
pub const ACCENT_MAX_SHARE: f64 = 0.10;
pub const ACCENT_MIN_CHROMA: f64 = 0.10;

/// 小占比簇的过滤阈值。占比低于此值且不符合强调色特征的簇不单独成色。
///
/// 被过滤的簇其像素并入距离最近的保留簇，而不是丢弃：这些像素在画面里真实存在，
/// 丢弃会使占比之和小于一，而规格要求占比在有效像素内归一且总和为一。
pub const MIN_CLUSTER_SHARE: f64 = 0.02;

/// 占比保留的小数位数。输出量化是确定性的最后一道保险：即使内部浮点在末位有
/// 差异，落到侧车里的数值也一致。
pub const SHARE_DECIMALS: i32 = 3;

/// OKLab 坐标保留的小数位数。与占比量化同理：坐标只用于距离比较，四位小数远超所需
/// 精度，量化后浮点尾数噪声不会进入侧车。
pub const OKLAB_DECIMALS: i32 = 4;

/// 色卡的整体状态。失败是一种正常结果而不是异常：单张图的色卡算不出来，
/// 不应让整次导入失败。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ColorCardStatus {
    Ok,
    Failed,
}

impl ColorCardStatus {
    /// 稳定的字符串标识，与序列化形式一致。索引把它存成 TEXT。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Failed => "failed",
        }
    }
}

/// 全部状态取值。一致性测试以它为准，新增取值时无需改动测试。
pub const ALL_COLOR_CARD_STATUSES: &[ColorCardStatus] =
    &[ColorCardStatus::Ok, ColorCardStatus::Failed];

/// 颜色在画面中承担的角色。取值固定为四种，前端据此排版而不必自行判断。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ColorRole {
    /// 占比最大的颜色。无论彩度高低都是主色——这是关于画面的事实。
    Dominant,
    Secondary,
    /// 占比小但彩度高：画面里少量却显眼的颜色。
    Accent,
    /// 彩度接近零的颜色。
    Neutral,
}

impl ColorRole {
    /// 稳定的字符串标识，与序列化形式一致。索引把它存成 TEXT。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Dominant => "dominant",
            Self::Secondary => "secondary",
            Self::Accent => "accent",
            Self::Neutral => "neutral",
        }
    }
}

/// 全部角色取值。规格要求角色取自固定枚举，这张清单就是那个枚举的可迭代形式。
pub const ALL_COLOR_ROLES: &[ColorRole] = &[
    ColorRole::Dominant,
    ColorRole::Secondary,
    ColorRole::Accent,
    ColorRole::Neutral,
];

/// 颜色在聚类色彩空间中的坐标。
///
/// 与 `hex` 并存而不是让调用方从 hex 反算：颜色筛选要做距离计算，每次筛选都反算一遍
/// 等于把色彩空间转换重做一次，而这个坐标在导入时已经算过。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct OklabCoords {
    pub l: f64,
    pub a: f64,
    pub b: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ColorEntry {
    /// `#rrggbb`，小写。取自图中真实存在的采样像素，不是聚类质心。
    pub hex: String,
    /// 与 `hex` 同一个颜色的 OKLab 坐标。
    pub oklab: OklabCoords,
    /// 占不透明像素的比例，保留三位小数。
    pub share: f64,
    pub role: ColorRole,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ColorCard {
    pub status: ColorCardStatus,
    pub algo_version: u32,
    /// 成功时按占比降序；失败时为空数组。
    pub colors: Vec<ColorEntry>,
    /// 实际参与聚类的像素数。用于解释"为什么这张图的色卡是失败的"。
    pub sampled_pixel_count: u64,
    pub failure_reason: Option<Code>,
}

impl ColorCard {
    /// 构造一张失败的色卡。colors 必为空——规格要求失败时不给出任何颜色，
    /// 而不是返回一张看起来正常的空色卡。
    pub fn failed(reason: Code) -> Self {
        Self {
            status: ColorCardStatus::Failed,
            algo_version: ALGO_VERSION,
            colors: Vec::new(),
            sampled_pixel_count: 0,
            failure_reason: Some(reason),
        }
    }

    pub fn is_ok(&self) -> bool {
        self.status == ColorCardStatus::Ok
    }
}

/// OKLab 坐标。选 OKLab 而不是 RGB 做聚类，因为 RGB 的欧氏距离与人眼感知差距很大，
/// 会把深蓝和黑归到一起而把两种相近的绿分开。
#[derive(Debug, Clone, Copy, PartialEq)]
struct Oklab {
    l: f64,
    a: f64,
    b: f64,
}

impl Oklab {
    const ZERO: Self = Self {
        l: 0.0,
        a: 0.0,
        b: 0.0,
    };

    fn chroma(self) -> f64 {
        (self.a * self.a + self.b * self.b).sqrt()
    }

    fn distance(self, o: Self) -> f64 {
        let (dl, da, db) = (self.l - o.l, self.a - o.a, self.b - o.b);
        (dl * dl + da * da + db * db).sqrt()
    }

    /// 排序用的全序键。用 `total_cmp` 而不是 `partial_cmp().unwrap()`，
    /// 使异常浮点值只影响排位而不会让整次导入 panic。
    fn cmp_key(&self, o: &Self) -> std::cmp::Ordering {
        self.l
            .total_cmp(&o.l)
            .then(self.a.total_cmp(&o.a))
            .then(self.b.total_cmp(&o.b))
    }
}

fn srgb_to_linear(c: f64) -> f64 {
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

/// 仅供 `oklab_to_hex` 使用，因此与它一同转为测试专用。
#[cfg(test)]
fn linear_to_srgb(c: f64) -> f64 {
    if c <= 0.003_130_8 {
        c * 12.92
    } else {
        1.055 * c.powf(1.0 / 2.4) - 0.055
    }
}

fn rgb_to_oklab(r: u8, g: u8, b: u8) -> Oklab {
    let r = srgb_to_linear(r as f64 / 255.0);
    let g = srgb_to_linear(g as f64 / 255.0);
    let b = srgb_to_linear(b as f64 / 255.0);
    let l = 0.412_221_470_8 * r + 0.536_332_536_3 * g + 0.051_445_992_9 * b;
    let m = 0.211_903_498_2 * r + 0.680_699_545_1 * g + 0.107_396_956_6 * b;
    let s = 0.088_302_461_9 * r + 0.281_718_837_6 * g + 0.629_978_700_5 * b;
    let (l, m, s) = (l.cbrt(), m.cbrt(), s.cbrt());
    Oklab {
        l: 0.210_454_255_3 * l + 0.793_617_785_0 * m - 0.004_072_046_8 * s,
        a: 1.977_998_495_1 * l - 2.428_592_205_0 * m + 0.450_593_709_9 * s,
        b: 0.025_904_037_1 * l + 0.782_771_766_2 * m - 0.808_675_766_0 * s,
    }
}

/// OKLab 到 sRGB 十六进制的反变换。
///
/// 生产路径不再使用它：代表色取自真实采样像素，其 hex 由该像素的 RGB 直接得出。
/// 保留它是因为它是 `rgb_to_oklab` 的逆变换，测试用它来验证正变换的正确性。
#[cfg(test)]
fn oklab_to_hex(c: Oklab) -> String {
    let l = c.l + 0.396_337_777_4 * c.a + 0.215_803_757_3 * c.b;
    let m = c.l - 0.105_561_345_8 * c.a - 0.063_854_172_8 * c.b;
    let s = c.l - 0.089_484_177_5 * c.a - 1.291_485_548_0 * c.b;
    let (l, m, s) = (l * l * l, m * m * m, s * s * s);
    let r = 4.076_741_662_1 * l - 3.307_711_591_3 * m + 0.230_969_929_2 * s;
    let g = -1.268_438_004_6 * l + 2.609_757_401_1 * m - 0.341_319_396_5 * s;
    let b = -0.004_196_086_3 * l - 0.703_418_614_7 * m + 1.707_614_701_0 * s;
    // OKLab 的可表示范围大于 sRGB 色域，反变换结果可能越界，故必须夹紧。
    let q = |v: f64| (linear_to_srgb(v).clamp(0.0, 1.0) * 255.0).round() as u8;
    format!("#{:02x}{:02x}{:02x}", q(r), q(g), q(b))
}

fn round_share(x: f64) -> f64 {
    let f = 10f64.powi(SHARE_DECIMALS);
    (x * f).round() / f
}

/// 分析一张已解码的图。内部先按 `media::COLOR_SAMPLE_LONG_EDGE` 降采样，
/// 因此耗时与原图尺寸无关。
pub fn analyze(image: &DynamicImage) -> ColorCard {
    analyze_sampled(&media::sample_for_color_card(image))
}

/// 聚类的中间态。
///
/// 保留成员下标而不是只保留计数：代表像素必须从簇内的真实样本里挑出来，只有计数挑不了。
struct Cluster {
    centroid: Oklab,
    members: Vec<usize>,
}

/// 是否符合强调色特征：占比小但彩度高。
///
/// 这个判据在两处使用且必须一致——小簇过滤前用它豁免强调色，输出时用它标注角色。
/// 规格要求角色不得由占比排序推导，理由正是这里：强调色的占比通常低于过滤阈值，
/// 若不先豁免就会被过滤掉，再按占比排序时被误判为次要色。
fn is_accent_like(share: f64, centroid: Oklab) -> bool {
    share < ACCENT_MAX_SHARE && centroid.chroma() >= ACCENT_MIN_CHROMA
}

/// 距离最近的质心下标。距离相等时取序号更小的簇，使归属不依赖遍历顺序。
fn nearest_centroid(centroids: &[Oklab], s: Oklab) -> usize {
    let mut best = 0usize;
    let mut best_d = f64::INFINITY;
    for (ci, c) in centroids.iter().enumerate() {
        let d = s.distance(*c);
        // 严格小于：距离相等时保留序号更小的簇。
        if d < best_d {
            best_d = d;
            best = ci;
        }
    }
    best
}

/// 一组样本的 OKLab 均值。
///
/// 按全部成员重算而不是对两个质心取加权平均：后者会在多次合并后累积误差，
/// 而本函数的结果只取决于成员集合本身。
fn mean_of(members: &[usize], samples: &[Oklab]) -> Oklab {
    let n = members.len() as f64;
    let mut acc = Oklab::ZERO;
    for &i in members {
        acc.l += samples[i].l;
        acc.a += samples[i].a;
        acc.b += samples[i].b;
    }
    Oklab {
        l: acc.l / n,
        a: acc.a / n,
        b: acc.b / n,
    }
}

/// 把一批样本并入某个簇并重算质心。
fn absorb(target: &mut Cluster, mut moved: Vec<usize>, samples: &[Oklab]) {
    target.members.append(&mut moved);
    target.centroid = mean_of(&target.members, samples);
}

/// 簇的代表像素：簇内距质心最近的真实样本。
///
/// 取真实样本而不是质心是规格的硬要求。质心是簇内颜色的均值，可能是一个原图里不存在
/// 的颜色，而色卡的用途之一正是让使用者复制色号去用——给出一个图里没有的色号，
/// 复制出去就是错的。
fn medoid(cluster: &Cluster, samples: &[Oklab]) -> usize {
    cluster
        .members
        .iter()
        .copied()
        .min_by(|&a, &b| {
            let da = samples[a].distance(cluster.centroid);
            let db = samples[b].distance(cluster.centroid);
            da.total_cmp(&db)
                // 距离相等时按颜色全序再按下标兜底，使结果不依赖成员顺序。
                .then(samples[a].cmp_key(&samples[b]))
                .then(a.cmp(&b))
        })
        .expect("簇非空：空簇已在建簇时剔除")
}

fn quantize_oklab(c: Oklab) -> OklabCoords {
    let f = 10f64.powi(OKLAB_DECIMALS);
    OklabCoords {
        l: (c.l * f).round() / f,
        a: (c.a * f).round() / f,
        b: (c.b * f).round() / f,
    }
}

/// 分析已降采样的 RGBA 像素。
///
/// 这是确定性算法的本体，也是确定性测试的接缝：跳过降采样后，测试可以直接用
/// 精确构造的像素断言结果，不受重采样滤波器的影响。
pub fn analyze_sampled(pixels: &RgbaImage) -> ColorCard {
    // 1. 筛出不透明像素，转入 OKLab，并留下每个样本的原始 RGB。
    //
    //    保留 RGB 是第 11 步的前提：输出的颜色必须是图中真实存在的像素。
    let mut samples: Vec<Oklab> = Vec::new();
    let mut sample_rgb: Vec<[u8; 3]> = Vec::new();
    let mut distinct: std::collections::BTreeSet<[u8; 3]> = std::collections::BTreeSet::new();
    for px in pixels.pixels() {
        let [r, g, b, a] = px.0;
        if a < ALPHA_THRESHOLD {
            continue;
        }
        distinct.insert([r, g, b]);
        samples.push(rgb_to_oklab(r, g, b));
        sample_rgb.push([r, g, b]);
    }
    let total = samples.len();
    if total < MIN_OPAQUE_PIXELS {
        let mut card = ColorCard::failed(Code::ColorCardInsufficientOpaquePixels);
        card.sampled_pixel_count = total as u64;
        return card;
    }
    let failed_cluster = || {
        let mut card = ColorCard::failed(Code::ColorCardClusterFailed);
        card.sampled_pixel_count = total as u64;
        card
    };

    // 2. 按 (L, a, b, 原索引) 排成全序。原索引只在颜色完全相同时才起作用，
    //    因此排序结果不依赖像素的遍历顺序。
    let mut order: Vec<usize> = (0..total).collect();
    order.sort_by(|&i, &j| samples[i].cmp_key(&samples[j]).then(i.cmp(&j)));

    // 3. 初始质心取分位点：第 i 个落在第 i 个等分区间的中点。取中点而不是端点，
    //    避免第一个质心永远落在最暗的那个像素上。
    let k = INITIAL_CLUSTERS.min(distinct.len()).max(1);
    let mut centroids: Vec<Oklab> = (0..k)
        .map(|i| {
            let pos = ((2 * i + 1) * total) / (2 * k);
            samples[order[pos.min(total - 1)]]
        })
        .collect();

    // 4. Lloyd 迭代。
    let mut assign = vec![0usize; total];
    for _ in 0..MAX_ITERATIONS {
        for (idx, s) in samples.iter().enumerate() {
            assign[idx] = nearest_centroid(&centroids, *s);
        }
        let mut sums = vec![Oklab::ZERO; k];
        let mut counts = vec![0usize; k];
        for (idx, s) in samples.iter().enumerate() {
            let c = assign[idx];
            sums[c].l += s.l;
            sums[c].a += s.a;
            sums[c].b += s.b;
            counts[c] += 1;
        }
        let mut moved: f64 = 0.0;
        for ci in 0..k {
            if counts[ci] == 0 {
                // 空簇保留旧质心，迭代结束后统一剔除。
                continue;
            }
            let n = counts[ci] as f64;
            let next = Oklab {
                l: sums[ci].l / n,
                a: sums[ci].a / n,
                b: sums[ci].b / n,
            };
            moved = moved.max(next.distance(centroids[ci]));
            centroids[ci] = next;
        }
        if moved < CONVERGENCE_EPSILON {
            break;
        }
    }

    // 5. 收敛后再做一次归属。迭代内的 assign 对应的是上一轮的质心，而第 11 步要从簇内
    //    样本里挑代表像素，"每个样本都属于离它最近的质心"这条必须真的成立。
    for (idx, s) in samples.iter().enumerate() {
        assign[idx] = nearest_centroid(&centroids, *s);
    }

    // 6. 建簇并剔除空簇。
    let mut clusters: Vec<Cluster> = {
        let mut members: Vec<Vec<usize>> = vec![Vec::new(); k];
        for (idx, &c) in assign.iter().enumerate() {
            members[c].push(idx);
        }
        centroids
            .iter()
            .zip(members)
            .filter(|(_, m)| !m.is_empty())
            .map(|(c, m)| Cluster {
                centroid: *c,
                members: m,
            })
            .collect()
    };

    // 7. 小占比簇过滤，强调色先行豁免。被过滤的簇其像素并入最近的保留簇。
    //
    //    至少有一个簇必然保留：簇数不超过 INITIAL_CLUSTERS 且占比之和为一，故最大簇的
    //    占比不低于 1/INITIAL_CLUSTERS，远高于 MIN_CLUSTER_SHARE。
    {
        let keep: Vec<bool> = clusters
            .iter()
            .map(|c| {
                let share = c.members.len() as f64 / total as f64;
                share >= MIN_CLUSTER_SHARE || is_accent_like(share, c.centroid)
            })
            .collect();
        let kept: Vec<usize> = (0..clusters.len()).filter(|&i| keep[i]).collect();
        if kept.is_empty() {
            // 上面的论证保证走不到这里。真走到了说明簇数上限或阈值被改坏，
            // 此时报聚类失败，不输出一张空色卡冒充成功。
            return failed_cluster();
        }
        // 处理顺序固定为占比升序、同占比按质心全序，使并入结果不依赖建簇顺序。
        let mut dropped: Vec<usize> = (0..clusters.len()).filter(|&i| !keep[i]).collect();
        dropped.sort_by(|&i, &j| {
            clusters[i]
                .members
                .len()
                .cmp(&clusters[j].members.len())
                .then(clusters[i].centroid.cmp_key(&clusters[j].centroid))
        });
        for i in dropped {
            let target = kept
                .iter()
                .copied()
                .min_by(|&a, &b| {
                    let da = clusters[i].centroid.distance(clusters[a].centroid);
                    let db = clusters[i].centroid.distance(clusters[b].centroid);
                    da.total_cmp(&db)
                        .then(clusters[a].centroid.cmp_key(&clusters[b].centroid))
                })
                .expect("kept 非空");
            let moved = std::mem::take(&mut clusters[i].members);
            absorb(&mut clusters[target], moved, &samples);
        }
        let mut retained: Vec<Cluster> = Vec::with_capacity(kept.len());
        for (i, c) in clusters.into_iter().enumerate() {
            if keep[i] {
                retained.push(c);
            }
        }
        clusters = retained;
    }

    // 8. 合并过近的簇。每轮合并全局最近的一对，合并后按全部成员重算质心。
    loop {
        let mut pair: Option<(usize, usize)> = None;
        let mut best = MERGE_DISTANCE;
        for i in 0..clusters.len() {
            for j in (i + 1)..clusters.len() {
                let d = clusters[i].centroid.distance(clusters[j].centroid);
                if d < best {
                    best = d;
                    pair = Some((i, j));
                }
            }
        }
        let Some((i, j)) = pair else { break };
        let moved = std::mem::take(&mut clusters[j].members);
        absorb(&mut clusters[i], moved, &samples);
        clusters.remove(j);
    }

    // 9. 按占比降序，占比相同时按质心全序，使输出顺序完全确定。
    clusters.sort_by(|a, b| {
        b.members
            .len()
            .cmp(&a.members.len())
            .then(a.centroid.cmp_key(&b.centroid))
    });

    // 10. 自检。数量越界时报告聚类失败，而不是截掉多余的颜色——静默截断会让
    //     "色卡不超过八色"这条承诺在实现出错时依然看起来成立。
    if clusters.is_empty() || clusters.len() > MAX_COLORS {
        return failed_cluster();
    }

    // 11. 为每个簇选代表像素并标注角色。
    let colors = clusters
        .iter()
        .enumerate()
        .map(|(rank, c)| {
            let share = round_share(c.members.len() as f64 / total as f64);
            let rep = medoid(c, &samples);
            let rgb = sample_rgb[rep];
            let role = if rank == 0 {
                // 占比最大的颜色无论彩度高低都是主色——这是关于画面的事实。
                ColorRole::Dominant
            } else if c.centroid.chroma() < NEUTRAL_CHROMA_MAX {
                ColorRole::Neutral
            } else if is_accent_like(share, c.centroid) {
                ColorRole::Accent
            } else {
                ColorRole::Secondary
            };
            ColorEntry {
                hex: format!("#{:02x}{:02x}{:02x}", rgb[0], rgb[1], rgb[2]),
                oklab: quantize_oklab(samples[rep]),
                share,
                role,
            }
        })
        .collect();

    ColorCard {
        status: ColorCardStatus::Ok,
        algo_version: ALGO_VERSION,
        colors,
        sampled_pixel_count: total as u64,
        failure_reason: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    /// 逐行填色构造图像。每个元素是 (行数, 颜色)。
    fn banded(width: u32, bands: &[(u32, [u8; 4])]) -> RgbaImage {
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
        img
    }

    /// 测试内自带的线性同余发生器。刻意不用 `rand`：色卡的确定性不允许依赖
    /// 任何跨版本可能变化的随机源，测试数据也一样。
    struct Lcg(u64);
    impl Lcg {
        fn next_u8(&mut self) -> u8 {
            self.0 = self.0.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
            (self.0 >> 33) as u8
        }
    }

    fn noisy(width: u32, height: u32, seed: u64) -> RgbaImage {
        let mut g = Lcg(seed);
        let mut img = RgbaImage::new(width, height);
        for y in 0..height {
            for x in 0..width {
                img.put_pixel(x, y, Rgba([g.next_u8(), g.next_u8(), g.next_u8(), 255]));
            }
        }
        img
    }

    #[test]
    fn as_str_matches_the_serialized_form() {
        // 索引存 as_str 的结果，侧车存序列化形式。两者分叉就会让同一个取值在
        // 索引与侧车里变成两个不同的字符串。
        for &r in ALL_COLOR_ROLES {
            let json = serde_json::to_string(&r).expect("序列化角色");
            assert_eq!(json, format!("\"{}\"", r.as_str()));
        }
        for &st in ALL_COLOR_CARD_STATUSES {
            let json = serde_json::to_string(&st).expect("序列化状态");
            assert_eq!(json, format!("\"{}\"", st.as_str()));
        }
    }

    #[test]
    fn a_failed_card_carries_no_colors() {
        let c = ColorCard::failed(Code::ColorCardDecodeFailed);
        assert_eq!(c.status, ColorCardStatus::Failed);
        assert!(c.colors.is_empty());
        assert_eq!(c.failure_reason, Some(Code::ColorCardDecodeFailed));
        assert!(!c.is_ok());
    }

    #[test]
    fn the_same_input_yields_a_byte_identical_card() {
        // 这是色卡最核心的承诺，也是最容易静默失效的一条：结果漂移不会报错，
        // 只会让同一张图在两次导入后有两张不同的色卡。
        let img = noisy(64, 64, 20_260_818);
        let a = analyze_sampled(&img);
        let b = analyze_sampled(&img);
        assert_eq!(a, b);
        let ja = serde_json::to_string(&a).expect("序列化色卡");
        let jb = serde_json::to_string(&b).expect("序列化色卡");
        assert_eq!(ja, jb, "两次分析的序列化结果不一致");
    }

    #[test]
    fn pixel_traversal_order_does_not_change_the_card() {
        // 排序键里的原索引只在颜色完全相同时参与比较，因此把同一批像素换个
        // 位置摆放不应改变结果。若这条失败，说明确定性依赖了遍历顺序。
        let img = noisy(48, 48, 7);
        let flipped = image::imageops::flip_horizontal(&img);
        let a = analyze_sampled(&img);
        let b = analyze_sampled(&flipped);
        assert_eq!(a.colors, b.colors);
    }

    #[test]
    fn two_flat_colors_report_their_exact_shares() {
        // 32 列宽、24 行红 8 行蓝 → 0.75 / 0.25。
        let img = banded(32, &[(24, [255, 0, 0, 255]), (8, [0, 0, 255, 255])]);
        let c = analyze_sampled(&img);
        assert!(c.is_ok(), "色卡应成功：{:?}", c.failure_reason);
        assert_eq!(c.colors.len(), 2);
        assert_eq!(c.colors[0].hex, "#ff0000");
        assert_eq!(c.colors[0].share, 0.75);
        assert_eq!(c.colors[0].role, ColorRole::Dominant);
        assert_eq!(c.colors[1].hex, "#0000ff");
        assert_eq!(c.colors[1].share, 0.25);
        // 占比 0.25 已超过强调色阈值，应归为次要色而不是强调色。
        assert_eq!(c.colors[1].role, ColorRole::Secondary);
        assert_eq!(c.sampled_pixel_count, 32 * 32);
    }

    #[test]
    fn a_small_saturated_patch_becomes_an_accent() {
        let img = banded(
            100,
            &[
                (50, [32, 32, 32, 255]),
                (3, [255, 0, 0, 255]),
                (47, [224, 224, 224, 255]),
            ],
        );
        let c = analyze_sampled(&img);
        assert!(c.is_ok(), "色卡应成功：{:?}", c.failure_reason);
        assert_eq!(c.colors.len(), 3);
        assert_eq!(c.colors[0].role, ColorRole::Dominant);
        let red = c
            .colors
            .iter()
            .find(|e| e.hex == "#ff0000")
            .expect("红色应作为独立一色出现");
        assert_eq!(red.share, 0.03);
        assert_eq!(red.role, ColorRole::Accent);
        let light = c
            .colors
            .iter()
            .find(|e| e.hex == "#e0e0e0")
            .expect("浅灰应作为独立一色出现");
        assert_eq!(light.role, ColorRole::Neutral, "无彩度的颜色应归为中性色");
    }

    #[test]
    fn every_colour_is_an_actual_sampled_pixel() {
        // reverse-prompt 规格：输出的颜色值必须取自图像实际样本中的代表像素，
        // 禁止输出可能不存在于原图的聚类质心颜色。质心是簇内像素的平均值，
        // 在噪声图上几乎必然是一个原图中不存在的颜色。
        let img = noisy(64, 64, 20_260_819);
        let present: std::collections::BTreeSet<String> = img
            .pixels()
            .filter(|px| px.0[3] >= ALPHA_THRESHOLD)
            .map(|px| format!("#{:02x}{:02x}{:02x}", px.0[0], px.0[1], px.0[2]))
            .collect();
        let c = analyze_sampled(&img);
        assert!(c.is_ok(), "色卡应成功：{:?}", c.failure_reason);
        for e in &c.colors {
            assert!(
                present.contains(&e.hex),
                "输出颜色 {} 不存在于原图采样像素中",
                e.hex
            );
        }
    }

    #[test]
    fn oklab_is_recorded_alongside_hex_and_describes_the_same_colour() {
        // reverse-prompt 规格：每个颜色必须同时记录可复制的十六进制值与其在聚类
        // 色彩空间中的坐标。两者必须描述同一个颜色，否则按坐标筛出来的结果与
        // 使用者看到的色块对不上。
        let c = analyze_sampled(&noisy(64, 64, 31));
        assert!(c.is_ok(), "色卡应成功：{:?}", c.failure_reason);
        assert!(!c.colors.is_empty());
        let tolerance = 10f64.powi(-OKLAB_DECIMALS);
        for e in &c.colors {
            let r = u8::from_str_radix(&e.hex[1..3], 16).expect("hex 的红通道");
            let g = u8::from_str_radix(&e.hex[3..5], 16).expect("hex 的绿通道");
            let b = u8::from_str_radix(&e.hex[5..7], 16).expect("hex 的蓝通道");
            let expected = quantize_oklab(rgb_to_oklab(r, g, b));
            assert!(
                (e.oklab.l - expected.l).abs() <= tolerance
                    && (e.oklab.a - expected.a).abs() <= tolerance
                    && (e.oklab.b - expected.b).abs() <= tolerance,
                "{} 的坐标 {:?} 与该颜色不符，应为 {:?}",
                e.hex,
                e.oklab,
                expected
            );
        }
    }

    #[test]
    fn a_tiny_neutral_band_is_filtered_into_its_nearest_neighbour() {
        // 中间那条 1 行的灰只占 0.01，低于小簇过滤阈值且彩度接近零，
        // 因此不应单独成色。它的像素并入最近的保留簇，故占比之和仍为 1。
        let img = banded(
            100,
            &[
                (50, [32, 32, 32, 255]),
                (1, [128, 128, 128, 255]),
                (49, [224, 224, 224, 255]),
            ],
        );
        let c = analyze_sampled(&img);
        assert!(c.is_ok(), "色卡应成功：{:?}", c.failure_reason);
        assert!(
            c.colors.iter().all(|e| e.hex != "#808080"),
            "占比 0.01 的中性色不应单独成色：{:?}",
            c.colors
        );
        assert_eq!(c.colors.len(), 2, "应只剩深灰与浅灰两色：{:?}", c.colors);
        let sum: f64 = c.colors.iter().map(|e| e.share).sum();
        let tolerance = c.colors.len() as f64 * 0.5 * 10f64.powi(-SHARE_DECIMALS) + 1e-9;
        assert!(
            (sum - 1.0).abs() <= tolerance,
            "过滤后占比之和 {sum} 偏离 1：被过滤的像素必须并入保留簇而不是丢弃"
        );
    }

    #[test]
    fn a_tiny_saturated_band_survives_filtering_as_an_accent() {
        // 同样只占 0.01，但彩度很高。规格解释了这两条为何耦合：强调色的占比
        // 通常低于普通簇的过滤阈值，因此过滤必须先让强调色发现把它救回来。
        let img = banded(
            100,
            &[
                (50, [32, 32, 32, 255]),
                (1, [255, 0, 0, 255]),
                (49, [224, 224, 224, 255]),
            ],
        );
        let c = analyze_sampled(&img);
        assert!(c.is_ok(), "色卡应成功：{:?}", c.failure_reason);
        let red = c
            .colors
            .iter()
            .find(|e| e.hex == "#ff0000")
            .expect("占比低于过滤阈值的高彩度色应被强调色发现救回");
        assert_eq!(red.share, 0.01);
        assert_eq!(red.role, ColorRole::Accent);
    }

    #[test]
    fn a_greyscale_image_has_no_accent_or_secondary() {
        let img = banded(
            40,
            &[
                (10, [16, 16, 16, 255]),
                (10, [80, 80, 80, 255]),
                (10, [160, 160, 160, 255]),
                (10, [240, 240, 240, 255]),
            ],
        );
        let c = analyze_sampled(&img);
        assert!(c.is_ok());
        for e in c.colors.iter().skip(1) {
            assert_eq!(e.role, ColorRole::Neutral, "灰阶图出现了非中性色：{e:?}");
        }
    }

    #[test]
    fn a_single_flat_colour_yields_exactly_one_entry() {
        let img = banded(16, &[(16, [17, 34, 51, 255])]);
        let c = analyze_sampled(&img);
        assert!(c.is_ok());
        assert_eq!(c.colors.len(), 1);
        assert_eq!(c.colors[0].hex, "#112233");
        assert_eq!(c.colors[0].share, 1.0);
    }

    #[test]
    fn the_colour_count_never_exceeds_the_documented_maximum() {
        for seed in [1u64, 2, 3, 999] {
            let c = analyze_sampled(&noisy(64, 64, seed));
            assert!(c.is_ok(), "seed {seed} 分析失败");
            assert!(
                c.colors.len() <= MAX_COLORS,
                "seed {seed} 产出 {} 色，超过上限",
                c.colors.len()
            );
        }
    }

    #[test]
    fn shares_sum_to_one_within_the_rounding_error() {
        let c = analyze_sampled(&noisy(80, 60, 42));
        let sum: f64 = c.colors.iter().map(|e| e.share).sum();
        let tolerance = c.colors.len() as f64 * 0.5 * 10f64.powi(-SHARE_DECIMALS) + 1e-9;
        assert!(
            (sum - 1.0).abs() <= tolerance,
            "占比之和 {sum} 偏离 1 超过量化误差"
        );
    }

    #[test]
    fn every_hex_is_lowercase_and_six_digits() {
        let c = analyze_sampled(&noisy(64, 64, 5));
        for e in &c.colors {
            assert_eq!(e.hex.len(), 7, "hex 长度不对：{}", e.hex);
            assert!(e.hex.starts_with('#'));
            assert!(
                e.hex[1..].chars().all(|ch| ch.is_ascii_hexdigit() && !ch.is_ascii_uppercase()),
                "hex 不是小写十六进制：{}",
                e.hex
            );
        }
    }

    #[test]
    fn a_fully_transparent_image_reports_insufficient_opaque_pixels() {
        let img = banded(32, &[(32, [200, 100, 50, 0])]);
        let c = analyze_sampled(&img);
        assert_eq!(c.status, ColorCardStatus::Failed);
        assert_eq!(
            c.failure_reason,
            Some(Code::ColorCardInsufficientOpaquePixels)
        );
        assert_eq!(c.sampled_pixel_count, 0);
        assert!(c.colors.is_empty());
    }

    #[test]
    fn an_image_with_too_few_opaque_pixels_is_refused() {
        // 63 个不透明像素，刚好低于门槛。
        let mut img = RgbaImage::new(MIN_OPAQUE_PIXELS as u32, 1);
        for x in 0..(MIN_OPAQUE_PIXELS as u32 - 1) {
            img.put_pixel(x, 0, Rgba([1, 2, 3, 255]));
        }
        let c = analyze_sampled(&img);
        assert_eq!(
            c.failure_reason,
            Some(Code::ColorCardInsufficientOpaquePixels)
        );
        assert_eq!(c.sampled_pixel_count, MIN_OPAQUE_PIXELS as u64 - 1);
    }

    #[test]
    fn semi_transparent_pixels_do_not_participate() {
        // 半透明像素的颜色已与背景混合，纳入会得到画面里并不存在的颜色。
        let img = banded(
            32,
            &[(16, [255, 0, 0, 255]), (16, [0, 255, 0, ALPHA_THRESHOLD - 1])],
        );
        let c = analyze_sampled(&img);
        assert!(c.is_ok());
        assert_eq!(c.colors.len(), 1);
        assert_eq!(c.colors[0].hex, "#ff0000");
        assert_eq!(c.sampled_pixel_count, 32 * 16);
    }

    #[test]
    fn oklab_survives_a_round_trip_through_hex() {
        for rgb in [
            [0u8, 0, 0],
            [255, 255, 255],
            [255, 0, 0],
            [0, 255, 0],
            [0, 0, 255],
            [17, 34, 51],
            [128, 128, 128],
            [224, 96, 32],
        ] {
            let hex = oklab_to_hex(rgb_to_oklab(rgb[0], rgb[1], rgb[2]));
            let expected = format!("#{:02x}{:02x}{:02x}", rgb[0], rgb[1], rgb[2]);
            assert_eq!(hex, expected, "OKLab 往返丢失了颜色");
        }
    }

    #[test]
    fn greys_sit_far_below_the_neutral_threshold() {
        // 中性色判据建立在 r=g=b 时彩度接近零这个事实上。不能断言它等于零：
        // 公开的 OKLab 矩阵系数是十进制近似值，三个通道的加权和无法精确抵消。
        // 真正需要成立的是“远低于中性色阈值”，否则灰阶图会被归成彩色。
        let bound = NEUTRAL_CHROMA_MAX / 1000.0;
        for v in [0u8, 32, 128, 200, 255] {
            let c = rgb_to_oklab(v, v, v).chroma();
            assert!(c < bound, "灰色 {v} 的彩度 {c} 未远低于阈值 {bound}");
        }
    }

    #[test]
    fn analyze_downsamples_before_clustering() {
        // 走完整路径（含降采样）的图应与手动降采样后的结果一致。
        let big = DynamicImage::ImageRgba8(noisy(600, 400, 11));
        let via_full = analyze(&big);
        let via_core = analyze_sampled(&media::sample_for_color_card(&big));
        assert_eq!(via_full, via_core);
        assert_eq!(via_full.sampled_pixel_count, 256 * 171);
    }
}
