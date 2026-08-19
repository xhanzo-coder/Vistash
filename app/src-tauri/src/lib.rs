//! Tauri 装配层。
//!
//! 本 crate 的职责边界见变更 `implement-vistash-import-and-browse` 的设计第一条：
//! 窗口、插件与 command 注册在这里，业务判断在 `vistash-core`。

pub mod commands;

use std::sync::Mutex;
use tauri::Manager;

/// 装配并运行应用。
///
/// 启动失败直接 panic 而不是返回 `Result`：此时窗口尚未出现，没有任何界面可以呈现错误，
/// 返回错误只会让进程静默退出而看不出原因。
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // 设置文件放在应用配置目录，不放在库目录内——理由见 `settings` 模块的文档。
            // 目录由平台决定，因此这段平台相关的解析留在装配层，核心 crate 只接收路径。
            let settings_path = app.path().app_config_dir()?.join("settings.json");
            app.manage(Mutex::new(commands::AppState::restore(settings_path)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::library_status,
            commands::open_library,
            commands::list_assets,
            commands::catalog_snapshot,
            commands::create_folder,
            commands::rename_folder,
            commands::delete_folder,
            commands::set_asset_folders,
            commands::set_asset_tags,
            commands::delete_asset,
            commands::restore_asset,
            commands::purge_trash,
            commands::import_paths,
            commands::asset_thumbnail,
            commands::asset_original,
            commands::all_error_codes,
        ])
        .run(tauri::generate_context!())
        .expect("启动 Vistash 失败");
}
