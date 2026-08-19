//! 内容寻址：SHA-256 摘要与两级 fanout 路径推导。
//!
//! 库内素材的路径由其内容摘要决定，因此本模块的输出一旦改变，既有库的全部路径
//! 都会失配。切片位置与目录层数属于库格式的一部分，改动必须提升库格式版本。

use crate::error::{AppError, Code, Result};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};

/// 哈希算法标识符，写入库级元数据。库内既有素材的寻址依赖它，因此它无法从本体
/// 反推——这也是库级元数据损坏时不能自愈重建的原因。
pub const HASH_ALGO_ID: &str = "sha256";

/// fanout 每级取用的十六进制字符数。两级各 2 字符即 256 × 256 = 65536 个叶目录。
const FANOUT_SEGMENT_LEN: usize = 2;
const FANOUT_LEVELS: usize = 2;

/// 已校验的内容摘要：64 个小写十六进制字符。
///
/// 用独立类型而不是裸 `String`，是为了让"未校验的字符串"无法直接当作摘要参与
/// 路径拼接——路径拼接一旦接受任意字符串，就等于把库目录结构暴露给调用方输入。
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ContentHash(String);

impl ContentHash {
    /// 校验并接管一个十六进制摘要字符串。
    pub fn parse(s: &str) -> Result<Self> {
        let ok = s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        if !ok {
            return Err(AppError::detailed(
                Code::LibraryMetadataCorrupt,
                format!("摘要不是 64 位小写十六进制：{s}"),
            ));
        }
        Ok(Self(s.to_owned()))
    }

    /// 计算内存中字节的摘要。
    pub fn of_bytes(bytes: &[u8]) -> Self {
        let mut h = Sha256::new();
        h.update(bytes);
        Self(hex::encode(h.finalize()))
    }

    /// 流式计算文件摘要。刻意不整体读入，因为素材可以是数百 MB 的图片。
    pub fn of_file(path: &Path) -> Result<Self> {
        let file = File::open(path).map_err(|e| {
            AppError::detailed(
                Code::ImportSourceUnreadable,
                format!("{}: {e}", path.display()),
            )
        })?;
        let mut reader = BufReader::new(file);
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = reader.read(&mut buf).map_err(|e| {
                AppError::detailed(
                    Code::ImportSourceUnreadable,
                    format!("{}: {e}", path.display()),
                )
            })?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        Ok(Self(hex::encode(hasher.finalize())))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// fanout 的两级目录名。
    fn segments(&self) -> [&str; FANOUT_LEVELS] {
        // parse 与 of_* 都保证长度为 64，故此处切片不会越界。
        [
            &self.0[0..FANOUT_SEGMENT_LEN],
            &self.0[FANOUT_SEGMENT_LEN..FANOUT_SEGMENT_LEN * 2],
        ]
    }

    /// 相对于某个树根的本体路径，例如 `objects/3f/a9/3fa9….png`。
    pub fn body_path_in(&self, tree_root: &Path, ext: &str) -> PathBuf {
        let mut p = self.leaf_dir_in(tree_root);
        p.push(format!("{}.{}", self.0, ext));
        p
    }

    /// 相对于某个树根的侧车路径。与本体同目录，使"复制一个叶目录等于复制完整素材"。
    pub fn sidecar_path_in(&self, tree_root: &Path) -> PathBuf {
        let mut p = self.leaf_dir_in(tree_root);
        p.push(format!("{}.json", self.0));
        p
    }

    /// 叶目录路径。
    pub fn leaf_dir_in(&self, tree_root: &Path) -> PathBuf {
        let mut p = tree_root.to_path_buf();
        for seg in self.segments() {
            p.push(seg);
        }
        p
    }
}

impl std::fmt::Display for ContentHash {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl serde::Serialize for ContentHash {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.0)
    }
}

impl<'de> serde::Deserialize<'de> for ContentHash {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        Self::parse(&s).map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 这些是 SHA-256 的公开已知值。用外部已知值而不是"跑一遍记下来"，
    // 否则实现改错时测试会跟着一起错。
    const EMPTY_SHA256: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const ABC_SHA256: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    #[test]
    fn known_content_maps_to_known_digest() {
        assert_eq!(ContentHash::of_bytes(b"").as_str(), EMPTY_SHA256);
        assert_eq!(ContentHash::of_bytes(b"abc").as_str(), ABC_SHA256);
    }

    #[test]
    fn file_digest_matches_in_memory_digest() {
        let dir = tempfile::tempdir().expect("建立临时目录");
        let f = dir.path().join("sample.bin");
        std::fs::write(&f, b"abc").expect("写入样本");
        assert_eq!(
            ContentHash::of_file(&f).expect("计算文件摘要").as_str(),
            ABC_SHA256
        );
    }

    #[test]
    fn fanout_slices_at_the_documented_positions() {
        // 这条锁死的是库格式：切片位置写错后库仍能工作，但两代路径互不兼容。
        let h = ContentHash::parse(ABC_SHA256).expect("解析已知摘要");
        let root = Path::new("objects");
        let body = h.body_path_in(root, "png");
        let expected = Path::new("objects")
            .join("ba")
            .join("78")
            .join(format!("{ABC_SHA256}.png"));
        assert_eq!(body, expected);
    }

    #[test]
    fn sidecar_sits_in_the_same_leaf_directory_as_the_body() {
        // 同目录侧车是"复制一个叶目录等于复制完整素材"的前提。
        let h = ContentHash::parse(ABC_SHA256).expect("解析已知摘要");
        let root = Path::new("objects");
        let body = h.body_path_in(root, "png");
        let sidecar = h.sidecar_path_in(root);
        assert_eq!(body.parent(), sidecar.parent());
    }

    #[test]
    fn fanout_yields_65536_distinct_leaf_directories() {
        // 两级各 2 个十六进制字符。层数或字符数改动都会改变这个数字，
        // 而那属于库格式变更。
        let combos = 16usize.pow((FANOUT_SEGMENT_LEN * FANOUT_LEVELS) as u32);
        assert_eq!(combos, 65_536);
    }

    #[test]
    fn malformed_digests_are_rejected() {
        for bad in [
            "",
            "ABC",
            EMPTY_SHA256.to_uppercase().as_str(),
            "zzz816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            "ba7816bf",
        ] {
            assert!(
                ContentHash::parse(bad).is_err(),
                "本应拒绝的摘要被接受：{bad}"
            );
        }
    }
}
