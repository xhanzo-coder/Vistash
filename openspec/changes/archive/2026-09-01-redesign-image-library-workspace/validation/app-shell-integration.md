# 默认应用壳层与跨工作区联动验收（11.1、11.3）

日期：2026-08-28。

## 实现

- `App.tsx` 现在由 `LibraryLifecycle`、`AppShell`、`asset-library` 与 `prompt-library` 公共出口组合；旧 `features/assets/AssetWorkspace` 及根级 `catalogVersion` 刷新协议已删除。
- 应用级 `app/runtime.ts` 提供一次性的 Tauri platform 与内部 `TaskCenter`；顶栏导入菜单通过 typed `AssetImportRequest` 投递到图片模块，不复制第二套导入协调器或渲染任务入口。
- `WorkspaceNavigation` 的定位请求按图片/提示词分别投递；提示词回收站定位保留 trash 范围，图片与提示词模块不互相导入内部实现。
- 设置中的“打开其他库”会回到生命周期选库界面；重新通过兼容性门禁后以新的 session key 重建两个工作区。

## 浏览器验收

`app/scripts/app-shell-integration-check.py` 使用 Edge headless 和 100 条内存 fixture，验证新版默认 App 的图片/提示词一级切换、顶栏导入菜单、全局搜索定位、无任务中心入口、设置 Dialog、水平溢出与页面错误。报告和截图位于 `app/artifacts/app-shell-integration/`，流程通过。

应用根单元回归同时验证兼容库直接进入 `AppShell`，且无库时仍停在欢迎/迁移生命周期界面。
