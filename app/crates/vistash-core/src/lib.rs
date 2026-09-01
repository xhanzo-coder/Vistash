//! Vistash 的领域逻辑。
//!
//! 本 crate 不依赖 `tauri`，因此库骨架、导入、媒体处理、色卡与索引的全部行为
//! 都能用 `cargo test` 直接验证，不需要启动 WebView。核心 crate 重点保证色卡确定性、
//! 导入回滚与索引重建；这些测试若需要启动窗口，就会慢到不会被真正执行。

pub mod catalog;
pub mod clipboard;
pub mod colorcard;
pub mod error;
pub mod export;
pub mod external_open;
pub mod hashing;
pub mod ids;
pub mod import;
pub mod index;
pub mod library;
pub mod media;
pub mod migration;
pub mod prompt;
pub mod settings;
pub mod sidecar;

pub use error::{AppError, Code, Domain, Result};
