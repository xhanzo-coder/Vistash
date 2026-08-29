# Windows release 原生验收（11.5）

日期：2026-08-29。

## 已完成

- `pnpm tauri build --no-bundle` 在当前 Windows 主机通过，产物为 `app/target/release/vistash.exe`。
- release 构建启动后能读取隔离库、显示 v1→v2→v3 迁移流程并进入新版 `AppShell`。此前迁移前索引重建错误使用 v3 解析器的问题已修复，并以真实 `Index::rebuild_at` 回归测试锁定。
- `node app/scripts/e2e-release.mjs` 已在 release WebView2/CDP 上完整通过：真实 v1→v3 迁移、备注/收藏落盘、多选批量标签、图片文件夹组织、分库搜索、全局搜索、提示词关联与封面、图片/提示词回收站还原和清空均通过；脚本使用 v3 `folder`、`source.filename` 与 `deleted_from_folder` 权威字段断言。
- platform contract、浏览器验收和 Rust 测试覆盖文件/目录来源、位图/文本分流、对话框取消、默认程序打开错误码及租约释放。

## 尚需发布环境操作

上述脚本通过 CDP 驱动 release WebView2，但仍没有替代 Windows 桌面层的全部验收。11.5 还需要在真实窗口中逐项操作并记录证据：资源管理器 `CF_HDROP` 文件/目录拖放、文件列表剪贴板、截图位图剪贴板、文本输入框普通粘贴、原生图片/目录对话框、默认程序打开、原生标题栏以及 780px 窄窗口。由于这些动作依赖桌面和系统剪贴板，不能由 headless/CDP 脚本单独证明，故 11.5 保持未勾选。
