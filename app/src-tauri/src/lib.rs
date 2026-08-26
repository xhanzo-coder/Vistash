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
            // 设置文件与分库布局都放在应用配置目录，不放在库目录内——理由见
            // `settings` 模块的文档。目录由平台决定，因此这段平台相关的解析留在
            // 装配层，核心 crate 只接收路径。
            let config_dir = app.path().app_config_dir()?;
            let settings_path = config_dir.join("settings.json");
            let layouts_dir = config_dir.join("layouts");
            app.manage(Mutex::new(commands::AppState::restore(
                settings_path,
                layouts_dir,
            )));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::library_status,
            commands::open_library,
            commands::migrate_library,
            commands::plan_v3_migration,
            commands::commit_v3_migration,
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
            commands::create_prompt,
            commands::update_prompt,
            commands::prompt_detail,
            commands::prompt_snapshot,
            commands::create_prompt_folder,
            commands::rename_prompt_folder,
            commands::delete_prompt_folder,
            commands::set_prompt_note,
            commands::set_prompt_favorite,
            commands::set_prompt_folders,
            commands::set_prompt_tags,
            commands::delete_prompt,
            commands::restore_prompt,
            commands::purge_prompt_trash,
            commands::link_images,
            commands::unlink_image,
            commands::set_prompt_cover,
            commands::import_and_link,
            commands::image_detail,
            commands::linked_image_states,
            commands::set_asset_note,
            commands::set_asset_favorite,
            commands::batch_add_asset_folder,
            commands::batch_remove_asset_folder,
            commands::batch_add_asset_tag,
            commands::batch_remove_asset_tag,
            commands::batch_set_asset_favorite,
            commands::batch_link_to_prompt,
            commands::batch_delete_assets,
            commands::batch_add_prompt_folder,
            commands::batch_remove_prompt_folder,
            commands::batch_add_prompt_tag,
            commands::batch_remove_prompt_tag,
            commands::batch_set_prompt_favorite,
            commands::batch_delete_prompts,
            commands::global_search,
            commands::read_layout,
            commands::write_layout,
        ])
        .run(tauri::generate_context!())
        .expect("启动 Vistash 失败");
}
