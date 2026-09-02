//! Tauri 装配层。
//!
//! 本 crate 负责 Tauri 装配、窗口、插件和 command 注册：
//! 窗口、插件与 command 注册在这里，业务判断在 `vistash-core`。

pub mod commands;
// Windows 剪贴板生产 adapter：本项目 Windows 优先，模块内的
// Win32 调用不需要跨平台替身；非 Windows 目标编译时整个模块缺席。
#[cfg(target_os = "windows")]
pub mod windows_clipboard;

use std::sync::Mutex;
use tauri::Manager;

/// 装配并运行应用。
///
/// 启动失败直接 panic 而不是返回 `Result`：此时窗口尚未出现，没有任何界面可以呈现错误，
/// 返回错误只会让进程静默退出而看不出原因。
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // 剪贴板位图读取：只在 Rust 侧注册插件——
        // 不给 WebView 添加任何剪贴板 ACL 权限，前端全程不见像素；窗口级
        // Ctrl+V 由 paste_import 命令在后端完成分流裁决。
        .plugin(tauri_plugin_clipboard_manager::init())
        // 默认程序打开：只在 Rust 侧经 OpenerExt 打开后端创建并
        // 校验过的只读副本路径，不给 WebView 开任何 opener 权限——前端拿到的
        // 只是"按素材哈希打开"的窄命令。
        .plugin(tauri_plugin_opener::init())
        // 库级导入运行注册表：begin 在 import_sources 内占用槽位，
        // import_stop 经它按并发键定位运行中的任务。命令层只克隆 Arc 句柄。
        .manage(commands::managed_transfer_runs())
        .setup(|app| {
            // 设置文件与分库布局都放在应用配置目录，不放在库目录内——理由见
            // `settings` 模块的文档。目录由平台决定，因此这段平台相关的解析留在
            // 装配层，核心 crate 只接收路径。
            let config_dir = app.path().app_config_dir()?;
            let settings_path = config_dir.join("settings.json");
            let layouts_dir = config_dir.join("layouts");
            // 只读临时副本根：位于应用缓存侧，与库根、
            // 内容哈希树和导出目标结构性隔离。会话 ID 本次运行生成一次；启动时
            // 顺手清理过期会话——被占用的留待下次启动重试。清理是自愈动作而非
            // 前置条件：失败不阻塞启动，报告暂无界面呈现。
            let external_open = vistash_core::external_open::ExternalOpenManager::new(
                app.path().app_cache_dir()?.join("external-open").join("v1"),
                vistash_core::external_open::ExternalOpenManager::new_session_id(),
            );
            let _report = external_open.cleanup(chrono::Utc::now())?;
            app.manage(Mutex::new(commands::AppState::restore(
                settings_path,
                layouts_dir,
                external_open,
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
            commands::move_folder,
            commands::delete_folder,
            commands::reorder_folder,
            commands::move_asset_to_folder,
            commands::rename_asset_display_filename,
            commands::set_asset_tags,
            commands::regenerate_color_card,
            commands::delete_asset,
            commands::restore_asset,
            commands::purge_trash,
            commands::import_sources,
            commands::import_stop,
            commands::paste_import,
            commands::plan_export,
            commands::export_assets,
            commands::copy_asset_to_clipboard,
            commands::open_with_default_app,
            commands::asset_thumbnail,
            commands::asset_original,
            commands::all_error_codes,
            commands::create_prompt,
            commands::update_prompt,
            commands::prompt_detail,
            commands::prompt_snapshot,
            commands::create_prompt_folder,
            commands::rename_prompt_folder,
            commands::move_prompt_folder,
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
            commands::batch_move_assets_to_folder,
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

#[cfg(test)]
mod tests {
    #[test]
    fn import_stop_and_builder_share_the_same_managed_run_type() {
        let commands = include_str!("commands.rs");
        let assembly = include_str!("lib.rs");

        assert!(
            commands.contains("State<'_, ManagedTransferRuns>"),
            "import_stop 必须请求装配层注册的精确 managed type"
        );
        assert!(
            assembly.contains(".manage(commands::managed_transfer_runs())"),
            "Builder 必须通过 commands 暴露的同一工厂注册运行表"
        );
    }
}
