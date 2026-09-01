# 前端可访问性与视觉验收（11.7）

日期：2026-08-29。

## 自动化浏览器检查

- `app-shell-integration-check.py`：默认新版 App 的一级导航、全局定位、顶栏菜单、无任务中心入口、设置、无水平溢出与页面错误。
- `import-entry-check.py`：深浅主题与宽窄窗口下的文件/文件夹/剪贴板入口、文本框粘贴隔离和空状态引导。
- `outbound-check.py`：复制、默认程序打开、导出、冲突跳过和四种主题/窗口组合。
- `lightbox-check.py`：灯箱键盘、焦点、缩放、背景、错误重试、返回滚动位置和租约释放。
- `multi-inspector-check.py`：多选共同值、部分失败重试、筛选退出与焦点恢复。
- `e2e-release.mjs`：release WebView2 上真实 v1→v3 迁移、图片/提示词组织、搜索、关联、回收站与权威文件落盘链路全部通过。

上述流程均在 Windows headless Edge 通过，页面无运行时错误；相关报告和截图位于 `app/artifacts/` 对应目录。

## 指南审查结论

按当日 [Web Interface Guidelines](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md)复核：交互控件均有可见/语义名称，弹层使用 Radix 焦点陷阱与 Escape，重要错误保留错误码并就地显示，长列表使用真正虚拟化，图片租约在卸载/换源/关闭时释放，深浅主题与窄窗口共用结构。未发现阻断级键盘、焦点、语义或对比度问题。

release Tauri 原生构建和 release WebView2/CDP 回归已经成功；Windows Shell 的真实文件拖放、CF_HDROP/位图剪贴板和默认程序进程行为仍需在签名发布环境做人工验收，记录在 `release-native.md`。
